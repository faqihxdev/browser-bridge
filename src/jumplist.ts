import { watch } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, basename, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrowserDefinition } from './config.js';

type Settings = NonNullable<BrowserDefinition['windowsJumpList']>;

export function taskArguments(settings: Settings): [string, string] {
  return [`${settings.arguments} --new-window`, `${settings.arguments} --incognito --new-window`];
}

function publish(settings: Settings): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-File',
        fileURLToPath(new URL('../native/jumplist.ps1', import.meta.url)),
      ],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-4000);
    });
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`JumpList update failed: ${errors.trim() || `exit ${code}`}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ ...settings, tasks: taskArguments(settings) }));
  });
}

// Watch only the configured app's cache. All writes use the Windows shell API.
// Compare the resulting arguments so our own commit cannot trigger a write loop.
export async function maintainJumpList(
  settings: Settings,
  options: {
    publish?: (settings: Settings) => Promise<void>;
    delayMs?: number;
    report?: (error: Error) => void;
  } = {},
): Promise<{ close(): Promise<void> }> {
  const publisher = options.publish ?? publish;
  const report = options.report ?? ((error) => console.error(error.message));
  const argumentsToFind = taskArguments(settings).map((value) => Buffer.from(value, 'utf16le'));
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  const correct = async () => {
    try {
      const content = await readFile(settings.cacheFile);
      return argumentsToFind.every((value) => content.includes(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const run = async () => {
    if (closed) return;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        if (!closed && !(await correct())) await publisher(settings);
      } while (again && !closed);
    })();
    try {
      await running;
    } catch (error) {
      report(error as Error);
    } finally {
      running = undefined;
    }
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), options.delayMs ?? 150);
  };
  await mkdir(dirname(settings.cacheFile), { recursive: true });
  const watcher = watch(dirname(settings.cacheFile), (_event, file) => {
    if (!file || file.toString().toLowerCase() === basename(settings.cacheFile).toLowerCase())
      schedule();
  });
  watcher.on('error', report);
  await run();
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      await running;
    },
  };
}

export async function maintainJumpLists(
  browsers: BrowserDefinition[] = [],
): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') return async () => undefined;
  const repairs: Awaited<ReturnType<typeof maintainJumpList>>[] = [];
  for (const browser of browsers) {
    const settings = browser.windowsJumpList;
    if (!settings) continue;
    try {
      if (!win32.isAbsolute(settings.cacheFile) || !win32.isAbsolute(settings.executable))
        throw new Error(`${browser.id}: JumpList paths must be absolute.`);
      repairs.push(await maintainJumpList(settings));
    } catch (error) {
      console.error(`Taskbar setup for ${browser.id}: ${(error as Error).message}`);
    }
  }
  return async () => {
    await Promise.all(repairs.map((repair) => repair.close()));
  };
}

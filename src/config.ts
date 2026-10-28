import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  browser: string;
  idleMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
}
export const home =
  process.env.BROWSER_BRIDGE_HOME ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'BrowserBridge');
const identity = createHash('sha256').update(home).digest('hex').slice(0, 20);
export const pipe =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\browser-bridge-${identity}`
    : join(home, 'controller.sock');
export const defaults: Config = {
  browser: 'msedge',
  idleMs: 600_000,
  actionTimeoutMs: 5_000,
  navigationTimeoutMs: 30_000,
};
export async function loadConfig(): Promise<Config> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  let supplied: Partial<Config> = {};
  try {
    supplied = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = {
    ...defaults,
    ...supplied,
    browser: process.env.BROWSER_BRIDGE_BROWSER ?? supplied.browser ?? defaults.browser,
  };
  for (const value of [config.idleMs, config.actionTimeoutMs, config.navigationTimeoutMs]) {
    if (!Number.isFinite(value) || value < 1) throw new Error('Timeouts must be positive numbers.');
  }
  return config;
}
export async function credential(): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'credential');
  try {
    await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return (await readFile(path, 'utf8')).trim();
}
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
export async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

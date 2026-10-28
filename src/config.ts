import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  browser: string;
  browsers?: BrowserDefinition[];
  connectTimeoutMs?: number;
  idleMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
}
export interface BrowserDefinition {
  id: string;
  name?: string;
  browser?: string;
  aliases?: string[];
  userDataDir?: string;
  endpoint?: string;
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
  browsers: [],
  connectTimeoutMs: 60_000,
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
  if (typeof config.browser !== 'string' || !config.browser.trim())
    throw new Error('browser must be a browser name, configured ID or CDP URL.');
  if (!Array.isArray(config.browsers)) throw new Error('browsers must be an array.');
  const ids = new Set<string>();
  for (const browser of config.browsers) {
    if (!browser || !/^[a-z0-9][a-z0-9._-]*$/.test(browser.id) || ids.has(browser.id))
      throw new Error('Each browser needs a unique lowercase id using letters, numbers, . _ or -.');
    ids.add(browser.id);
    for (const key of ['name', 'browser', 'userDataDir', 'endpoint'] as const)
      if (browser[key] !== undefined && (typeof browser[key] !== 'string' || !browser[key]!.trim()))
        throw new Error(`Browser ${browser.id}: ${key} must be a nonempty string.`);
    if (!browser.endpoint && !browser.userDataDir)
      throw new Error(`Browser ${browser.id} needs endpoint or userDataDir.`);
    if (
      browser.aliases !== undefined &&
      (!Array.isArray(browser.aliases) ||
        browser.aliases.some((alias) => typeof alias !== 'string' || !alias.trim()))
    )
      throw new Error(`Browser ${browser.id}: aliases must be nonempty strings.`);
  }
  for (const value of [
    config.idleMs,
    config.actionTimeoutMs,
    config.navigationTimeoutMs,
    config.connectTimeoutMs,
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
      throw new Error('Timeouts must be positive numbers.');
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

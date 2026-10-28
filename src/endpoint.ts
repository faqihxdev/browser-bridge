import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseActivePort(content: string): string {
  const [portText, target = '/devtools/browser'] = content.trim().split(/\r?\n/);
  const port = Number(portText);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/.test(target)
  )
    throw new Error('Invalid DevToolsActivePort file.');
  return `ws://127.0.0.1:${port}${target}`;
}
export async function resolveEndpoint(browser: string): Promise<string> {
  if (!['msedge', 'chrome', 'chromium'].includes(browser)) return browser;
  let root: string;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    root =
      browser === 'msedge'
        ? join(local, 'Microsoft', 'Edge', 'User Data')
        : browser === 'chrome'
          ? join(local, 'Google', 'Chrome', 'User Data')
          : join(local, 'Chromium', 'User Data');
  } else if (process.platform === 'darwin')
    root = join(
      homedir(),
      'Library',
      'Application Support',
      browser === 'msedge' ? 'Microsoft Edge' : browser === 'chrome' ? 'Google/Chrome' : 'Chromium',
    );
  else
    root = join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      browser === 'msedge' ? 'microsoft-edge' : browser === 'chrome' ? 'google-chrome' : 'chromium',
    );
  try {
    return parseActivePort(await readFile(join(root, 'DevToolsActivePort'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return browser;
    throw error;
  }
}

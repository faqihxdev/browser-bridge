import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, home, loadConfig } from './config.js';
import { browserRoots } from './browsers.js';

const exec = promisify(execFile);
export async function setup(codex: boolean): Promise<unknown> {
  const config = await loadConfig();
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const extension = fileURLToPath(new URL('./extension/', import.meta.url));
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  const digest = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32);
  const extensionId = [...digest]
    .map((character) => String.fromCharCode(97 + parseInt(character, 16)))
    .join('');
  const nativeDir = join(home, 'native');
  await mkdir(nativeDir, { recursive: true });
  const launcher = join(
    nativeDir,
    process.platform === 'win32' ? 'browser-bridge.cmd' : 'browser-bridge',
  );
  if (process.platform === 'win32') {
    const quote = (value: string) => '"' + value.replaceAll('%', '%%') + '"';
    await writeFile(launcher, `@echo off\r\n${quote(process.execPath)} ${quote(cli)} native\r\n`);
  } else {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} native\n`);
    await chmod(launcher, 0o700);
  }
  const nativeManifest = {
    name: 'dev.browser_bridge',
    description: 'Browser Bridge local controller',
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const path = join(nativeDir, 'dev.browser_bridge.json');
  await writeFile(path, JSON.stringify(nativeManifest, null, 2));
  if (process.platform === 'win32') {
    for (const browser of [
      'Google\\Chrome',
      'Microsoft\\Edge',
      'Chromium',
      'BraveSoftware\\Brave-Browser',
      'Vivaldi',
    ]) {
      await exec(
        'reg.exe',
        [
          'add',
          `HKCU\\Software\\${browser}\\NativeMessagingHosts\\dev.browser_bridge`,
          '/ve',
          '/t',
          'REG_SZ',
          '/d',
          path,
          '/f',
        ],
        { windowsHide: true },
      );
    }
  } else {
    const roots = new Set([
      ...browserRoots().map(({ root }) => join(root, 'NativeMessagingHosts')),
      ...(config.browsers ?? []).flatMap((browser) =>
        browser.userDataDir ? [join(browser.userDataDir, 'NativeMessagingHosts')] : [],
      ),
    ]);
    for (const root of roots) {
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, 'dev.browser_bridge.json'),
        JSON.stringify(nativeManifest, null, 2),
      );
    }
  }
  try {
    await writeFile(join(home, 'config.json'), JSON.stringify(defaults, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const agentCommand = { command: process.execPath, args: [cli, 'mcp'] };
  await writeFile(
    join(home, 'mcp.json'),
    JSON.stringify({ mcpServers: { browser_bridge: agentCommand } }, null, 2),
  );
  const toml = `[mcp_servers.browser_bridge]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cli, 'mcp'])}\nstartup_timeout_sec = 30\n`;
  await writeFile(join(home, 'codex.toml'), toml);
  if (codex) {
    const args = [
      'mcp',
      'add',
      'browser_bridge',
      '--env',
      'BROWSER_BRIDGE_AGENT=Codex',
      '--',
      process.execPath,
      cli,
      'mcp',
    ];
    if (process.platform !== 'win32') await exec('codex', args);
    else {
      let launch: { command: string; args: string[] } | undefined;
      for (const folder of (process.env.PATH ?? '').split(delimiter)) {
        for (const candidate of [
          join(folder, 'codex.exe'),
          join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        ]) {
          try {
            await access(candidate);
            launch = candidate.endsWith('.js')
              ? { command: process.execPath, args: [candidate, ...args] }
              : { command: candidate, args };
            break;
          } catch {
            /* Try the next PATH entry. */
          }
        }
        if (launch) break;
      }
      if (!launch)
        throw new Error(
          'Codex CLI was not found. Copy the generated codex.toml entry into your Codex configuration.',
        );
      await exec(launch.command, launch.args, { windowsHide: true });
    }
  }
  return {
    extensionDirectory: extension.replace(/[\\/]$/, ''),
    extensionId,
    nativeManifest: path,
    runtimeDirectory: home,
    codexConfigured: codex,
    agentCommand,
  };
}

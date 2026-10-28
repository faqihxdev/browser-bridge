#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { connectController } from './client.js';
import { message } from './config.js';

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'daemon') {
    await (await import('./daemon.js')).runDaemon();
    return;
  }
  if (command === 'mcp') {
    await (await import('./mcp.js')).runMcp();
    return;
  }
  if (command === 'native') {
    await (await import('./native.js')).runNative();
    return;
  }
  if (command === 'setup') {
    console.log(
      JSON.stringify(await (await import('./setup.js')).setup(args.includes('--codex')), null, 2),
    );
    return;
  }
  if (['status', 'browsers', 'tabs', 'call', 'doctor', 'stop'].includes(command)) {
    const client = await connectController(
      process.env.BROWSER_BRIDGE_AGENT ?? 'CLI',
      'agent',
      command !== 'stop',
    );
    try {
      let op = command;
      if (command === 'stop') op = 'shutdown';
      const browserIndex = args.indexOf('--browser');
      let input: Record<string, unknown> =
        browserIndex >= 0 ? { browser: args[browserIndex + 1] } : {};
      if (command === 'call') {
        op = args[0] ?? 'status';
        const fileIndex = args.indexOf('--args-file');
        input = JSON.parse(
          fileIndex >= 0 ? await readFile(args[fileIndex + 1]!, 'utf8') : (args[1] ?? '{}'),
        );
      }
      if (command === 'doctor') {
        const tabs = (await client.call('tabs', input)) as unknown[];
        const status = await client.call('status');
        console.log(
          JSON.stringify(
            { ...(status as object), tabCount: tabs.length, browserReachable: true },
            null,
            2,
          ),
        );
        return;
      }
      console.log(JSON.stringify(await client.call(op, input), null, 2));
    } finally {
      client.close();
    }
    return;
  }
  console.log(
    'Browser Bridge\n\nsetup [--codex]  Register Native Messaging and generate agent settings\nmcp              MCP stdio adapter for an agent\ndaemon           Run the shared controller in the foreground\nstatus           Controller and extension status\nbrowsers         Discover browser names, IDs and debugging state\ndoctor           Verify the browser connection; --browser NAME selects a browser\nstop             Disconnect the controller and restore indicators\ntabs             List tabs without changing focus; --browser NAME selects a browser\ncall OP [JSON]   Execute an operation; --args-file PATH reads JSON safely',
  );
}
main().catch((error) => {
  console.error(message(error));
  process.exitCode = 1;
});

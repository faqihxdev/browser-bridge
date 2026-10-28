import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test(
  'installed MV3 extension reaches its real native host and browser APIs',
  { timeout: 90000 },
  async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'browser-bridge-extension-'));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writeFile(
      join(runtime, 'config.json'),
      JSON.stringify({ browser: `http://127.0.0.1:${port}`, idleMs: 2000 }),
    );
    const extension = resolve('dist/extension');
    const context = await chromium.launchPersistentContext(join(runtime, 'profile'), {
      channel: 'chromium',
      headless: true,
      env: { ...process.env, BROWSER_BRIDGE_HOME: runtime },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `--remote-debugging-port=${port}`,
      ],
    });
    const client = new Client({ name: 'Extension verification', version: '1' });
    try {
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 15000 }));
      const id = new URL(worker.url()).host;
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('dist/cli.js'), 'mcp'],
          env: { ...(process.env as Record<string, string>), BROWSER_BRIDGE_HOME: runtime },
        }),
      );
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      try {
        await popup.waitForFunction(
          () => document.querySelector('#connection')?.textContent === 'Controller ready',
          undefined,
          { timeout: 15000 },
        );
      } catch {
        throw new Error(await popup.locator('body').innerText());
      }
      const reply = (await client.callTool({
        name: 'browser_api',
        arguments: { namespace: 'tabs', method: 'query', args: [{}] },
      })) as { isError?: boolean; content: { text: string }[] };
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      assert.ok(
        JSON.parse(reply.content[0]!.text).some((tab: { url: string }) =>
          tab.url.endsWith('/popup.html'),
        ),
      );
      const page = (await client.callTool({ name: 'browser_open', arguments: {} })) as {
        content: { text: string }[];
      };
      const { tabId } = JSON.parse(page.content[0]!.text);
      await popup.locator('#refresh').click();
      await popup.getByRole('button', { name: /^Stop / }).waitFor();
      await popup.getByRole('button', { name: /^Stop / }).click();
      await popup.getByText('No agent is controlling a tab.').waitFor();
      await mkdir('artifacts', { recursive: true });
      await popup.locator('body').screenshot({ path: 'artifacts/extension-popup.png' });
    } finally {
      await client.close();
      await context.close();
    }
  },
);

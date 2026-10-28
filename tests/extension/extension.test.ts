import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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
          () => document.querySelector('#connection')?.textContent === 'Ready',
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
      await popup.getByText('No active tabs.').waitFor();
      await mkdir('artifacts', { recursive: true });
      await popup.locator('body').screenshot({ path: 'artifacts/extension-popup.png' });
    } finally {
      await client.close();
      await context.close();
    }
  },
);

test(
  'two installed extensions keep API results and human stop in their own browser',
  { timeout: 120000 },
  async () => {
    const runtime = await mkdtemp(join(tmpdir(), 'browser-bridge-two-extensions-'));
    const firstPort = await availablePort();
    const secondPort = await availablePort();
    await writeFile(
      join(runtime, 'config.json'),
      JSON.stringify({
        browser: 'alpha',
        idleMs: 2000,
        browsers: [
          { id: 'alpha', name: 'Test Edge', endpoint: `http://127.0.0.1:${firstPort}` },
          { id: 'beta', name: 'Test Brave', endpoint: `http://127.0.0.1:${secondPort}` },
        ],
      }),
    );
    const extension = resolve('dist/extension');
    const launch = (name: string, port: number) =>
      chromium.launchPersistentContext(join(runtime, name), {
        channel: 'chromium',
        headless: true,
        env: { ...process.env, BROWSER_BRIDGE_HOME: runtime },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          `--remote-debugging-port=${port}`,
        ],
      });
    const first = await launch('profile-a', firstPort);
    const second = await launch('profile-b', secondPort);
    const client = new Client({ name: 'Multi-browser verification', version: '1' });
    let closingFirst: Promise<void> | undefined;
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
      const response = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return JSON.parse(response.content[0]!.text);
    };
    try {
      const workerA = first.serviceWorkers()[0] ?? (await first.waitForEvent('serviceworker'));
      const workerB = second.serviceWorkers()[0] ?? (await second.waitForEvent('serviceworker'));
      const extensionId = new URL(workerA.url()).host;
      const popupA = await first.newPage();
      const popupB = await second.newPage();
      await Promise.all([
        popupA.goto(`chrome-extension://${extensionId}/popup.html`),
        popupB.goto(`chrome-extension://${extensionId}/popup.html`),
      ]);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('dist/cli.js'), 'mcp'],
          env: { ...(process.env as Record<string, string>), BROWSER_BRIDGE_HOME: runtime },
        }),
      );
      let status;
      for (let attempt = 0; attempt < 150; attempt++) {
        status = await call('browser_status');
        if (status.registeredExtensions === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(status.registeredExtensions, 2);
      assert.notEqual(
        await workerA.evaluate('globalThis.__browserBridgeConnectionId'),
        await workerB.evaluate('globalThis.__browserBridgeConnectionId'),
      );
      await call('browser_api', {
        browser: 'Test Edge',
        namespace: 'storage',
        method: 'local.set',
        args: [{ routingMarker: 'alpha' }],
      });
      await call('browser_api', {
        browser: 'Test Brave',
        namespace: 'storage',
        method: 'local.set',
        args: [{ routingMarker: 'beta' }],
      });
      assert.equal(
        (
          await call('browser_api', {
            browser: 'Test Edge',
            namespace: 'storage',
            method: 'local.get',
            args: ['routingMarker'],
          })
        ).routingMarker,
        'alpha',
      );
      assert.equal(
        (
          await call('browser_api', {
            browser: 'Test Brave',
            namespace: 'storage',
            method: 'local.get',
            args: ['routingMarker'],
          })
        ).routingMarker,
        'beta',
      );
      const pageA = await call('browser_open', {
        browser: 'Test Edge',
        url: 'data:text/html,<h1>bridge-alpha</h1>',
      });
      const pageB = await call('browser_open', {
        browser: 'Test Brave',
        url: 'data:text/html,<h1>bridge-beta</h1>',
      });
      const tabsA = await call('browser_api', {
        browser: 'alpha',
        namespace: 'tabs',
        method: 'query',
        args: [{}],
      });
      const tabsB = await call('browser_api', {
        browser: 'beta',
        namespace: 'tabs',
        method: 'query',
        args: [{}],
      });
      assert.ok(tabsA.some((tab: { url: string }) => tab.url.includes('bridge-alpha')));
      assert.ok(!tabsA.some((tab: { url: string }) => tab.url.includes('bridge-beta')));
      assert.ok(tabsB.some((tab: { url: string }) => tab.url.includes('bridge-beta')));
      assert.ok(!tabsB.some((tab: { url: string }) => tab.url.includes('bridge-alpha')));
      await popupA.locator('#refresh').click();
      await popupB.locator('#refresh').click();
      await popupA.getByRole('button', { name: /^Stop / }).waitFor();
      await popupB.getByRole('button', { name: /^Stop / }).waitFor();
      assert.equal(await popupA.getByRole('button', { name: /^Stop / }).count(), 1);
      assert.equal(await popupB.getByRole('button', { name: /^Stop / }).count(), 1);
      const wrongBrowser = await popupA.evaluate(
        async (tabId) => chrome.runtime.sendMessage({ op: 'release', args: { tabId } }),
        pageB.tabId,
      );
      assert.match(wrongBrowser.error, /cannot release a tab in another browser/);
      await mkdir('artifacts', { recursive: true });
      await popupA.locator('body').screenshot({ path: 'artifacts/extension-active.png' });
      await popupA.getByRole('button', { name: /^Stop / }).click();
      await popupA.getByText('No active tabs.').waitFor();
      const claims = (await call('browser_status')).claims;
      assert.ok(!claims.some((claim: { tabId: string }) => claim.tabId === pageA.tabId));
      assert.ok(claims.some((claim: { tabId: string }) => claim.tabId === pageB.tabId));
      // CDP disconnects before Playwright finishes waiting for native-host descendants.
      closingFirst = first.close();
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await call('browser_status');
        if (!current.browsers.find((browser: { id: string }) => browser.id === 'alpha').connected)
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        (await call('browser_status')).browsers.find(
          (browser: { id: string }) => browser.id === 'alpha',
        ).connected,
        false,
      );
      const unavailable = await client.callTool({
        name: 'browser_api',
        arguments: {
          browser: 'alpha',
          namespace: 'storage',
          method: 'local.get',
          args: ['routingMarker'],
        },
      });
      assert.equal(unavailable.isError, true);
      assert.equal(
        (
          await call('browser_api', {
            browser: 'beta',
            namespace: 'storage',
            method: 'local.get',
            args: ['routingMarker'],
          })
        ).routingMarker,
        'beta',
      );
    } finally {
      await client.close();
      await Promise.all([closingFirst ?? first.close(), second.close()]);
    }
  },
);

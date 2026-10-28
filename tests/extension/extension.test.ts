import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium, type BrowserContext, type Worker } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function waitForFavicon(worker: Worker, url: string, controlled: boolean): Promise<string> {
  // Keep this browser-side function outside tsx's named-function instrumentation.
  return worker.evaluate(`
      new Promise((resolve, reject) => {
        const { url, controlled } = ${JSON.stringify({ url, controlled })};
        const browser = chrome;
        const matches = (href) =>
          controlled
            ? href?.startsWith('data:image/svg+xml,') &&
              decodeURIComponent(href).includes('<image ')
            : href === url + 'favicon.svg';
        const finish = (href) => {
          clearTimeout(timer);
          browser.tabs.onUpdated.removeListener(updated);
          resolve(href);
        };
        const updated = (_id, _change, tab) => {
          if (tab.url === url && matches(tab.favIconUrl)) finish(tab.favIconUrl);
        };
        const timer = setTimeout(() => {
          browser.tabs.onUpdated.removeListener(updated);
          reject(
            new Error('Browser favicon did not become ' + (controlled ? 'controlled' : 'original') + '.'),
          );
        }, 8000);
        browser.tabs.onUpdated.addListener(updated);
        void browser.tabs.query({}).then((tabs) => {
          const tab = tabs.find((tab) => tab.url === url);
          if (matches(tab?.favIconUrl)) finish(tab.favIconUrl);
        });
      })`);
}

function cleanupOnEnd(t: TestContext, client: Client) {
  const contexts: BrowserContext[] = [];
  const pending: Promise<unknown>[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await client.close().catch(() => undefined);
      const results = await Promise.allSettled([
        ...pending,
        ...contexts.map((context) => context.close()),
      ]);
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, 'Browser test cleanup failed.');
    })());
  t.after(close);
  return { contexts, pending, close };
}

test(
  'installed MV3 extension reaches its real native host and browser APIs',
  { timeout: 90000 },
  async (t) => {
    const server = createServer((request, response) => {
      if (request.url === '/favicon.svg') {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2674d9"/></svg>',
        );
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><link rel="icon" href="/favicon.svg"><title>Favicon fixture</title>Browser Bridge',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const runtime = await mkdtemp(join(tmpdir(), 'browser-bridge-extension-'));
    const profile = join(runtime, 'profile');
    await writeFile(
      join(runtime, 'config.json'),
      JSON.stringify({
        browser: 'extension-test',
        browsers: [{ id: 'extension-test', userDataDir: profile }],
        idleMs: 2000,
      }),
    );
    const extension = resolve('dist/extension');
    const client = new Client({ name: 'Extension verification', version: '1' });
    const cleanup = cleanupOnEnd(t, client);
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      env: { ...process.env, BROWSER_BRIDGE_HOME: runtime },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--remote-debugging-port=0',
      ],
    });
    cleanup.contexts.push(context);
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
      const discovery = (await client.callTool({ name: 'browser_list' })) as {
        content: { text: string }[];
      };
      assert.equal(
        JSON.parse(discovery.content[0]!.text).browsers.find(
          (browser: { id: string }) => browser.id === 'extension-test',
        ).listening,
        true,
      );
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
      const page = (await client.callTool({
        name: 'browser_open',
        arguments: { url, focus: true },
      })) as {
        content: { text: string }[];
      };
      const { tabId } = JSON.parse(page.content[0]!.text);
      await waitForFavicon(worker, url, true);
      await popup.locator('#refresh').click();
      await popup.getByRole('button', { name: /^Stop / }).waitFor();
      await popup.getByRole('button', { name: /^Stop / }).click();
      await popup.getByText('No active tabs.').waitFor();
      await waitForFavicon(worker, url, false);
      const claim = await client.callTool({
        name: 'browser_page',
        arguments: { op: 'claim', tabId },
      });
      assert.notEqual(claim.isError, true);
      await waitForFavicon(worker, url, true);
      await client.close();
      await waitForFavicon(worker, url, false);
      await mkdir('artifacts', { recursive: true });
      await popup.locator('body').screenshot({ path: 'artifacts/extension-popup.png' });
    } finally {
      await cleanup.close();
    }
  },
);

test(
  'two installed extensions keep API results and human stop in their own browser',
  { timeout: 120000 },
  async (t) => {
    const runtime = await mkdtemp(join(tmpdir(), 'browser-bridge-two-extensions-'));
    await writeFile(
      join(runtime, 'config.json'),
      JSON.stringify({
        browser: 'alpha',
        idleMs: 2000,
        browsers: [
          { id: 'alpha', name: 'Test Edge', userDataDir: join(runtime, 'profile-a') },
          { id: 'beta', name: 'Test Brave', userDataDir: join(runtime, 'profile-b') },
        ],
      }),
    );
    const extension = resolve('dist/extension');
    const launch = (name: string) =>
      chromium.launchPersistentContext(join(runtime, name), {
        channel: 'chromium',
        headless: true,
        env: { ...process.env, BROWSER_BRIDGE_HOME: runtime },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          '--remote-debugging-port=0',
        ],
      });
    const client = new Client({ name: 'Multi-browser verification', version: '1' });
    const cleanup = cleanupOnEnd(t, client);
    const first = await launch('profile-a');
    cleanup.contexts.push(first);
    const second = await launch('profile-b');
    cleanup.contexts.push(second);
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
      const discovery = await call('browser_list');
      assert.ok(
        discovery.browsers
          .filter((browser: { id: string }) => ['alpha', 'beta'].includes(browser.id))
          .every((browser: { listening: boolean }) => browser.listening),
      );
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
      cleanup.pending.push(first.close());
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
      await cleanup.close();
    }
  },
);

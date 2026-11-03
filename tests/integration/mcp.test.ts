import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { NativeDecoder, encodeNative } from '../../src/native.js';

test(
  'MCP clients route independent browsers and reject unverified native hosts',
  { timeout: 120000 },
  async (t) => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    t.after(() => browser.close());
    const secondServer = createServer();
    await new Promise<void>((resolve) => secondServer.listen(0, '127.0.0.1', resolve));
    const secondPort = (secondServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => secondServer.close(() => resolve()));
    const otherBrowser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${secondPort}`],
    });
    t.after(() => otherBrowser.close());
    const runtime = await mkdtemp(join(tmpdir(), 'browser-bridge-mcp-'));
    await writeFile(
      join(runtime, 'config.json'),
      JSON.stringify({
        browser: 'browser-a',
        browsers: [
          { id: 'browser-a', name: 'Browser A', endpoint: `http://127.0.0.1:${port}` },
          { id: 'browser-b', name: 'Browser B', endpoint: `http://127.0.0.1:${secondPort}` },
        ],
        idleMs: 2000,
      }),
    );
    const clients: Client[] = [];
    const connect = async (name: string) => {
      const client = new Client({ name, version: '1' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('dist/cli.js'), 'mcp'],
          env: { ...(process.env as Record<string, string>), BROWSER_BRIDGE_HOME: runtime },
        }),
      );
      clients.push(client);
      return client;
    };
    const json = (reply: unknown): any => {
      const result = reply as { content: { text: string }[]; isError?: boolean };
      if (result.isError) throw new Error(result.content[0]!.text);
      return JSON.parse(result.content[0]!.text);
    };
    let native: ReturnType<typeof spawn> | undefined;
    try {
      const first = await connect('First MCP client');
      const second = await connect('Second MCP client');
      assert.equal((await first.listTools()).tools.length, 13);
      const same = await Promise.all([
        first.callTool({ name: 'browser_status' }),
        first.callTool({ name: 'browser_status' }),
      ]);
      const firstStatus = json(same[0]);
      assert.equal(firstStatus.clients, 1);
      assert.equal(json(same[1]).pid, firstStatus.pid);
      assert.equal(json(await second.callTool({ name: 'browser_status' })).pid, firstStatus.pid);
      const discovered = json(await first.callTool({ name: 'browser_list' }));
      assert.ok(discovered.browsers.some((browser: { id: string }) => browser.id === 'browser-b'));
      assert.ok(discovered.browsers.every((browser: { connected: boolean }) => !browser.connected));
      json(await first.callTool({ name: 'browser_select', arguments: { browser: 'Browser A' } }));
      json(await second.callTool({ name: 'browser_select', arguments: { browser: 'Browser B' } }));
      const { tabId } = json(await first.callTool({ name: 'browser_open', arguments: {} }));
      const otherTab = json(await second.callTool({ name: 'browser_open', arguments: {} }));
      assert.ok(tabId.startsWith('browser-a/'));
      assert.ok(otherTab.tabId.startsWith('browser-b/'));
      json(
        await second.callTool({
          name: 'browser_evaluate',
          arguments: { tabId: otherTab.tabId, expression: 'globalThis.routingMarker = "B"' },
        }),
      );
      json(await first.callTool({ name: 'browser_select', arguments: { browser: 'Browser B' } }));
      assert.equal(
        json(
          await first.callTool({
            name: 'browser_evaluate',
            arguments: { tabId, expression: 'globalThis.routingMarker ?? "A"' },
          }),
        ),
        'A',
      );
      const mismatch = await first.callTool({
        name: 'browser_evaluate',
        arguments: { tabId, browser: 'Browser B', expression: '"wrong"' },
      });
      assert.equal(mismatch.isError, true);
      const mixed = await first.callTool({
        name: 'browser_batch',
        arguments: {
          actions: [
            {
              op: 'evaluate',
              args: { tabId, expression: 'globalThis.crossBrowserMutation = true' },
            },
            { op: 'evaluate', args: { tabId: otherTab.tabId, expression: 'true' } },
          ],
        },
      });
      assert.equal(mixed.isError, true);
      assert.equal(
        json(
          await first.callTool({
            name: 'browser_evaluate',
            arguments: { tabId, expression: 'globalThis.crossBrowserMutation ?? false' },
          }),
        ),
        false,
      );
      json(await first.callTool({ name: 'browser_select', arguments: { browser: 'Browser A' } }));
      assert.equal(
        json(await second.callTool({ name: 'browser_status' })).selectedBrowserId,
        'browser-b',
      );
      json(
        await first.callTool({
          name: 'browser_evaluate',
          arguments: {
            tabId,
            expression:
              '(() => { const button = document.createElement("button"); button.textContent = "Run"; button.onclick = () => button.textContent = "Done"; document.body.replaceChildren(button); })()',
          },
        }),
      );
      const snapshot = json(
        await first.callTool({ name: 'browser_snapshot', arguments: { tabId } }),
      );
      assert.equal(snapshot.tabId, tabId);
      assert.ok(snapshot.frames[0]?.elements, JSON.stringify(snapshot));
      const ref = snapshot.frames[0].elements[0].ref;
      json(
        await first.callTool({ name: 'browser_act', arguments: { tabId, action: 'click', ref } }),
      );
      assert.equal(
        json(
          await first.callTool({
            name: 'browser_evaluate',
            arguments: { tabId, expression: 'document.querySelector("button").textContent' },
          }),
        ),
        'Done',
      );
      const blocked = await second.callTool({ name: 'browser_snapshot', arguments: { tabId } });
      assert.equal(blocked.isError, true);
      const images = await first.callTool({
        name: 'browser_batch',
        arguments: { tabId, actions: [{ op: 'screenshot' }] },
      });
      assert.equal(images.content[1].type, 'image');
      assert.ok(images.content[0].text.length < 200);

      native = spawn(process.execPath, [resolve('dist/cli.js'), 'native'], {
        env: { ...process.env, BROWSER_BRIDGE_HOME: runtime },
        stdio: 'pipe',
        windowsHide: true,
      });
      const decoder = new NativeDecoder();
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error('Native host did not start.')), 10000);
        native!.stdout!.on('data', (chunk) => {
          for (const packet of decoder.push(chunk)) {
            if (packet.event === 'ready') {
              clearTimeout(timer);
              resolveReady();
            }
            if (packet.event === 'browser-api')
              native!.stdin!.write(
                encodeNative({
                  id: 'extension-response',
                  op: 'extension-result',
                  args: {
                    requestId: packet.id,
                    result: [{ id: 7, title: 'Extension API result' }],
                  },
                }),
              );
          }
        });
        native!.once('error', reject);
      });
      assert.equal(
        json(await first.callTool({ name: 'browser_status' })).extensionConnected,
        false,
      );
      const unverified = await first.callTool({
        name: 'browser_api',
        arguments: { namespace: 'tabs', method: 'query', args: [{}] },
      });
      assert.equal(unverified.isError, true);
      assert.match(unverified.content[0].text, /no verified Browser Bridge extension/);
      json(
        await second.callTool({
          name: 'browser_page',
          arguments: { tabId: otherTab.tabId, op: 'release' },
        }),
      );
      await first.close();
      let claims;
      for (let attempt = 0; attempt < 100; attempt++) {
        claims = json(await second.callTool({ name: 'browser_status' })).claims;
        if (!claims.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(claims, []);
      assert.equal(
        (await second.callTool({ name: 'browser_snapshot', arguments: { tabId } })).isError,
        undefined,
      );
    } finally {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      native?.stdin?.end();
    }
  },
);

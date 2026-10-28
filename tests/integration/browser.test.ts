import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { chromium } from 'playwright-core';
import { BrowserController, type Session } from '../../src/browser.js';
import { defaults } from '../../src/config.js';

async function port(): Promise<number> {
  const socket = createNetServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const number = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve())); return number;
}
test('real Chromium control, references, ownership, indicators and disconnect', { timeout: 120_000 }, async t => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><link rel="icon" href="/original.svg"><link rel="shortcut icon" href="/other.ico"><title>Bridge fixture</title></head><body><h1>Browser Bridge verification</h1><label>Name <input id="name"></label><input type="password" value="private-value"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button><p id="result"></p><input id="file" type="file"><a href="/next">Next</a><iframe srcdoc="<button>Frame button</button>"></iframe></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cdpPort = await port();
  const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  const controller = new BrowserController({ ...defaults, browser: `http://127.0.0.1:${cdpPort}`, actionTimeoutMs: 1500 }, async () => { throw new Error('No extension in this test.'); });
  const first: Session = { id: 'one', label: 'First agent', role: 'agent', active: true };
  const second: Session = { id: 'two', label: 'Second agent', role: 'agent', active: true };
  const human: Session = { id: 'human', label: 'Human', role: 'extension', active: true };
  try {
    const opened = await controller.execute(first, 'open', { url }) as { tabId: string };
    const tabId = opened.tabId;
    const call = (op: string, args: Record<string, unknown> = {}) => controller.execute(first, op, { tabId, ...args });
    let nameRef: string;
    await t.test('snapshot produces document-bound refs across frames and masks password values', async () => {
      const snapshot = await call('snapshot') as { frames: { elements: { ref: string; name: string; value?: string }[] }[] };
      assert.equal(snapshot.frames.length, 2);
      const elements = snapshot.frames.flatMap(frame => frame.elements);
      nameRef = elements.find(element => element.name === 'Name')!.ref;
      assert.ok(nameRef); assert.ok(elements.some(element => element.name === 'Frame button'));
      assert.equal(JSON.stringify(snapshot).includes('private-value'), false);
    });
    await t.test('real input and batches change application state', async () => {
      const results = await call('batch', { actions: [{ op: 'act', args: { action: 'fill', ref: nameRef, text: 'Verified ✓' } }, { op: 'act', args: { action: 'click', selector: '#save' } }, { op: 'evaluate', args: { expression: 'document.querySelector("#result").textContent' } }] }) as { ok: boolean; result: unknown }[];
      assert.equal(results.every(result => result.ok), true); assert.equal(results[2]!.result, 'Verified ✓');
    });
    await t.test('tab ownership blocks another agent', async () => {
      await assert.rejects(controller.execute(second, 'act', { tabId, action: 'click', selector: '#save' }), /controlled by First agent/);
    });
    await t.test('release restores all original favicon attributes and allows transfer', async () => {
      await call('release');
      // Inspect through the independent original connection without claiming the tab again.
      const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { noDefaults: true });
      try {
        const page = observer.contexts()[0]!.pages().find(page => page.url() === url + '/')!;
        assert.deepEqual(await page.locator('link[rel~="icon"]').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/original.svg', '/other.ico']);
        assert.equal(await page.evaluate('globalThis.__browserBridge.owner'), null);
      } finally { await observer.close(); }
      await controller.execute(second, 'claim', { tabId });
      await assert.rejects(call('snapshot'), /controlled by Second agent/);
      await controller.execute(second, 'release', { tabId });
    });
    await t.test('queued work cannot reclaim a stopped tab', async () => {
      await call('claim');
      const waiting = call('wait', { selector: '#never', timeout: 200 });
      await new Promise(resolve => setTimeout(resolve, 30));
      const queued = call('act', { action: 'fill', selector: '#name', text: 'Must not run' });
      await controller.execute(human, 'release', { tabId });
      await assert.rejects(waiting); await assert.rejects(queued, /released/);
    });
    await t.test('navigation invalidates old refs', async () => {
      await call('navigate', { url: url + '/next' });
      await assert.rejects(call('act', { action: 'fill', ref: nameRef!, text: 'stale' }), /Stale reference/);
    });
    await t.test('screenshots return actual PNG data and unhide the indicator', async () => {
      const result = await call('screenshot') as { data: string };
      assert.equal(Buffer.from(result.data, 'base64').subarray(1, 4).toString(), 'PNG');
    });
    await t.test('raw page and browser protocol commands work', async () => {
      const page = await call('cdp', { method: 'Runtime.evaluate', params: { expression: '6 * 7', returnByValue: true } }) as { result: { value: number } };
      assert.equal(page.result.value, 42);
      const version = await controller.execute(first, 'cdp', { method: 'Browser.getVersion' }) as { product: string };
      assert.ok(version.product);
    });
    await t.test('disconnect restores indicators without closing browser tabs', async () => {
      await controller.releaseSession(first.id);
      assert.equal((controller.status().claims as unknown[]).length, 0);
      await controller.dispose(); assert.equal(browser.isConnected(), true);
    });
  } finally { await controller.dispose(); await browser.close(); server.close(); }
});

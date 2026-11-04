import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { chromium } from 'playwright-core';
import { BrowserController, type Session } from '../../src/browser.js';
import { defaults } from '../../src/config.js';

async function port(): Promise<number> {
  const socket = createNetServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const number = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return number;
}
test(
  'real Chromium control, references, ownership, indicators and disconnect',
  { timeout: 120_000 },
  async (t) => {
    const server = createServer((request, response) => {
      if (request.url === '/original.svg' || request.url === '/other.ico') {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2674d9"/></svg>',
        );
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.url === '/trusted')
        response.setHeader(
          'Content-Security-Policy',
          "require-trusted-types-for 'script'; trusted-types 'none'; style-src 'nonce-fixture'",
        );
      response.end(
        `<!doctype html><html><head><link rel="icon" href="/original.svg"><link rel="shortcut icon" href="/other.ico"><title>Bridge fixture</title></head><body><h1>Browser Bridge verification</h1><label>Name <input id="name"></label><input type="password" value="private-value"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button><p id="result"></p><input id="file" type="file"><a href="/next">Next</a><iframe srcdoc="<button>Frame button</button>"></iframe></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const cdpPort = await port();
    // Installed Edge can redirect temporary profiles through the user's enterprise policies.
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${cdpPort}`],
    });
    const controller = new BrowserController(
      { ...defaults, browser: `http://127.0.0.1:${cdpPort}`, actionTimeoutMs: 1500 },
      async () => {
        throw new Error('No extension in this test.');
      },
    );
    const first: Session = { id: 'one', label: 'First agent', role: 'agent', active: true };
    const second: Session = { id: 'two', label: 'Second agent', role: 'agent', active: true };
    const human: Session = { id: 'human', label: 'Human', role: 'extension', active: true };
    try {
      const opened = (await controller.execute(first, 'open', { url })) as { tabId: string };
      const tabId = opened.tabId;
      const call = (op: string, args: Record<string, unknown> = {}) =>
        controller.execute(first, op, { tabId, ...args });
      let nameRef: string;
      await t.test(
        'snapshot produces document-bound refs across frames and masks password values',
        async () => {
          const snapshot = (await call('snapshot')) as {
            frames: { elements: { ref: string; name: string; value?: string }[] }[];
          };
          assert.equal(snapshot.frames.length, 2);
          const elements = snapshot.frames.flatMap((frame) => frame.elements);
          nameRef = elements.find((element) => element.name === 'Name')!.ref;
          assert.ok(nameRef);
          assert.ok(elements.some((element) => element.name === 'Frame button'));
          assert.equal(JSON.stringify(snapshot).includes('private-value'), false);
          const count = snapshot.frames[0]!.elements.length;
          const exact = (await call('snapshot', { limit: count })) as {
            frames: { truncated: boolean }[];
          };
          assert.equal(exact.frames[0]!.truncated, false, 'An exact limit is not truncation');
          const short = (await call('snapshot', { limit: count - 1 })) as {
            frames: { truncated: boolean }[];
          };
          assert.equal(short.frames[0]!.truncated, true);
        },
      );
      await t.test('claim shows the cursor before any pointer action', async () => {
        const { root } = (await call('cdp', {
          method: 'DOM.getDocument',
          params: { depth: -1, pierce: true },
        })) as { root: any };
        const find = (node: any): number | undefined => {
          const attributes: string[] = node.attributes ?? [];
          for (let index = 0; index < attributes.length; index += 2)
            if (attributes[index] === 'class' && attributes[index + 1] === 'cursor')
              return node.nodeId;
          for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
            const found = find(child);
            if (found) return found;
          }
        };
        const nodeId = find(root);
        assert.ok(nodeId, 'The owned cursor is mounted');
        const { model } = (await call('cdp', {
          method: 'DOM.getBoxModel',
          params: { nodeId },
        })) as { model: { width: number; height: number } };
        assert.ok(model.width > 0 && model.height > 0, 'The cursor has a visible layout box');
      });
      await t.test('the cursor stays above modal dialogs', async () => {
        await call('act', { action: 'move', x: 200, y: 200 });
        await call('evaluate', {
          expression: `(() => {
            const dialog = document.createElement('dialog');
            dialog.id = 'modal';
            dialog.style.cssText = 'width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0';
            document.body.append(dialog);
            dialog.showModal();
          })()`,
        });
        try {
          const { backendNodeId } = (await call('cdp', {
            method: 'DOM.getNodeForLocation',
            params: {
              x: 206,
              y: 206,
              includeUserAgentShadowDOM: true,
              ignorePointerEventsNone: true,
            },
          })) as { backendNodeId: number };
          const { node } = (await call('cdp', {
            method: 'DOM.describeNode',
            params: { backendNodeId },
          })) as { node: { localName: string } };
          assert.ok(
            ['svg', 'path'].includes(node.localName),
            'The cursor arrow is the topmost node',
          );
        } finally {
          await call('evaluate', { expression: 'document.querySelector("#modal").remove()' });
        }
      });
      await t.test('real input and batches change application state', async () => {
        const results = (await call('batch', {
          actions: [
            { op: 'act', args: { action: 'fill', ref: nameRef, text: 'Verified ✓' } },
            { op: 'act', args: { action: 'click', selector: '#save' } },
            {
              op: 'evaluate',
              args: { expression: 'document.querySelector("#result").textContent' },
            },
          ],
        })) as { ok: boolean; result: unknown }[];
        assert.equal(
          results.every((result) => result.ok),
          true,
        );
        assert.equal(results[2]!.result, 'Verified ✓');
      });
      await t.test(
        'the indicator follows agent actions and ignores manual pointer input',
        async () => {
          const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
            noDefaults: true,
          });
          try {
            const page = observer
              .contexts()[0]!
              .pages()
              .find((page) => page.url() === url + '/')!;
            const cdp = await page.context().newCDPSession(page);
            const pointerStyle = async (): Promise<string> => {
              const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
              const visit = (node: {
                attributes?: string[];
                children?: any[];
                shadowRoots?: any[];
              }): string | undefined => {
                const attributes = node.attributes ?? [];
                const properties = Object.fromEntries(
                  Array.from({ length: attributes.length / 2 }, (_, index) => [
                    attributes[index * 2]!,
                    attributes[index * 2 + 1]!,
                  ]),
                );
                if (properties.class === 'cursor') return properties.style;
                for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
                  const found = visit(child);
                  if (found !== undefined) return found;
                }
              };
              const style = visit(root);
              assert.ok(style, 'Agent cursor exists in its closed shadow root');
              return style;
            };
            await call('act', { action: 'move', x: 70, y: 90 });
            const before = await pointerStyle();
            await page.mouse.move(250, 260);
            await page.mouse.click(250, 260);
            assert.equal(await pointerStyle(), before);
            await call('act', { action: 'move', x: 90, y: 110 });
            assert.notEqual(await pointerStyle(), before);
            const position = await pointerStyle();
            await call('snapshot');
            assert.equal(
              await pointerStyle(),
              position,
              'Reading keeps the cursor at its last position',
            );
            assert.ok(
              !position.includes('display: none'),
              'The owned cursor stays visible between actions',
            );
            await page.locator('link[data-browser-bridge-icon]').waitFor({ state: 'attached' });
            const composite = await page
              .locator('link[data-browser-bridge-icon]')
              .first()
              .evaluate((link) => {
                const svg = decodeURIComponent(link.getAttribute('href')!.split(',')[1]!);
                const root = new DOMParser().parseFromString(svg, 'image/svg+xml');
                return {
                  siteOpacity: Number(root.querySelector('image')?.getAttribute('opacity')),
                  siteImage: root.querySelector('image')?.getAttribute('href'),
                  cursorFill: root.querySelector('path')?.getAttribute('fill'),
                  cursorOutline: root.querySelector('path')?.getAttribute('stroke'),
                  cursorOpacity: root.querySelector('path')?.getAttribute('opacity'),
                };
              });
            assert.ok(composite.siteOpacity > 0 && composite.siteOpacity < 1);
            assert.ok(composite.siteImage?.startsWith('data:image/'), 'The site icon is embedded');
            assert.equal(composite.cursorFill, '#fff');
            assert.equal(composite.cursorOutline, '#000');
            assert.equal(composite.cursorOpacity, null, 'The cursor has full opacity');
            await cdp.detach();
          } finally {
            await observer.close();
          }
        },
      );
      await t.test(
        'watched actions wait for movement, cancel on blur and respect Stop',
        async () => {
          const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
            noDefaults: true,
          });
          try {
            const page = observer
              .contexts()[0]!
              .pages()
              .find((page) => page.url() === url + '/')!;
            // Exercise animation timing independently of the runner's accessibility settings.
            await page.emulateMedia({ reducedMotion: 'no-preference' });
            await page.evaluate('globalThis.__browserBridge.setAttention(true)');
            await page.evaluate(
              'document.querySelector("#save").onclick = () => globalThis.clickedAt = performance.now()',
            );
            // The cursor lives in a closed shadow root, so observe its animations through CDP.
            const animations = await page.context().newCDPSession(page);
            let drifts = 0;
            animations.on('Animation.animationStarted', ({ animation }) => {
              if (animation.source?.duration === 28000) drifts++;
            });
            await animations.send('Animation.enable');
            const started = (await page.evaluate('performance.now()')) as number;
            await call('act', { action: 'click', selector: '#save' });
            const clickedAt = (await page.evaluate('globalThis.clickedAt')) as number;
            assert.ok(clickedAt - started >= 450, 'Input waits for visible cursor travel');
            assert.ok(
              ((await page.evaluate('performance.now()')) as number) - clickedAt >= 125,
              'A watched action includes a short result pause',
            );
            await page.waitForTimeout(800);
            assert.ok(drifts > 0, 'The cursor drifts at rest');
            await page.emulateMedia({ reducedMotion: 'reduce' });
            drifts = 0;
            await call('act', { action: 'move', x: 120, y: 140 });
            await page.waitForTimeout(800);
            assert.equal(drifts, 0, 'Reduced motion disables idle drift');
            await animations.detach();
            await page.emulateMedia({ reducedMotion: 'no-preference' });

            const moving = call('act', { action: 'move', x: 130, y: 150 });
            await page.waitForFunction('globalThis.__browserBridge.position.x === 130');
            await page.evaluate('globalThis.__browserBridge.setAttention(false)');
            await moving;
            const fastStart = performance.now();
            await call('act', { action: 'move', x: 140, y: 160 });
            assert.ok(performance.now() - fastStart < 450, 'Background input has no movement wait');

            await page.evaluate(
              'globalThis.__browserBridge.setAttention(true); globalThis.clickedAt = null',
            );
            const stopped = call('act', { action: 'click', selector: '#save' });
            const rejected = assert.rejects(stopped, /released|transferred/);
            await page.waitForFunction('globalThis.__browserBridge.position.x !== 140');
            await controller.execute(human, 'release', { tabId });
            await rejected;
            assert.equal(
              await page.evaluate('globalThis.clickedAt'),
              null,
              'Stop during movement prevents the click',
            );
            await call('claim');
          } finally {
            await observer.close();
          }
        },
      );
      await t.test('tab ownership blocks another agent', async () => {
        await assert.rejects(
          controller.execute(second, 'act', { tabId, action: 'click', selector: '#save' }),
          /controlled by First agent/,
        );
      });
      await t.test(
        'release restores all original favicon attributes and allows transfer',
        async () => {
          await call('release');
          // Inspect through the independent original connection without claiming the tab again.
          const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
            noDefaults: true,
          });
          try {
            const page = observer
              .contexts()[0]!
              .pages()
              .find((page) => page.url() === url + '/')!;
            assert.deepEqual(
              await page
                .locator('link[rel~="icon"]')
                .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
              ['/original.svg', '/other.ico'],
            );
            assert.equal(await page.evaluate('globalThis.__browserBridge.owner'), null);
          } finally {
            await observer.close();
          }
          await controller.execute(second, 'claim', { tabId });
          await assert.rejects(call('snapshot'), /controlled by Second agent/);
          await controller.execute(second, 'release', { tabId });
        },
      );
      await t.test('the fast pointer path refuses disabled and covered controls', async () => {
        await call('evaluate', { expression: 'document.querySelector("#save").disabled = true' });
        await assert.rejects(call('act', { action: 'click', selector: '#save' }), /disabled/);
        await call('evaluate', {
          expression:
            '(() => { document.querySelector("#save").disabled = false; const cover = document.createElement("div"); cover.id = "cover"; cover.style.cssText = "position:fixed;inset:0;z-index:999999;background:white"; document.body.append(cover); })()',
        });
        await assert.rejects(call('act', { action: 'click', selector: '#save' }));
        await call('evaluate', { expression: 'document.querySelector("#cover").remove()' });
      });
      await t.test('queued work cannot reclaim a stopped tab', async () => {
        await call('claim');
        const waiting = call('wait', { selector: '#never', timeout: 200 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        const queued = call('act', { action: 'fill', selector: '#name', text: 'Must not run' });
        await controller.execute(human, 'release', { tabId });
        await assert.rejects(waiting);
        await assert.rejects(queued, /released/);
      });
      await t.test('navigation invalidates old refs', async () => {
        const before = await call('evaluate', {
          expression: 'globalThis.__browserBridge.position',
        });
        await call('navigate', { url: url + '/next' });
        const position = await call('evaluate', {
          expression: 'globalThis.__browserBridge.position',
        });
        assert.deepEqual(position, before, 'Navigation preserves the last agent pointer position');
        await assert.rejects(
          call('act', { action: 'fill', ref: nameRef!, text: 'stale' }),
          /Stale reference/,
        );
      });
      await t.test('human stop prevents a batch from resuming after its current step', async () => {
        await call('claim');
        const batch = call('batch', {
          actions: [
            { op: 'wait', args: { selector: '#late', timeout: 1000 } },
            { op: 'act', args: { action: 'fill', selector: '#name', text: 'Must not resume' } },
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        await controller.execute(human, 'release', { tabId });
        const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
          noDefaults: true,
        });
        try {
          await observer
            .contexts()[0]!
            .pages()
            .find((page) => page.url().endsWith('/next'))!
            .evaluate('document.body.insertAdjacentHTML("beforeend", "<div id=late>Ready</div>")');
        } finally {
          await observer.close();
        }
        const result = (await batch) as { ok: boolean }[];
        assert.equal(result[0]!.ok, true);
        assert.equal(result[1]!.ok, false);
      });
      await t.test(
        'a dialog can be read and handled while an evaluation waits for it',
        async () => {
          await call('claim');
          const evaluation = call('evaluate', {
            expression: 'confirm("Bridge test confirmation")',
          });
          let pending: { message: string };
          const deadline = Date.now() + 2000;
          while (true) {
            try {
              pending = (await call('dialog')) as { message: string };
              break;
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !error.message.includes('No pending dialog') ||
                Date.now() > deadline
              )
                throw error;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          assert.equal(pending.message, 'Bridge test confirmation');
          await call('dialog', { accept: false });
          assert.equal(await evaluation, false);
        },
      );
      await t.test('screenshots return actual PNG data and unhide the indicator', async () => {
        const result = (await call('screenshot')) as { data: string };
        assert.equal(Buffer.from(result.data, 'base64').subarray(1, 4).toString(), 'PNG');
      });
      await t.test('raw page and browser protocol commands work', async () => {
        const page = (await call('cdp', {
          method: 'Runtime.evaluate',
          params: { expression: '6 * 7', returnByValue: true },
        })) as { result: { value: number } };
        assert.equal(page.result.value, 42);
        const version = (await controller.execute(first, 'cdp', {
          method: 'Browser.getVersion',
        })) as { product: string };
        assert.ok(version.product);
      });
      await t.test(
        'helper upgrades preserve ownership and restore the original favicons',
        async () => {
          const before = await call('evaluate', {
            expression:
              '(() => { globalThis.__browserBridge.version = 0; return globalThis.__browserBridge.documentId; })()',
          });
          await call('snapshot');
          const after = (await call('evaluate', {
            expression:
              '({ documentId: globalThis.__browserBridge.documentId, owner: globalThis.__browserBridge.owner, overlays: document.querySelectorAll("html > div[aria-hidden=true]").length })',
          })) as { documentId: string; owner: string; overlays: number };
          assert.notEqual(after.documentId, before);
          assert.equal(after.owner, first.label);
          assert.equal(after.overlays, 1);
          await call('release');
          const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
            noDefaults: true,
          });
          try {
            const page = observer
              .contexts()[0]!
              .pages()
              .find((page) => page.url().endsWith('/next'))!;
            assert.deepEqual(
              await page
                .locator('link[rel~="icon"]')
                .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
              ['/original.svg', '/other.ico'],
            );
          } finally {
            await observer.close();
          }
        },
      );
      await t.test('indicators survive Trusted Types and nonce-only CSS', async (t) => {
        await call('navigate', { url: url + '/trusted' });
        const observer = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
          noDefaults: true,
        });
        t.after(() => observer.close());
        const page = observer
          .contexts()[0]!
          .pages()
          .find((page) => page.url().endsWith('/trusted'))!;
        assert.equal(
          await page.evaluate(() => {
            try {
              document.createElement('div').innerHTML = '<span>Blocked</span>';
              return false;
            } catch {
              return true;
            }
          }),
          true,
          'The fixture enforces Trusted Types without a default policy',
        );
        assert.equal(
          await page.evaluate(() => {
            const style = document.createElement('style');
            style.textContent = 'body{color:red}';
            document.head.append(style);
            const blocked = style.sheet === null;
            style.remove();
            return blocked;
          }),
          true,
          'The fixture rejects stylesheets without the required nonce',
        );
        await call('snapshot');
        await page.locator('link[data-browser-bridge-icon]').waitFor({ state: 'attached' });
        const cdp = await page.context().newCDPSession(page);
        try {
          const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
          const findCursor = (node: any): any => {
            const attributes: string[] = node.attributes ?? [];
            if (
              attributes.some(
                (value, index) =>
                  index % 2 === 0 && value === 'class' && attributes[index + 1] === 'cursor',
              )
            )
              return node;
            for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
              const found = findCursor(child);
              if (found) return found;
            }
          };
          const cursor = findCursor(root);
          assert.ok(cursor, 'The cursor mounts despite HTML sink restrictions');
          const { model } = await cdp.send('DOM.getBoxModel', { nodeId: cursor.nodeId });
          assert.equal(model.width, 22);
          assert.equal(model.height, 22);
          const arrow = cursor.children.find((node: any) => node.attributes?.includes('pointer'));
          const svg = arrow.children.find((node: any) => node.localName === 'svg');
          assert.ok(svg.children.some((node: any) => node.localName === 'path'));
          const { model: svgModel } = await cdp.send('DOM.getBoxModel', { nodeId: svg.nodeId });
          assert.equal(svgModel.width, 22);
          assert.equal(svgModel.height, 22);
          await call('act', { action: 'fill', selector: '#name', text: 'Trusted Types passed' });
          await call('act', { action: 'click', selector: '#save' });
          assert.equal(await page.locator('#result').textContent(), 'Trusted Types passed');
          await call('release');
          assert.deepEqual(
            await page
              .locator('link[rel~="icon"]')
              .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
            ['/original.svg', '/other.ico'],
          );
        } finally {
          await cdp.detach();
        }
      });
      await t.test('idle tabs release on their own but never during work', async () => {
        let released = () => {};
        const idle = new BrowserController(
          { ...defaults, browser: `http://127.0.0.1:${cdpPort}`, releaseIdleMs: 300 },
          async () => undefined,
          () => released(),
        );
        const next = () => new Promise<void>((resolve) => (released = resolve));
        const claims = () => (idle.status().claims as unknown[]).length;
        try {
          let expired = next();
          const started = Date.now();
          const { tabId } = (await idle.execute(first, 'open', { url })) as { tabId: string };
          assert.equal(claims(), 1);
          await expired;
          assert.ok(Date.now() - started >= 300);
          assert.equal(claims(), 0, 'An unused tab releases after releaseIdleMs');
          expired = next();
          const waiting = idle.execute(first, 'wait', { tabId, selector: '#never', timeout: 700 });
          await new Promise((resolve) => setTimeout(resolve, 500));
          assert.equal(claims(), 1, 'Work in flight keeps the claim');
          await assert.rejects(waiting);
          await expired;
          assert.equal(claims(), 0);
          await idle.execute(first, 'close', { tabId });
        } finally {
          await idle.dispose();
        }
      });
      await t.test('disconnect restores indicators without closing browser tabs', async () => {
        await controller.releaseSession(first.id);
        assert.equal((controller.status().claims as unknown[]).length, 0);
        await controller.dispose();
        assert.equal(browser.isConnected(), true);
      });
    } finally {
      await controller.dispose();
      await browser.close();
    }
  },
);

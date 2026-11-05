// Controller latency per operation against isolated headless Chromium. Tabs are unwatched,
// so results exclude the intentional cursor pacing that watched tabs add.
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';
import { BrowserController } from '../src/browser.js';
import { defaults } from '../src/config.js';

const rows = Array.from(
  { length: 1500 },
  (_, i) =>
    `<tr><td>Row ${i}</td><td><a href="#r${i}">Link ${i}</a></td><td><button>Act ${i}</button></td><td><input aria-label="Field ${i}"></td></tr>`,
).join('');
const pages: Record<string, string> = {
  '/': `<!doctype html><title>Small</title><label>Name <input id="name"></label><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button><p id="result"></p>`,
  '/large': `<!doctype html><title>Large</title><table>${rows}</table>`,
  '/frames': `<!doctype html><title>Frames</title><button>Top</button>${Array.from({ length: 8 }, (_, i) => `<iframe srcdoc="<button>Frame ${i}</button><input>"></iframe>`).join('')}`,
};
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(pages[request.url ?? '/'] ?? pages['/']);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const probe = createNetServer();
await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));
const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${port}`],
});
const controller = new BrowserController(
  { ...defaults, browser: `http://127.0.0.1:${port}` },
  async () => {
    throw new Error('No extension in this benchmark.');
  },
);
const session = { id: 'latency', label: 'Latency', role: 'agent', active: true };
const run = (op: string, args: Record<string, unknown> = {}) =>
  controller.execute(session, op, args);
const results: { operation: string; medianMs: number; p90Ms: number }[] = [];
// A task may return its own duration to exclude setup work.
async function measure(
  operation: string,
  samples: number,
  task: (index: number) => Promise<unknown>,
) {
  for (let index = 0; index < 3; index++) await task(index);
  const times: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    const own = await task(index);
    times.push(typeof own === 'number' ? own : performance.now() - started);
  }
  times.sort((a, b) => a - b);
  results.push({
    operation,
    medianMs: +times[Math.floor(samples / 2)]!.toFixed(2),
    p90Ms: +times[Math.floor(samples * 0.9)]!.toFixed(2),
  });
}
try {
  const opened: string[] = [];
  await measure('open', 8, async () => {
    opened.push(((await run('open', { url })) as { tabId: string }).tabId);
  });
  for (const id of opened.slice(1)) await run('close', { tabId: id });
  const tabId = opened[0]!;
  const tab = (args: Record<string, unknown> = {}) => ({ tabId, ...args });
  await measure('evaluate', 40, () => run('evaluate', tab({ expression: 'document.title' })));
  await measure('snapshot', 40, () => run('snapshot', tab()));
  await measure('click by selector', 30, () =>
    run('act', tab({ action: 'click', selector: '#save' })),
  );
  await measure('click by ref', 30, async () => {
    const snapshot = (await run('snapshot', tab())) as {
      frames: { elements: { ref: string; name: string }[] }[];
    };
    const ref = snapshot.frames[0]!.elements.find((element) => element.name === 'Save')!.ref;
    const started = performance.now();
    await run('act', tab({ action: 'click', ref }));
    return performance.now() - started;
  });
  await measure('fill', 30, () =>
    run('act', tab({ action: 'fill', selector: '#name', text: 'hello' })),
  );
  await measure('move to new point', 30, (index) =>
    run('act', tab({ action: 'move', x: 100 + (index % 8) * 10, y: 100 })),
  );
  await measure('key', 30, () => run('key', tab({ key: 'Shift' })));
  await measure('fill, click and read batch', 20, () =>
    run(
      'batch',
      tab({
        actions: [
          { op: 'act', args: { action: 'fill', selector: '#name', text: 'works' } },
          { op: 'act', args: { action: 'click', selector: '#save' } },
          { op: 'evaluate', args: { expression: 'document.querySelector("#result").textContent' } },
        ],
      }),
    ),
  );
  await measure('screenshot', 15, () => run('screenshot', tab()));
  await measure('tabs', 30, () => run('tabs'));
  await measure('release and claim', 20, async () => {
    await run('release', tab());
    await run('claim', tab());
  });
  await run('navigate', tab({ url: `${url}/large` }));
  await measure('snapshot, 200 of 6000 elements', 20, () => run('snapshot', tab()));
  await measure('snapshot, 1000 of 6000 elements', 15, () =>
    run('snapshot', tab({ limit: 1000, maxText: 100000 })),
  );
  await measure('click deep in a large page', 20, () =>
    run('act', tab({ action: 'click', selector: 'tr:nth-child(1400) button' })),
  );
  await run('navigate', tab({ url: `${url}/frames` }));
  await measure('snapshot, 9 frames', 20, () => run('snapshot', tab()));
  await measure('navigate', 15, () => run('navigate', tab({ url })));
} finally {
  await controller.dispose();
  await browser.close();
  server.close();
}
console.table(results);

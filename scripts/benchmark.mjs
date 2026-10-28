import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { connectController } from '../dist/client.js';

const fixture = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    '<!doctype html><html><head><title>Browser Bridge verification</title></head><body style="font:18px/1.5 system-ui;padding:40px"><h1>Browser Bridge verification</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><p id="result"></p></body></html>',
  );
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const client = await connectController('Bridge verification');
let tabId;
try {
  const opened = await client.call('open', { url: `http://127.0.0.1:${fixture.address().port}` });
  tabId = opened.tabId;
  const samples = { evaluate: [], snapshot: [] };
  for (let index = 0; index < 12; index++) {
    for (const op of Object.keys(samples)) {
      const started = performance.now();
      await client.call(op, {
        tabId,
        ...(op === 'evaluate' ? { expression: 'document.title' } : {}),
      });
      if (index >= 2) samples[op].push(performance.now() - started);
    }
  }
  const started = performance.now();
  const results = await client.call('batch', {
    tabId,
    actions: [
      { op: 'act', args: { action: 'fill', selector: '#name', text: 'Browser Bridge works' } },
      { op: 'act', args: { action: 'click', selector: '#save' } },
      { op: 'evaluate', args: { expression: 'document.querySelector("#result").textContent' } },
    ],
  });
  const batchMs = performance.now() - started;
  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  assert.equal(results[2].result, 'Browser Bridge works');
  await mkdir('artifacts', { recursive: true });
  await client.call('screenshot', {
    tabId,
    path: new URL('../artifacts/live-edge-verification.png', import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      '$1',
    ),
  });
  const summary = Object.fromEntries(
    Object.entries(samples).map(([op, values]) => {
      values.sort((a, b) => a - b);
      return [
        op,
        {
          medianMs: +values[Math.floor(values.length / 2)].toFixed(2),
          p95Ms: +values.at(-1).toFixed(2),
          samples: values.length,
        },
      ];
    }),
  );
  const report = {
    time: new Date().toISOString(),
    node: process.version,
    ...summary,
    fillClickReadBatchMs: +batchMs.toFixed(2),
    verified: true,
  };
  await writeFile('artifacts/benchmark.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (tabId) await client.call('close', { tabId }).catch(() => undefined);
  client.close();
  fixture.close();
}

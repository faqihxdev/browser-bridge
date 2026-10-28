import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/config.js';
import { NativeDecoder, encodeNative } from '../src/native.js';
import { parseActivePort } from '../src/endpoint.js';

test('a failed action does not poison the ordered queue', async () => {
  const queue = new Queue(); const order: number[] = [];
  const failed = queue.run(async () => { order.push(1); throw new Error('expected'); });
  const next = queue.run(async () => { order.push(2); return 7; });
  await assert.rejects(failed, /expected/); assert.equal(await next, 7); assert.deepEqual(order, [1, 2]);
});
test('native messaging handles split UTF-8 frames and coalesced messages', () => {
  const decoder = new NativeDecoder();
  const packet = encodeNative({ text: '東京 🧭', id: '1' });
  assert.deepEqual(decoder.push(packet.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(packet.subarray(2, 9)), []);
  assert.deepEqual(decoder.push(Buffer.concat([packet.subarray(9), encodeNative({ id: '2' })])), [{ text: '東京 🧭', id: '1' }, { id: '2' }]);
});
test('native messaging refuses excessive length before buffering the body', () => {
  const header = Buffer.alloc(4); header.writeUInt32LE(9 * 1024 * 1024);
  assert.throws(() => new NativeDecoder().push(header), /exceeds/);
});
test('endpoint discovery preserves legacy browser target IDs and supports modern consent endpoints', () => {
  assert.equal(parseActivePort('9222\r\n/devtools/browser/abc-123\r\n'), 'ws://127.0.0.1:9222/devtools/browser/abc-123');
  assert.equal(parseActivePort('54321\n/devtools/browser'), 'ws://127.0.0.1:54321/devtools/browser');
  assert.throws(() => parseActivePort('0\n/devtools/browser'));
  assert.throws(() => parseActivePort('9222\nhttps://elsewhere/'));
});

import { randomUUID } from 'node:crypto';
import { connectController } from './client.js';
import { message } from './config.js';
import type { Data, Packet } from './wire.js';

export function encodeNative(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1024 * 1024)
    throw new Error('Native response exceeds 1 MiB. Request a smaller result.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export class NativeDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): Data[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Data[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) throw new Error('Native request exceeds 8 MiB.');
      if (this.buffer.length < length + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }
}
export async function runNative(): Promise<void> {
  const client = await connectController('Browser Bridge extension', 'extension');
  const write = (value: unknown) => {
    process.stdout.write(encodeNative(value));
  };
  client.wire.on('packet', (packet: Packet) => {
    if (packet.event) write(packet);
  });
  client.wire.on('closed', () => process.exit(0));
  const decoder = new NativeDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const input of decoder.push(chunk)) {
        const id = String(input.id ?? randomUUID());
        void client.call(String(input.op), (input.args ?? {}) as Data).then(
          (result) => {
            try {
              write({ id, result });
            } catch (error) {
              write({ id, error: message(error) });
            }
          },
          (error) => write({ id, error: message(error) }),
        );
      }
    } catch (error) {
      console.error(message(error));
      client.close();
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });
  process.stdin.once('end', () => client.close());
  write({ event: 'ready' });
}

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

export type Data = Record<string, unknown>;
export interface Packet {
  id?: string;
  op?: string;
  args?: Data;
  result?: unknown;
  error?: string;
  event?: string;
  token?: string;
  label?: string;
  role?: string;
}
export const MAX_MESSAGE = 16 * 1024 * 1024;
export class Wire extends EventEmitter {
  private buffer = '';
  constructor(readonly socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (part: string) => {
      this.buffer += part;
      if (Buffer.byteLength(this.buffer) > MAX_MESSAGE)
        return socket.destroy(new Error('Message exceeds 16 MiB.'));
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        try {
          const packet: unknown = JSON.parse(line);
          if (!packet || typeof packet !== 'object' || Array.isArray(packet))
            throw new Error('Expected an object.');
          this.emit('packet', packet);
        } catch {
          socket.destroy(new Error('Invalid JSON message.'));
          return;
        }
      }
    });
    socket.on('error', (error) => this.emit('failure', error));
    socket.on('close', () => this.emit('closed'));
  }
  send(packet: Packet): void {
    const line = JSON.stringify(packet) + '\n';
    if (Buffer.byteLength(line) > MAX_MESSAGE)
      throw new Error('Response exceeds 16 MiB. Request a smaller result.');
    if (!this.socket.destroyed) this.socket.write(line);
  }
}

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { credential, deadline, pipe } from './config.js';
import { Wire, type Data, type Packet } from './wire.js';

export class Client {
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  constructor(readonly wire: Wire) {
    wire.on('packet', (packet: Packet) => {
      const request = packet.id && this.pending.get(packet.id);
      if (!request) return;
      this.pending.delete(packet.id!);
      if (packet.error) request.reject(new Error(packet.error));
      else request.resolve(packet.result);
    });
    const fail = () => {
      for (const request of this.pending.values())
        request.reject(new Error('Controller disconnected.'));
      this.pending.clear();
    };
    wire.on('closed', fail);
    wire.on('failure', fail);
  }
  async call(op: string, args: Data = {}, timeout = 90_000): Promise<unknown> {
    if (this.wire.socket.destroyed) throw new Error('Controller disconnected.');
    const id = randomUUID();
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.wire.send({ id, op, args });
    });
    try {
      return await deadline(result, timeout, op);
    } finally {
      this.pending.delete(id);
    }
  }
  close(): void {
    this.wire.socket.end();
  }
}
async function dial(): Promise<Wire> {
  const socket = connect(pipe);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return new Wire(socket);
}
export async function connectController(
  label: string,
  role = 'agent',
  autoStart = true,
): Promise<Client> {
  const token = await credential();
  let wire: Wire;
  try {
    wire = await dial();
  } catch (error) {
    if (!autoStart) throw error;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.js', import.meta.url)), 'daemon'],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      },
    );
    child.unref();
    const started = Date.now();
    while (true) {
      try {
        wire = await dial();
        break;
      } catch {
        if (Date.now() - started > 12_000)
          throw new Error(
            'Controller did not start. Run browser-bridge daemon to inspect the error.',
          );
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  const client = new Client(wire);
  try {
    await client.call('hello', { token, label, role }, 5_000);
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}

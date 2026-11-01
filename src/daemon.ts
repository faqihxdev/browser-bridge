import { createServer } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credential, deadline, home, loadConfig, message, pipe } from './config.js';
import { Wire, type Packet } from './wire.js';
import { BrowserManager } from './manager.js';
import { maintainJumpLists } from './jumplist.js';

export async function runDaemon(): Promise<void> {
  const config = await loadConfig();
  const token = await credential();
  const lock = join(home, 'daemon.lock');
  try {
    const handle = await open(lock, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      pid = Number(await readFile(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error(
          'Controller startup lock is incomplete. Retry after the starting process exits.',
        );
    }
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await unlink(lock);
      return runDaemon();
    }
  }
  if (process.platform !== 'win32') await unlink(pipe).catch(() => undefined);
  const peers = new Set<Wire>();
  const extensions = new Set<Wire>();
  const extensionRequests = new Map<
    string,
    { wire: Wire; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const sessions = new Map<string, Wire>();
  const controller = new BrowserManager(config, async (connectionId, args) => {
    const sessionId = controller.extensionSession(connectionId);
    const extension = sessionId && sessions.get(sessionId);
    if (!extension)
      throw new Error(
        'The selected browser extension disconnected. Reload Browser Bridge in that browser.',
      );
    const id = randomUUID();
    try {
      return await deadline(
        new Promise((resolve, reject) => {
          extensionRequests.set(id, { wire: extension, resolve, reject });
          extension.send({ id, event: 'browser-api', args });
        }),
        30_000,
        'Browser API',
      );
    } finally {
      extensionRequests.delete(id);
    }
  });
  let active = 0;
  let lastActivity = Date.now();
  let closing = false;
  let jumpLists: Promise<() => Promise<void>> = Promise.resolve(async () => {});
  const states = new Map<Wire, string>();
  const broadcast = async () => {
    for (const [sessionId, extension] of sessions) {
      if (!extensions.has(extension)) continue;
      const state = await controller.status({
        id: sessionId,
        label: 'Extension',
        role: 'extension',
        active: true,
      });
      const encoded = JSON.stringify(state);
      if (encoded === states.get(extension)) continue;
      states.set(extension, encoded);
      extension.send({ event: 'state', args: state });
    }
  };
  const server = createServer((socket) => {
    const wire = new Wire(socket);
    const session = { id: randomUUID(), label: 'Agent', role: 'agent', active: true };
    let authenticated = false;
    const authTimer = setTimeout(() => socket.destroy(), 5_000);
    wire.on('failure', () => undefined);
    wire.on('closed', () => {
      clearTimeout(authTimer);
      session.active = false;
      peers.delete(wire);
      extensions.delete(wire);
      sessions.delete(session.id);
      states.delete(wire);
      lastActivity = Date.now();
      for (const [id, request] of extensionRequests)
        if (request.wire === wire) {
          request.reject(new Error('Extension disconnected.'));
          extensionRequests.delete(id);
        }
      void controller
        .releaseSession(session.id)
        .then(broadcast)
        .catch((error) => console.error(message(error)));
    });
    wire.on('packet', async (packet: Packet) => {
      if (!packet.id || typeof packet.id !== 'string') return socket.destroy();
      try {
        if (!authenticated) {
          const supplied = packet.args?.token;
          if (
            packet.op !== 'hello' ||
            typeof supplied !== 'string' ||
            supplied.length !== token.length ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(supplied))
          )
            throw new Error('Authentication failed.');
          authenticated = true;
          clearTimeout(authTimer);
          peers.add(wire);
          sessions.set(session.id, wire);
          session.label = String(packet.args?.label ?? 'Agent').slice(0, 80);
          session.role = packet.args?.role === 'extension' ? 'extension' : 'agent';
          if (session.role === 'extension') extensions.add(wire);
          wire.send({
            id: packet.id,
            result: { sessionId: session.id, pid: process.pid, version: '0.1.0' },
          });
          return;
        }
        if (packet.op === 'extension-result') {
          const requestId = String(packet.args?.requestId);
          const request = extensionRequests.get(requestId);
          if (session.role !== 'extension' || request?.wire !== wire)
            throw new Error('Unknown extension request.');
          if (packet.args?.error) request.reject(new Error(String(packet.args.error)));
          else request.resolve(packet.args?.result);
          wire.send({ id: packet.id, result: true });
          return;
        }
        if (packet.op === 'shutdown') {
          wire.send({ id: packet.id, result: { stopping: true } });
          void shutdown();
          return;
        }
        active++;
        lastActivity = Date.now();
        try {
          const result =
            packet.op === 'status'
              ? {
                  pid: process.pid,
                  clients: peers.size - extensions.size,
                  extensionConnected: extensions.size > 0,
                  ...(await controller.status(session)),
                }
              : await controller.execute(session, packet.op ?? '', packet.args ?? {});
          wire.send({ id: packet.id, result });
        } finally {
          active--;
          lastActivity = Date.now();
          await broadcast();
        }
      } catch (error) {
        wire.send({ id: packet.id, error: message(error) });
        if (!authenticated) socket.end();
      }
    });
  });
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(idle);
    const closeJumpLists = await jumpLists;
    await closeJumpLists();
    await controller.dispose();
    for (const peer of peers) peer.socket.destroy();
    server.close();
    if ((await readFile(lock, 'utf8').catch(() => '')) === String(process.pid))
      await unlink(lock).catch(() => undefined);
    await unlink(join(home, 'daemon.json')).catch(() => undefined);
  };
  const idle = setInterval(
    () => {
      if (peers.size === 0 && !active && Date.now() - lastActivity > config.idleMs) void shutdown();
    },
    Math.min(config.idleMs, 30_000),
  );
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, resolve);
    });
    await writeFile(
      join(home, 'daemon.json'),
      JSON.stringify({ pid: process.pid, pipe, started: new Date().toISOString() }),
      { mode: 0o600 },
    );
    console.error(`Browser Bridge listening on ${pipe}`);
    jumpLists = maintainJumpLists(config.browsers);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deadline, Queue } from './config.js';
import type { Data } from './wire.js';

export class Desktop {
  private child?: ChildProcessWithoutNullStreams;
  private queue = new Queue();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private start(): void {
    if (this.child) return;
    if (process.platform !== 'win32') throw new Error('Native desktop control requires Windows.');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../native/desktop.ps1', import.meta.url))], { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const reply = JSON.parse(line);
        const request = this.pending.get(reply.id);
        if (!request) return;
        this.pending.delete(reply.id);
        if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.result);
      } catch { /* PowerShell startup diagnostics are not protocol messages. */ }
    });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    const fail = () => {
      this.child = undefined;
      for (const request of this.pending.values()) request.reject(new Error('Windows helper disconnected.'));
      this.pending.clear();
    };
    child.once('exit', fail); child.once('error', fail);
  }
  call(args: Data): Promise<unknown> {
    return this.queue.run(async () => {
      this.start(); const id = randomUUID();
      try {
        return await deadline(new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject }); this.child!.stdin.write(JSON.stringify({ id, ...args }) + '\n');
        }), 20_000, 'Windows UI Automation');
      } catch (error) { this.close(); throw error; }
      finally { this.pending.delete(id); }
    });
  }
  close(): void { this.child?.kill(); this.child = undefined; }
}

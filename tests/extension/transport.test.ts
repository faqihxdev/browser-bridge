import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright-core';
import { ExtensionTransport } from '../../src/extension-transport.js';

test(
  'extension CDP controls trusted input, raw sessions and reconnects without a browser port',
  { timeout: 40000 },
  async (t) => {
    const runtime = await mkdtemp(join(tmpdir(), 'browser-bridge-transport-'));
    const extension = join(runtime, 'extension');
    await mkdir(extension);
    let transport: ExtensionTransport;
    let nextId = 0;
    const commands: object[] = [],
      waiting: ServerResponse[] = [];
    const pending = new Map<
      number,
      { resolve: (result: any) => void; reject: (error: Error) => void }
    >();
    const trace: string[] = [];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/command') {
        const command = commands.shift();
        if (command) res.end(JSON.stringify(command));
        else {
          waiting.push(res);
          res.on('close', () => {
            const i = waiting.indexOf(res);
            if (i >= 0) waiting.splice(i, 1);
          });
        }
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (req.url === '/event') transport?.event(data);
        if (req.url === '/ready') ready();
        if (req.url === '/result') {
          const request = pending.get(data.id);
          pending.delete(data.id);
          data.error ? request?.reject(new Error(data.error)) : request?.resolve(data.result);
        }
        res.end('{}');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<title>Extension transport fixture</title><input id="name"><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value;globalThis.trusted=event.isTrusted">Save</button><p id="result"></p>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/';
    const background = [
      'const url=' + JSON.stringify(url),
      "const post=(path,data)=>fetch(url+path,{method:'POST',body:JSON.stringify(data)})",
      "chrome.debugger.onEvent.addListener((source,method,params)=>void post('event',{name:'event',source,method,params}))",
      "chrome.debugger.onDetach.addListener((source,reason)=>void post('event',{name:'detached',source,reason}))",
      "chrome.tabs.onCreated.addListener(tab=>void post('event',{name:'tab-created',tab}))",
      "chrome.tabs.onRemoved.addListener(tabId=>void post('event',{name:'tab-removed',source:{tabId}}))",
      "void(async()=>{await post('ready',{});while(true){const packet=await(await fetch(url+'command')).json();void(async()=>{try{await post('result',{id:packet.id,result:await chrome[packet.namespace][packet.method](...packet.args)})}catch(error){await post('result',{id:packet.id,error:error.message})}})()}})()",
    ].join(';');
    await writeFile(
      join(extension, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Transport verification',
        version: '1.0',
        permissions: ['debugger', 'tabs'],
        host_permissions: [url + '*'],
        background: { service_worker: 'background.js' },
      }),
    );
    await writeFile(join(extension, 'background.js'), background);
    const child = spawn(
      chromium.executablePath(),
      [
        '--headless=new',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--user-data-dir=' + join(runtime, 'profile'),
        '--disable-extensions-except=' + extension,
        '--load-extension=' + extension,
        url,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    let browser: Browser | undefined;
    t.after(async () => {
      await Promise.race([
        browser?.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (child.pid) {
        if (process.platform === 'win32')
          await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
          }).catch(() => undefined);
        else child.kill('SIGKILL');
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Extension did not start')), 10000),
      ),
    ]);
    const invoke = (namespace: string, method: string, args: unknown[] = []) => {
      trace.push(namespace + '.' + method + (method === 'sendCommand' ? ':' + args[1] : ''));
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      const command = { id, namespace, method, args };
      const response = waiting.shift();
      if (response) response.end(JSON.stringify(command));
      else commands.push(command);
      return promise;
    };
    const connect = async () => {
      transport = new ExtensionTransport(invoke);
      return chromium.connectOverCDP(transport, { noDefaults: true, timeout: 12000 });
    };
    try {
      browser = await connect();
      const page = browser
        .contexts()[0]!
        .pages()
        .find((page) => page.url() === url)!;
      assert.ok(page);
      await page.locator('#name').fill('Native extension path');
      await page.getByRole('button', { name: 'Save' }).click();
      assert.equal(await page.locator('#result').textContent(), 'Native extension path');
      assert.equal(await page.evaluate('globalThis.trusted'), true);
      const session = await page.context().newCDPSession(page);
      assert.equal(
        (await session.send('Runtime.evaluate', { expression: '6*7', returnByValue: true })).result
          .value,
        42,
      );
      await session.detach();
      assert.equal(await page.title(), 'Extension transport fixture');
      assert.equal((await page.screenshot()).subarray(1, 4).toString(), 'PNG');
      const root = await browser.newBrowserCDPSession();
      assert.ok(
        (await root.send('Target.getTargets')).targetInfos.some((target) => target.url === url),
      );
      await root.detach();
      await browser.close();
      browser = await connect();
      const reconnected = browser
        .contexts()[0]!
        .pages()
        .find((page) => page.url() === url)!;
      assert.equal(await reconnected.locator('#result').textContent(), 'Native extension path');
      await reconnected.locator('#name').fill('Reconnected');
      await reconnected.getByRole('button', { name: 'Save' }).click();
      assert.equal(await reconnected.locator('#result').textContent(), 'Reconnected');
    } catch (error) {
      t.diagnostic(trace.slice(-20).join('\n'));
      throw error;
    }
  },
);

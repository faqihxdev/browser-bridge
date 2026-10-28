import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Frame,
  type ElementHandle,
  type Request,
} from 'playwright-core';
import { Queue, deadline, home, message, type Config } from './config.js';
import type { Data } from './wire.js';
import { Desktop } from './desktop.js';
import { resolveEndpoint } from './endpoint.js';
import { extensionOrigin } from './extension-identity.js';

export interface Session {
  id: string;
  label: string;
  role: string;
  active: boolean;
}
interface Tab {
  id: string;
  page: Page;
  cdp: CDPSession;
  queue: Queue;
  owner?: Session;
  generation: number;
  refs: Map<string, Frame>;
  console: Data[];
  network: { index: number; request: Request }[];
  requestSequence: number;
  dialog?: import('playwright-core').Dialog;
  pointer?: { x: number; y: number };
}
const helper = readFile(new URL('../assets/page-helper.js', import.meta.url), 'utf8');
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a nonempty string.`);
  return value;
};
const number = (value: unknown, fallback: number): number =>
  value === undefined ? fallback : Number(value);

export class BrowserController {
  connectionVersion = 0;
  private browser?: Browser;
  private connecting?: Promise<Browser>;
  private context?: BrowserContext;
  private tabs = new Map<string, Tab>();
  private attaching = new Map<Page, Promise<Tab>>();
  private global = new Queue();
  private favicons = new Map<string, Promise<string | undefined>>();
  private desktop = new Desktop();
  constructor(
    private config: Config,
    private extension: (args: Data) => Promise<unknown>,
  ) {}
  status(): Data {
    return {
      browser: this.config.browser,
      connected: this.browser?.isConnected() ?? false,
      claims: [...this.tabs.values()]
        .filter((tab) => tab.owner)
        .map((tab) => ({ tabId: tab.id, agent: tab.owner!.label, url: tab.page.url() })),
    };
  }
  private async connect(): Promise<Browser> {
    if (this.connecting) return this.connecting;
    if (this.browser?.isConnected()) return this.browser;
    this.connecting = (async () => {
      const browser = await chromium.connectOverCDP(await resolveEndpoint(this.config.browser), {
        timeout: this.config.connectTimeoutMs ?? 60_000,
        noDefaults: true,
      });
      this.browser = browser;
      this.connectionVersion++;
      this.context = browser.contexts()[0];
      if (!this.context) throw new Error('Browser has no default context.');
      this.context.setDefaultTimeout(this.config.actionTimeoutMs);
      this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      await this.context.addInitScript({ content: await helper });
      browser.on('disconnected', () => {
        this.tabs.clear();
        this.attaching.clear();
        this.browser = undefined;
        this.context = undefined;
      });
      return browser;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  async extensionConnections(): Promise<string[]> {
    await this.connect();
    const origin = await extensionOrigin;
    const workers = this.context!.serviceWorkers().filter(
      (worker) => worker.url() === `${origin}background.js`,
    );
    const results = await Promise.allSettled(
      workers.map((worker) =>
        deadline(
          worker.evaluate('globalThis.__browserBridgeConnectionId ?? null'),
          2000,
          'Extension identity',
        ),
      ),
    );
    return results.flatMap((result) =>
      result.status === 'fulfilled' && typeof result.value === 'string' ? [result.value] : [],
    );
  }
  private async attach(page: Page): Promise<Tab> {
    for (const tab of this.tabs.values()) if (tab.page === page) return tab;
    const existing = this.attaching.get(page);
    if (existing) return existing;
    const promise = (async () => {
      const cdp = await this.context!.newCDPSession(page);
      const info = await cdp.send('Target.getTargetInfo');
      const tab: Tab = {
        id: info.targetInfo.targetId,
        page,
        cdp,
        queue: new Queue(),
        generation: 0,
        refs: new Map(),
        console: [],
        network: [],
        requestSequence: 0,
      };
      this.tabs.set(tab.id, tab);
      page.on('close', () => this.tabs.delete(tab.id));
      page.on('console', (entry) => {
        tab.console.push({ level: entry.type(), text: entry.text().slice(0, 6000) });
        if (tab.console.length > 100) tab.console.shift();
      });
      page.on('requestfinished', (request) => {
        tab.network.push({ index: ++tab.requestSequence, request });
        if (tab.network.length > 100) tab.network.shift();
      });
      page.on('dialog', (dialog) => {
        tab.dialog = dialog;
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          tab.refs.clear();
          if (tab.owner) void this.decorate(tab).catch(() => undefined);
        }
      });
      page.on('domcontentloaded', () => {
        if (tab.owner) void this.decorate(tab).catch(() => undefined);
      });
      return tab;
    })();
    this.attaching.set(page, promise);
    try {
      return await promise;
    } finally {
      this.attaching.delete(page);
    }
  }
  private async allTabs(): Promise<Tab[]> {
    await this.connect();
    return (
      await Promise.allSettled(this.context!.pages().map((page) => this.attach(page)))
    ).flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }
  private async tab(id: unknown): Promise<Tab> {
    text(id, 'tabId');
    await this.allTabs();
    const tab = this.tabs.get(id as string);
    if (!tab || tab.page.isClosed()) throw new Error('Tab no longer exists. List tabs again.');
    return tab;
  }
  private ensure(session: Session, tab?: Tab, generation?: number): void {
    if (!session.active) throw new Error('Agent disconnected.');
    if (
      tab &&
      (tab.owner?.id !== session.id || (generation !== undefined && generation !== tab.generation))
    )
      throw new Error('Tab ownership was released or transferred.');
  }
  private async decorate(tab: Tab): Promise<void> {
    const owner = tab.owner;
    if (!owner) return;
    await tab.page.evaluate(await helper);
    if (tab.owner?.id !== owner.id) return;
    const metadata = await tab.page.evaluate(
      ({ label, key, position }) =>
        (
          globalThis as unknown as {
            __browserBridge: {
              claim(
                label: string,
                key: string,
                position?: { x: number; y: number },
              ): {
                documentId: string;
                faviconUrl: string | null;
              };
            };
          }
        ).__browserBridge.claim(label, key, position),
      { label: owner.label, key: owner.id, position: tab.pointer },
    );
    if (!metadata.faviconUrl) return;
    const url = metadata.faviconUrl;
    let data = this.favicons.get(url);
    if (!data) {
      data = (async () => {
        if (url.startsWith('data:image/')) return url;
        if (!/^https?:\/\//.test(url)) return;
        const response = await tab.page.request.get(url, { timeout: 3000, maxRedirects: 4 });
        try {
          const type = response.headers()['content-type']?.split(';')[0];
          if (!response.ok() || !type?.startsWith('image/')) return;
          if (Number(response.headers()['content-length']) > 256 * 1024) return;
          const bytes = await response.body();
          if (bytes.length > 256 * 1024) return;
          return `data:${type};base64,${bytes.toString('base64')}`;
        } finally {
          await response.dispose();
        }
      })().catch(() => undefined);
      this.favicons.set(url, data);
      if (this.favicons.size > 64) this.favicons.delete(this.favicons.keys().next().value!);
    }
    // Icon loading must not block input. Guard the document and owner before applying it.
    void data
      .then(async (data) => {
        if (!data || tab.owner?.id !== owner.id || tab.page.isClosed()) return;
        await tab.page.evaluate(
          ({ data, key, documentId, source }) =>
            (
              globalThis as unknown as {
                __browserBridge?: {
                  setIcon(data: string, key: string, documentId: string, source: string): void;
                };
              }
            ).__browserBridge?.setIcon(data, key, documentId, source),
          { data, key: owner.id, documentId: metadata.documentId, source: url },
        );
      })
      .catch(() => undefined);
  }
  private async claim(session: Session, tab: Tab): Promise<number> {
    this.ensure(session);
    if (tab.owner && tab.owner.id !== session.id)
      throw new Error(
        `Tab is controlled by ${tab.owner.label}. Release it from that agent or the extension first.`,
      );
    if (!tab.owner) {
      tab.owner = session;
      tab.generation++;
      await tab.cdp
        .send('Emulation.setFocusEmulationEnabled', { enabled: true })
        .catch(() => undefined);
      this.ensure(session, tab);
      await this.decorate(tab).catch(() => undefined);
    }
    return tab.generation;
  }
  async releaseSession(id: string): Promise<void> {
    await Promise.all(
      [...this.tabs.values()].filter((tab) => tab.owner?.id === id).map((tab) => this.release(tab)),
    );
  }
  private async release(tab: Tab): Promise<void> {
    const owner = tab.owner;
    tab.owner = undefined;
    tab.generation++;
    const generation = tab.generation;
    await deadline(
      tab.page.evaluate(
        (key) =>
          (
            globalThis as unknown as {
              __browserBridge?: { release(key: string | undefined): void };
            }
          ).__browserBridge?.release(key),
        owner?.id,
      ),
      2000,
      'Indicator cleanup',
    ).catch(() => undefined);
    if (tab.generation === generation && !tab.owner)
      await tab.cdp
        .send('Emulation.setFocusEmulationEnabled', { enabled: false })
        .catch(() => undefined);
  }
  private async move(tab: Tab, x: number, y: number, click = false): Promise<void> {
    tab.pointer = { x, y };
    await tab.page
      .evaluate(
        ({ x, y, click }) =>
          (
            globalThis as unknown as {
              __browserBridge?: { move(x: number, y: number, click: boolean): void };
            }
          ).__browserBridge?.move(x, y, click),
        { x, y, click },
      )
      .catch(() => undefined);
  }
  private async element(tab: Tab, args: Data): Promise<ElementHandle<HTMLElement | SVGElement>> {
    if (args.ref) {
      const ref = text(args.ref, 'ref');
      const frame = tab.refs.get(ref);
      if (!frame || frame.isDetached()) throw new Error('Stale reference. Take a new snapshot.');
      const handle = await frame.evaluateHandle(
        (ref) =>
          (
            globalThis as unknown as { __browserBridge?: { resolve(ref: string): Element | null } }
          ).__browserBridge?.resolve(ref),
        ref,
      );
      const element = handle.asElement();
      if (!element || !(await element.evaluate((element) => element.isConnected))) {
        await handle.dispose();
        throw new Error('Stale reference. Take a new snapshot.');
      }
      return element as ElementHandle<HTMLElement | SVGElement>;
    }
    const frame = args.frameUrl
      ? tab.page.frames().find((frame) => frame.url() === args.frameUrl)
      : tab.page.mainFrame();
    if (!frame) throw new Error('Frame not found.');
    const locator = frame.locator(text(args.selector, 'selector'));
    const handle = await locator.elementHandle({ timeout: this.config.actionTimeoutMs });
    if (!handle) throw new Error('Element not found.');
    return handle;
  }
  async execute(session: Session, op: string, args: Data): Promise<unknown> {
    this.ensure(session);
    if (op === 'batch') {
      const actions = args.actions;
      if (!Array.isArray(actions) || actions.length > 100)
        throw new Error('actions must be an array with at most 100 entries.');
      const results: unknown[] = [];
      const epochs = new Map<string, number>();
      for (const action of actions) {
        if (!action || typeof action !== 'object' || action.op === 'batch')
          throw new Error('Invalid batch action.');
        try {
          const actionArgs = { ...(args.tabId ? { tabId: args.tabId } : {}), ...action.args };
          const tabId = actionArgs.tabId;
          if (tabId && action.op !== 'release') {
            const target = await this.tab(tabId);
            if (epochs.has(tabId)) this.ensure(session, target, epochs.get(tabId));
            else epochs.set(tabId, await this.claim(session, target));
          }
          results.push({ ok: true, result: await this.execute(session, action.op, actionArgs) });
          if (tabId && action.op === 'release') epochs.delete(tabId);
          else if (tabId && this.tabs.get(tabId)?.owner?.id === session.id)
            epochs.set(tabId, this.tabs.get(tabId)!.generation);
        } catch (error) {
          results.push({ ok: false, error: message(error) });
          break;
        }
      }
      return results;
    }
    if (op === 'api')
      return this.global.run(async () => {
        this.ensure(session);
        return this.extension(args);
      });
    if (op === 'desktop')
      return this.global.run(async () => {
        this.ensure(session);
        return this.desktop.call(args);
      });
    if (op === 'tabs')
      return Promise.all(
        (await this.allTabs()).map(async (tab) => ({
          tabId: tab.id,
          url: tab.page.url(),
          title: await deadline(tab.page.title(), 2000, 'Title').catch(() => ''),
          agent: tab.owner?.label ?? null,
        })),
      );
    if (op === 'open')
      return this.global.run(async () => {
        await this.connect();
        this.ensure(session);
        const root = await this.browser!.newBrowserCDPSession();
        try {
          const { targetId } = await root.send('Target.createTarget', {
            url: 'about:blank',
            background: args.focus !== true,
          });
          let tab: Tab | undefined;
          for (let attempt = 0; attempt < 60; attempt++) {
            tab = (await this.allTabs()).find((tab) => tab.id === targetId);
            if (tab) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          if (!tab) throw new Error('New tab did not appear.');
          await this.claim(session, tab);
          if (args.url)
            await tab.page.goto(text(args.url, 'url'), { waitUntil: 'domcontentloaded' });
          if (args.focus === true) await tab.page.bringToFront();
          return { tabId: tab.id, url: tab.page.url() };
        } finally {
          await root.detach();
        }
      });
    if (op === 'cdp' && !args.tabId)
      return this.global.run(async () => {
        await this.connect();
        this.ensure(session);
        const root = await this.browser!.newBrowserCDPSession();
        try {
          return await deadline(
            root.send(text(args.method, 'method') as never, (args.params ?? {}) as never),
            30_000,
            'CDP command',
          );
        } finally {
          await root.detach().catch(() => undefined);
        }
      });
    const tab = await this.tab(args.tabId);
    if (op === 'release') {
      if (tab.owner?.id !== session.id && session.role !== 'extension')
        throw new Error('Only the owning agent or the extension can release this tab.');
      await this.release(tab);
      return { released: tab.id };
    }
    if (op === 'dialog') {
      await this.claim(session, tab);
      this.ensure(session, tab);
      if (!tab.dialog) throw new Error('No pending dialog.');
      const dialog = tab.dialog;
      if (args.accept === undefined)
        return {
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
        };
      tab.dialog = undefined;
      if (args.accept === false) await dialog.dismiss();
      else await dialog.accept(String(args.text ?? ''));
      return { handled: dialog.type() };
    }
    const admitted = tab.generation;
    return tab.queue.run(async () => {
      if (
        tab.generation !== admitted &&
        !(tab.owner?.id === session.id && tab.generation === admitted + 1)
      )
        throw new Error('Tab was released while this operation was queued.');
      const generation = await this.claim(session, tab);
      this.ensure(session, tab, generation);
      const page = tab.page;
      if (op === 'claim') return { tabId: tab.id, agent: session.label };
      if (op === 'navigate') {
        await page.goto(text(args.url, 'url'), { waitUntil: 'domcontentloaded' });
        tab.refs.clear();
        this.ensure(session, tab, generation);
        await this.decorate(tab).catch(() => undefined);
        return { url: page.url() };
      }
      if (op === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return { url: page.url() };
      }
      if (op === 'reload') {
        await page.reload({ waitUntil: 'domcontentloaded' });
        return { url: page.url() };
      }
      if (op === 'close') {
        await page.close();
        return { closed: tab.id };
      }
      if (op === 'focus') {
        await page.bringToFront();
        return { focused: tab.id };
      }
      if (op === 'snapshot') {
        const frames: unknown[] = [];
        tab.refs.clear();
        for (const frame of page.frames()) {
          try {
            await frame.evaluate(await helper);
            const snapshot = await frame.evaluate(
              ({ limit, maxText }) =>
                (
                  globalThis as unknown as {
                    __browserBridge: {
                      snapshot(limit: number, maxText: number): { elements: { ref: string }[] };
                    };
                  }
                ).__browserBridge.snapshot(limit, maxText),
              {
                limit: Math.min(1000, Math.max(1, number(args.limit, 200))),
                maxText: Math.min(100000, Math.max(0, number(args.maxText, 12000))),
              },
            );
            for (const element of snapshot.elements) tab.refs.set(element.ref, frame);
            frames.push({ frameUrl: frame.url(), ...snapshot });
          } catch (error) {
            frames.push({ frameUrl: frame.url(), error: message(error) });
          }
        }
        if (frames.length && frames.every((frame) => 'error' in (frame as Data)))
          throw new Error(`Cannot snapshot this page: ${(frames[0] as Data).error}`);
        return { tabId: tab.id, frames };
      }
      if (op === 'evaluate')
        return deadline(
          page.evaluate(text(args.expression, 'expression')),
          this.config.navigationTimeoutMs,
          'Page evaluation',
        );
      if (op === 'cdp')
        return deadline(
          tab.cdp.send(text(args.method, 'method') as never, (args.params ?? {}) as never),
          30_000,
          'CDP command',
        );
      if (op === 'console') return tab.console;
      if (op === 'network') {
        if (args.index === undefined)
          return tab.network.map(({ index, request }) => ({
            index,
            method: request.method(),
            url: request.url(),
            type: request.resourceType(),
          }));
        const request = tab.network.find((entry) => entry.index === args.index)?.request;
        if (!request) throw new Error('Network entry expired. List recent requests again.');
        const response = await request.response();
        const body = response
          ? await response.body().catch(() => Buffer.alloc(0))
          : Buffer.alloc(0);
        return {
          url: request.url(),
          method: request.method(),
          requestHeaders: await request.allHeaders(),
          requestBody: request.postData(),
          status: response?.status(),
          responseHeaders: response ? await response.allHeaders() : {},
          responseBody: body.subarray(0, 1_000_000).toString('utf8'),
          truncated: body.length > 1_000_000,
        };
      }
      if (op === 'cookies') {
        if (args.action === 'set') {
          if (!Array.isArray(args.cookies)) throw new Error('cookies must be an array.');
          await this.context!.addCookies(args.cookies);
          return true;
        }
        if (args.action === 'clear') {
          await this.context!.clearCookies({ domain: new URL(page.url()).hostname });
          return true;
        }
        return this.context!.cookies(page.url());
      }
      if (op === 'screenshot' || op === 'pdf') {
        if (!args.includeCursor)
          await page.evaluate('globalThis.__browserBridge?.hide(true)').catch(() => undefined);
        try {
          const buffer =
            op === 'pdf'
              ? await page.pdf({ printBackground: true })
              : await page.screenshot({
                  fullPage: args.fullPage === true,
                  type: 'png',
                  timeout: 10_000,
                });
          if (args.path) {
            const path = resolve(text(args.path, 'path'));
            await writeFile(path, buffer);
            return { path, bytes: buffer.length };
          }
          if (op === 'pdf') {
            const path = join(home, 'output', `page-${Date.now()}.pdf`);
            await mkdir(join(home, 'output'), { recursive: true });
            await writeFile(path, buffer);
            return { path, bytes: buffer.length };
          }
          return { mimeType: 'image/png', data: buffer.toString('base64') };
        } finally {
          await page.evaluate('globalThis.__browserBridge?.hide(false)').catch(() => undefined);
        }
      }
      if (op === 'key') {
        await page.keyboard.press(text(args.key, 'key'));
        return true;
      }
      if (op === 'scroll') {
        await page.mouse.wheel(number(args.deltaX, 0), number(args.deltaY, 600));
        return true;
      }
      if (op === 'wait') {
        if (args.selector)
          await page.locator(text(args.selector, 'selector')).waitFor({
            state: args.state as 'visible' | undefined,
            timeout: number(args.timeout, this.config.navigationTimeoutMs),
          });
        else if (args.url)
          await page.waitForURL(text(args.url, 'url'), {
            timeout: number(args.timeout, this.config.navigationTimeoutMs),
          });
        else throw new Error('Provide a selector or URL to wait for.');
        return true;
      }
      if (op !== 'act') throw new Error(`Unknown operation: ${op}`);
      const action = text(args.action, 'action');
      if (args.x !== undefined || args.y !== undefined) {
        const x = Number(args.x),
          y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error('x and y must be finite coordinates.');
        await this.move(tab, x, y, action === 'click');
        this.ensure(session, tab, generation);
        if (action === 'click')
          await page.mouse.click(x, y, {
            button: args.button as 'left' | 'right' | 'middle' | undefined,
            clickCount: number(args.clickCount, 1),
          });
        else if (action === 'move') await page.mouse.move(x, y, { steps: number(args.steps, 1) });
        else if (action === 'down') {
          await page.mouse.move(x, y);
          await page.mouse.down();
        } else if (action === 'up') {
          await page.mouse.move(x, y);
          await page.mouse.up();
        } else throw new Error('Coordinate actions: click, move, down, up.');
        return true;
      }
      const element = await this.element(tab, args);
      try {
        let immediate = false;
        if (['click', 'hover', 'fill', 'type', 'check', 'select'].includes(action)) {
          const target = await element.evaluate((element) => {
            let rect = element.getBoundingClientRect();
            if (
              rect.top < 0 ||
              rect.left < 0 ||
              rect.bottom > innerHeight ||
              rect.right > innerWidth
            ) {
              element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              rect = element.getBoundingClientRect();
            }
            const root = element.getRootNode() as Document | ShadowRoot;
            const x = rect.x + rect.width / 2,
              y = rect.y + rect.height / 2;
            const hit = root.elementFromPoint(x, y);
            let outer = element;
            while (outer.getRootNode() instanceof ShadowRoot)
              outer = (outer.getRootNode() as ShadowRoot).host as typeof element;
            const documentHit = document.elementFromPoint(x, y);
            return {
              hit:
                (hit === element || (!!hit && element.contains(hit))) &&
                (documentHit === outer || (!!documentHit && outer.contains(documentHit))),
              disabled: element.matches(':disabled,[aria-disabled="true"]'),
            };
          });
          if (target.disabled && action !== 'hover') throw new Error('Target element is disabled.');
          immediate =
            target.hit && args.stable !== true && (await element.ownerFrame()) === page.mainFrame();
          const box = await element.boundingBox();
          if (box)
            await this.move(tab, box.x + box.width / 2, box.y + box.height / 2, action === 'click');
        }
        this.ensure(session, tab, generation);
        switch (action) {
          case 'click':
            await element.click({
              force: immediate,
              button: args.button as 'left' | 'right' | 'middle' | undefined,
              clickCount: number(args.clickCount, 1),
            });
            break;
          case 'hover':
            await element.hover({ force: immediate });
            break;
          case 'fill':
            await element.fill(String(args.text ?? ''));
            break;
          case 'type':
            await element.type(String(args.text ?? ''));
            break;
          case 'press':
            await element.press(text(args.key, 'key'));
            break;
          case 'check':
            await element.setChecked(args.checked !== false, { force: immediate });
            break;
          case 'select':
            await element.selectOption(args.values as string | string[]);
            break;
          case 'upload':
            if (!Array.isArray(args.paths)) throw new Error('paths must be an array.');
            await element.setInputFiles(args.paths);
            break;
          default:
            throw new Error(`Unknown action: ${action}`);
        }
        return { action, url: page.url() };
      } finally {
        await element.dispose();
      }
    });
  }
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.tabs.values()].filter((tab) => tab.owner).map((tab) => this.release(tab)),
    );
    this.desktop.close();
    // Closing an attached Playwright connection disconnects the client, not Edge.
    await this.browser?.close().catch(() => undefined);
  }
}

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
  busy: number;
  expiry?: NodeJS.Timeout;
  decorating?: Promise<void>;
  redecorate?: boolean;
}
const helper = readFile(new URL('../assets/page-helper.js', import.meta.url), 'utf8');
const helperVersion = helper.then((source) => Number(/\bversion: (\d+),/.exec(source)![1]));
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
  private rootSession?: Promise<CDPSession>;
  private desktop = new Desktop();
  constructor(
    private config: Config,
    private extension: (args: Data) => Promise<unknown>,
    private released: () => void = () => undefined,
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
        this.rootSession = undefined;
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
  // One browser-level session serves tab listing and creation for the whole connection.
  private async root(): Promise<CDPSession> {
    await this.connect();
    this.rootSession ??= this.browser!.newBrowserCDPSession();
    return this.rootSession.catch((error) => {
      this.rootSession = undefined;
      throw error;
    });
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
        busy: 0,
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
    const known = this.tabs.get(id as string);
    if (known && !known.page.isClosed() && this.browser?.isConnected()) return known;
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
  // Navigation events and operations can ask for indicators at once. Run one decoration at a
  // time, and once more afterwards if another request arrived meanwhile.
  private decorate(tab: Tab): Promise<void> {
    if (tab.decorating) {
      tab.redecorate = true;
      return tab.decorating;
    }
    tab.decorating = (async () => {
      try {
        do {
          tab.redecorate = false;
          await this.paint(tab);
        } while (tab.redecorate);
      } finally {
        tab.decorating = undefined;
      }
    })();
    return tab.decorating;
  }
  private async paint(tab: Tab): Promise<void> {
    const owner = tab.owner;
    if (!owner) return;
    // Install the helper if needed and claim the document in one round trip.
    const metadata = (await tab.page.evaluate(
      `${await helper}\n;globalThis.__browserBridge.claim(${JSON.stringify(owner.label)}, ${JSON.stringify(owner.id)}, ${JSON.stringify(tab.pointer ?? null)})`,
    )) as { documentId: string; faviconUrl: string | null; fresh: boolean };
    if (!metadata.fresh) return;
    // Page focus is emulated for background input; ask the verified extension for real focus.
    await this.extension({ namespace: 'browserBridge', method: 'syncAttention' }).catch(
      () => undefined,
    );
    if (!metadata.faviconUrl) return;
    const url = metadata.faviconUrl;
    let data = this.favicons.get(url);
    if (!data) {
      data = (async () => {
        if (url.startsWith('data:image/')) return url;
        if (!/^https?:\/\//.test(url)) return;
        try {
          const cached = await tab.page.evaluate(async (url) => {
            const response = await fetch(url, {
              cache: 'force-cache',
              signal: AbortSignal.timeout(1500),
            });
            if (!response.ok) return;
            const blob = await response.blob();
            if (!blob.type.startsWith('image/') || blob.size > 256 * 1024) return;
            return new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
          }, url);
          if (cached) return cached;
        } catch {
          // Cross-origin icons may require the browser context's request client.
        }
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
      await Promise.all([
        tab.cdp
          .send('Emulation.setFocusEmulationEnabled', { enabled: true })
          .catch(() => undefined),
        this.decorate(tab).catch(() => undefined),
      ]);
      this.ensure(session, tab);
    }
    return tab.generation;
  }
  async releaseSession(id: string): Promise<void> {
    await Promise.all(
      [...this.tabs.values()].filter((tab) => tab.owner?.id === id).map((tab) => this.release(tab)),
    );
  }
  // Release tabs an agent has stopped using. Its next operation claims the tab again.
  private expire(tab: Tab): void {
    clearTimeout(tab.expiry);
    const ms = this.config.releaseIdleMs;
    if (!ms || !tab.owner || tab.busy) return;
    const { generation } = tab;
    tab.expiry = setTimeout(() => {
      if (!tab.owner || tab.busy || tab.generation !== generation || tab.page.isClosed()) return;
      void this.release(tab).then(this.released, () => undefined);
    }, ms);
    tab.expiry.unref();
  }
  private async release(tab: Tab): Promise<void> {
    clearTimeout(tab.expiry);
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
  // Resolves after any visible travel, with whether a person is watching the tab.
  private async move(tab: Tab, x: number, y: number, click = false): Promise<boolean> {
    tab.pointer = { x, y };
    return tab.page
      .evaluate(
        ({ x, y, click }) =>
          (
            globalThis as unknown as {
              __browserBridge?: { move(x: number, y: number, click: boolean): Promise<boolean> };
            }
          ).__browserBridge?.move(x, y, click),
        { x, y, click },
      )
      .then(Boolean, () => false);
  }
  // A short pause after input lets a watching person see each result.
  private async pause(page: Page): Promise<void> {
    await page.evaluate('globalThis.__browserBridge?.pause()').catch(() => undefined);
  }
  private async element(tab: Tab, args: Data): Promise<ElementHandle<HTMLElement | SVGElement>> {
    if (args.ref) {
      const ref = text(args.ref, 'ref');
      const frame = tab.refs.get(ref);
      if (!frame || frame.isDetached()) throw new Error('Stale reference. Take a new snapshot.');
      const handle = await frame.evaluateHandle((ref) => {
        const element = (
          globalThis as unknown as { __browserBridge?: { resolve(ref: string): Element | null } }
        ).__browserBridge?.resolve(ref);
        return element?.isConnected ? element : null;
      }, ref);
      const element = handle.asElement();
      if (!element) {
        void handle.dispose().catch(() => undefined);
        throw new Error('Stale reference. Take a new snapshot.');
      }
      return element as ElementHandle<HTMLElement | SVGElement>;
    }
    const frame = args.frameUrl
      ? tab.page.frames().find((frame) => frame.url() === args.frameUrl)
      : tab.page.mainFrame();
    if (!frame) throw new Error('Frame not found.');
    const selector = text(args.selector, 'selector');
    // Plain CSS with exactly one match skips Playwright's slower selector engine. Its syntax,
    // shadow DOM piercing, waiting and strictness errors still apply to everything else.
    const quick = await frame
      .evaluateHandle((selector) => {
        try {
          const found = document.querySelectorAll(selector);
          return found.length === 1 ? found[0]! : null;
        } catch {
          return null;
        }
      }, selector)
      .catch(() => undefined);
    const found = quick?.asElement();
    if (found) return found as ElementHandle<HTMLElement | SVGElement>;
    void quick?.dispose().catch(() => undefined);
    const locator = frame.locator(selector);
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
    if (op === 'tabs') {
      const tabs = await this.allTabs();
      // The browser knows every title, including frozen tabs that would stall a page query.
      // It shows the URL when a page has no title.
      const targets = await (
        await this.root()
      )
        .send('Target.getTargets')
        .then(({ targetInfos }) => new Map(targetInfos.map((info) => [info.targetId, info])))
        .catch(() => new Map<string, { title: string; url: string }>());
      return Promise.all(
        tabs.map(async (tab) => {
          const target = targets.get(tab.id);
          return {
            tabId: tab.id,
            url: tab.page.url(),
            title: target
              ? target.title === target.url
                ? ''
                : target.title
              : await deadline(tab.page.title(), 2000, 'Title').catch(() => ''),
            agent: tab.owner?.label ?? null,
          };
        }),
      );
    }
    if (op === 'open')
      return this.global.run(async () => {
        await this.connect();
        this.ensure(session);
        const root = await this.root();
        const { targetId } = await root.send('Target.createTarget', {
          url: 'about:blank',
          background: args.focus !== true,
        });
        // Playwright announces the page once it can drive it; waiting for that beats polling.
        const context = this.context!;
        const tab = await new Promise<Tab>((resolve, reject) => {
          const check = (page: Page) =>
            void this.attach(page).then(
              (tab) => tab.id === targetId && finish(tab),
              () => undefined,
            );
          const finish = (tab?: Tab) => {
            clearTimeout(timer);
            context.off('page', check);
            if (tab) resolve(tab);
            else reject(new Error('New tab did not appear.'));
          };
          const timer = setTimeout(finish, this.config.navigationTimeoutMs);
          context.on('page', check);
          for (const page of context.pages()) check(page);
        });
        tab.busy++;
        try {
          await this.claim(session, tab);
          if (args.url)
            await tab.page.goto(text(args.url, 'url'), { waitUntil: 'domcontentloaded' });
          if (args.focus === true) await tab.page.bringToFront();
        } finally {
          tab.busy--;
          this.expire(tab);
        }
        return { tabId: tab.id, url: tab.page.url() };
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
    // Count work in flight so idle release never interrupts an operation.
    tab.busy++;
    clearTimeout(tab.expiry);
    try {
      return await this.operate(session, tab, op, args);
    } finally {
      tab.busy--;
      this.expire(tab);
    }
  }
  private async operate(session: Session, tab: Tab, op: string, args: Data): Promise<unknown> {
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
        tab.refs.clear();
        const limit = Math.min(1000, Math.max(1, number(args.limit, 200)));
        const maxText = Math.min(100000, Math.max(0, number(args.maxText, 12000)));
        // Read frames concurrently. The init script has usually installed the current helper, so the
        // full source goes only to frames without it. A JSON string crosses the protocol several
        // times faster than a serialized object.
        const read = `JSON.stringify(globalThis.__browserBridge.snapshot(${limit}, ${maxText}))`;
        const quick = `globalThis.__browserBridge?.version === ${await helperVersion} ? ${read} : null`;
        const full = `${await helper}\n;${read}`;
        const frames = await Promise.all(
          page.frames().map(async (frame) => {
            try {
              const evaluate = (source: string) =>
                deadline(frame.evaluate(source), this.config.navigationTimeoutMs, 'Frame snapshot');
              const json = ((await evaluate(quick)) ?? (await evaluate(full))) as string;
              const snapshot = JSON.parse(json) as { elements: { ref: string }[] };
              for (const element of snapshot.elements) tab.refs.set(element.ref, frame);
              return { frameUrl: frame.url(), ...snapshot };
            } catch (error) {
              return { frameUrl: frame.url(), error: message(error) };
            }
          }),
        );
        if (frames.length && frames.every((frame) => 'error' in frame))
          throw new Error(`Cannot snapshot this page: ${(frames[0] as Data).error}`);
        return { tabId: tab.id, frames };
      }
      if (op === 'evaluate')
        return deadline(
          page.evaluate(text(args.expression, 'expression')),
          this.config.navigationTimeoutMs,
          'Page evaluation',
        );
      if (op === 'cdp') {
        const result = await deadline(
          tab.cdp.send(text(args.method, 'method') as never, (args.params ?? {}) as never),
          30_000,
          'CDP command',
        );
        if (args.method === 'Input.insertText' || args.method === 'Input.dispatchKeyEvent')
          await this.pause(page);
        return result;
      }
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
        await this.pause(page);
        return true;
      }
      if (op === 'scroll') {
        await page.mouse.wheel(number(args.deltaX, 0), number(args.deltaY, 600));
        await this.pause(page);
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
        const watched = await this.move(tab, x, y, action === 'click');
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
        if (watched) await this.pause(page);
        return true;
      }
      // Top-document clicks, hovers and text fills on an unobstructed target finish in two round
      // trips. Everything else takes the Playwright path below.
      const fill = action === 'fill' ? String(args.text ?? '') : undefined;
      const ref = typeof args.ref === 'string' ? args.ref : undefined;
      if (
        ['click', 'hover', 'fill'].includes(action) &&
        fill !== '' &&
        !args.frameUrl &&
        args.stable !== true &&
        (ref ? tab.refs.get(ref) === page.mainFrame() : typeof args.selector === 'string')
      ) {
        const target = await page
          .evaluate(
            ({ selector, ref, action }) =>
              (
                globalThis as unknown as {
                  __browserBridge?: {
                    target?(
                      selector: string | undefined,
                      ref: string | undefined,
                      action: string,
                    ): Promise<
                      | { x: number; y: number; watched: boolean; stale?: never; disabled?: never }
                      | { stale?: boolean; disabled?: boolean; x?: never }
                      | null
                    >;
                  };
                }
              ).__browserBridge?.target?.(selector, ref, action) ?? null,
            { selector: ref ? undefined : (args.selector as string), ref, action },
          )
          .catch(() => null);
        if (target?.stale) throw new Error('Stale reference. Take a new snapshot.');
        if (target?.disabled) throw new Error('Target element is disabled.');
        if (target?.x !== undefined) {
          tab.pointer = { x: target.x, y: target.y };
          this.ensure(session, tab, generation);
          if (action === 'click')
            await page.mouse.click(target.x, target.y, {
              button: args.button as 'left' | 'right' | 'middle' | undefined,
              clickCount: number(args.clickCount, 1),
            });
          else if (action === 'hover') await page.mouse.move(target.x, target.y);
          else await tab.cdp.send('Input.insertText', { text: fill! });
          if (target.watched) await this.pause(page);
          return { action, url: page.url() };
        }
      }
      const element = await this.element(tab, args);
      try {
        // Unobstructed main-frame targets take direct pointer input at the hit-tested point.
        let immediate: { x: number; y: number } | undefined;
        let watched = true;
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
              top: window === window.top,
              x,
              y,
            };
          });
          if (target.disabled && action !== 'hover') throw new Error('Target element is disabled.');
          if (target.hit && target.top && args.stable !== true) immediate = target;
          // Frame content needs page coordinates for the cursor.
          const box = target.top ? undefined : await element.boundingBox();
          const point = target.top
            ? target
            : box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          if (point) watched = await this.move(tab, point.x, point.y, action === 'click');
        }
        this.ensure(session, tab, generation);
        switch (action) {
          case 'click':
            if (immediate)
              await page.mouse.click(immediate.x, immediate.y, {
                button: args.button as 'left' | 'right' | 'middle' | undefined,
                clickCount: number(args.clickCount, 1),
              });
            else
              await element.click({
                button: args.button as 'left' | 'right' | 'middle' | undefined,
                clickCount: number(args.clickCount, 1),
              });
            break;
          case 'hover':
            if (immediate) await page.mouse.move(immediate.x, immediate.y);
            else await element.hover();
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
            await element.setChecked(args.checked !== false, { force: !!immediate });
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
        if (watched) await this.pause(page);
        return { action, url: page.url() };
      } finally {
        void element.dispose().catch(() => undefined);
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

import { BrowserController, type Session } from './browser.js';
import { BrowserRegistry, type BrowserTarget } from './browsers.js';
import { Queue, type Config } from './config.js';
import { Desktop } from './desktop.js';
import type { Data } from './wire.js';

interface ExtensionIdentity {
  connectionId: string;
  profileId: string;
  sessionId: string;
}
interface Instance {
  target: BrowserTarget;
  controller: BrowserController;
  binding?: { version: string; ids: string[] };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BrowserManager {
  private instances = new Map<string, Instance>();
  private selected = new Map<string, string>();
  private extensions = new Map<string, ExtensionIdentity>();
  private extensionVersion = 0;
  private desktop = new Desktop();
  private desktopQueue = new Queue();
  constructor(
    private config: Config,
    private invokeExtension: (connectionId: string, args: Data) => Promise<unknown>,
    private registry = new BrowserRegistry(config),
  ) {}
  registerExtension(session: Session, args: Data): Data {
    if (session.role !== 'extension')
      throw new Error('Only an extension can register its identity.');
    const { connectionId, profileId } = args;
    if (
      typeof connectionId !== 'string' ||
      !uuid.test(connectionId) ||
      typeof profileId !== 'string' ||
      !uuid.test(profileId)
    )
      throw new Error('Extension connectionId and profileId must be UUIDs.');
    const existing = this.extensions.get(connectionId);
    if (existing && existing.sessionId !== session.id)
      throw new Error('Extension connection ID is already registered.');
    for (const [id, identity] of this.extensions)
      if (identity.sessionId === session.id) this.extensions.delete(id);
    this.extensions.set(connectionId, { connectionId, profileId, sessionId: session.id });
    this.extensionVersion++;
    return { registered: true, connectionId, profileId };
  }
  extensionSession(connectionId: string): string | undefined {
    return this.extensions.get(connectionId)?.sessionId;
  }
  private instance(target: BrowserTarget): Instance {
    let instance = this.instances.get(target.id);
    if (!instance) {
      instance = {
        target,
        controller: new BrowserController({ ...this.config, browser: target.endpoint! }, (args) =>
          this.browserApi(target.id, args),
        ),
      };
      this.instances.set(target.id, instance);
    } else if (instance.target.endpoint !== target.endpoint) {
      if (instance.controller.status().connected) return instance;
      const previous = instance.controller;
      instance = {
        target,
        controller: new BrowserController({ ...this.config, browser: target.endpoint! }, (args) =>
          this.browserApi(target.id, args),
        ),
      };
      this.instances.set(target.id, instance);
      void previous.dispose();
    }
    return instance;
  }
  private async bindings(instance: Instance, connect = false): Promise<string[]> {
    const connected = instance.controller.status().connected;
    if (!connected && !connect) return [];
    const version = `${this.extensionVersion}/${instance.controller.connectionVersion}`;
    if (connected && instance.binding?.version === version) return instance.binding.ids;
    const candidates = this.extensions.size ? await instance.controller.extensionConnections() : [];
    const ids = [...new Set(candidates)].filter((id) => this.extensions.has(id));
    instance.binding = {
      version: `${this.extensionVersion}/${instance.controller.connectionVersion}`,
      ids,
    };
    return ids;
  }
  private async browserApi(browserId: string, args: Data): Promise<unknown> {
    const instance = this.instances.get(browserId)!;
    const ids = await this.bindings(instance, true);
    if (!ids.length)
      throw new Error(
        `${instance.target.name}: no verified Browser Bridge extension is connected to this browser context. Load or reload dist/extension in that browser after setup.`,
      );
    if (ids.length > 1)
      throw new Error(
        `${instance.target.name}: multiple extension profiles share this browser context. Use separate user-data directories to address them independently.`,
      );
    return this.invokeExtension(ids[0]!, args);
  }
  private tab(raw: unknown): { browserId: string; raw: string } | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !/^[a-z0-9][a-z0-9._-]*\/[^/]+$/.test(raw))
      throw new Error(
        'tabId must be the complete browser-qualified ID from browser_tabs or browser_open.',
      );
    const separator = raw.indexOf('/');
    return { browserId: raw.slice(0, separator), raw: raw.slice(separator + 1) };
  }
  private async route(
    session: Session,
    args: Data,
  ): Promise<{ target: BrowserTarget; args: Data }> {
    const tab = this.tab(args.tabId);
    const selector = args.browser;
    if (selector !== undefined && (typeof selector !== 'string' || !selector.trim()))
      throw new Error('browser must be a browser name or ID from browser_list.');
    const target = await this.registry.resolve(
      tab?.browserId ?? selector ?? this.selected.get(session.id) ?? this.config.browser,
    );
    if (tab && selector !== undefined && (await this.registry.resolve(selector)).id !== target.id)
      throw new Error('The browser selector does not match this tabId.');
    const normalized = { ...args };
    delete normalized.browser;
    if (tab) normalized.tabId = tab.raw;
    return { target, args: normalized };
  }
  private qualify(target: BrowserTarget, op: string, result: unknown, args: Data): unknown {
    if (op === 'tabs')
      return (result as Data[]).map((tab) => ({
        ...tab,
        tabId: `${target.id}/${tab.tabId}`,
        browserId: target.id,
      }));
    if (
      ['open', 'claim', 'release', 'close'].includes(op) &&
      result &&
      typeof result === 'object'
    ) {
      const output: Data = { ...(result as Data), browserId: target.id };
      for (const key of ['tabId', 'released', 'closed'])
        if (typeof output[key] === 'string') output[key] = `${target.id}/${output[key]}`;
      return output;
    }
    if (op === 'batch') {
      const actions = args.actions as Data[];
      return (result as Data[]).map((item, index) =>
        item.ok
          ? {
              ...item,
              result: this.qualify(
                target,
                String(actions[index]!.op),
                item.result,
                (actions[index]!.args ?? {}) as Data,
              ),
            }
          : item,
      );
    }
    return result;
  }
  async status(session?: Session, refresh = false): Promise<Data> {
    const targets = await this.registry.list(refresh);
    await Promise.all([...this.instances.values()].map((instance) => this.bindings(instance)));
    const identity =
      session?.role === 'extension'
        ? [...this.extensions.values()].find((identity) => identity.sessionId === session.id)
        : undefined;
    const visible = [...this.instances.values()].filter(
      (instance) =>
        session?.role !== 'extension' ||
        (identity && instance.binding?.ids.includes(identity.connectionId)),
    );
    const claims = visible.flatMap((instance) =>
      (instance.controller.status().claims as Data[]).map((claim) => ({
        ...claim,
        tabId: `${instance.target.id}/${claim.tabId}`,
        browserId: instance.target.id,
      })),
    );
    const browsers = targets.map((target) => {
      const instance = this.instances.get(target.id);
      return {
        id: target.id,
        name: target.name,
        browser: target.browser,
        aliases: target.aliases,
        userDataDir: target.userDataDir,
        installed: target.installed,
        configured: target.configured,
        debuggingEnabled: !!target.endpoint,
        setupUrl: target.setupUrl,
        connected: instance?.controller.status().connected ?? false,
        extensionConnected: !!instance?.binding?.ids.length,
        error: target.error,
      };
    });
    return {
      browser: this.config.browser,
      selectedBrowserId: session ? (this.selected.get(session.id) ?? null) : null,
      connected: visible.some((instance) => instance.controller.status().connected),
      extensionConnected: session?.role === 'extension' ? !!identity : this.extensions.size > 0,
      claims,
      ...(session?.role === 'extension' ? {} : { browsers }),
    };
  }
  async execute(session: Session, op: string, args: Data): Promise<unknown> {
    if (!session.active) throw new Error('Agent disconnected.');
    if (session.role === 'extension' && !['status', 'release', 'extension-register'].includes(op))
      throw new Error('Unsupported extension operation.');
    if (op === 'extension-register') return this.registerExtension(session, args);
    if (op === 'status') return this.status(session);
    if (op === 'browsers') {
      const status = await this.status(session, args.refresh === true);
      return { selectedBrowserId: status.selectedBrowserId, browsers: status.browsers };
    }
    if (op === 'select') {
      if (typeof args.browser !== 'string' || !args.browser.trim())
        throw new Error('browser is required.');
      const target = await this.registry.resolve(args.browser);
      this.selected.set(session.id, target.id);
      return { selectedBrowserId: target.id, name: target.name };
    }
    if (op === 'desktop')
      return this.desktopQueue.run(() => {
        if (!session.active) throw new Error('Agent disconnected.');
        return this.desktop.call(args);
      });
    let routeArgs = args;
    if (op === 'batch' && Array.isArray(args.actions)) {
      const first = args.actions.find((action: Data) => {
        const input = action?.args as Data | undefined;
        return input?.tabId || input?.browser;
      })?.args as Data | undefined;
      routeArgs = {
        ...args,
        tabId: args.tabId ?? first?.tabId,
        browser: args.browser ?? first?.browser,
      };
    }
    const route = await this.route(session, routeArgs);
    const instance = this.instance(route.target);
    if (session.role === 'extension') {
      const ids = await this.bindings(instance);
      if (!ids.some((id) => this.extensions.get(id)?.sessionId === session.id))
        throw new Error('This extension cannot release a tab in another browser.');
    }
    if (op === 'batch' && Array.isArray(args.actions)) {
      route.args.actions = await Promise.all(
        args.actions.map(async (action: Data) => {
          if (!action || typeof action !== 'object' || action.op === 'batch')
            throw new Error('Invalid batch action.');
          if (
            action.args !== undefined &&
            (!action.args || typeof action.args !== 'object' || Array.isArray(action.args))
          )
            throw new Error('Batch action args must be an object.');
          const normalized = await this.route(session, {
            browser: route.target.id,
            ...(args.tabId ? { tabId: args.tabId } : {}),
            ...(action.args as Data | undefined),
          });
          if (normalized.target.id !== route.target.id)
            throw new Error(
              'Each batch must target one browser. Split operations across browsers into separate calls.',
            );
          return { ...action, args: normalized.args };
        }),
      );
    }
    const result = await instance.controller.execute(session, op, route.args);
    await this.bindings(instance);
    return this.qualify(route.target, op, result, route.args);
  }
  async releaseSession(sessionId: string): Promise<void> {
    this.selected.delete(sessionId);
    for (const [id, identity] of this.extensions)
      if (identity.sessionId === sessionId) {
        this.extensions.delete(id);
        this.extensionVersion++;
      }
    await Promise.all(
      [...this.instances.values()].map((instance) => instance.controller.releaseSession(sessionId)),
    );
  }
  async dispose(): Promise<void> {
    this.desktop.close();
    await Promise.all(
      [...this.instances.values()].map((instance) => instance.controller.dispose()),
    );
  }
}

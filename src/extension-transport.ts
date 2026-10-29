import { randomUUID } from 'node:crypto';
import type { ConnectOverCDPTransport } from 'playwright-core';
import type { Data } from './wire.js';

type Invoke = (namespace: string, method: string, args?: unknown[]) => Promise<any>;
interface Target {
  tabId: number;
  info: Data;
  sessionId: string;
  children: Set<string>;
}

/** CDP carried by the authenticated Native Messaging connection, without a browser port. */
export class ExtensionTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private targets = new Map<string, Target>();
  private attaching = new Map<number, Promise<Target>>();
  private roots = new Set<string>();
  private aliases = new Map<string, { target: Target; parent?: string }>();
  private autoAttach = false;
  private closed = false;
  constructor(private invoke: Invoke) {}

  private emit(message: Data): void {
    if (!this.closed) this.onmessage?.(message);
  }
  send(input: object): void {
    const message = input as Data;
    void this.command(
      String(message.method),
      (message.params ?? {}) as Data,
      message.sessionId as string | undefined,
    ).then(
      (result) => this.emit({ id: message.id, sessionId: message.sessionId, result }),
      (error) =>
        this.emit({
          id: message.id,
          sessionId: message.sessionId,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        }),
    );
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.targets.values()].map((target) =>
        this.invoke('debugger', 'detach', [{ tabId: target.tabId }]),
      ),
    );
    this.targets.clear();
    this.onclose?.();
  }
  disconnected(reason = 'Browser Bridge extension disconnected.'): void {
    if (this.closed) return;
    this.closed = true;
    this.targets.clear();
    this.onclose?.(reason);
  }
  event(event: Data): void {
    if (this.closed) return;
    const source = (event.source ?? {}) as Data;
    const target = [...this.targets.values()].find((target) => target.tabId === source.tabId);
    if (event.name === 'tab-created' && this.autoAttach) {
      const tab = event.tab as Data;
      if (typeof tab.id === 'number') void this.attach(tab.id).catch(() => undefined);
      return;
    }
    if (!target) return;
    if (event.name === 'detached' || event.name === 'tab-removed') {
      this.targets.delete(String(target.info.targetId));
      this.emit({
        method: 'Target.detachedFromTarget',
        params: {
          sessionId: target.sessionId,
          targetId: target.info.targetId,
        },
      });
      return;
    }
    const params = (event.params ?? {}) as Data;
    if (event.method === 'Target.attachedToTarget' && typeof params.sessionId === 'string')
      target.children.add(params.sessionId);
    if (event.method === 'Target.detachedFromTarget')
      target.children.delete(String(params.sessionId));
    this.emit({ sessionId: source.sessionId ?? target.sessionId, method: event.method, params });
    if (!source.sessionId)
      for (const [id, alias] of this.aliases)
        if (alias.target === target) this.emit({ sessionId: id, method: event.method, params });
  }
  private async attach(tabId: number): Promise<Target> {
    const existing = [...this.targets.values()].find((target) => target.tabId === tabId);
    if (existing) return existing;
    const pending = this.attaching.get(tabId);
    if (pending) return pending;
    const attaching = (async () => {
      await this.invoke('debugger', 'attach', [{ tabId }, '1.3']);
      const { targetInfo } = await this.invoke('debugger', 'sendCommand', [
        { tabId },
        'Target.getTargetInfo',
      ]);
      const target: Target = {
        tabId,
        info: targetInfo,
        sessionId: randomUUID(),
        children: new Set(),
      };
      this.targets.set(String(targetInfo.targetId), target);
      this.emit({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: target.sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      });
      return target;
    })();
    this.attaching.set(tabId, attaching);
    try {
      return await attaching;
    } finally {
      this.attaching.delete(tabId);
    }
  }
  private async command(method: string, params: Data, sessionId?: string): Promise<unknown> {
    if (this.closed) throw new Error('Extension transport disconnected.');
    const root = !sessionId || this.roots.has(sessionId);
    if (root) {
      if (method === 'Browser.getVersion')
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Extension',
          revision: '',
          userAgent: 'Browser Bridge extension',
          jsVersion: '',
        };
      if (method === 'Target.attachToBrowserTarget') {
        const id = randomUUID();
        this.roots.add(id);
        return { sessionId: id };
      }
      if (method === 'Target.setAutoAttach') {
        this.autoAttach = params.autoAttach === true;
        if (this.autoAttach) {
          const tabs = await this.invoke('tabs', 'query', [{}]);
          await Promise.allSettled(tabs.map((tab: Data) => this.attach(Number(tab.id))));
        }
        return {};
      }
      if (method === 'Target.getTargets') {
        const targets = await this.invoke('debugger', 'getTargets');
        return {
          targetInfos: targets.map((target: Data) => ({
            targetId: target.id,
            type: target.type,
            title: target.title ?? '',
            url: target.url ?? '',
            attached: target.attached,
            canAccessOpener: false,
          })),
        };
      }
      if (method === 'Target.getTargetInfo' && !params.targetId)
        return {
          targetInfo: {
            targetId: 'browser-bridge',
            type: 'browser',
            title: '',
            url: '',
            attached: true,
          },
        };
      if (method === 'Target.createTarget') {
        const tab = await this.invoke('tabs', 'create', [
          { url: params.url ?? 'about:blank', active: params.background !== true },
        ]);
        const target = await this.attach(tab.id);
        return { targetId: target.info.targetId };
      }
      if (method === 'Target.closeTarget') {
        const target = this.targets.get(String(params.targetId));
        if (!target) return { success: false };
        await this.invoke('tabs', 'remove', [target.tabId]);
        return { success: true };
      }
      if (method === 'Target.activateTarget') {
        const target = this.targets.get(String(params.targetId));
        if (!target) throw new Error('Tab target is unavailable.');
        await this.invoke('tabs', 'update', [target.tabId, { active: true }]);
        return {};
      }
      if (method === 'Target.attachToTarget') {
        const target = this.targets.get(String(params.targetId));
        if (!target) throw new Error('Tab target is unavailable.');
        const id = randomUUID();
        this.aliases.set(id, { target, parent: sessionId });
        return { sessionId: id };
      }
      if (method === 'Target.detachFromTarget') {
        const id = String(params.sessionId);
        const alias = this.aliases.get(id);
        if (alias || this.roots.delete(id)) {
          this.aliases.delete(id);
          this.emit({
            sessionId: alias?.parent,
            method: 'Target.detachedFromTarget',
            params: {
              sessionId: id,
              ...(alias ? { targetId: alias.target.info.targetId } : {}),
            },
          });
          return {};
        }
      }
    }
    const alias = sessionId && this.aliases.get(sessionId);
    const target = alias
      ? alias.target
      : root
        ? (this.targets.get(String(params.targetId)) ?? this.targets.values().next().value)
        : [...this.targets.values()].find(
            (target) => target.sessionId === sessionId || target.children.has(sessionId!),
          );
    if (!target) throw new Error(`No tab is available for ${method}.`);
    const debuggee = {
      tabId: target.tabId,
      ...(!root && !alias && target.sessionId !== sessionId ? { sessionId } : {}),
    };
    return this.invoke('debugger', 'sendCommand', [debuggee, method, params]);
  }
}

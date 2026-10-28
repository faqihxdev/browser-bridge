let port;
let attentionGeneration = 0;
let attentionTab;
let attentionQueue = Promise.resolve();
function syncAttention() {
  const generation = ++attentionGeneration;
  attentionQueue = attentionQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation !== attentionGeneration) return;
      const windows = await chrome.windows.getAll({ populate: true });
      if (generation !== attentionGeneration) return;
      const window = windows.find((window) => window.focused && window.state !== 'minimized');
      const current = window?.tabs?.find((tab) => tab.active)?.id;
      const previous = attentionTab;
      attentionTab = current;
      await Promise.all(
        [...new Set([previous, current])].filter(Number.isInteger).map((tabId) =>
          chrome.scripting
            .executeScript({
              target: { tabId },
              world: 'MAIN',
              func: (watched) => globalThis.__browserBridge?.setAttention?.(watched),
              args: [tabId === current],
            })
            .catch(() => undefined),
        ),
      );
    });
  return attentionQueue;
}
chrome.tabs.onActivated.addListener(() => void syncAttention());
chrome.tabs.onAttached.addListener(() => void syncAttention());
chrome.tabs.onRemoved.addListener(() => void syncAttention());
chrome.windows.onFocusChanged.addListener(() => void syncAttention());
const profile = chrome.storage.local.get('browserBridgeProfileId').then(async (stored) => {
  if (typeof stored.browserBridgeProfileId === 'string') return stored.browserBridgeProfileId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ browserBridgeProfileId: id });
  return id;
});
const pending = new Map();
const namespaces = new Set([
  'tabs',
  'windows',
  'tabGroups',
  'bookmarks',
  'history',
  'downloads',
  'cookies',
  'sessions',
  'management',
  'browsingData',
  'privacy',
  'contentSettings',
  'topSites',
  'fontSettings',
  'scripting',
  'permissions',
  'webNavigation',
  'action',
  'runtime',
  'alarms',
  'storage',
]);
let connectionError = 'Connecting to the local controller.';
function connect() {
  if (port) return;
  const connectionId = crypto.randomUUID();
  globalThis.__browserBridgeConnectionId = connectionId;
  port = chrome.runtime.connectNative('dev.browser_bridge');
  const connectedPort = port;
  port.onMessage.addListener(async (packet) => {
    if (packet.event === 'ready') {
      try {
        if (port !== connectedPort) return;
        await request('extension-register', { connectionId, profileId: await profile });
        await syncAttention();
        connectionError = '';
        await chrome.action.setBadgeText({ text: '' });
      } catch (error) {
        connectionError = error.message;
        await chrome.action.setBadgeText({ text: '!' });
      }
      return;
    }
    if (packet.event === 'state') {
      void syncAttention();
      void chrome.runtime
        .sendMessage({ event: 'state', result: packet.args })
        .catch(() => undefined);
      return;
    }
    if (packet.event === 'browser-api') {
      try {
        const { namespace, method, args = [] } = packet.args;
        if (namespace === 'browserBridge' && method === 'syncAttention') {
          await syncAttention();
          await request('extension-result', { requestId: packet.id, result: true });
          return;
        }
        if (!namespaces.has(namespace) || !/^[a-zA-Z][\w.]*$/.test(method) || !Array.isArray(args))
          throw new Error('Unsupported browser API request.');
        const parts = method.split('.');
        let object = chrome[namespace];
        for (const part of parts.slice(0, -1)) {
          if (['__proto__', 'constructor', 'prototype'].includes(part))
            throw new Error('Invalid API method.');
          object = object[part];
        }
        const name = parts.at(-1);
        if (
          ['__proto__', 'constructor', 'prototype'].includes(name) ||
          typeof object?.[name] !== 'function' ||
          /^(on|addListener|removeListener)/.test(name)
        )
          throw new Error('API method is unavailable.');
        const result = await object[name](...args);
        await request('extension-result', { requestId: packet.id, result: result ?? null });
      } catch (error) {
        await request('extension-result', { requestId: packet.id, error: error.message }).catch(
          () => undefined,
        );
      }
      return;
    }
    const callback = pending.get(packet.id);
    if (callback) {
      clearTimeout(callback.timer);
      pending.delete(packet.id);
      packet.error ? callback.reject(new Error(packet.error)) : callback.resolve(packet.result);
    }
  });
  port.onDisconnect.addListener(() => {
    if (port !== connectedPort) return;
    connectionError = chrome.runtime.lastError?.message || 'Local controller disconnected.';
    port = null;
    globalThis.__browserBridgeConnectionId = null;
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error(connectionError));
    }
    pending.clear();
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setBadgeBackgroundColor({ color: '#b52c42' });
    void chrome.alarms.create('reconnect', { delayInMinutes: 1 });
  });
}
function request(op, args = {}) {
  connect();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(connectionError || 'Controller request timed out.'));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ id, op, args });
  });
}
chrome.runtime.onMessage.addListener((input, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html'))
    return false;
  if (!['status', 'release'].includes(input.op)) {
    respond({ error: 'Unsupported popup action.' });
    return false;
  }
  request(input.op, input.args).then(
    (result) => respond({ result }),
    (error) => respond({ error: error.message }),
  );
  return true;
});
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connect();
});

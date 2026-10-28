const string = { type: 'string' };
const boolean = { type: 'boolean' };
const numeric = { type: 'number' };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: true,
});
const target = {
  tabId: { ...string, description: 'Stable target ID from browser_tabs or browser_open.' },
};
export const tools = [
  {
    name: 'browser_status',
    op: 'status',
    description:
      'Controller status, connected extension and current tab owners. Does not connect to the browser.',
    inputSchema: schema({}),
  },
  {
    name: 'browser_tabs',
    op: 'tabs',
    description: 'List existing browser tabs and their stable IDs without changing focus.',
    inputSchema: schema({}),
  },
  {
    name: 'browser_open',
    op: 'open',
    description:
      'Open and own a background tab. Set focus=true only when foreground interaction is intended.',
    inputSchema: schema({ url: string, focus: boolean }),
  },
  {
    name: 'browser_snapshot',
    op: 'snapshot',
    description:
      'Read page text and interactive elements across frames. Use returned ref values in browser_act. References expire on navigation. Snapshot reads claim the tab for this agent.',
    inputSchema: schema({ ...target, limit: numeric, maxText: numeric }, ['tabId']),
  },
  {
    name: 'browser_act',
    op: 'act',
    description:
      'Act on an element using ref or a Playwright selector. Actions: click, hover, fill, type, press, check, select, upload. For coordinates use action click/move/down/up and x,y in main-frame CSS pixels. text supplies fill/type text; key supplies a key chord; values supplies select options; paths supplies local upload files. Target a specific frame with frameUrl when using selectors.',
    inputSchema: schema(
      {
        ...target,
        action: string,
        ref: string,
        selector: string,
        frameUrl: string,
        text: string,
        key: string,
        x: numeric,
        y: numeric,
        button: string,
        checked: boolean,
        clickCount: numeric,
        steps: numeric,
        values: { oneOf: [string, { type: 'array', items: string }] },
        paths: { type: 'array', items: string },
      },
      ['tabId', 'action'],
    ),
  },
  {
    name: 'browser_page',
    description:
      'Page operations: claim, release, navigate, back, reload, focus, close, screenshot, pdf, key, scroll, wait, dialog, console, network, cookies. Navigation uses url. Screenshots accept fullPage, includeCursor and optional absolute path. wait accepts selector/state or url, with timeout. dialog without accept reads the pending message; accept=true/false handles it. network lists recent requests; index reads one request/response with headers and body. cookies accepts action=get/set/clear and cookies array for set. Focus explicitly activates the tab.',
    inputSchema: schema(
      {
        ...target,
        op: string,
        url: string,
        key: string,
        deltaX: numeric,
        deltaY: numeric,
        selector: string,
        state: string,
        timeout: numeric,
        accept: boolean,
        text: string,
        index: numeric,
        action: string,
        cookies: { type: 'array', items: { type: 'object' } },
        fullPage: boolean,
        includeCursor: boolean,
        path: string,
      },
      ['tabId', 'op'],
    ),
  },
  {
    name: 'browser_evaluate',
    op: 'evaluate',
    description:
      'Run a JavaScript expression in the target page and return its JSON-serializable result. Promises are awaited. This has the signed-in page privileges. Programmatic DOM changes do not necessarily create pointer movement.',
    inputSchema: schema({ ...target, expression: string }, ['tabId', 'expression']),
  },
  {
    name: 'browser_cdp',
    op: 'cdp',
    description:
      'Send a raw CDP method with params. With tabId, use that page session; omit tabId for the browser session. This is a privileged escape hatch that can change browser-wide state and bypass tab ownership. Prefer ordinary tools when available.',
    inputSchema: schema(
      { ...target, method: string, params: { type: 'object', additionalProperties: true } },
      ['method'],
    ),
  },
  {
    name: 'browser_api',
    op: 'api',
    description:
      'Call an installed extension browser API. Supply namespace, method and positional args array, for example tabs/query/[{}] or bookmarks/search/["work"]. Supports tabs, windows, tabGroups, bookmarks, history, downloads, cookies, sessions, management, browsingData, privacy, contentSettings, topSites and fontSettings. Browser permissions still apply.',
    inputSchema: schema({ namespace: string, method: string, args: { type: 'array', items: {} } }, [
      'namespace',
      'method',
    ]),
  },
  {
    name: 'browser_desktop',
    op: 'desktop',
    description:
      'Windows native UI fallback. action=windows lists window references. inspect accepts hwnd or pid plus maxDepth/maxNodes. Use returned refs for invoke/value/toggle/expand/collapse/focus/click/keys/screenshot. keys uses Windows SendKeys syntax. Physical click, cursor, keys and screenshot affect the foreground desktop. Avoid them for background page work.',
    inputSchema: schema(
      {
        action: string,
        ref: string,
        hwnd: numeric,
        pid: numeric,
        maxDepth: numeric,
        maxNodes: numeric,
        text: string,
        keys: string,
        x: numeric,
        y: numeric,
        button: string,
      },
      ['action'],
    ),
  },
  {
    name: 'browser_batch',
    op: 'batch',
    description:
      'Run up to 100 ordered operations in one agent round trip. Each entry is {op,args}. Optional tabId is inherited by each entry. Operations use controller names such as snapshot, act, navigate, evaluate, screenshot, api, cdp. Stops at the first error and returns completed results.',
    inputSchema: schema(
      {
        ...target,
        actions: {
          type: 'array',
          maxItems: 100,
          items: schema({ op: string, args: { type: 'object', additionalProperties: true } }, [
            'op',
          ]),
        },
      },
      ['actions'],
    ),
  },
];
export const pageOperations = new Set([
  'claim',
  'release',
  'navigate',
  'back',
  'reload',
  'focus',
  'close',
  'screenshot',
  'pdf',
  'key',
  'scroll',
  'wait',
  'dialog',
  'console',
  'network',
  'cookies',
]);

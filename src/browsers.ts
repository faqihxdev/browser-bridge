import { createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserDefinition, Config } from './config.js';
import { parseActivePort } from './endpoint.js';

export const browserFamilies = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    aliases: ['edge', 'msedge', 'microsoft edge'],
    windows: 'Microsoft/Edge/User Data',
    mac: 'Microsoft Edge',
    linux: 'microsoft-edge',
    scheme: 'edge',
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    aliases: ['chrome', 'google chrome'],
    windows: 'Google/Chrome/User Data',
    mac: 'Google/Chrome',
    linux: 'google-chrome',
    scheme: 'chrome',
  },
  {
    id: 'brave',
    name: 'Brave',
    aliases: ['brave', 'brave browser'],
    windows: 'BraveSoftware/Brave-Browser/User Data',
    mac: 'BraveSoftware/Brave-Browser',
    linux: 'BraveSoftware/Brave-Browser',
    scheme: 'brave',
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    aliases: ['vivaldi'],
    windows: 'Vivaldi/User Data',
    mac: 'Vivaldi',
    linux: 'vivaldi',
    scheme: 'vivaldi',
  },
  {
    id: 'opera',
    name: 'Opera',
    aliases: ['opera'],
    windows: 'Opera Software/Opera Stable',
    mac: 'com.operasoftware.Opera',
    linux: 'opera',
    scheme: 'opera',
  },
  {
    id: 'opera-gx',
    name: 'Opera GX',
    aliases: ['opera gx', 'opera-gx'],
    windows: 'Opera Software/Opera GX Stable',
    mac: 'com.operasoftware.OperaGX',
    linux: 'opera-gx',
    scheme: 'opera',
  },
  {
    id: 'chromium',
    name: 'Chromium',
    aliases: ['chromium'],
    windows: 'Chromium/User Data',
    mac: 'Chromium',
    linux: 'chromium',
    scheme: 'chrome',
  },
] as const;
export interface BrowserTarget {
  id: string;
  name: string;
  browser: string;
  aliases: string[];
  userDataDir?: string;
  endpoint?: string;
  installed: boolean;
  configured: boolean;
  setupUrl: string;
  error?: string;
}
export interface DiscoveryEnvironment {
  platform: string;
  home: string;
  local: string;
  roaming: string;
  config: string;
  scoop: string;
}
const environment = (): DiscoveryEnvironment => ({
  platform: process.platform,
  home: homedir(),
  local: process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  roaming: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  config: process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  scoop: process.env.SCOOP ?? join(homedir(), 'scoop'),
});
const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
export function browserRoots(env = environment()): { browser: string; root: string }[] {
  return browserFamilies.flatMap((family) => {
    const roots =
      env.platform === 'win32'
        ? [
            join(family.id.startsWith('opera') ? env.roaming : env.local, family.windows),
            join(env.scoop, 'persist', family.id, 'User Data'),
            join(env.scoop, 'apps', family.id, 'current', 'User Data'),
          ]
        : env.platform === 'darwin'
          ? [join(env.home, 'Library', 'Application Support', family.mac)]
          : [join(env.config, family.linux)];
    return roots.map((root) => ({ browser: family.id, root }));
  });
}
const isEndpoint = (value: string) => /^(?:https?|wss?):\/\//i.test(value);
function checkEndpoint(endpoint: string): string {
  if (!isEndpoint(endpoint)) throw new Error('CDP endpoint must use http, https, ws or wss.');
  new URL(endpoint);
  return endpoint;
}

export class BrowserRegistry {
  private targets: BrowserTarget[] = [];
  private updated = 0;
  private discovering?: Promise<BrowserTarget[]>;
  constructor(
    private config: Config,
    private env = environment(),
  ) {}
  async list(refresh = false): Promise<BrowserTarget[]> {
    if (!refresh && Date.now() - this.updated < 2000) return this.targets;
    if (this.discovering) return this.discovering;
    this.discovering = this.discover();
    try {
      this.targets = await this.discovering;
      this.updated = Date.now();
      return this.targets;
    } finally {
      this.discovering = undefined;
    }
  }
  private async discover(): Promise<BrowserTarget[]> {
    const configured: BrowserDefinition[] = [...(this.config.browsers ?? [])];
    if (
      isEndpoint(this.config.browser) &&
      !configured.some((item) => item.endpoint === this.config.browser)
    )
      configured.unshift({
        id: 'default',
        name: 'Configured browser',
        endpoint: this.config.browser,
      });
    const definitions = [
      ...configured.map((definition) => ({ definition, configured: true })),
      ...browserRoots(this.env).map(({ browser, root }) => ({
        definition: { id: '', browser, userDataDir: root } as BrowserDefinition,
        configured: false,
      })),
    ];
    const found = await Promise.all(
      definitions.map(async ({ definition, configured }): Promise<BrowserTarget | undefined> => {
        const family = browserFamilies.find((item) =>
          item.aliases.some((alias) => normalize(alias) === normalize(definition.browser ?? '')),
        );
        let root: string | undefined;
        let installed = false;
        if (definition.userDataDir) {
          try {
            root = await realpath(resolve(definition.userDataDir));
            installed = true;
          } catch {
            if (!configured) return undefined;
            root = resolve(definition.userDataDir);
          }
        }
        let endpoint = definition.endpoint && checkEndpoint(definition.endpoint);
        let issue: string | undefined;
        if (!endpoint && root) {
          try {
            endpoint = parseActivePort(await readFile(join(root, 'DevToolsActivePort'), 'utf8'));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              issue = 'DevToolsActivePort could not be read or is invalid.';
          }
        }
        if (!configured && !endpoint && !issue && root) {
          try {
            await access(join(root, 'Local State'));
          } catch {
            return undefined;
          }
        }
        const canonical = this.env.platform === 'win32' ? root?.toLowerCase() : root;
        const id =
          definition.id ||
          `${family!.id}-${createHash('sha256').update(canonical!).digest('hex').slice(0, 10)}`;
        return {
          id,
          name: definition.name ?? family?.name ?? definition.id,
          browser: family?.id ?? definition.browser ?? 'custom',
          aliases: [...(definition.aliases ?? []), ...(family?.aliases ?? [])],
          userDataDir: root,
          endpoint,
          installed,
          configured,
          setupUrl: `${family?.scheme ?? 'chrome'}://inspect/#remote-debugging`,
          error: issue,
        };
      }),
    );
    const targets: BrowserTarget[] = [];
    const identities = new Set<string>();
    for (const target of found) {
      if (!target) continue;
      const identity = target.userDataDir
        ? this.env.platform === 'win32'
          ? target.userDataDir.toLowerCase()
          : target.userDataDir
        : target.endpoint!;
      let endpointIdentity: string | undefined;
      if (target.endpoint) {
        const url = new URL(target.endpoint);
        endpointIdentity = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          ? `loopback:${url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80')}`
          : target.endpoint;
      }
      const keys = [identity, endpointIdentity].filter((key): key is string => !!key);
      if (keys.some((key) => identities.has(key))) {
        if (!target.configured) continue;
        throw new Error(
          `Browser ${target.id} duplicates another configured instance. Add an alias instead.`,
        );
      }
      for (const key of keys) identities.add(key);
      if (targets.some((item) => item.id === target.id))
        throw new Error(`Duplicate browser ID: ${target.id}.`);
      targets.push(target);
    }
    return targets;
  }
  async resolve(selector = this.config.browser): Promise<BrowserTarget> {
    const targets = await this.list();
    const key = normalize(selector);
    const endpointTarget = isEndpoint(selector)
      ? targets.find((target) => target.endpoint === selector)
      : undefined;
    const exact = endpointTarget ?? targets.find((target) => target.id === key);
    const matches = exact
      ? [exact]
      : targets.filter((target) =>
          [target.name, ...target.aliases].some((alias) => normalize(alias) === key),
        );
    if (!matches.length)
      throw new Error(
        `Browser "${selector}" was not found. Use browser_list; add a custom userDataDir or CDP endpoint in config.json for portable installs.`,
      );
    if (matches.length > 1)
      throw new Error(
        `Browser "${selector}" is ambiguous. Choose an ID: ${matches.map((target) => `${target.id} (${target.name})`).join(', ')}.`,
      );
    const target = matches[0]!;
    if (!target.endpoint)
      throw new Error(
        `${target.name} has no debugging endpoint. Enable remote debugging at ${target.setupUrl}, then refresh browser_list.`,
      );
    return target;
  }
}

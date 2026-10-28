import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BrowserRegistry, type DiscoveryEnvironment } from '../src/browsers.js';
import { BrowserManager } from '../src/manager.js';
import { defaults } from '../src/config.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-bridge-discovery-'));
  const env: DiscoveryEnvironment = {
    platform: 'win32',
    home: root,
    local: join(root, 'local'),
    roaming: join(root, 'roaming'),
    config: join(root, 'config'),
    scoop: join(root, 'scoop'),
  };
  const profile = async (path: string, port: number | string) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'DevToolsActivePort'), `${port}\n/devtools/browser/test-id`);
    return path;
  };
  return { root, env, profile };
}

test('discovery finds portable Brave, deduplicates its junction and isolates malformed endpoints', async () => {
  const { env, profile } = await fixture();
  const brave = await profile(join(env.scoop, 'persist', 'brave', 'User Data'), 59001);
  const current = join(env.scoop, 'apps', 'brave', 'current');
  await mkdir(current, { recursive: true });
  await symlink(brave, join(current, 'User Data'), 'junction');
  await profile(join(env.local, 'Microsoft', 'Edge', 'User Data'), 59002);
  await profile(join(env.local, 'Google', 'Chrome', 'User Data'), 'invalid');
  const registry = new BrowserRegistry(defaults, env);
  const browsers = await registry.list();
  assert.equal(browsers.filter((browser) => browser.browser === 'brave').length, 1);
  assert.equal(
    (await registry.resolve('Brave')).endpoint,
    'ws://127.0.0.1:59001/devtools/browser/test-id',
  );
  assert.equal(
    (await registry.resolve('Microsoft Edge')).endpoint,
    'ws://127.0.0.1:59002/devtools/browser/test-id',
  );
  assert.ok(browsers.find((browser) => browser.browser === 'chrome')?.error);
  await assert.rejects(registry.resolve('Chrome'), /no debugging endpoint/);
  const id = (await registry.resolve('Brave')).id;
  assert.equal(
    (await registry.list(true)).find((browser) => browser.id === id)?.userDataDir,
    brave,
  );
});

test('ambiguous browser names require explicit stable IDs and custom aliases address one instance', async () => {
  const { root, env, profile } = await fixture();
  await profile(join(env.local, 'BraveSoftware', 'Brave-Browser', 'User Data'), 59003);
  const work = await profile(join(root, 'work-profile'), 59004);
  const registry = new BrowserRegistry(
    {
      ...defaults,
      browsers: [
        {
          id: 'brave-work',
          name: 'Brave work',
          browser: 'brave',
          aliases: ['work'],
          userDataDir: work,
        },
      ],
    },
    env,
  );
  await assert.rejects(registry.resolve('Brave'), /ambiguous.*brave-work/);
  assert.equal((await registry.resolve('work')).id, 'brave-work');
  assert.equal((await registry.resolve('Brave work')).id, 'brave-work');
  assert.equal(
    (await registry.resolve('brave-work')).endpoint,
    'ws://127.0.0.1:59004/devtools/browser/test-id',
  );
});

test('one endpoint has one identity even when configured with HTTP and discovered with WebSocket', async () => {
  const { env, profile } = await fixture();
  await profile(join(env.local, 'Microsoft', 'Edge', 'User Data'), 59005);
  const registry = new BrowserRegistry(
    {
      ...defaults,
      browser: 'daily',
      browsers: [
        { id: 'daily', name: 'Daily browser', browser: 'edge', endpoint: 'http://localhost:59005' },
      ],
    },
    env,
  );
  assert.equal((await registry.list()).length, 1);
  assert.equal((await registry.resolve('Edge')).id, 'daily');
  const legacy = new BrowserRegistry({ ...defaults, browser: 'http://localhost:59005' }, env);
  assert.equal((await legacy.resolve('Edge')).id, 'default');
  const duplicate = new BrowserRegistry(
    {
      ...defaults,
      browser: 'daily',
      browsers: [
        { id: 'daily', endpoint: 'http://localhost:59005' },
        { id: 'copy', endpoint: 'ws://127.0.0.1:59005/devtools/browser/test' },
      ],
    },
    env,
  );
  await assert.rejects(duplicate.list(), /duplicates another configured instance/);
});

test('discovery distinguishes a listening browser from its stale endpoint file without attaching', async () => {
  const { env, profile } = await fixture();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await profile(join(env.local, 'BraveSoftware', 'Brave-Browser', 'User Data'), port);
  const manager = new BrowserManager(
    { ...defaults, browser: 'Brave' },
    async () => {
      throw new Error('No extension expected');
    },
    new BrowserRegistry(defaults, env),
  );
  const session = { id: 'discovery', label: 'Discovery test', role: 'agent', active: true };
  try {
    const live = (await manager.execute(session, 'browsers', {})) as {
      browsers: { endpointFound: boolean; listening: boolean; connected: boolean }[];
    };
    assert.equal(live.browsers[0]!.endpointFound, true);
    assert.equal(live.browsers[0]!.listening, true);
    assert.equal(live.browsers[0]!.connected, false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const stale = (await manager.execute(session, 'browsers', { refresh: false })) as typeof live;
    assert.equal(stale.browsers[0]!.endpointFound, true);
    assert.equal(stale.browsers[0]!.listening, false);
  } finally {
    server.close();
    await manager.dispose();
  }
});

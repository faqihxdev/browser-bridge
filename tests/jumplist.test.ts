import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { maintainJumpList, taskArguments } from '../src/jumplist.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Taskbar repair did not finish.');
    await delay(10);
  }
}

test('taskbar launches regain debugging flags after browser rewrites without a feedback loop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-bridge-jumplist-'));
  const settings = {
    appId: 'BrowserBridge.Test',
    cacheFile: join(root, 'tasks'),
    executable: 'C:\\Browser\\brave.exe',
    arguments: '--user-data-dir="C:\\Browser Profile" --remote-debugging-port=19225',
  };
  let commits = 0;
  const errors: Error[] = [];
  const repair = await maintainJumpList(settings, {
    delayMs: 10,
    report: (error) => errors.push(error),
    publish: async () => {
      await writeFile(
        settings.cacheFile,
        Buffer.from(taskArguments(settings).join('\0'), 'utf16le'),
      );
      commits++;
    },
  });
  t.after(async () => {
    await repair.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(commits, 1);
  await delay(80);
  assert.equal(commits, 1, 'The shell commit must not republish itself.');
  await writeFile(
    settings.cacheFile,
    Buffer.from('--user-data-dir="C:\\Browser Profile"', 'utf16le'),
  );
  await until(() => commits === 2);
  const content = (await readFile(settings.cacheFile)).toString('utf16le');
  assert.ok(content.includes('--remote-debugging-port=19225 --new-window'));
  assert.ok(content.includes('--remote-debugging-port=19225 --incognito --new-window'));
  await delay(80);
  assert.equal(commits, 2);
  assert.deepEqual(errors, []);
  await repair.close();
  await writeFile(settings.cacheFile, 'closed');
  await delay(80);
  assert.equal(commits, 2, 'Shutdown must release the watcher.');
});

test('failed shell updates report errors and recover on a later browser write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-bridge-jumplist-error-'));
  const settings = {
    appId: 'BrowserBridge.Test',
    cacheFile: join(root, 'tasks'),
    executable: 'C:\\Browser\\brave.exe',
    arguments: '--remote-debugging-port=19225',
  };
  let attempts = 0;
  const errors: Error[] = [];
  const repair = await maintainJumpList(settings, {
    delayMs: 10,
    report: (error) => errors.push(error),
    publish: async () => {
      if (++attempts === 1) throw new Error('Shell busy');
      await writeFile(
        settings.cacheFile,
        Buffer.from(taskArguments(settings).join('\0'), 'utf16le'),
      );
    },
  });
  t.after(async () => {
    await repair.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(errors[0]?.message, 'Shell busy');
  await delay(80);
  assert.equal(attempts, 1, 'Failure alone must not start a retry loop.');
  await writeFile(settings.cacheFile, 'browser update');
  await until(() => attempts === 2);
  await delay(80);
  assert.equal(attempts, 2);
});

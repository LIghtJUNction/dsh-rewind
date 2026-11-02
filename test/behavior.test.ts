import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as plugin from '../src/index.js';
import { createHost } from './host.js';

function value(result: Awaited<ReturnType<Awaited<ReturnType<typeof createHost>>['execute']>>) {
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok('value' in result && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value));
  return result.value;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rewind-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'tracked'), 'initial\n');
  git('add', '--', 'tracked'); git('commit', '-qm', 'initial');
  const host = await createHost(root);
  await host.ctx.plugin(plugin, { root });
  return { root, git, host, close: async () => { await host.close(); await rm(root, { recursive: true, force: true }); } };
}

test('checkpoints persist in Git; restore/redo keep HEAD, index, unrelated dirty and untracked bytes', async t => {
  const { root, git, host, close } = await setup(); t.after(close);
  await writeFile(join(root, 'tracked'), 'staged\n'); git('add', '--', 'tracked');
  await writeFile(join(root, 'tracked'), 'dirty baseline\n');
  await writeFile(join(root, 'other'), 'unrelated dirty data');
  const index = await readFile(join(root, '.git/index'));
  const head = git('rev-parse', 'HEAD');
  const cp = value(await host.execute('rewind', { action: 'checkpoint', paths: ['tracked'] }));
  assert.ok(typeof cp.id === 'string');
  await writeFile(join(root, 'tracked'), 'agent modification\n');
  await writeFile(join(root, 'new-untracked'), 'preserve');
  const preview = value(await host.execute('rewind', { action: 'preview', id: cp.id }));
  assert.ok(Array.isArray(preview.files) && preview.files.length === 1);
  const restored = value(await host.execute('rewind', { action: 'restore', id: cp.id, token: preview.token }));
  assert.equal(await readFile(join(root, 'tracked'), 'utf8'), 'dirty baseline\n');
  assert.equal(await readFile(join(root, 'other'), 'utf8'), 'unrelated dirty data');
  assert.equal(await readFile(join(root, 'new-untracked'), 'utf8'), 'preserve');
  assert.deepEqual(await readFile(join(root, '.git/index')), index);
  assert.equal(git('rev-parse', 'HEAD'), head);
  const redo = value(await host.execute('rewind', { action: 'preview', id: restored.backupId }));
  value(await host.execute('rewind', { action: 'restore', id: restored.backupId, token: redo.token }));
  assert.equal(await readFile(join(root, 'tracked'), 'utf8'), 'agent modification\n');
  assert.deepEqual(await readFile(join(root, '.git/index')), index);
  const fresh = await createHost(root); t.after(() => fresh.close());
  await fresh.ctx.plugin(plugin, { root });
  const listed = value(await fresh.execute('rewind', { action: 'list' }));
  assert.ok(typeof cp.id === 'string');
  assert.ok(Array.isArray(listed.ids) && listed.ids.includes(cp.id));
});

test('rejects stale previews, branch changes, symlink traversal and metadata paths without mutation', async t => {
  const { root, git, host, close } = await setup(); t.after(close);
  const cp = value(await host.execute('rewind', { action: 'checkpoint', paths: ['tracked'] }));
  const preview = value(await host.execute('rewind', { action: 'preview', id: cp.id }));
  await writeFile(join(root, 'tracked'), 'human edit');
  assert.equal((await host.execute('rewind', { action: 'restore', id: cp.id, token: preview.token })).isError, true);
  assert.equal(await readFile(join(root, 'tracked'), 'utf8'), 'human edit');
  await symlink('/tmp', join(root, 'escape'));
  for (const paths of [['escape'], ['.git/config'], ['../missing'], ['tracked', './tracked']]) {
    assert.equal((await host.execute('rewind', { action: 'checkpoint', paths })).isError, true);
  }
  git('checkout', '-qb', 'other-branch');
  assert.equal((await host.execute('rewind', { action: 'preview', id: cp.id })).isError, true);
  assert.equal((await host.execute('rewind', { action: 'preview', id: '--help' })).isError, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await host.execute('rewind', { action: 'checkpoint', paths: ['tracked'] }, controller.signal)).isError, true);
});

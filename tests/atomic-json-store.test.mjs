import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
  AtomicJsonStore,
  AtomicJsonStoreCorruptError
} from '../src/main/services/atomic-json-store.ts';

const emptyStore = () => ({ version: 1, workspaces: {} });

function validateStore(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    value.workspaces === null ||
    typeof value.workspaces !== 'object' ||
    Array.isArray(value.workspaces)
  ) {
    throw new TypeError('存储结构无效');
  }
  return value;
}

async function makeStorePath(context) {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-atomic-store-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'workspace-model-settings.json');
}

test('returns a fresh empty store only when both main and backup are missing', async (context) => {
  const path = await makeStorePath(context);
  const store = new AtomicJsonStore(path, validateStore, emptyStore);

  const first = await store.read();
  first.workspaces.changed = {};
  assert.deepEqual(await store.read(), emptyStore());
});

test('reads a valid backup without replacing a corrupt main file', async (context) => {
  const path = await makeStorePath(context);
  await writeFile(path, '{broken', 'utf8');
  await writeFile(`${path}.bak`, JSON.stringify({ version: 1, workspaces: { safe: {} } }), 'utf8');
  const store = new AtomicJsonStore(path, validateStore, emptyStore);

  assert.deepEqual(await store.read(), { version: 1, workspaces: { safe: {} } });
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('throws a dedicated error and preserves files when main and backup are corrupt', async (context) => {
  const path = await makeStorePath(context);
  await writeFile(path, '{main-broken', 'utf8');
  await writeFile(`${path}.bak`, '{backup-broken', 'utf8');
  const store = new AtomicJsonStore(path, validateStore, emptyStore);

  await assert.rejects(store.read(), (error) => {
    assert.ok(error instanceof AtomicJsonStoreCorruptError);
    assert.equal(error.storagePath, path);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), '{main-broken');
  assert.equal(await readFile(`${path}.bak`, 'utf8'), '{backup-broken');
});

test('does not fall back to a backup when reading the main file has an I/O error', async (context) => {
  const path = await makeStorePath(context);
  await writeFile(`${path}.bak`, JSON.stringify({ version: 1, workspaces: { stale: {} } }), 'utf8');
  const accessError = Object.assign(new Error('access denied'), { code: 'EACCES' });
  const store = new AtomicJsonStore(path, validateStore, emptyStore, async (requestedPath, encoding) => {
    if (requestedPath === path) {
      throw accessError;
    }
    return readFile(requestedPath, encoding);
  });

  await assert.rejects(store.read(), (error) => error === accessError);
});

test('preserves a backup I/O error after the main file is corrupt', async (context) => {
  const path = await makeStorePath(context);
  await writeFile(path, '{broken', 'utf8');
  const accessError = Object.assign(new Error('backup access denied'), { code: 'EACCES' });
  const store = new AtomicJsonStore(path, validateStore, emptyStore, async (requestedPath, encoding) => {
    if (requestedPath === `${path}.bak`) {
      throw accessError;
    }
    return readFile(requestedPath, encoding);
  });

  await assert.rejects(store.read(), (error) => error === accessError);
});

test('writes through a same-directory unique temp file and keeps a valid backup', async (context) => {
  const path = await makeStorePath(context);
  const store = new AtomicJsonStore(path, validateStore, emptyStore);
  const first = { version: 1, workspaces: { first: { model: 'a' } } };
  const second = { version: 1, workspaces: { second: { model: 'b' } } };

  await store.write(first);
  await store.write(second);

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), second);
  assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')), first);
  const files = await readdir(dirname(path));
  assert.deepEqual(files.sort(), [basename(path), `${basename(path)}.bak`].sort());
});

test('serializes concurrent updates so fields are not lost', async (context) => {
  const path = await makeStorePath(context);
  const store = new AtomicJsonStore(path, validateStore, emptyStore);

  await Promise.all([
    store.update((value) => {
      value.workspaces.alpha = { model: 'alpha' };
    }),
    store.update((value) => {
      value.workspaces.beta = { model: 'beta' };
    })
  ]);

  assert.deepEqual((await store.read()).workspaces, {
    alpha: { model: 'alpha' },
    beta: { model: 'beta' }
  });
});

test('continues queued updates after one update fails', async (context) => {
  const path = await makeStorePath(context);
  const store = new AtomicJsonStore(path, validateStore, emptyStore);

  await assert.rejects(
    store.update(() => {
      throw new Error('模拟更新失败');
    }),
    /模拟更新失败/
  );
  await store.update((value) => {
    value.workspaces.recovered = { model: 'deepseek-chat' };
  });

  assert.deepEqual((await store.read()).workspaces, {
    recovered: { model: 'deepseek-chat' }
  });
});

test('a failed write leaves the previous main file untouched', async (context) => {
  const path = await makeStorePath(context);
  const store = new AtomicJsonStore(path, validateStore, emptyStore);
  const original = { version: 1, workspaces: { safe: {} } };
  await store.write(original);

  // BigInt 无法序列化，用于模拟临时文件落盘前的写入失败。
  await assert.rejects(store.write({ version: 1, workspaces: { broken: 1n } }), /BigInt/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
});

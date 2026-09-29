import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ModulePreloadCacheStore } from '../src/main/services/module-preload-cache.store.ts';

function readySnapshot(moduleKey) {
  return {
    moduleKey,
    moduleName: 'orders',
    modulePath: 'D:\\work\\orders',
    state: 'READY',
    fingerprint: 'a'.repeat(64),
    executionDataPath: 'D:\\work\\orders\\target\\preload.exec',
    classReportPairs: {
      'com.example.Order': {
        qualifiedClassName: 'com.example.Order',
        fingerprint: 'a'.repeat(64),
        executionDataPath: 'D:\\work\\orders\\target\\preload.exec',
        reportPairId: 'b'.repeat(64),
        reportPath: 'D:\\work\\orders\\target\\Order.xml',
        branchSnapshotPath: 'D:\\work\\orders\\target\\Order.branches.json',
        generatedAt: '2026-08-09T01:02:03.000Z'
      }
    },
    classPreloadFailures: {},
    diagnostic: null,
    updatedAt: '2026-08-09T01:02:03.000Z'
  };
}

test('persists bounded serializable module snapshots and class pairs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'module-preload-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'cache.json');
  const first = new ModulePreloadCacheStore(storagePath);
  const snapshot = readySnapshot('module-a');

  await first.set(snapshot);
  const reopened = new ModulePreloadCacheStore(storagePath);

  assert.deepEqual(await reopened.get('module-a'), snapshot);
  assert.deepEqual(JSON.parse(await readFile(storagePath, 'utf8')), {
    version: 1,
    modules: { 'module-a': snapshot }
  });
});

test('loads legacy class pairs by inheriting their module execution data path', async (t) => {
  // Mutation caught: requiring the new pair-level field makes existing user caches unreadable.
  const directory = await mkdtemp(join(tmpdir(), 'module-preload-cache-legacy-pair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storagePath = join(directory, 'cache.json');
  const snapshot = readySnapshot('module-a');
  const legacyPair = { ...snapshot.classReportPairs['com.example.Order'] };
  delete legacyPair.executionDataPath;
  await writeFile(storagePath, JSON.stringify({
    version: 1,
    modules: {
      'module-a': {
        ...snapshot,
        classReportPairs: { 'com.example.Order': legacyPair }
      }
    }
  }), 'utf8');

  const cache = new ModulePreloadCacheStore(storagePath);
  const loaded = await cache.get('module-a');

  assert.equal(
    loaded.classReportPairs['com.example.Order'].executionDataPath,
    'D:\\work\\orders\\target\\preload.exec'
  );
});

test('persists an IDLE snapshot with the fingerprint of a manually stopped preload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'module-preload-stopped-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new ModulePreloadCacheStore(join(directory, 'cache.json'));
  const snapshot = {
    ...readySnapshot('module-a'),
    state: 'IDLE',
    executionDataPath: null,
    classReportPairs: {},
    diagnostic: null
  };

  await cache.set(snapshot);

  assert.deepEqual(await cache.get('module-a'), snapshot);
});

test('rejects runtime handles, source text, secrets, and unbounded diagnostics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'module-preload-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new ModulePreloadCacheStore(join(directory, 'cache.json'));
  const snapshot = readySnapshot('module-a');

  await assert.rejects(
    cache.set({ ...snapshot, processHandle: { pid: 42 } }),
    /字段|field/i
  );
  await assert.rejects(
    cache.set({
      ...snapshot,
      diagnostic: {
        command: 'mvn',
        exitCode: 1,
        summary: 'x'.repeat(20_000),
        repairInstruction: '请修复该模块后重新检测。'
      }
    }),
    /诊断|diagnostic/i
  );
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  JacocoArtifactsService
} from '../src/main/services/jacoco-artifacts.service.ts';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function writePair(paths, label) {
  const report = Buffer.from(`<report name="${label}"/>`, 'utf8');
  const pairId = sha256(`pair:${label}`);
  await writeFile(paths.reportPath, report);
  await writeFile(
    paths.branchSnapshotPath,
    JSON.stringify({
      schemaVersion: 1,
      pairId,
      targetClass: 'com.example.Target',
      targetSourceSha256: sha256('source'),
      targetClassSha256: sha256('class'),
      executionDataSha256: sha256(label),
      reportSha256: sha256(report),
      methods: []
    }),
    'utf8'
  );
  return { ...paths, pairId };
}

test('derives an XML and branches JSON path for every coverage artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-pair-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new JacocoArtifactsService();
  const paths = service.paths(root);

  assert.equal(paths.standard.reportPath.endsWith('site\\jacoco\\jacoco.xml') || paths.standard.reportPath.endsWith('site/jacoco/jacoco.xml'), true);
  assert.equal(paths.standard.branchSnapshotPath.endsWith('jacoco.branches.json'), true);
  assert.equal(paths.baseline.reportPath.endsWith('baseline.xml'), true);
  assert.equal(paths.baseline.branchSnapshotPath.endsWith('baseline.branches.json'), true);
  assert.equal(paths.best.reportPath.endsWith('best.xml'), true);
  assert.equal(paths.best.branchSnapshotPath.endsWith('best.branches.json'), true);
  assert.equal(paths.after.reportPath.endsWith('after.xml'), true);
  assert.equal(paths.after.branchSnapshotPath.endsWith('after.branches.json'), true);

  const iterationId = randomUUID();
  const iteration = await service.prepareIteration(root, iterationId);
  assert.equal(iteration.iteration.reportPath.endsWith(`${iterationId}.xml`), true);
  assert.equal(iteration.iteration.branchSnapshotPath.endsWith(`${iterationId}.branches.json`), true);
});

test('publishes and revokes XML and branch snapshots as one validated pair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-pair-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new JacocoArtifactsService();
  const paths = await service.prepareBaseline(root);
  const baseline = await writePair(paths.baseline, 'baseline');

  const publishedBaseline = await service.publishBaseline(root, baseline);
  assert.deepEqual(publishedBaseline, {
    ...paths.standard,
    pairId: baseline.pairId
  });

  const after = await writePair(paths.after, 'after');
  await service.publishAfter(root, after);
  assert.equal(await readFile(paths.standard.reportPath, 'utf8'), '<report name="after"/>');
  assert.equal(
    JSON.parse(await readFile(paths.standard.branchSnapshotPath, 'utf8')).pairId,
    after.pairId
  );

  await service.revoke(root);
  assert.equal(await readFile(paths.standard.reportPath, 'utf8'), '<report name="baseline"/>');
  assert.equal(
    JSON.parse(await readFile(paths.standard.branchSnapshotPath, 'utf8')).pairId,
    baseline.pairId
  );
});

test('continues with the session pair when IDEA locks the published branch snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-pair-locked-standard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = new JacocoArtifactsService().paths(root);
  await fs.mkdir(paths.standardReportDirectory, { recursive: true });
  const published = await writePair(paths.standard, 'published');

  const busy = (operation) => Object.assign(
    new Error(`injected IDEA lock during ${operation}`),
    { code: 'EBUSY' }
  );
  const lockedFileSystem = {
    ...fs,
    rm: async (path, options) => {
      if (path === paths.standardReportDirectory) {
        throw busy('standard report cleanup');
      }
      return fs.rm(path, options);
    },
    rename: async (source, destination) => {
      if (source === paths.standard.branchSnapshotPath) {
        throw busy('published snapshot replacement');
      }
      return fs.rename(source, destination);
    }
  };
  const service = new JacocoArtifactsService(lockedFileSystem);

  const prepared = await service.prepareBaseline(root);
  const baseline = await writePair(prepared.baseline, 'baseline');
  const active = await service.publishBaseline(root, baseline);

  assert.deepEqual(active, baseline);
  assert.equal(
    await readFile(paths.standard.reportPath, 'utf8'),
    '<report name="published"/>'
  );
  assert.equal(
    JSON.parse(await readFile(paths.standard.branchSnapshotPath, 'utf8')).pairId,
    published.pairId
  );
});

test('rejects a mismatched source pair without changing the published pair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-pair-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new JacocoArtifactsService();
  const paths = await service.prepareBaseline(root);
  const baseline = await writePair(paths.baseline, 'baseline');
  await service.publishBaseline(root, baseline);
  const after = await writePair(paths.after, 'after');
  const snapshot = JSON.parse(await readFile(after.branchSnapshotPath, 'utf8'));
  snapshot.reportSha256 = sha256('different-report');
  await writeFile(after.branchSnapshotPath, JSON.stringify(snapshot), 'utf8');

  await assert.rejects(
    service.publishAfter(root, after),
    /摘要|配对/
  );
  assert.equal(await readFile(paths.standard.reportPath, 'utf8'), '<report name="baseline"/>');
  assert.equal(
    JSON.parse(await readFile(paths.standard.branchSnapshotPath, 'utf8')).pairId,
    baseline.pairId
  );
});

test('restores both previously published files when the second commit rename fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-pair-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new JacocoArtifactsService();
  const paths = await service.prepareBaseline(root);
  const baseline = await writePair(paths.baseline, 'baseline');
  await service.publishBaseline(root, baseline);
  const after = await writePair(paths.after, 'after');

  let failSnapshotCommit = true;
  const failingFileSystem = {
    ...fs,
    rename: async (source, destination) => {
      if (
        failSnapshotCommit
        && destination === paths.standard.branchSnapshotPath
        && String(source).includes('.tmp')
      ) {
        failSnapshotCommit = false;
        throw new Error('injected snapshot commit failure');
      }
      return fs.rename(source, destination);
    }
  };
  const failingService = new JacocoArtifactsService(failingFileSystem);

  await assert.rejects(
    failingService.publishAfter(root, after),
    /injected snapshot commit failure/
  );
  assert.equal(await readFile(paths.standard.reportPath, 'utf8'), '<report name="baseline"/>');
  assert.equal(
    JSON.parse(await readFile(paths.standard.branchSnapshotPath, 'utf8')).pairId,
    baseline.pairId
  );
  assert.deepEqual(
    (await readdir(paths.standardReportDirectory)).filter((name) =>
      name.includes('.tmp') || name.includes('.bak')
    ),
    []
  );
});

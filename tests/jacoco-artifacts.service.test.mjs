import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { JacocoArtifactsService } from '../src/main/services/jacoco-artifacts.service.ts';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('an artifact namespace isolates real-boundary runs from workstation cache paths', () => {
  const moduleRoot = 'D:\\workspace\\module-a';
  const fingerprint = 'a'.repeat(64);
  const taskId = '11111111-1111-4111-8111-111111111111';
  const persistent = new JacocoArtifactsService();
  const isolated = new JacocoArtifactsService(undefined, 'real-boundary-run');

  assert.notEqual(
    isolated.modulePreloadPaths(moduleRoot, fingerprint).versionDirectory,
    persistent.modulePreloadPaths(moduleRoot, fingerprint).versionDirectory
  );
  assert.notEqual(
    isolated.taskSessionPaths(moduleRoot, taskId).taskDirectory,
    persistent.taskSessionPaths(moduleRoot, taskId).taskDirectory
  );
  assert.notEqual(
    isolated.paths(moduleRoot).transactionDirectory,
    persistent.paths(moduleRoot).transactionDirectory
  );
  assert.match(
    isolated.modulePreloadPaths(moduleRoot, fingerprint).versionDirectory,
    /[\\/]ai-unit-test[\\/]scopes[\\/]real-boundary-run[\\/]jacoco[\\/]preload[\\/]/
  );
  assert.throws(
    () => new JacocoArtifactsService(undefined, '..\\escape'),
    /namespace/i
  );
});

async function writePair(paths, label) {
  const report = Buffer.from(label, 'utf8');
  const pairId = sha256(`pair:${label}`);
  await writeFile(paths.reportPath, report);
  await writeFile(paths.branchSnapshotPath, JSON.stringify({
    schemaVersion: 1,
    pairId,
    reportSha256: sha256(report)
  }));
  return { ...paths, pairId };
}

async function writeCoveragePair(paths) {
  const report = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<report name="com.example.TaskService">
  <package name="com/example">
    <class name="com/example/TaskService" sourcefilename="TaskService.java">
      <counter type="BRANCH" missed="1" covered="1"/>
      <counter type="LINE" missed="1" covered="1"/>
    </class>
    <sourcefile name="TaskService.java">
      <line nr="10" mi="0" ci="2" mb="1" cb="1"/>
      <line nr="11" mi="1" ci="0" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`, 'utf8');
  const pairId = sha256('pair:unreliable-mapping');
  await mkdir(dirname(paths.reportPath), { recursive: true });
  await writeFile(paths.reportPath, report);
  await writeFile(paths.branchSnapshotPath, JSON.stringify({
    schemaVersion: 1,
    pairId,
    targetClass: 'com.example.TaskService',
    reportSha256: sha256(report),
    methods: [{
      mappingStatus: 'UNRELIABLE',
      targets: [
        {
          kind: 'LINE_EXECUTE',
          sourceLine: 10,
          covered: false
        },
        {
          kind: 'LINE_EXECUTE',
          sourceLine: 11,
          covered: false
        },
        {
          kind: 'LINE_EXECUTE',
          sourceLine: 12,
          covered: false
        },
        ...Array.from({ length: 4 }, (_, index) => ({
          kind: 'BRANCH',
          targetId: `unreliable-branch-${index}`,
          covered: false
        }))
      ]
    }]
  }));
  return { ...paths, pairId };
}

test('cleans session artifacts without deleting compiled classes or the published report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-artifacts-'));
  try {
    const service = new JacocoArtifactsService();
    const paths = service.paths(root);
    const classFile = join(paths.targetDirectory, 'classes', 'com', 'example', 'Order.class');
    await mkdir(join(paths.standardReportDirectory), { recursive: true });
    await mkdir(dirname(classFile), { recursive: true });
    await writeFile(paths.executionDataPath, 'old exec');
    await writeFile(paths.standard.reportPath, 'old report');
    await writeFile(classFile, 'compiled');

    await service.prepareBaseline(root);

    await access(classFile);
    await assert.rejects(access(paths.executionDataPath));
    assert.equal(await readFile(paths.standard.reportPath, 'utf8'), 'old report');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes after report and restores baseline on revoke', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-transaction-'));
  try {
    const service = new JacocoArtifactsService();
    const paths = await service.prepareBaseline(root);
    const baseline = await writePair(paths.baseline, 'baseline');
    await service.publishBaseline(root, baseline);
    const after = await writePair(paths.after, 'after');
    await service.publishAfter(root, after);
    assert.equal(await readFile(paths.standard.reportPath, 'utf8'), 'after');

    await service.revoke(root);

    assert.equal(await readFile(paths.standard.reportPath, 'utf8'), 'baseline');
    await assert.rejects(access(paths.transactionDirectory));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses JaCoCo XML identities when conservative branch mappings differ from exact counters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jacoco-exact-coverage-'));
  try {
    const service = new JacocoArtifactsService();
    const pair = await writeCoveragePair({
      reportPath: join(root, 'target', 'TaskService.xml'),
      branchSnapshotPath: join(root, 'target', 'TaskService.branches.json')
    });

    const coverage = await service.readExactCoverageSnapshot(
      root,
      pair,
      {
        lineCovered: 1,
        lineMissed: 1,
        lineTotal: 2,
        branchCovered: 1,
        branchMissed: 1,
        branchTotal: 2
      },
      'com.example.TaskService'
    );

    assert.deepEqual(coverage.lineIds, ['L10', 'L11']);
    assert.deepEqual(coverage.coveredLineIds, ['L10']);
    assert.deepEqual(coverage.branchIds, ['L10:B0', 'L10:B1']);
    assert.deepEqual(coverage.coveredBranchIds, ['L10:B0']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

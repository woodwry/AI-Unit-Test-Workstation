import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GeneratedTestTransactionService
} from '../src/main/services/generated-test-transaction.service.ts';
import {
  TestWriterService
} from '../src/main/services/test-writer.service.ts';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function writeCoveragePair(reportPath, branchSnapshotPath, label) {
  const report = Buffer.from(`<report name="${label}"/>`, 'utf8');
  const pairId = sha256(`pair:${label}`);
  await writeFile(reportPath, report);
  await writeFile(branchSnapshotPath, JSON.stringify({
    schemaVersion: 1,
    pairId,
    targetClass: 'com.example.TaskService',
    targetSourceSha256: sha256('source'),
    targetClassSha256: sha256('class'),
    executionDataSha256: sha256(label),
    reportSha256: sha256(report),
    methods: []
  }), 'utf8');
  return { reportPath, branchSnapshotPath, pairId };
}

async function createHarness(t, prefix, wrapWriter = (writer) => writer) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const targetFilePath = join(
    workspaceRoot,
    'module',
    'src',
    'main',
    'java',
    'com',
    'example',
    'TaskService.java'
  );
  const reportPath = join(
    workspaceRoot,
    'module',
    'target',
    'site',
    'jacoco',
    'jacoco.xml'
  );
  const branchSnapshotPath = join(
    workspaceRoot,
    'module',
    'target',
    'site',
    'jacoco',
    'jacoco.branches.json'
  );
  await mkdir(join(targetFilePath, '..'), { recursive: true });
  await mkdir(join(reportPath, '..'), { recursive: true });
  await writeFile(targetFilePath, 'package com.example;\nclass TaskService {}\n');
  const baselineArtifacts = await writeCoveragePair(
    reportPath,
    branchSnapshotPath,
    'baseline'
  );

  const writer = new TestWriterService();
  const transaction = new GeneratedTestTransactionService(wrapWriter(writer));
  transaction.begin({
    workspaceRoot,
    baselineCoverage: { reportFound: true }
  });
  await transaction.initializeBaselineArtifacts(baselineArtifacts);
  return {
    workspaceRoot,
    targetFilePath,
    reportPath,
    branchSnapshotPath,
    baselineArtifacts,
    writer,
    transaction
  };
}

async function promoteRound(harness, round) {
  const prepared = await harness.writer.prepareGeneratedTest({
    workspaceRoot: harness.workspaceRoot,
    targetFilePath: harness.targetFilePath,
    content: [
      'package com.example;',
      '',
      'class DraftTest {',
      `    void round${round}Only() {}`,
      '}',
      ''
    ].join('\n')
  });
  const candidateId = randomUUID();
  const staged = await harness.transaction.stageCandidate({
    candidateId,
    prepared
  });
  const artifacts = await writeCoveragePair(
    join(harness.workspaceRoot, 'module', 'target', `round-${round}.xml`),
    join(harness.workspaceRoot, 'module', 'target', `round-${round}.branches.json`),
    `round-${round}`
  );
  await harness.transaction.promoteCandidate(
    candidateId,
    { reportFound: true, coveredLines: round },
    artifacts
  );
  return staged;
}

test('多轮晋升保留全部正式文件且回滚只删除当前轮候选', async (t) => {
  const harness = await createHarness(t, 'multi-round-accept-');
  const first = await promoteRound(harness, 1);
  const second = await promoteRound(harness, 2);

  assert.deepEqual(
    harness.transaction.snapshot().map((file) => file.testClassName),
    ['TaskServiceTest', 'TaskService1Test']
  );

  const thirdPrepared = await harness.writer.prepareGeneratedTest({
    workspaceRoot: harness.workspaceRoot,
    targetFilePath: harness.targetFilePath,
    content: 'package com.example;\nclass DraftTest { void round3Only() {} }\n'
  });
  const thirdId = randomUUID();
  const third = await harness.transaction.stageCandidate({
    candidateId: thirdId,
    prepared: thirdPrepared
  });
  await harness.transaction.rollbackCandidate(thirdId);

  await assert.rejects(access(third.filePath));
  await access(first.filePath);
  await access(second.filePath);
  const accepted = await harness.transaction.accept();
  assert.deepEqual(
    accepted.map((file) => [file.testClassName, file.state]),
    [
      ['TaskServiceTest', 'accepted'],
      ['TaskService1Test', 'accepted']
    ]
  );
});

test('撤销多轮事务删除全部正式文件并恢复基线报告', async (t) => {
  const harness = await createHarness(t, 'multi-round-revoke-');
  const first = await promoteRound(harness, 1);
  const second = await promoteRound(harness, 2);

  const revoked = await harness.transaction.revoke();

  await assert.rejects(access(first.filePath));
  await assert.rejects(access(second.filePath));
  assert.deepEqual(
    revoked.files.map((file) => [file.testClassName, file.state]),
    [
      ['TaskServiceTest', 'revoked'],
      ['TaskService1Test', 'revoked']
    ]
  );
  assert.equal(
    await readFile(harness.reportPath, 'utf8'),
    '<report name="baseline"/>'
  );
  assert.equal(
    JSON.parse(await readFile(harness.branchSnapshotPath, 'utf8')).pairId,
    harness.baselineArtifacts.pairId
  );
  assert.deepEqual(revoked.preservedExternallyModifiedFilePaths, []);
});

test('接受后仍可撤回并保留用户修改过的正式文件', async (t) => {
  const harness = await createHarness(t, 'accepted-revoke-conflict-');
  const first = await promoteRound(harness, 1);
  const second = await promoteRound(harness, 2);
  await harness.transaction.accept();
  const userContent = 'package com.example;\nclass TaskServiceTest { void userEdit() {} }\n';
  await writeFile(first.filePath, userContent, 'utf8');

  const revoked = await harness.transaction.revoke();

  assert.equal(await readFile(first.filePath, 'utf8'), userContent);
  await assert.rejects(
    access(second.filePath),
    (error) => error?.code === 'ENOENT'
  );
  assert.deepEqual(
    revoked.files.map((file) => file.state),
    ['revoked', 'revoked']
  );
  assert.deepEqual(
    revoked.preservedExternallyModifiedFilePaths,
    [first.filePath]
  );
  assert.equal(
    await readFile(harness.reportPath, 'utf8'),
    '<report name="baseline"/>'
  );
});

test('撤回时忽略已经不存在的正式生成文件并继续删除其余文件', async (t) => {
  const harness = await createHarness(t, 'revoke-missing-file-');
  const first = await promoteRound(harness, 1);
  const second = await promoteRound(harness, 2);
  await rm(first.filePath, { force: true });

  const revoked = await harness.transaction.revoke();

  await assert.rejects(
    access(second.filePath),
    (error) => error?.code === 'ENOENT'
  );
  assert.deepEqual(
    revoked.files.map((file) => file.state),
    ['revoked', 'revoked']
  );
  assert.deepEqual(revoked.preservedExternallyModifiedFilePaths, []);
});

test('撤回时当前候选文件已经不存在也直接完成撤回', async (t) => {
  const harness = await createHarness(t, 'revoke-missing-candidate-');
  const prepared = await harness.writer.prepareGeneratedTest({
    workspaceRoot: harness.workspaceRoot,
    targetFilePath: harness.targetFilePath,
    content: 'package com.example;\nclass DraftTest {}\n'
  });
  const candidate = await harness.transaction.stageCandidate({
    candidateId: randomUUID(),
    prepared
  });
  await rm(candidate.filePath, { force: true });

  const revoked = await harness.transaction.revoke();

  assert.deepEqual(revoked.files, []);
  assert.deepEqual(revoked.preservedExternallyModifiedFilePaths, []);
  assert.equal(
    await readFile(harness.reportPath, 'utf8'),
    '<report name="baseline"/>'
  );
});

test('候选 XML 与分支快照摘要不匹配时拒绝晋升且不改变最佳文件对', async (t) => {
  const harness = await createHarness(t, 'pair-mismatch-');
  const prepared = await harness.writer.prepareGeneratedTest({
    workspaceRoot: harness.workspaceRoot,
    targetFilePath: harness.targetFilePath,
    content: 'package com.example;\nclass DraftTest {}\n'
  });
  const candidateId = randomUUID();
  await harness.transaction.stageCandidate({ candidateId, prepared });
  const candidateArtifacts = await writeCoveragePair(
    join(harness.workspaceRoot, 'module', 'target', 'mismatch.xml'),
    join(harness.workspaceRoot, 'module', 'target', 'mismatch.branches.json'),
    'candidate'
  );
  const snapshot = JSON.parse(
    await readFile(candidateArtifacts.branchSnapshotPath, 'utf8')
  );
  snapshot.reportSha256 = sha256('different');
  await writeFile(
    candidateArtifacts.branchSnapshotPath,
    JSON.stringify(snapshot),
    'utf8'
  );

  await assert.rejects(
    harness.transaction.promoteCandidate(
      candidateId,
      { reportFound: true, coveredLines: 1 },
      candidateArtifacts
    ),
    /摘要|配对/
  );
  assert.deepEqual(harness.transaction.getBestArtifacts(), {
    ...harness.baselineArtifacts
  });
});

test('晋升文件对的第二次替换失败时恢复原最佳 XML 和快照', async (t) => {
  let branchWriteFailed = false;
  const harness = await createHarness(
    t,
    'pair-write-rollback-',
    (writer) => new Proxy(writer, {
      get(target, property) {
        if (property === 'replaceOwnedArtifact') {
          return async (request) => {
            if (
              !branchWriteFailed
              && request.filePath.endsWith('jacoco.branches.json')
            ) {
              branchWriteFailed = true;
              throw new Error('injected branch snapshot write failure');
            }
            return target.replaceOwnedArtifact(request);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    })
  );
  const prepared = await harness.writer.prepareGeneratedTest({
    workspaceRoot: harness.workspaceRoot,
    targetFilePath: harness.targetFilePath,
    content: 'package com.example;\nclass DraftTest {}\n'
  });
  const candidateId = randomUUID();
  await harness.transaction.stageCandidate({ candidateId, prepared });
  const candidateArtifacts = await writeCoveragePair(
    join(harness.workspaceRoot, 'module', 'target', 'candidate.xml'),
    join(harness.workspaceRoot, 'module', 'target', 'candidate.branches.json'),
    'candidate'
  );

  await assert.rejects(
    harness.transaction.promoteCandidate(
      candidateId,
      { reportFound: true, coveredLines: 1 },
      candidateArtifacts
    ),
    /injected branch snapshot write failure/
  );
  assert.equal(
    await readFile(harness.reportPath, 'utf8'),
    '<report name="baseline"/>'
  );
  assert.equal(
    JSON.parse(await readFile(harness.branchSnapshotPath, 'utf8')).pairId,
    harness.baselineArtifacts.pairId
  );
});

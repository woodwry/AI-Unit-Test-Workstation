import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';

import {
  ClassTaskFileTransactionService
} from '../src/main/services/class-task-file-transaction.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function harness(t, prefix) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  let id = 0;
  const transaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService(),
    now: () => new Date(`2026-08-09T00:00:0${id}.000Z`),
    idFactory: () => `artifact-${++id}`
  });
  return { workspaceRoot, transaction };
}

async function trackGenerated(transaction, input) {
  await mkdir(dirname(input.filePath), { recursive: true });
  await writeFile(input.filePath, input.generatedContent, 'utf8');
  const methodIds = input.methodIds ?? ['method-1'];
  const testCount = input.testCount ?? methodIds.length;
  const methodResults = input.methodResults ?? methodIds.map((methodId, index) => ({
    methodId,
    methodName: `method${index + 1}`,
    displaySignature: `void method${index + 1}()`,
    jacocoOrder: index,
    ordinaryTestMethodCount: index === methodIds.length - 1
      ? testCount - (methodIds.length - 1)
      : 1
  }));
  return transaction.track({
    taskId: input.taskId,
    workspaceRoot: input.workspaceRoot,
    filePath: input.filePath,
    testClassName: input.testClassName,
    sha256: sha256(input.generatedContent),
    ordinaryTestMethodCount: testCount,
    methodIds,
    methodResults,
    sealed: input.sealed ?? false,
    existedBefore: input.existedBefore ?? false,
    ...(input.originalContent === undefined
      ? {}
      : { originalContent: input.originalContent })
  });
}

test('new artifact creation requires per-method display results', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-result-required-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const content = 'class TaskService1Test { void generated() {} }\n';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');

  await assert.rejects(transaction.track({
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    sha256: sha256(content),
    ordinaryTestMethodCount: 1,
    methodIds: ['method-1'],
    sealed: false,
    existedBefore: false
  }), /per-method results/i);
});

function formalPath(workspaceRoot, fileName) {
  return join(
    workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'com',
    'example',
    fileName
  );
}

function methodResult(methodId = 'method-1', index = 0) {
  return {
    methodId,
    methodName: `method${index + 1}`,
    displaySignature: `void method${index + 1}()`,
    jacocoOrder: index,
    ordinaryTestMethodCount: 1
  };
}

test('revoke deletes a user-modified generated file', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-conflict-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  const userEdit = 'class TaskService1Test { void userEdit() {} }\n';
  await writeFile(filePath, userEdit, 'utf8');

  const result = await transaction.revoke(TASK_A);

  await assert.rejects(access(filePath), (error) => error?.code === 'ENOENT');
  assert.deepEqual(result.revokedArtifactIds, ['artifact-1']);
  assert.deepEqual(result.conflictingFilePaths, []);
  assert.deepEqual(transaction.artifacts(TASK_A), []);
});

test('revoke succeeds when the generated file is already missing', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-missing-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  await rm(filePath);

  const result = await transaction.revoke(TASK_A);

  assert.deepEqual(result.revokedArtifactIds, ['artifact-1']);
  assert.deepEqual(result.conflictingFilePaths, []);
  assert.deepEqual(transaction.artifacts(TASK_A), []);
});

test('accept ignores modified and missing generated files', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-accept-unavailable-');
  const modifiedPath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const missingPath = formalPath(workspaceRoot, 'OtherService1Test.java');
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath: modifiedPath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  await trackGenerated(transaction, {
    taskId: TASK_B,
    workspaceRoot,
    filePath: missingPath,
    testClassName: 'OtherService1Test',
    generatedContent: 'class OtherService1Test {}\n'
  });
  const userEdit = 'class TaskService1Test { void userEdit() {} }\n';
  await writeFile(modifiedPath, userEdit, 'utf8');
  await rm(missingPath);

  const modifiedAccepted = await transaction.accept(TASK_A);
  const missingAccepted = await transaction.accept(TASK_B);

  assert.deepEqual(modifiedAccepted.map((item) => item.accepted), [true]);
  assert.deepEqual(missingAccepted.map((item) => item.accepted), [true]);
  assert.equal(await readFile(modifiedPath, 'utf8'), userEdit);
  await assert.rejects(access(missingPath), (error) => error?.code === 'ENOENT');
});

test('accept removes rollback capability only for the accepted task', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-accept-');
  const firstPath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const secondPath = formalPath(workspaceRoot, 'OtherService1Test.java');
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath: firstPath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  await trackGenerated(transaction, {
    taskId: TASK_B,
    workspaceRoot,
    filePath: secondPath,
    testClassName: 'OtherService1Test',
    generatedContent: 'class OtherService1Test {}\n'
  });

  const accepted = await transaction.accept(TASK_A);

  assert.deepEqual(accepted.map((item) => item.accepted), [true]);
  await assert.rejects(transaction.revoke(TASK_A), /accepted|rollback/i);
  await transaction.revoke(TASK_B);
  await access(firstPath);
  await assert.rejects(access(secondPath), (error) => error?.code === 'ENOENT');
});

test('revoke restores content that existed before the generated result', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-restore-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const originalContent = 'class TaskService1Test { void original() {} }\n';

  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test { void generated() {} }\n',
    existedBefore: true,
    originalContent
  });

  const result = await transaction.revoke(TASK_A);

  assert.equal(await readFile(filePath, 'utf8'), originalContent);
  assert.deepEqual(result.revokedArtifactIds, ['artifact-1']);
  assert.deepEqual(result.conflictingFilePaths, []);
  assert.deepEqual(transaction.artifacts(TASK_A), []);
});

test('revoke never deletes a path still referenced by an accepted artifact', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-protected-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const generatedContent = 'class TaskService1Test { void accepted() {} }\n';

  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent
  });

  const result = await transaction.revoke(TASK_A, {
    protectedFilePaths: [filePath]
  });

  assert.equal(await readFile(filePath, 'utf8'), generatedContent);
  assert.deepEqual(result.revokedArtifactIds, ['artifact-1']);
  assert.deepEqual(result.conflictingFilePaths, [filePath]);
  assert.deepEqual(transaction.artifacts(TASK_A), []);
});

test('an artifact update retains identity and advances generated ownership hash', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-update-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const first = await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test { void first() {} }\n'
  });
  const nextContent = 'class TaskService1Test { void first() {} void second() {} }\n';
  await writeFile(filePath, nextContent, 'utf8');

  const updated = await transaction.update({
    taskId: TASK_A,
    artifactId: first.id,
    previousSha256: first.sha256,
    sha256: sha256(nextContent),
    ordinaryTestMethodCount: 2,
    methodIds: ['method-1', 'method-2'],
    methodResults: [
      {
        methodId: 'method-1',
        methodName: 'first',
        displaySignature: 'void first()',
        jacocoOrder: 0,
        ordinaryTestMethodCount: 1
      },
      {
        methodId: 'method-2',
        methodName: 'second',
        displaySignature: 'void second()',
        jacocoOrder: 1,
        ordinaryTestMethodCount: 1
      }
    ],
    sealed: true
  });

  assert.equal(updated.id, first.id);
  assert.equal(updated.sha256, sha256(nextContent));
  assert.equal(updated.sealed, true);
  assert.deepEqual(updated.methodIds, ['method-1', 'method-2']);
});

test('an accepted task cannot register another rollback-managed file', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-accepted-final-');
  const firstPath = formalPath(workspaceRoot, 'TaskService1Test.java');
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath: firstPath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  await transaction.accept(TASK_A);
  const secondPath = formalPath(workspaceRoot, 'TaskService2Test.java');
  await writeFile(secondPath, 'class TaskService2Test {}\n', 'utf8');

  await assert.rejects(
    transaction.track({
      taskId: TASK_A,
      workspaceRoot,
      filePath: secondPath,
      testClassName: 'TaskService2Test',
      sha256: sha256('class TaskService2Test {}\n'),
      ordinaryTestMethodCount: 1,
      methodIds: ['method-2'],
      methodResults: [methodResult('method-2', 1)],
      sealed: false,
      existedBefore: false
    }),
    /accepted|finished/i
  );
});

test('artifact identifiers remain unique across different class tasks', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'task-file-global-id-'));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const transaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService(),
    idFactory: () => 'same-artifact-id'
  });
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath: formalPath(workspaceRoot, 'TaskService1Test.java'),
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });

  await assert.rejects(
    trackGenerated(transaction, {
      taskId: TASK_B,
      workspaceRoot,
      filePath: formalPath(workspaceRoot, 'OtherService1Test.java'),
      testClassName: 'OtherService1Test',
      generatedContent: 'class OtherService1Test {}\n'
    }),
    /identifier.*duplicated/i
  );
});

test('restores persisted task ownership so an unaccepted file remains revocable after restart', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-restore-owner-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const artifact = await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  const restored = new ClassTaskFileTransactionService({
    writer: new TestWriterService()
  });

  await restored.restoreTask({
    taskId: TASK_A,
    workspaceRoot,
    artifacts: [artifact]
  });
  await restored.revoke(TASK_A);

  await assert.rejects(access(filePath), (error) => error?.code === 'ENOENT');
});

test('restores accepted metadata without reclaiming a file the user edited afterward', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-restore-accepted-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: 'class TaskService1Test {}\n'
  });
  const accepted = await transaction.accept(TASK_A);
  const userEdit = 'class TaskService1Test { void userEdit() {} }\n';
  await writeFile(filePath, userEdit, 'utf8');
  const restored = new ClassTaskFileTransactionService({
    writer: new TestWriterService()
  });

  await restored.restoreTask({
    taskId: TASK_A,
    workspaceRoot,
    artifacts: accepted
  });

  await assert.rejects(restored.revoke(TASK_A), /accepted|rollback/i);
  assert.equal(await readFile(filePath, 'utf8'), userEdit);
});

test('refuses to manage a production Java source file as a generated test', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-source-guard-');
  const sourceFile = join(
    workspaceRoot,
    'module',
    'src',
    'main',
    'java',
    'com',
    'example',
    'TaskService.java'
  );
  const content = 'class TaskService {}\n';
  await mkdir(dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, content, 'utf8');

  await assert.rejects(
    transaction.track({
      taskId: TASK_A,
      workspaceRoot,
      filePath: sourceFile,
      testClassName: 'TaskService',
      sha256: sha256(content),
      ordinaryTestMethodCount: 1,
      methodIds: ['method-1'],
      methodResults: [methodResult()],
      sealed: false,
      existedBefore: false
    }),
    /src\/test\/java|test source/i
  );

  assert.equal(await readFile(sourceFile, 'utf8'), content);
});

test('concurrent tasks cannot both acquire ownership of the same generated file', async (t) => {
  const { workspaceRoot } = await harness(t, 'task-file-owner-race-');
  let id = 0;
  const transaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService(),
    idFactory: () => `race-artifact-${++id}`
  });
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const content = 'class TaskService1Test {}\n';
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  const input = (taskId) => ({
    taskId,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    sha256: sha256(content),
    ordinaryTestMethodCount: 1,
    methodIds: ['method-1'],
    methodResults: [methodResult()],
    sealed: false,
    existedBefore: false
  });

  const outcomes = await Promise.allSettled([
    transaction.track(input(TASK_A)),
    transaction.track({
      ...input(TASK_B),
      filePath: `${dirname(filePath)}${sep}alias-segment${sep}..${sep}TaskService1Test.java`
    })
  ]);

  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(
    transaction.artifacts(TASK_A).length + transaction.artifacts(TASK_B).length,
    1
  );
});

test('a sealed formal artifact cannot be updated with another source method', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-sealed-');
  const filePath = formalPath(workspaceRoot, 'TaskService1Test.java');
  const firstContent = 'class TaskService1Test { void first() {} }\n';
  const artifact = await trackGenerated(transaction, {
    taskId: TASK_A,
    workspaceRoot,
    filePath,
    testClassName: 'TaskService1Test',
    generatedContent: firstContent,
    sealed: true
  });
  const nextContent = 'class TaskService1Test { void first() {} void second() {} }\n';
  await writeFile(filePath, nextContent, 'utf8');

  await assert.rejects(
    transaction.update({
      taskId: TASK_A,
      artifactId: artifact.id,
      previousSha256: artifact.sha256,
      sha256: sha256(nextContent),
      ordinaryTestMethodCount: 2,
      methodIds: ['method-1', 'method-2'],
      methodResults: [methodResult(), methodResult('method-2', 1)],
      sealed: true
    }),
    /sealed/i
  );
});

test('moves a verified Wave candidate between isolation and src/test/java with checkpoint phases', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-wave-move-');
  const content = 'package com.example; class TaskServiceTmp1Test {}\n';
  const isolationPath = join(
    workspaceRoot,
    '.ai-unit-test',
    'wave-candidates',
    TASK_A,
    'TaskServiceTmp1Test.java'
  );
  const projectPath = formalPath(workspaceRoot, 'TaskServiceTmp1Test.java');
  await mkdir(dirname(isolationPath), { recursive: true });
  await writeFile(isolationPath, content, 'utf8');
  const phases = [];

  await transaction.moveWaveCandidateFiles({
    moves: [{
      candidateId: '33333333-3333-4333-8333-333333333333',
      workspaceRoot,
      testClassName: 'TaskServiceTmp1Test',
      sourcePath: isolationPath,
      targetPath: projectPath,
      sha256: sha256(content)
    }],
    async saveMoveTransactions(items) {
      phases.push(items.map((item) => ({ ...item })));
    }
  });

  assert.equal(await readFile(projectPath, 'utf8'), content);
  await assert.rejects(access(isolationPath), (error) => error?.code === 'ENOENT');
  assert.deepEqual(phases.map((items) => items[0].phase), ['PREPARED', 'MOVED']);
  assert.deepEqual(phases[0][0], {
    candidateId: '33333333-3333-4333-8333-333333333333',
    sourcePath: isolationPath,
    targetPath: projectPath,
    sha256: sha256(content),
    phase: 'PREPARED'
  });
});

test('rolls every Wave candidate file back when the moved checkpoint cannot commit', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-wave-rollback-');
  const moves = [];
  for (const [index, className] of ['ATmp1Test', 'BTmp1Test'].entries()) {
    const content = `class ${className} {}\n`;
    const sourcePath = join(
      workspaceRoot,
      '.ai-unit-test',
      'wave-candidates',
      `${className}.java`
    );
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content, 'utf8');
    moves.push({
      candidateId: index === 0
        ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceRoot,
      testClassName: className,
      sourcePath,
      targetPath: formalPath(workspaceRoot, `${className}.java`),
      sha256: sha256(content),
      content
    });
  }

  await assert.rejects(transaction.moveWaveCandidateFiles({
    moves,
    async saveMoveTransactions(items) {
      if (items[0].phase === 'MOVED') {
        throw new Error('checkpoint unavailable');
      }
    }
  }), /checkpoint unavailable/);

  for (const move of moves) {
    assert.equal(await readFile(move.sourcePath, 'utf8'), move.content);
    await assert.rejects(access(move.targetPath), (error) => error?.code === 'ENOENT');
  }
});

test('startup recovery rolls back an untouched PREPARED Wave move and completes a renamed one', async (t) => {
  const { workspaceRoot, transaction } = await harness(t, 'task-file-wave-recover-');
  const content = 'class TaskServiceTmp1Test {}\n';
  const digest = sha256(content);
  const isolationPath = join(
    workspaceRoot,
    '.ai-unit-test',
    'wave-candidates',
    'TaskServiceTmp1Test.java'
  );
  const projectPath = formalPath(workspaceRoot, 'TaskServiceTmp1Test.java');
  await mkdir(dirname(isolationPath), { recursive: true });
  await writeFile(isolationPath, content, 'utf8');
  const prepared = {
    candidateId: '33333333-3333-4333-8333-333333333333',
    workspaceRoot,
    testClassName: 'TaskServiceTmp1Test',
    sourcePath: isolationPath,
    targetPath: projectPath,
    sha256: digest,
    phase: 'PREPARED'
  };

  const rolledBack = await transaction.recoverWaveCandidateMove(prepared);
  assert.equal(rolledBack.outcome, 'ROLLED_BACK');
  assert.equal(rolledBack.filePath, isolationPath);
  assert.equal(await readFile(isolationPath, 'utf8'), content);
  await assert.rejects(access(projectPath), (error) => error?.code === 'ENOENT');

  await mkdir(dirname(projectPath), { recursive: true });
  await rename(isolationPath, projectPath);
  const completed = await transaction.recoverWaveCandidateMove(prepared);
  assert.equal(completed.outcome, 'COMPLETED');
  assert.equal(completed.filePath, projectPath);
  assert.equal(await readFile(projectPath, 'utf8'), content);
  await assert.rejects(access(isolationPath), (error) => error?.code === 'ENOENT');
});

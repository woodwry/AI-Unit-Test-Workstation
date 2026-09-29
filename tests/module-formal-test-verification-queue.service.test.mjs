import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ModuleFormalTestVerificationQueueService
} from '../src/main/services/module-formal-test-verification-queue.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';

function passingFeedback(candidate) {
  return {
    candidateId: candidate.candidateId,
    status: 'passed',
    mavenExecutions: [],
    testReport: {
      reportCount: 1,
      tests: 3,
      failures: 0,
      errors: 0,
      skipped: 0,
      generatedTestClassName: candidate.qualifiedTestClassName,
      generatedTests: 3,
      generatedSkipped: 0,
      failureDetails: []
    },
    trace: {
      mavenBatchId: 'batch-1',
      moduleRoot: 'D:\\work\\manager-core',
      startedAt: '2026-09-28T00:00:00.000Z',
      completedAt: '2026-09-28T00:00:01.000Z',
      durationMs: 1000,
      candidates: [],
      steps: [],
      results: []
    }
  };
}

function candidate(candidateId, taskId, testClassName) {
  return {
    moduleKey: 'module-a',
    environmentFingerprint: 'same-maven-env',
    taskId,
    candidateId,
    workspaceRoot: 'D:\\work',
    moduleRoot: 'D:\\work\\manager-core',
    buildSettings: { mavenHome: 'fake-maven', javaHome: 'fake-java' },
    filePath: `D:\\work\\manager-core\\src\\test\\java\\demo\\${testClassName}.java`,
    expectedSha256: `${candidateId}-sha`,
    testClassName,
    qualifiedTestClassName: `demo.${testClassName}`,
    ordinaryTestMethodCount: 1
  };
}

test('batches formal verification files from the same module across one task and neighbor tasks', async () => {
  const batches = [];
  const asserted = [];
  const queue = new ModuleFormalTestVerificationQueueService({
    moduleLock: new ModuleOperationLock(),
    writer: {
      async assertGeneratedTestUnchanged(input) {
        asserted.push(`${input.filePath}:${input.expectedSha256}`);
      }
    },
    maven: {
      async executeBatch(input) {
        batches.push(input.candidates.map((item) => item.qualifiedTestClassName));
        await input.placement.activate(input.candidates);
        return new Map(input.candidates.map((item) => [
          item.candidateId,
          passingFeedback(item)
        ]));
      }
    },
    idFactory: () => 'formal-batch-1'
  });

  const first = queue.enqueue(candidate(
    'task-manager-8',
    'task-manager',
    'TaskManager8Test'
  ));
  await Promise.resolve();
  const second = queue.enqueue(candidate(
    'task-manager-9',
    'task-manager',
    'TaskManager9Test'
  ));
  const third = queue.enqueue(candidate(
    'data-export-manager-1',
    'data-export-manager',
    'DataExportManager1Test'
  ));

  await Promise.all([first, second, third]);

  assert.deepEqual(batches, [[
    'demo.TaskManager8Test',
    'demo.TaskManager9Test',
    'demo.DataExportManager1Test'
  ]]);
  assert.equal(asserted.length, 6);
});

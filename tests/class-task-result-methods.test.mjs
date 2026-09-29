import assert from 'node:assert/strict';
import test from 'node:test';

import { validateClassTaskResultSnapshot } from '../src/main/services/class-task-ipc-validation.ts';
import { generatedResultMethodsFromArtifacts } from '../src/shared/class-task-result-methods.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const METHOD_A = 'a'.repeat(64);
const METHOD_B = 'b'.repeat(64);

test('aggregates split formal artifacts into unique source-method results', () => {
  const artifacts = [
    artifact('artifact-1', 'TaskService1Test', 20, [methodResult(METHOD_A, 'a', 0, 20)]),
    artifact('artifact-2', 'TaskService2Test', 11, [
      methodResult(METHOD_A, 'a', 0, 5),
      methodResult(METHOD_B, 'b', 1, 6)
    ])
  ];

  const generatedMethods = generatedResultMethodsFromArtifacts(artifacts);

  assert.deepEqual(
    generatedMethods.map((method) => [
      method.methodId,
      method.ordinaryTestMethodCount,
      method.testClassName
    ]),
    [
      [METHOD_A, 25, 'TaskService1Test'],
      [METHOD_B, 6, 'TaskService2Test']
    ]
  );
  assert.doesNotThrow(() => validateClassTaskResultSnapshot({
    taskId: TASK_ID,
    state: 'COMPLETED',
    artifacts,
    generatedMethods,
    tokenUsage: null,
    modelCallCount: 0,
    usageReportedCallCount: 0,
    coverageBaseline: coverage(),
    coverageCurrent: coverage(),
    coverageContributions: [],
    canAccept: true,
    canRevoke: true
  }));
});

test('aggregates split artifacts when only historical JaCoCo display order differs', () => {
  const artifacts = [
    artifact('artifact-1', 'TaskService1Test', 20, [
      methodResult(METHOD_A, 'a', 5, 20)
    ]),
    artifact('artifact-2', 'TaskService2Test', 11, [
      methodResult(METHOD_A, 'a', 2, 5),
      methodResult(METHOD_B, 'b', 3, 6)
    ])
  ];

  const generatedMethods = generatedResultMethodsFromArtifacts(artifacts);

  assert.deepEqual(
    generatedMethods.map((method) => [
      method.methodId,
      method.jacocoOrder,
      method.ordinaryTestMethodCount
    ]),
    [
      [METHOD_A, 2, 25],
      [METHOD_B, 3, 6]
    ]
  );
});

function artifact(id, testClassName, ordinaryTestMethodCount, methodResults) {
  return {
    id,
    filePath: `D:\\workspace\\src\\test\\java\\${testClassName}.java`,
    testClassName,
    ordinaryTestMethodCount,
    methodIds: methodResults.map((method) => method.methodId),
    methodResults,
    sha256: id === 'artifact-1' ? '1'.repeat(64) : '2'.repeat(64),
    sealed: id === 'artifact-1',
    accepted: false,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z'
  };
}

function methodResult(methodId, methodName, jacocoOrder, ordinaryTestMethodCount) {
  return {
    methodId,
    methodName,
    displaySignature: `void ${methodName}()`,
    jacocoOrder,
    ordinaryTestMethodCount
  };
}

function coverage() {
  return {
    lineCovered: 0,
    lineMissed: 0,
    lineTotal: 0,
    branchCovered: 0,
    branchMissed: 0,
    branchTotal: 0
  };
}

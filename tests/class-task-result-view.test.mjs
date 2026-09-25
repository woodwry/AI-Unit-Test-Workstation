import assert from 'node:assert/strict';
import test from 'node:test';

import * as resultView from '../src/renderer/src/class-tasks/class-task-result-view.ts';

const {
  buildClassTaskResultProgress,
  buildClassTaskResultMethodRows,
  buildClassTaskResultSummary
} = resultView;

const HASH_METHOD_ID = '8a488352b060712f5a4f6a5cfc535e1c68fdd8a3bb78d2abb15a186d44cdb7a1';

test('running result overview shows completed progress before staged method results', () => {
  const result = resultSnapshot({
    state: 'RUNNING',
    artifacts: [artifact({ ordinaryTestMethodCount: 38 })],
    generatedMethods: Array.from({ length: 8 }, (_, index) => generatedMethod({
      methodId: `method-${index + 1}`,
      methodName: `method${index + 1}`,
      ordinaryTestMethodCount: index < 6 ? 5 : 4
    }))
  });
  const progress = buildClassTaskResultProgress({
    state: 'RUNNING',
    methodOrder: Array.from({ length: 14 }, (_, index) => `method-${index + 1}`),
    coveredMethodIds: ['method-1', 'method-2', 'method-3', 'method-4', 'method-5'],
    currentMethodIndex: 0
  }, result, buildClassTaskResultSummary(result));

  assert.deepEqual(progress, {
    heading: '生成进行中',
    description: '5/14 个方法已完成，8/14 个方法已有阶段结果，38 个测试已通过 Maven 验证',
    methodCountLabel: '8 / 14 已有结果',
    totalMethodCount: 14
  });
});

test('completed progress keeps the all-skipped explanation', () => {
  const result = resultSnapshot({
    artifacts: [],
    generatedMethods: [],
    allScenariosSkipped: true
  });
  const progress = buildClassTaskResultProgress({
    state: 'COMPLETED',
    methodOrder: ['method-1', 'method-2'],
    coveredMethodIds: [],
    currentMethodIndex: -1
  }, result, buildClassTaskResultSummary(result));

  assert.equal(progress.heading, '生成已完成');
  assert.equal(progress.description, '未生成测试，全部场景已跳过');
  assert.equal(progress.methodCountLabel, '0 / 2 已有结果');
});

test('result rows display real method identity and keep per-method test counts', () => {
  const result = resultSnapshot({
    generatedMethods: [
      generatedMethod({
        methodId: HASH_METHOD_ID,
        methodName: 'getChildZipFile',
        displaySignature: 'public File getChildZipFile(Task task) throws IOException',
        jacocoOrder: 2,
        ordinaryTestMethodCount: 3
      }),
      generatedMethod({
        methodId: 'e0cd2c377abb5642d3648aabce172b353eb1015140e8c77e2d',
        methodName: 'buildArchive',
        displaySignature: 'private Path buildArchive(List<File> files)',
        jacocoOrder: 5,
        ordinaryTestMethodCount: 7
      })
    ]
  });

  const rows = buildClassTaskResultMethodRows(result);

  assert.deepEqual(rows.map((row) => ({
    methodName: row.methodName,
    displaySignature: row.displaySignature,
    testMethodCount: row.testMethodCount,
    orderLabel: row.orderLabel
  })), [
    {
      methodName: 'getChildZipFile',
      displaySignature: 'public File getChildZipFile(Task task) throws IOException',
      testMethodCount: 3,
      orderLabel: '3'
    },
    {
      methodName: 'buildArchive',
      displaySignature: 'private Path buildArchive(List<File> files)',
      testMethodCount: 7,
      orderLabel: '6'
    }
  ]);
  assert.equal(Object.hasOwn(rows[0], 'methodId'), false);
});

test('search matches method name and full signature without exposing internal ids', () => {
  const result = resultSnapshot({
    generatedMethods: [generatedMethod({
      methodId: HASH_METHOD_ID,
      methodName: 'getChildZipFile',
      displaySignature: 'public File getChildZipFile(Task task) throws IOException'
    })]
  });

  assert.equal(buildClassTaskResultMethodRows(result, 'childzip').length, 1);
  assert.equal(buildClassTaskResultMethodRows(result, 'IOException').length, 1);
  assert.equal(buildClassTaskResultMethodRows(result, HASH_METHOD_ID).length, 0);
});

test('legacy artifacts fall back to one file row and never repeat a file total for every method id', () => {
  const result = resultSnapshot({
    artifacts: [artifact({
      ordinaryTestMethodCount: 10,
      methodIds: [HASH_METHOD_ID, 'b'.repeat(64)]
    })],
    generatedMethods: []
  });

  const rows = buildClassTaskResultMethodRows(result);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].methodName, '历史结果');
  assert.equal(rows[0].testMethodCount, 10);
  assert.equal(JSON.stringify(rows).includes(HASH_METHOD_ID), false);
});

test('result summary uses exact generated method, test and file totals', () => {
  const summary = buildClassTaskResultSummary(resultSnapshot({
    artifacts: [artifact({ ordinaryTestMethodCount: 10 })],
    generatedMethods: [
      generatedMethod({ methodName: 'first', ordinaryTestMethodCount: 3 }),
      generatedMethod({ methodId: 'second', methodName: 'second', ordinaryTestMethodCount: 7 })
    ]
  }));

  assert.deepEqual(summary, {
    generatedMethodCount: 2,
    generatedTestMethodCount: 10,
    formalFileCount: 1
  });
});

test('result view aggregates formal-file parts back into one source method', () => {
  const firstArtifact = artifact({
    id: 'artifact-1',
    ordinaryTestMethodCount: 20,
    methodIds: [HASH_METHOD_ID]
  });
  const secondArtifact = artifact({
    id: 'artifact-2',
    filePath: 'D:\\work\\src\\test\\java\\TaskService2Test.java',
    testClassName: 'TaskService2Test',
    ordinaryTestMethodCount: 11,
    methodIds: [HASH_METHOD_ID, 'second']
  });
  const result = resultSnapshot({
    artifacts: [firstArtifact, secondArtifact],
    generatedMethods: [
      generatedMethod({ ordinaryTestMethodCount: 20 }),
      generatedMethod({
        artifactId: 'artifact-2',
        filePath: secondArtifact.filePath,
        testClassName: secondArtifact.testClassName,
        ordinaryTestMethodCount: 5
      }),
      generatedMethod({
        methodId: 'second',
        methodName: 'second',
        displaySignature: 'void second()',
        jacocoOrder: 1,
        ordinaryTestMethodCount: 6,
        artifactId: 'artifact-2',
        filePath: secondArtifact.filePath,
        testClassName: secondArtifact.testClassName
      })
    ]
  });

  assert.deepEqual(
    buildClassTaskResultMethodRows(result).map((row) => [
      row.methodName,
      row.testMethodCount
    ]),
    [['getChildZipFile', 25], ['second', 6]]
  );
  assert.deepEqual(buildClassTaskResultSummary(result), {
    generatedMethodCount: 2,
    generatedTestMethodCount: 31,
    formalFileCount: 2
  });
});

test('missing result files keep a concise visible message across the Electron IPC boundary', () => {
  // Mutation caught: showing Electron's wrapper verbatim can ellipsize the actual
  // missing-file reason out of the result footer.
  const wrapped = new Error(
    "Error invoking remote method 'class-task:accept': Error: 测试文件不存在，请恢复文件后重试。"
  );
  assert.equal(typeof resultView.normalizeClassTaskResultActionError, 'function');

  assert.equal(
    resultView.normalizeClassTaskResultActionError(wrapped),
    '测试文件不存在，请恢复文件后重试。'
  );
  assert.equal(
    resultView.normalizeClassTaskResultActionError(new Error('生成测试文件已被外部修改。')),
    '生成测试文件已被外部修改。'
  );
});

function resultSnapshot(overrides = {}) {
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    state: 'COMPLETED',
    artifacts: [artifact()],
    generatedMethods: [generatedMethod()],
    coverageBaseline: coverage(2, 8, 0, 4),
    coverageCurrent: coverage(7, 3, 2, 2),
    coverageContributions: [],
    canAccept: true,
    canRevoke: true,
    ...overrides
  };
}

function artifact(overrides = {}) {
  return {
    id: 'artifact-1',
    filePath: 'D:\\work\\src\\test\\java\\TaskService1Test.java',
    testClassName: 'TaskService1Test',
    ordinaryTestMethodCount: 10,
    methodIds: [HASH_METHOD_ID],
    methodResults: [],
    sha256: 'a'.repeat(64),
    sealed: false,
    accepted: false,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides
  };
}

function generatedMethod(overrides = {}) {
  return {
    methodId: HASH_METHOD_ID,
    methodName: 'getChildZipFile',
    displaySignature: 'public File getChildZipFile(Task task)',
    jacocoOrder: 0,
    ordinaryTestMethodCount: 10,
    artifactId: 'artifact-1',
    filePath: 'D:\\work\\src\\test\\java\\TaskService1Test.java',
    testClassName: 'TaskService1Test',
    ...overrides
  };
}

function coverage(lineCovered, lineMissed, branchCovered, branchMissed) {
  return {
    lineCovered,
    lineMissed,
    lineTotal: lineCovered + lineMissed,
    branchCovered,
    branchMissed,
    branchTotal: branchCovered + branchMissed
  };
}

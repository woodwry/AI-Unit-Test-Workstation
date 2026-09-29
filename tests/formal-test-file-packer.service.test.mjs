import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  FormalTestFilePackerService
} from '../src/main/services/formal-test-file-packer.service.ts';
import {
  ClassTaskFileTransactionService
} from '../src/main/services/class-task-file-transaction.service.ts';
import {
  GeneratedTestNameReservationService
} from '../src/main/services/generated-test-name-reservation.service.ts';
import { JavaTestStructureService } from '../src/main/services/java-test-structure.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

function methodBundle(index, count) {
  const names = Array.from({ length: count }, (_, offset) => (
    `method${index}Case${offset + 1}`
  ));
  return {
    methodId: `method-${index}`,
    methodName: `sourceMethod${index}`,
    displaySignature: `public void sourceMethod${index}()`,
    jacocoOrder: index - 1,
    code: [
      'package com.example;',
      '',
      'import org.junit.jupiter.api.Test;',
      '',
      `class TaskServiceTmp${index}Test {`,
      ...names.flatMap((name) => [
        '    @Test',
        `    void ${name}() {}`,
        ''
      ]),
      '}',
      ''
    ].join('\n'),
    ordinaryTestMethodCount: count,
    passedTestMethods: names,
    sourceBatchIds: [`batch-${index}`]
  };
}

function waveBundle(sourceMethodIndex, waveIndex, count, hasRemainingScenarios) {
  return {
    ...methodBundle(sourceMethodIndex, count),
    sourceMethodId: `method-${sourceMethodIndex}`,
    waveIndex,
    hasRemainingScenarios,
    sourceBatchIds: [`candidate-${sourceMethodIndex}-${waveIndex}`]
  };
}

function customBundle(index, members) {
  const code = [
    'package com.example;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    `class TaskServiceTmp${index}Test {`,
    ...members,
    '}',
    ''
  ].join('\n');
  const passedTestMethods = new JavaTestStructureService()
    .findTestMethods(code)
    .map((method) => method.name);
  return {
    methodId: `method-${index}`,
    methodName: `sourceMethod${index}`,
    displaySignature: `public void sourceMethod${index}()`,
    jacocoOrder: index - 1,
    code,
    ordinaryTestMethodCount: passedTestMethods.length,
    passedTestMethods,
    sourceBatchIds: [`batch-${index}`]
  };
}

function retainedMethodBundle(index, count) {
  const retained = Array.from({ length: count }, (_, offset) => {
    const name = `method${index}RetainedCase${offset + 1}`;
    return [
      '    // TODO 当前测试方法需要修复',
      '    // @Test',
      `    // void ${name}() {}`,
      ''
    ];
  }).flat();
  return {
    methodId: `method-retained-${index}`,
    methodName: `retainedSourceMethod${index}`,
    displaySignature: `public void retainedSourceMethod${index}()`,
    jacocoOrder: index - 1,
    code: [
      'package com.example;',
      '',
      'import org.junit.jupiter.api.Test;',
      '',
      `class TaskServiceTmp${index}Test {`,
      ...retained,
      '}',
      ''
    ].join('\n'),
    ordinaryTestMethodCount: 0,
    passedTestMethods: [],
    sourceBatchIds: [`batch-retained-${index}`]
  };
}

function mixedRetainedMethodBundle(index, activeCount, retainedCount) {
  const active = Array.from({ length: activeCount }, (_, offset) => {
    const name = `method${index}ActiveCase${offset + 1}`;
    return [
      '    @Test',
      `    void ${name}() {`,
      '        helper();',
      '    }',
      ''
    ];
  }).flat();
  const retained = Array.from({ length: retainedCount }, (_, offset) => {
    const name = `method${index}RetainedCase${offset + 1}`;
    return [
      '    // TODO 当前测试方法需要修复',
      '    // @Test',
      `    // void ${name}() {`,
      '    //     helper();',
      '    // }',
      ''
    ];
  }).flat();
  const passedTestMethods = Array.from({ length: activeCount }, (_, offset) => (
    `method${index}ActiveCase${offset + 1}`
  ));
  return {
    methodId: `method-${index}`,
    methodName: `sourceMethod${index}`,
    displaySignature: `public void sourceMethod${index}()`,
    jacocoOrder: index - 1,
    code: [
      'package com.example;',
      '',
      'import org.junit.jupiter.api.Test;',
      '',
      `class TaskServiceTmp${index}Test {`,
      '    private void helper() {}',
      '',
      ...active,
      ...retained,
      '}',
      ''
    ].join('\n'),
    ordinaryTestMethodCount: activeCount,
    passedTestMethods,
    sourceBatchIds: [`batch-mixed-${index}`]
  };
}

function passingFeedback(qualifiedTestClassName) {
  return {
    status: 'passed',
    mavenExecutions: [
      {
        scope: 'method_candidate',
        phase: 'test_compile',
        command: 'fake-mvn test-compile',
        exitCode: 0,
        stdout: '',
        stderr: '',
        surefireReports: []
      },
      {
        scope: 'method_candidate',
        phase: 'test',
        command: `fake-mvn -Dtest=${qualifiedTestClassName}`,
        exitCode: 0,
        stdout: '',
        stderr: '',
        surefireReports: [{ fileName: 'TEST-generated.xml', content: '<testsuite/>' }]
      }
    ],
    testReport: {
      reportCount: 1,
      tests: 1000,
      failures: 0,
      errors: 0,
      skipped: 0,
      generatedTestClassName: qualifiedTestClassName,
      generatedTests: 1000,
      generatedSkipped: 0,
      failureDetails: []
    }
  };
}

async function harness(t, prefix, mavenResult, packerOverrides = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  const moduleRoot = join(workspaceRoot, 'module');
  const targetFilePath = join(
    moduleRoot,
    'src',
    'main',
    'java',
    'com',
    'example',
    'TaskService.java'
  );
  await mkdir(dirname(targetFilePath), { recursive: true });
  await writeFile(targetFilePath, 'package com.example;\nclass TaskService {}\n', 'utf8');
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  let lockDepth = 0;
  const mavenCalls = [];
  const moduleLock = {
    async runExclusive(moduleKey, operation, signal) {
      assert.equal(moduleKey, 'module-key');
      assert.equal(signal?.aborted ?? false, false);
      assert.equal(lockDepth, 0);
      lockDepth += 1;
      try {
        return await operation();
      } finally {
        lockDepth -= 1;
      }
    }
  };
  const maven = {
    async execute(input) {
      assert.equal(lockDepth, 1, 'formal Maven verification must hold the module lock');
      mavenCalls.push(input);
      return mavenResult
        ? mavenResult(mavenCalls.length, input, {
            workspaceRoot,
            moduleRoot,
            targetFilePath
          })
        : passingFeedback(input.qualifiedTestClassName);
    }
  };
  let id = 0;
  const writer = new TestWriterService();
  const transaction = new ClassTaskFileTransactionService({
    writer,
    idFactory: () => `artifact-${++id}`,
    now: () => new Date(`2026-08-09T00:00:0${id}.000Z`)
  });
  const makePacker = (owner = transaction) => new FormalTestFilePackerService({
    taskId: TASK_ID,
    workspaceRoot,
    moduleRoot,
    moduleKey: 'module-key',
    targetFilePath,
    qualifiedClassName: 'com.example.TaskService',
    buildSettings: { mavenHome: 'fake-maven', javaHome: 'fake-java' },
    writer,
    reservations: new GeneratedTestNameReservationService(),
    transaction: owner,
    moduleLock,
    maven,
    idFactory: () => `attempt-${mavenCalls.length + 1}`,
    ...packerOverrides
  });
  const packer = makePacker();
  return {
    packer,
    transaction,
    mavenCalls,
    makePacker,
    workspaceRoot
  };
}

test('packs whole source-method bundles toward twenty tests without splitting them', async (t) => {
  const { packer } = await harness(t, 'formal-pack-counts-');
  for (const [index, count] of [8, 6, 5, 18].entries()) {
    await packer.append(methodBundle(index + 1, count));
  }
  await packer.finish();

  const artifacts = packer.artifacts();
  assert.deepEqual(
    artifacts.map((item) => item.ordinaryTestMethodCount),
    [19, 18]
  );
  assert.deepEqual(
    artifacts.map((item) => item.methodIds.length),
    [3, 1]
  );
  assert.deepEqual(
    artifacts.map((item) => item.methodResults.map((method) => [
      method.methodName,
      method.ordinaryTestMethodCount
    ])),
    [
      [['sourceMethod1', 8], ['sourceMethod2', 6], ['sourceMethod3', 5]],
      [['sourceMethod4', 18]]
    ]
  );
  assert.deepEqual(
    artifacts.map((item) => item.testClassName),
    ['TaskService1Test', 'TaskService2Test']
  );
  assert.deepEqual(artifacts.map((item) => item.sealed), [true, false]);

  const structure = new JavaTestStructureService();
  const firstCode = await readFile(artifacts[0].filePath, 'utf8');
  const secondCode = await readFile(artifacts[1].filePath, 'utf8');
  assert.equal(structure.findTestMethods(firstCode).length, 19);
  assert.equal(structure.findTestMethods(secondCode).length, 18);
  assert.match(firstCode, /class TaskService1Test/);
  assert.match(secondCode, /class TaskService2Test/);
});

test('appends one verified data-class group with one formal Maven verification', async (t) => {
  const { packer, mavenCalls } = await harness(t, 'formal-pack-group-');
  const bundles = [1, 2, 3].map((index) => methodBundle(index, 1));

  await packer.appendMany(bundles);

  assert.equal(mavenCalls.length, 1);
  assert.deepEqual(
    packer.artifacts().map((artifact) => ({
      tests: artifact.ordinaryTestMethodCount,
      methods: artifact.methodIds
    })),
    [{ tests: 3, methods: ['method-1', 'method-2', 'method-3'] }]
  );
});

test('publishes one repaired class-Wave candidate directly without formal member merging', async (t) => {
  const mergerCalls = [];
  const { packer, mavenCalls } = await harness(
    t,
    'formal-pack-class-wave-direct-',
    undefined,
    {
      merger: {
        merge(...args) {
          mergerCalls.push(args);
          throw new Error('formal member merger must not run for a shared class-Wave candidate');
        }
      }
    }
  );
  const first = waveBundle(1, 1, 3, false);
  const second = waveBundle(2, 1, 2, false);
  const names = [...first.passedTestMethods, ...second.passedTestMethods];
  const code = [
    'package com.example;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    ...names.flatMap((name) => [
      '    @Test',
      `    void ${name}() {}`,
      ''
    ]),
    '}',
    ''
  ].join('\n');

  const artifact = await packer.appendSharedTemporaryGroup({
    code,
    bundles: [first, second]
  });

  assert.equal(mergerCalls.length, 0);
  assert.equal(mavenCalls.length, 1);
  assert.equal(artifact.sealed, true);
  assert.deepEqual(artifact.methodIds, ['method-1', 'method-2']);
  assert.deepEqual(
    artifact.methodResults.map((method) => method.ordinaryTestMethodCount),
    [3, 2]
  );
  const published = await readFile(artifact.filePath, 'utf8');
  assert.match(published, /public class TaskService1Test/);
  assert.doesNotMatch(published, /TaskServiceTmp1Test/);
});

test('falls back to independent formal files when delayed appendMany verification rejects the merge', async (t) => {
  // Mutation caught: appendMany rollback followed by rethrow loses a data-class group even
  // though each original TMP was already Maven-passing and can be published independently.
  const { packer, mavenCalls } = await harness(
    t,
    'formal-pack-group-verification-fallback-',
    async (_call, input, context) => {
      const testClassName = input.qualifiedTestClassName.split('.').at(-1);
      const code = await readFile(join(
        context.moduleRoot,
        'src',
        'test',
        'java',
        'com',
        'example',
        `${testClassName}.java`
      ), 'utf8');
      const combinesBothMethods = /method1Case1/u.test(code) && /method2Case1/u.test(code);
      return combinesBothMethods
        ? {
            status: 'test_failed',
            mavenExecutions: [],
            testReport: {
              ...passingFeedback(input.qualifiedTestClassName).testReport,
              failures: 1,
              failureDetails: []
            }
          }
        : passingFeedback(input.qualifiedTestClassName);
    }
  );

  await packer.appendMany([methodBundle(1, 1), methodBundle(2, 1)]);

  assert.deepEqual(
    packer.artifacts().map((artifact) => ({
      tests: artifact.ordinaryTestMethodCount,
      methods: artifact.methodIds
    })),
    [
      { tests: 1, methods: ['method-1'] },
      { tests: 1, methods: ['method-2'] }
    ]
  );
  assert.equal(mavenCalls.length, 4);
});

test('starts a new file instead of splitting a bundle that would cross twenty tests', async (t) => {
  const { packer } = await harness(t, 'formal-pack-user-example-');
  for (const [index, count] of [6, 8, 7, 9].entries()) {
    await packer.append(methodBundle(index + 1, count));
  }
  await packer.finish();

  assert.deepEqual(
    packer.artifacts().map((item) => [
      item.ordinaryTestMethodCount,
      item.methodIds
    ]),
    [
      [14, ['method-1', 'method-2']],
      [16, ['method-3', 'method-4']]
    ]
  );
});

test('keeps a single-Wave bundle over twenty tests whole and independent', async (t) => {
  const { packer } = await harness(t, 'formal-pack-one-method-whole-');

  await packer.append(waveBundle(1, 1, 29, false));
  await packer.finish();

  assert.deepEqual(
    packer.artifacts().map((item) => [
      item.testClassName,
      item.ordinaryTestMethodCount,
      item.methodIds,
      item.methodResults.map((method) => method.ordinaryTestMethodCount),
      item.sealed
    ]),
    [
      ['TaskService1Test', 29, ['method-1'], [29], true]
    ]
  );
});

test('keeps every Wave of a multi-Wave source method independent including its short tail', async (t) => {
  const { packer } = await harness(t, 'formal-pack-multi-wave-independent-');

  await packer.append(waveBundle(1, 1, 25, true));
  await packer.append(waveBundle(1, 2, 20, true));
  await packer.append(waveBundle(1, 3, 5, false));
  await packer.finish();

  assert.deepEqual(
    packer.artifacts().map((item) => [
      item.ordinaryTestMethodCount,
      item.methodIds,
      item.sealed
    ]),
    [
      [25, ['method-1'], true],
      [20, ['method-1'], true],
      [5, ['method-1'], true]
    ]
  );
});

test('does not append another method to a single-Wave bundle at the twenty-test target', async (t) => {
  const { packer } = await harness(t, 'formal-pack-target-independent-');

  await packer.append(waveBundle(1, 1, 20, false));
  await packer.append(methodBundle(2, 12));
  await packer.finish();

  assert.deepEqual(
    packer.artifacts().map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [
      [20, ['method-1']],
      [12, ['method-2']]
    ]
  );
});

test('keeps active and retained tests from one TMP in the same formal file', async (t) => {
  const { packer } = await harness(t, 'formal-pack-retained-source-whole-');

  await packer.append(mixedRetainedMethodBundle(1, 5, 20));
  await packer.finish();

  const artifacts = packer.artifacts();
  assert.deepEqual(
    artifacts.map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [[5, ['method-1']]]
  );
  assert.deepEqual(
    await Promise.all(artifacts.map(async (artifact) => {
      const code = await readFile(artifact.filePath, 'utf8');
      return [
        new JavaTestStructureService().findTestMethods(code).length
          + [...code.matchAll(/^\s*\/\/ TODO 当前测试方法需要修复\s*$/gm)].length,
        [...code.matchAll(/private void helper\(\)/g)].length
      ];
    })),
    [[25, 1]]
  );
});

test('publishes an incompatible whole bundle as a new formal file', async (t) => {
  const { packer } = await harness(t, 'formal-pack-incompatible-support-');
  const first = customBundle(1, [
    '    private String shared = "first";',
    '    @Test void firstCase() { shared.length(); }'
  ]);
  const second = customBundle(2, [
    '    private Integer shared = 2;',
    '    @Test void secondCase() { shared.intValue(); }'
  ]);

  await packer.append(first);
  await packer.append(second);

  assert.deepEqual(
    packer.artifacts().map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [
      [1, ['method-1']],
      [1, ['method-2']]
    ]
  );
});

test('rolls back a failed combined formal candidate and publishes the passing TMP independently', async (t) => {
  const { packer } = await harness(
    t,
    'formal-pack-merge-verification-fallback-',
    (call, input) => call === 2
      ? {
          status: 'test_failed',
          mavenExecutions: [],
          testReport: {
            ...passingFeedback(input.qualifiedTestClassName).testReport,
            failures: 1,
            failureDetails: []
          }
        }
      : passingFeedback(input.qualifiedTestClassName)
  );

  await packer.append(methodBundle(1, 8));
  const firstBefore = packer.artifacts()[0];
  const firstCode = await readFile(firstBefore.filePath, 'utf8');

  await packer.append(methodBundle(2, 6));

  const artifacts = packer.artifacts();
  assert.deepEqual(
    artifacts.map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [
      [8, ['method-1']],
      [6, ['method-2']]
    ]
  );
  assert.equal(await readFile(artifacts[0].filePath, 'utf8'), firstCode);
});

test('restores completed Wave identities and accepts the next Wave without merging it', async (t) => {
  const { packer, makePacker, workspaceRoot } = await harness(
    t,
    'formal-pack-wave-restart-'
  );
  await packer.append(waveBundle(1, 1, 25, true));
  const restoredTransaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService()
  });
  await restoredTransaction.restoreTask({
    taskId: TASK_ID,
    workspaceRoot,
    artifacts: packer.artifacts()
  });
  const restarted = makePacker(restoredTransaction);

  await restarted.append(waveBundle(1, 2, 6, false));

  assert.deepEqual(
    restarted.artifacts().map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [
      [25, ['method-1']],
      [6, ['method-1']]
    ]
  );
});

test('restores split Waves when historical JaCoCo display order drifted', async (t) => {
  const { packer, makePacker, workspaceRoot } = await harness(
    t,
    'formal-pack-wave-jacoco-order-drift-'
  );
  await packer.append(waveBundle(1, 1, 25, true));
  await packer.append(waveBundle(1, 2, 20, true));
  const restoredArtifacts = packer.artifacts();
  restoredArtifacts[1].methodResults[0].jacocoOrder = 1;

  const restoredTransaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService()
  });
  await restoredTransaction.restoreTask({
    taskId: TASK_ID,
    workspaceRoot,
    artifacts: restoredArtifacts
  });
  const restarted = makePacker(restoredTransaction);

  await restarted.append(waveBundle(1, 3, 6, false));

  assert.deepEqual(
    restarted.artifacts().map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [
      [25, ['method-1']],
      [20, ['method-1']],
      [6, ['method-1']]
    ]
  );
});

test('appends a partially retained method to TaskService5Test and continues appending the next method', async (t) => {
  const { packer, workspaceRoot } = await harness(t, 'formal-pack-retained-method-');
  const testDirectory = join(
    workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'com',
    'example'
  );
  await mkdir(testDirectory, { recursive: true });
  for (let index = 1; index <= 4; index += 1) {
    await writeFile(
      join(testDirectory, `TaskService${index}Test.java`),
      `package com.example;\nclass TaskService${index}Test {}\n`,
      'utf8'
    );
  }
  const retainedFailures = Array.from({ length: 11 }, (_, index) => {
    const suffix = String(index + 2).padStart(2, '0');
    return [
      '    // TODO 当前测试方法需要修复',
      '    // @Test',
      `    // void getChildZipFile_P${suffix}() {`,
      '    //     newTask();',
      '    // }',
      ''
    ];
  }).flat();
  const firstCode = [
    'package com.example;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class TaskServiceTmp1Test {',
    '    private Object newTask() {',
    '        return new Object();',
    '    }',
    '',
    '    @Test',
    '    void getChildZipFile_P01() {',
    '        newTask();',
    '    }',
    '',
    ...retainedFailures,
    '}',
    ''
  ].join('\n');
  const firstBundle = {
    methodId: 'method-retained',
    methodName: 'getChildZipFile',
    displaySignature: 'public void getChildZipFile()',
    jacocoOrder: 0,
    code: firstCode,
    ordinaryTestMethodCount: 1,
    passedTestMethods: ['getChildZipFile_P01'],
    sourceBatchIds: ['batch-retained']
  };

  const firstArtifact = await packer.append(firstBundle);
  const secondArtifact = await packer.append(methodBundle(2, 2));

  assert.equal(firstArtifact.testClassName, 'TaskService5Test');
  assert.equal(secondArtifact.id, firstArtifact.id);
  assert.equal(secondArtifact.testClassName, 'TaskService5Test');
  assert.equal(secondArtifact.ordinaryTestMethodCount, 3);
  assert.deepEqual(secondArtifact.methodIds, ['method-retained', 'method-2']);
  const code = await readFile(secondArtifact.filePath, 'utf8');
  assert.match(code, /class TaskService5Test\b/);
  assert.doesNotMatch(code, /class TaskServiceTmp1Test\b/);
  assert.match(code, /private Object newTask\(\)/);
  assert.equal(
    [...code.matchAll(/^\s*\/\/ TODO 当前测试方法需要修复\s*$/gm)].length,
    11
  );
  assert.deepEqual(
    new JavaTestStructureService().findTestMethods(code).map((method) => method.name),
    ['getChildZipFile_P01', 'method2Case1', 'method2Case2']
  );
});

test('formalizes a fully commented method as TaskService5Test before appending the next method', async (t) => {
  const { packer, workspaceRoot, mavenCalls } = await harness(
    t,
    'formal-pack-fully-commented-method-'
  );
  const testDirectory = join(
    workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'com',
    'example'
  );
  await mkdir(testDirectory, { recursive: true });
  for (let index = 1; index <= 4; index += 1) {
    await writeFile(
      join(testDirectory, `TaskService${index}Test.java`),
      `package com.example;\nclass TaskService${index}Test {}\n`,
      'utf8'
    );
  }
  const retainedCode = [
    'package com.example;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class TaskServiceTmp1Test {',
    '    private Object newTask() {',
    '        return new Object();',
    '    }',
    '',
    '    // TODO 当前测试方法需要修复',
    '    // @Test',
    '    // void getChildZipFile_P01() {',
    '    //     newTask();',
    '    // }',
    '}',
    ''
  ].join('\n');
  const retainedBundle = {
    methodId: 'method-retained-zero',
    methodName: 'getChildZipFile',
    displaySignature: 'public void getChildZipFile()',
    jacocoOrder: 0,
    code: retainedCode,
    ordinaryTestMethodCount: 0,
    passedTestMethods: [],
    sourceBatchIds: ['batch-retained-zero']
  };

  const firstArtifact = await packer.append(retainedBundle);

  assert.equal(firstArtifact.testClassName, 'TaskService5Test');
  assert.equal(firstArtifact.ordinaryTestMethodCount, 0);
  assert.deepEqual(firstArtifact.methodIds, ['method-retained-zero']);
  assert.equal(mavenCalls.length, 0);

  const secondArtifact = await packer.append(methodBundle(2, 2));

  assert.equal(secondArtifact.id, firstArtifact.id);
  assert.equal(secondArtifact.testClassName, 'TaskService5Test');
  assert.equal(secondArtifact.ordinaryTestMethodCount, 2);
  assert.deepEqual(secondArtifact.methodIds, ['method-retained-zero', 'method-2']);
  assert.deepEqual(
    secondArtifact.methodResults.map((method) => method.ordinaryTestMethodCount),
    [0, 2]
  );
  assert.equal(mavenCalls.length, 1);
  const code = await readFile(secondArtifact.filePath, 'utf8');
  assert.match(code, /class TaskService5Test\b/);
  assert.match(code, /private Object newTask\(\)/);
  assert.match(code, /\/\/ TODO 当前测试方法需要修复/);
  assert.deepEqual(
    new JavaTestStructureService().findTestMethods(code).map((method) => method.name),
    ['method2Case1', 'method2Case2']
  );
});

test('a new source method starts another file when the current file already has twenty tests', async (t) => {
  const { packer } = await harness(t, 'formal-pack-boundary-');
  await packer.append(methodBundle(1, 20));
  assert.deepEqual(packer.artifacts().map((item) => item.sealed), [true]);

  await packer.append(methodBundle(2, 1));

  assert.deepEqual(
    packer.artifacts().map((item) => [
      item.ordinaryTestMethodCount,
      item.methodIds,
      item.sealed
    ]),
    [
      [20, ['method-1'], true],
      [1, ['method-2'], false]
    ]
  );
});

test('commented test methods consume formal-file capacity without becoming passed tests', async (t) => {
  const { packer } = await harness(t, 'formal-pack-retained-capacity-');

  await packer.append(retainedMethodBundle(1, 12));
  await packer.append(methodBundle(2, 4));

  assert.deepEqual(
    packer.artifacts().map((item) => [
      item.ordinaryTestMethodCount,
      item.methodIds,
      item.sealed
    ]),
    [[4, ['method-retained-1', 'method-2'], false]]
  );

  await packer.append(methodBundle(3, 5));

  assert.deepEqual(
    packer.artifacts().map((item) => [
      item.testClassName,
      item.ordinaryTestMethodCount,
      item.methodIds,
      item.sealed
    ]),
    [
      ['TaskService1Test', 4, ['method-retained-1', 'method-2'], true],
      ['TaskService2Test', 5, ['method-3'], false]
    ]
  );
});

test('finish re-verifies and retains a nonempty under-limit tail as the current file', async (t) => {
  const { packer, mavenCalls } = await harness(t, 'formal-pack-tail-');
  await packer.append(methodBundle(1, 4));

  await packer.finish();

  assert.equal(mavenCalls.length, 2);
  assert.deepEqual(
    packer.artifacts().map((item) => [item.ordinaryTestMethodCount, item.sealed]),
    [[4, false]]
  );
});

test('failed append restores the previously verified unsealed formal file', async (t) => {
  const { packer } = await harness(
    t,
    'formal-pack-rollback-',
    (call, input) => call >= 2
      ? {
          status: 'test_failed',
          mavenExecutions: [],
          testReport: {
            ...passingFeedback(input.qualifiedTestClassName).testReport,
            failures: 1,
            failureDetails: [{
              testClassName: input.qualifiedTestClassName,
              testMethodName: 'method2Case1',
              type: 'java.lang.AssertionError',
              message: 'failed',
              stackTrace: 'failed'
            }]
          }
        }
      : passingFeedback(input.qualifiedTestClassName)
  );
  await packer.append(methodBundle(1, 8));
  const before = packer.artifacts()[0];
  const beforeCode = await readFile(before.filePath, 'utf8');

  await assert.rejects(packer.append(methodBundle(2, 6)), /verification/i);

  const after = packer.artifacts()[0];
  assert.equal(after.sha256, before.sha256);
  assert.equal(after.ordinaryTestMethodCount, 8);
  assert.deepEqual(after.methodIds, ['method-1']);
  assert.equal(await readFile(after.filePath, 'utf8'), beforeCode);
  assert.equal(createHash('sha256').update(beforeCode).digest('hex'), before.sha256);
});

test('a restarted packer continues the persisted unsealed tail instead of opening a new file', async (t) => {
  const {
    packer,
    makePacker,
    workspaceRoot
  } = await harness(t, 'formal-pack-restart-');
  await packer.append(methodBundle(1, 8));
  const before = packer.artifacts();
  const restoredTransaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService()
  });
  await restoredTransaction.restoreTask({
    taskId: TASK_ID,
    workspaceRoot,
    artifacts: before
  });
  const restarted = makePacker(restoredTransaction);

  await restarted.append(methodBundle(2, 6));

  assert.deepEqual(
    restarted.artifacts().map((item) => [
      item.testClassName,
      item.ordinaryTestMethodCount,
      item.methodIds,
      item.sealed
    ]),
    [[
      'TaskService1Test',
      14,
      ['method-1', 'method-2'],
      false
    ]]
  );
});

test('finish detects and preserves a user edit made while Maven is running', async (t) => {
  const userEdit = 'package com.example;\nclass TaskService1Test { void userEdit() {} }\n';
  const { packer } = await harness(
    t,
    'formal-pack-finish-race-',
    async (call, input, context) => {
      if (call === 2) {
        await writeFile(
          join(
            context.moduleRoot,
            'src',
            'test',
            'java',
            'com',
            'example',
            'TaskService1Test.java'
          ),
          userEdit,
          'utf8'
        );
      }
      return passingFeedback(input.qualifiedTestClassName);
    }
  );
  await packer.append(methodBundle(1, 4));
  const artifact = packer.artifacts()[0];

  await assert.rejects(packer.finish(), /modified|changed|ownership/i);

  assert.equal(await readFile(artifact.filePath, 'utf8'), userEdit);
});

test('cancellation reported during Maven rolls back the uncommitted append', async (t) => {
  const controller = new AbortController();
  const reason = new Error('task terminated');
  const { packer } = await harness(
    t,
    'formal-pack-abort-',
    (call, input) => {
      if (call === 2) controller.abort(reason);
      return passingFeedback(input.qualifiedTestClassName);
    }
  );
  await packer.append(methodBundle(1, 8), controller.signal);
  const before = packer.artifacts()[0];
  const beforeCode = await readFile(before.filePath, 'utf8');

  await assert.rejects(
    packer.append(methodBundle(2, 6), controller.signal),
    (error) => error === reason
  );

  assert.deepEqual(
    packer.artifacts().map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [[8, ['method-1']]]
  );
  assert.equal(await readFile(before.filePath, 'utf8'), beforeCode);
});

test('failed restored-tail validation leaves initialization retryable after the file is repaired', async (t) => {
  const {
    packer,
    makePacker,
    workspaceRoot
  } = await harness(t, 'formal-pack-restore-retry-');
  await packer.append(methodBundle(1, 8));
  const artifacts = packer.artifacts();
  const originalCode = await readFile(artifacts[0].filePath, 'utf8');
  const restoredTransaction = new ClassTaskFileTransactionService({
    writer: new TestWriterService()
  });
  await restoredTransaction.restoreTask({
    taskId: TASK_ID,
    workspaceRoot,
    artifacts
  });
  const restarted = makePacker(restoredTransaction);
  await writeFile(
    artifacts[0].filePath,
    'package com.example;\nclass TaskService1Test { void userEdit() {} }\n',
    'utf8'
  );
  await assert.rejects(
    restarted.append(methodBundle(2, 6)),
    (error) => error?.code === 'GENERATED_TEST_EXTERNALLY_MODIFIED'
  );
  await writeFile(artifacts[0].filePath, originalCode, 'utf8');

  await restarted.append(methodBundle(2, 6));

  assert.deepEqual(
    restarted.artifacts().map((item) => [item.ordinaryTestMethodCount, item.methodIds]),
    [[14, ['method-1', 'method-2']]]
  );
});

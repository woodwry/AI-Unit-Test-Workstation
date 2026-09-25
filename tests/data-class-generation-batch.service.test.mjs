import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DataClassGenerationBatchService,
  planDataClassGenerationBatches
} from '../src/main/services/data-class-generation-batch.service.ts';

function fact(methodId, overrides = {}) {
  return {
    methodId,
    methodName: `get${methodId}`,
    descriptor: '()Ljava/lang/String;',
    parameterCount: 0,
    modifiers: ['public'],
    scenarioCount: 1,
    plannedTestMethods: 1,
    remainingTestMethods: 0,
    requiredCallCount: 0,
    activeStubCount: 0,
    sourceCharacterCount: 40,
    lombokGenerated: false,
    ...overrides
  };
}

test('all selected data-class methods stay in one generation group beyond fifteen scenarios', () => {
  const facts = Array.from({ length: 16 }, (_, index) => fact(`M${index + 1}`));

  const batches = planDataClassGenerationBatches({
    classKind: 'DATA_EXPLICIT_ACCESSORS',
    methodOrder: facts.map((item) => item.methodId),
    facts
  });

  assert.deepEqual(batches.map((batch) => batch.methodIds), [
    facts.map((item) => item.methodId)
  ]);
  assert.deepEqual(batches.map((batch) => batch.scenarioCount), [16]);
  assert.equal(batches[0].fastPath, true);
});

test('one selected data-class method still uses the one-shot group', () => {
  const batches = planDataClassGenerationBatches({
    classKind: 'DATA_LOMBOK',
    methodOrder: ['equals'],
    facts: [fact('equals', {
      methodName: 'equals',
      descriptor: '(Ljava/lang/Object;)Z',
      parameterCount: 1,
      lombokGenerated: true
    })]
  });

  assert.deepEqual(batches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [['equals'], true]
  ]);
});

test('scenario totals do not split selected data-class methods into multiple calls', () => {
  const facts = [
    fact('A', { scenarioCount: 8, plannedTestMethods: 4 }),
    fact('B', { scenarioCount: 7, plannedTestMethods: 4 }),
    fact('C', { scenarioCount: 2, plannedTestMethods: 2 })
  ];

  const batches = planDataClassGenerationBatches({
    classKind: 'DATA_SETTER_ONLY',
    methodOrder: ['A', 'B', 'C'],
    facts
  });

  assert.deepEqual(batches.map((batch) => [batch.methodIds, batch.scenarioCount]), [
    [['A', 'B', 'C'], 17]
  ]);
});

test('a scenario-heavy selected data-class method does not split the one-shot group', () => {
  const batches = planDataClassGenerationBatches({
    classKind: 'DATA_LOMBOK',
    methodOrder: ['large', 'small'],
    facts: [
      fact('large', { scenarioCount: 18 }),
      fact('small')
    ]
  });

  assert.deepEqual(batches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [['large', 'small'], true]
  ]);
});

test('business methods and methods with external calls stay on the existing single-method path', () => {
  const batches = planDataClassGenerationBatches({
    classKind: 'DATA_EXPLICIT_ACCESSORS',
    methodOrder: ['getName', 'calculatePrice', 'setName', 'getRemoteValue'],
    facts: [
      fact('getName'),
      fact('calculatePrice', { methodName: 'calculatePrice' }),
      fact('setName', {
        methodName: 'setName',
        descriptor: '(Ljava/lang/String;)V',
        parameterCount: 1
      }),
      fact('getRemoteValue', { requiredCallCount: 1, activeStubCount: 1 })
    ]
  });

  assert.deepEqual(batches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [['getName'], false],
    [['calculatePrice'], false],
    [['setName'], false],
    [['getRemoteValue'], false]
  ]);
});

test('Lombok data contracts batch with accessors while explicit business overrides stay isolated', () => {
  const facts = [
    fact('getName'),
    fact('equals', {
      methodName: 'equals',
      descriptor: '(Ljava/lang/Object;)Z',
      parameterCount: 1,
      requiredCallCount: 1,
      lombokGenerated: true
    }),
    fact('hashCode', {
      methodName: 'hashCode',
      descriptor: '()I',
      lombokGenerated: true
    }),
    fact('toString', {
      methodName: 'toString',
      descriptor: '()Ljava/lang/String;',
      lombokGenerated: true
    })
  ];

  const lombokBatches = planDataClassGenerationBatches({
    classKind: 'DATA_LOMBOK',
    methodOrder: facts.map((item) => item.methodId),
    facts
  });
  assert.deepEqual(lombokBatches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [facts.map((item) => item.methodId), true]
  ]);

  const explicitBatches = planDataClassGenerationBatches({
    classKind: 'DATA_EXPLICIT_ACCESSORS',
    methodOrder: facts.map((item) => item.methodId),
    facts
  });
  assert.deepEqual(explicitBatches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [['getName'], false],
    [['equals'], false],
    [['hashCode'], false],
    [['toString'], false]
  ]);
});

test('non-data classes preserve the current one-method generation behavior', () => {
  const batches = planDataClassGenerationBatches({
    classKind: 'SERVICE_WITH_DEPENDENCIES',
    methodOrder: ['getA', 'setA'],
    facts: [
      fact('getA'),
      fact('setA', { methodName: 'setA', descriptor: '(I)V' })
    ]
  });

  assert.deepEqual(batches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [['getA'], false],
    [['setA'], false]
  ]);
});

test('a set-prefixed business method with multiple parameters is not treated as a setter', () => {
  const batches = planDataClassGenerationBatches({
    classKind: 'DATA_EXPLICIT_ACCESSORS',
    methodOrder: ['setBoth', 'getName'],
    facts: [
      fact('setBoth', {
        methodName: 'setBoth',
        descriptor: '(Ljava/lang/String;Ljava/lang/String;)V',
        parameterCount: 2
      }),
      fact('getName')
    ]
  });

  assert.deepEqual(batches.map((batch) => [batch.methodIds, batch.fastPath]), [
    [['setBoth'], false],
    [['getName'], false]
  ]);
});

function page(methodId, methodName, scenarioCount = 1) {
  return {
    batchId: createHash('sha256').update(`batch:${methodId}`).digest('hex'),
    reportPairId: 'a'.repeat(64),
    methodId,
    hasWork: true,
    method: {
      methodId,
      declaringType: 'example.UserVO',
      methodName,
      descriptor: methodName.startsWith('set') ? '(Ljava/lang/String;)V' : '()Ljava/lang/String;',
      firstLine: 1,
      lastLine: 3,
      completeMethodSource: methodName.startsWith('set')
        ? `public void ${methodName}(String value) { this.value = value; }`
        : `public String ${methodName}() { return value; }`,
      modifiers: ['public'],
      parameterTypes: methodName.startsWith('set') ? ['java.lang.String'] : [],
      returnType: methodName.startsWith('set') ? 'void' : 'java.lang.String',
      declaredExceptions: [],
      invocationPlan: { strategy: 'DIRECT', receiverExpression: 'target' },
      activeScenarioIds: Array.from({ length: scenarioCount }, (_, index) => `${methodId}-s${index}`)
    },
    scenarios: Array.from({ length: scenarioCount }, (_, index) => ({
      scenarioId: `${methodId}-s${index}`,
      methodId,
      chineseDescription: `scenario ${index + 1}`
    })),
    methodTestPlan: {
      methodId,
      testMethodPlans: [{ testMethodPlanId: `${methodId}-plan`, methodId }]
    },
    methodStubInventory: { methodId, requiredCallCount: 0, calls: [] },
    activeStubPlans: [],
    targetFixturePlan: {
      targetClass: 'example.UserVO',
      targetVariableName: 'target',
      targetClassDeclaration: 'UserVO target = new UserVO();',
      dependencySourceDeclarations: [],
      constructionMode: 'DIRECT_CONSTRUCTOR',
      constructorParameterTypes: [],
      constructorArgumentFixtureIds: [],
      dependencies: [],
      setupStatements: [],
      status: 'READY',
      chineseInstruction: '直接创建真实对象。'
    },
    referencedTypes: [],
    necessaryImports: ['org.junit.jupiter.api.Test'],
    plannedTestMethods: 1,
    remainingTestMethods: 0,
    warnings: []
  };
}

function batchModelOutput(methodNames, className = 'UserVOTmp1Test') {
  return [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    `class ${className} {`,
    ...methodNames.map((methodName, index) => (
      `  @Test void m${String(index + 1).padStart(2, '0')}_${methodName}() {}`
    )),
    '}'
  ].join('\n');
}

function executionHarness(overrides = {}) {
  const pages = new Map([
    ['1'.repeat(64), page('1'.repeat(64), 'getName')],
    ['2'.repeat(64), page('2'.repeat(64), 'setName')]
  ]);
  const written = new Map();
  const commits = [];
  const atomicSteps = [];
  const modelUsageUpdates = [];
  const modelPrompts = [];
  const modelLogRecords = [];
  const analyzerRequests = [];
  const candidateMoves = [];
  let modelCalls = 0;
  let mavenCalls = 0;
  const output = overrides.modelOutput ?? [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'class UserVOTmp1Test {',
    '  @Test void m01_getName() { new UserVO().getName(); }',
    '  @Test void m02_setName() { new UserVO().setName("x"); }',
    '  private UserVO helper() { return new UserVO(); }',
    '}'
  ].join('\n');
  const modelOutputs = overrides.modelOutputs ?? [output];
  const generatedTestCount = (output.match(/@Test\b/g) ?? []).length;
  const checkpoints = {
    async methodCheckpoint() {
      return { completedBatches: [], completedTestMethodPlanIds: [] };
    },
    async taskProgress() {
      return {
        catalogIdentity: { analysisSessionId: 'analysis', reportPairId: 'a'.repeat(64) },
        resolvedMethodOrder: [...pages.keys()],
        completedMethodIds: [],
        methods: {}
      };
    },
    async beginAtomicStep(_taskId, step, activeGenerationBatch) {
      atomicSteps.push({ phase: 'begin', step, activeGenerationBatch });
    },
    async completeAtomicStep(_taskId, step) {
      atomicSteps.push({ phase: 'complete', step });
    },
    async commitBatch(value) { commits.push(structuredClone(value)); },
    async addModelUsage(taskId, value) {
      modelUsageUpdates.push({ taskId, ...structuredClone(value) });
    }
  };
  const service = new DataClassGenerationBatchService({
    analyzer: {
      async classifyUnitTestTarget() {
        return {
          targetClass: 'example.UserVO', packageName: 'example', className: 'UserVO',
          classKind: overrides.classKind ?? 'DATA_EXPLICIT_ACCESSORS',
          features: {
            lombokAnnotations: [], hasServiceAnnotation: false,
            hasDependencyInjectionAnnotations: false, dataClassName: true
          }
        };
      },
      async nextMethodBatch(_sessionId, methodId, request) {
        analyzerRequests.push({ methodId, request: structuredClone(request) });
        return pages.get(methodId);
      }
    },
    agent: {
      async generateUnitTestPrompt(prompt) {
        modelCalls += 1;
        modelPrompts.push(prompt);
        if (overrides.modelError) throw overrides.modelError;
        return {
          result: modelOutputs[Math.min(modelCalls - 1, modelOutputs.length - 1)],
          provider: 'openai-compatible',
          model: 'model',
          generationMode: 'deterministic_prompt',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        };
      }
    },
    contextProvider: {
      async resolve() {
        return {
          analysisSessionId: '00000000-0000-4000-8000-000000000001',
          reportPairId: 'a'.repeat(64),
          packageName: 'example',
          plannedRelativeTestPath: 'src/test/java/example/UserVOTest.java',
          moduleRoot: 'D:\\workspace',
          buildSettings: {},
          modelContext: { llmConfig: {} },
          captureModelCalls: overrides.captureModelCalls ?? false
        };
      }
    },
    checkpoints,
    moduleLock: { async runExclusive(_key, operation) { return operation(); } },
    writer: {
      async prepareMethodBatchTemporaryGeneratedTest(input) {
        const content = input.content.replace(/\bUserVOTmp\d+Test\b/g, input.outputTestClassName);
        return {
          workspaceRoot: input.workspaceRoot,
          testFilePath: `D:\\workspace\\${input.outputTestClassName}.java`,
          relativePath: `${input.outputTestClassName}.java`,
          testClassName: input.outputTestClassName,
          content,
          sha256: createHash('sha256').update(content).digest('hex')
        };
      },
      async writePreparedGeneratedTest(prepared) {
        const sha256 = createHash('sha256').update(prepared.content).digest('hex');
        written.set(prepared.testFilePath, { code: prepared.content, sha256 });
        return {
          testFilePath: prepared.testFilePath,
          relativePath: prepared.relativePath,
          testClassName: prepared.testClassName,
          sha256
        };
      },
      async loadOwnedGeneratedTest(input) {
        const owned = written.get(input.filePath);
        if (!owned || owned.sha256 !== input.expectedSha256) {
          throw new Error('owned generated test is unavailable');
        }
        return owned.code;
      },
      prepareReplacement(input) {
        const content = input.content;
        return {
          testClassName: input.filePath.split(/[\\/]/).at(-1).replace(/\.java$/, ''),
          content,
          sha256: createHash('sha256').update(content).digest('hex'),
          bytesWritten: Buffer.byteLength(content, 'utf8')
        };
      },
      async replacePreparedGeneratedTest(input) {
        const owned = written.get(input.filePath);
        if (!owned || owned.sha256 !== input.expectedSha256) {
          throw new Error('owned generated test is unavailable');
        }
        written.set(input.filePath, {
          code: input.prepared.content,
          sha256: input.prepared.sha256
        });
        return {
          sha256: input.prepared.sha256,
          bytesWritten: input.prepared.bytesWritten
        };
      },
      async deleteGeneratedTest(input) { written.delete(input.filePath); }
    },
    candidateFiles: {
      async moveWaveCandidateFiles(input) {
        const prepared = input.moves.map((move) => ({ ...move, phase: 'PREPARED' }));
        await input.saveMoveTransactions(prepared);
        for (const move of input.moves) {
          candidateMoves.push({ sourcePath: move.sourcePath, targetPath: move.targetPath });
          const owned = written.get(move.sourcePath);
          if (!owned || owned.sha256 !== move.sha256) {
            throw new Error('owned generated test is unavailable');
          }
          written.delete(move.sourcePath);
          written.set(move.targetPath, owned);
        }
        const moved = input.moves.map((move) => ({ ...move, phase: 'MOVED' }));
        await input.saveMoveTransactions(moved);
        return moved;
      }
    },
    maven: {
      async execute() {
        mavenCalls += 1;
        return overrides.mavenResults?.[Math.min(
          mavenCalls - 1,
          overrides.mavenResults.length - 1
        )] ?? overrides.mavenResult ?? {
          status: 'passed',
          mavenExecutions: [],
          testReport: {
            tests: generatedTestCount, failures: 0, errors: 0, skipped: 0,
            generatedTests: generatedTestCount, generatedSkipped: 0, testCases: []
          }
        };
      }
    },
    logs: {
      async record(record) {
        modelLogRecords.push(structuredClone(record));
      }
    },
    randomUUID: () => '00000000-0000-4000-8000-000000000002'
  });
  return {
    service, pages, written, commits, atomicSteps, modelUsageUpdates, modelPrompts,
    modelLogRecords, analyzerRequests,
    candidateMoves,
    modelCalls: () => modelCalls,
    mavenCalls: () => mavenCalls,
    checkpoints
  };
}

const TASK = {
  id: '00000000-0000-4000-8000-000000000010',
  workspaceRoot: 'D:\\workspace',
  sourceFilePath: 'D:\\workspace\\src\\main\\java\\example\\UserVO.java',
  qualifiedClassName: 'example.UserVO',
  moduleKey: 'd:/workspace',
  moduleDisplayPath: 'D:\\workspace',
  repairAttemptLimit: 3,
  unlimitedRepair: false
};

test('batch service plans from Analyzer scenarios and verifies the group with one model and Maven call', async () => {
  const h = executionHarness();
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];

  const groups = await h.service.plan(TASK, methodIds, new AbortController().signal);
  assert.deepEqual(groups, [methodIds]);
  assert.ok(h.analyzerRequests.every(({ request }) => request.maxTestMethods === 20_000));

  const methodCheckpoints = Object.fromEntries(methodIds.map((methodId) => [
    methodId, { completedBatches: [], completedTestMethodPlanIds: [] }
  ]));
  const handled = await h.service.execute(
    TASK,
    methodIds,
    methodCheckpoints,
    new AbortController().signal
  );

  assert.equal(handled, true);
  assert.equal(h.modelCalls(), 1);
  assert.deepEqual(h.modelUsageUpdates, [{
    taskId: TASK.id,
    tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    modelCallCount: 1,
    usageReportedCallCount: 1
  }]);
  assert.equal(h.mavenCalls(), 1);
  assert.equal(h.commits.length, 2);
  assert.deepEqual(
    h.atomicSteps.find((entry) => entry.phase === 'begin' && entry.step === 'MODEL_GENERATION')
      ?.activeGenerationBatch,
    { methodCount: 2, scenarioCount: 2 }
  );
  assert.deepEqual(h.commits.map((item) => item.methodId), methodIds);
  const outputs = [...h.written.values()].map((item) => item.code);
  assert.equal(outputs.length, 1, 'one verified generation group must remain one TMP file');
  assert.match(outputs[0], /m01_getName/);
  assert.match(outputs[0], /m02_setName/);
  assert.match(outputs[0], /helper\(\)/);
  assert.equal(new Set(h.commits.map((item) => item.tmpFilePath)).size, 1);
  assert.equal(new Set(h.commits.map((item) => item.tmpFileSha256)).size, 1);

  const committedCheckpoints = Object.fromEntries(h.commits.map((item) => [
    item.methodId,
    {
      completedBatches: [item],
      completedTestMethodPlanIds: [...item.completedTestMethodPlanIds]
    }
  ]));
  const restored = await h.service.restoreCommittedGroup(
    TASK,
    methodIds,
    committedCheckpoints,
    new AbortController().signal
  );
  assert.ok(restored);
  assert.match(restored.code, /m01_getName/);
  assert.match(restored.code, /m02_setName/);
  assert.equal(restored.methodBundles.length, 2);
  assert.match(restored.methodBundles[0].code, /m01_getName/);
  assert.doesNotMatch(restored.methodBundles[0].code, /m02_setName/);
  assert.match(restored.methodBundles[1].code, /m02_setName/);
  assert.doesNotMatch(restored.methodBundles[1].code, /m01_getName/);
  assert.ok(restored.methodBundles.every((bundle) => bundle.code.includes('helper()')));
});

test('batch service accepts multiple mapped tests for one selected data-class method', async () => {
  const h = executionHarness({
    modelOutput: [
      'package example;',
      'import org.junit.jupiter.api.Test;',
      'class UserVOTmp1Test {',
      '  @Test void m01_getName_whenValueIsNull() { new UserVO().getName(); }',
      '  @Test void m01_getName_whenValueIsPresent() { new UserVO().getName(); }',
      '  @Test void m02_setName() { new UserVO().setName("x"); }',
      '}'
    ].join('\n')
  });
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];

  await h.service.plan(TASK, methodIds, new AbortController().signal);
  const handled = await h.service.execute(
    TASK,
    methodIds,
    Object.fromEntries(methodIds.map((methodId) => [methodId, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  assert.equal(handled, true);
  assert.equal(h.mavenCalls(), 1);
  assert.deepEqual(
    h.commits.map(({ methodId, ordinaryTestMethodCount }) => ({
      methodId,
      ordinaryTestMethodCount
    })),
    [
      { methodId: methodIds[0], ordinaryTestMethodCount: 2 },
      { methodId: methodIds[1], ordinaryTestMethodCount: 1 }
    ]
  );
});

test('Lombok batch prompt is compact and contains only the selected methods in order', async () => {
  const selectedMethods = [
    ['equals', '(Ljava/lang/Object;)Z', ['java.lang.Object'], 'boolean', ['public']],
    ['hashCode', '()I', [], 'int', ['public']],
    ['toString', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['setPortalUrl', '(Ljava/lang/String;)V', ['java.lang.String'], 'void', ['public']],
    ['setWebServiceURL', '(Ljava/lang/String;)V', ['java.lang.String'], 'void', ['public']],
    [
      'setBBHTYPE',
      '(Lcom/dtsz/report/model/entity/report/common/ReportUnitType;)V',
      ['com.dtsz.report.model.entity.report.common.ReportUnitType'],
      'void',
      ['public']
    ],
    ['getPortalUrl', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['getWebServiceURL', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['getROLECODES', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['getUSERID', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['getBBHCODE', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['getONLYPROCESS', '()Ljava/lang/String;', [], 'java.lang.String', ['public']],
    ['canEqual', '(Ljava/lang/Object;)Z', ['java.lang.Object'], 'boolean', ['protected']]
  ];
  const h = executionHarness({
    classKind: 'DATA_LOMBOK',
    modelOutput: batchModelOutput(
      selectedMethods.map(([methodName]) => methodName),
      'IndexVOTmp1Test'
    )
  });
  const methodIds = selectedMethods.map((_, index) => (
    createHash('sha256').update(`selected:${index}`).digest('hex')
  ));
  const structure = [
    'package example;',
    '',
    'import com.dtsz.report.model.entity.report.common.ReportUnitType;',
    'import lombok.Data;',
    '',
    '@Data',
    'public class IndexVO {',
    '    private String portalUrl;',
    '    private String webServiceURL;',
    '    private ReportUnitType BBHTYPE;',
    '}'
  ].join('\n');
  h.pages.clear();
  selectedMethods.forEach(([methodName, descriptor, parameterTypes, returnType, modifiers], index) => {
    const methodId = methodIds[index];
    const current = page(methodId, methodName);
    current.method.descriptor = descriptor;
    current.method.parameterTypes = parameterTypes;
    current.method.returnType = returnType;
    current.method.modifiers = modifiers;
    current.method.completeMethodSource =
      `/* Lombok generated from field state. */ ${modifiers[0]} ${returnType} ${methodName}();`;
    current.targetFixturePlan.targetClass = 'example.IndexVO';
    current.targetFixturePlan.targetClassDeclaration = structure;
    current.necessaryImports = [
      'org.junit.jupiter.api.Test',
      'org.junit.jupiter.api.Assertions',
      'org.junit.jupiter.api.BeforeEach',
      'org.mockito.Mock',
      'org.mockito.InjectMocks',
      'org.mockito.Mockito.*',
      'lombok.Data'
    ];
    if (methodName === 'setBBHTYPE') {
      current.referencedTypes = [{
        qualifiedName: 'com.dtsz.report.model.entity.report.common.ReportUnitType',
        kind: 'ENUM',
        constructors: [],
        methods: [],
        enumConstants: ['SUM', 'BASIC', 'USER', 'BASICINST', 'SUMINST']
      }];
    }
    h.pages.set(methodId, current);
  });

  const indexTask = {
    ...TASK,
    sourceFilePath: 'D:\\workspace\\src\\main\\java\\example\\IndexVO.java',
    qualifiedClassName: 'example.IndexVO'
  };
  const groups = await h.service.plan(indexTask, methodIds, new AbortController().signal);
  assert.deepEqual(groups, [methodIds]);
  await h.service.execute(
    indexTask,
    methodIds,
    Object.fromEntries(methodIds.map((methodId) => [methodId, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  assert.equal(h.modelPrompts.length, 1);
  const prompt = h.modelPrompts[0];
  assert.equal(prompt.split(structure).length - 1, 1);
  assert.match(prompt, /## 生产源码（完整）/);
  assert.match(prompt, /## 本次选中的方法/);
  assert.match(prompt, /每个已选方法至少生成 1 个普通 `@Test`/);
  assert.doesNotMatch(prompt, /共生成 \d+ 个普通 `@Test`/);
  const positions = selectedMethods.map(([methodName]) => prompt.indexOf(`${methodName}(`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.doesNotMatch(prompt, /setDATABASETYPE\(/);
  assert.doesNotMatch(prompt, /## 允许 import|JVM|org\.mockito/);
  assert.match(prompt, /## 非 Getter\/Setter 覆盖矩阵/);
  assert.match(prompt, /## Getter\/Setter 快速规则/);
  assert.match(prompt, /字段状态相同的两个真实对象产生相同哈希值/);
  assert.match(prompt, /JaCoCo 指令覆盖率和分支覆盖率均达到 100%/);
  assert.match(prompt, /禁止展开字段组合的笛卡尔积/);
  assert.match(prompt, /每个字段分别作为第一个不相等字段/);
  assert.match(
    prompt,
    /全字段非 null 且相等.*全字段为 null 且相等.*左 null、右非 null.*两个不同的非 null 值/s
  );
  assert.match(prompt, /equals 内部的 canEqual.*false/);
  assert.match(prompt, /hashCode.*全字段为 null.*全字段为非 null/s);
  assert.match(prompt, /setter：新建对象.*调用 setter.*对应 getter/s);
  assert.match(prompt, /getter：通过已有 setter 或构造器准备一个代表值/s);
  assert.equal((prompt.match(/Getter\/Setter 快速规则/g) ?? []).length, 1);
  assert.match(prompt, /同类型对象为 true，不同类型对象和 null 为 false/);
  assert.match(prompt, /## 三、枚举/);
  assert.match(prompt, /ReportUnitType.*SUM.*BASIC.*USER.*BASICINST.*SUMINST/);
  assert.match(prompt, /## 四、真实对象/);
  assert.match(prompt, /IndexVO.*new IndexVO\(\)/);
  assert.match(prompt, /## 五、调用信息/);
  assert.match(prompt, /### 外部对象/);
  assert.match(prompt, /无外部对象调用/);
  assert.doesNotMatch(
    prompt,
    /portal-url|service-url|role-1|user-1|bbh-1|process-1|ReportUnitType\.BASIC/
  );
  for (const verboseField of [
    'BEGIN_ANALYZER_EVIDENCE_JSON',
    'completeMethodSource',
    'invocationPlan',
    'scenarios',
    'methodTestPlan',
    'targetFixturePlan',
    'methodStubInventory',
    'activeStubPlans',
    'referencedTypes'
  ]) {
    assert.doesNotMatch(prompt, new RegExp(verboseField));
  }
});

test('batch output cannot relabel a selected method or fall back to split generation', async () => {
  const h = executionHarness({
    modelOutput: [
      'package example;',
      'import org.junit.jupiter.api.Test;',
      'class UserVOTmp1Test {',
      '  @Test void m01_toString() { new UserVO().toString(); }',
      '  @Test void m02_setName() { new UserVO().setName("x"); }',
      '}'
    ].join('\n')
  });
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];
  await h.service.plan(TASK, methodIds, new AbortController().signal);

  await assert.rejects(
    h.service.execute(
      TASK,
      methodIds,
      Object.fromEntries(methodIds.map((methodId) => [methodId, {
        completedBatches: [], completedTestMethodPlanIds: []
      }])),
      new AbortController().signal
    ),
    /Batch candidate prefix/
  );

  assert.equal(h.commits.length, 0);
  assert.equal(h.mavenCalls(), 0);
});

test('explicit accessor data classes use the same compact selected-method prompt', async () => {
  const h = executionHarness({ classKind: 'DATA_EXPLICIT_ACCESSORS' });
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];

  await h.service.plan(TASK, methodIds, new AbortController().signal);
  await h.service.execute(
    TASK,
    methodIds,
    Object.fromEntries(methodIds.map((methodId) => [methodId, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  const prompt = h.modelPrompts[0];
  assert.match(prompt, /## 本次选中的方法/);
  assert.match(prompt, /getName\(\)/);
  assert.match(prompt, /setName\(java\.lang\.String\)/);
  assert.match(prompt, /源码：`public String getName\(\) \{ return value; \}`/);
  assert.match(prompt, /源码：`public void setName\(String value\) \{ this\.value = value; \}`/);
  assert.doesNotMatch(
    prompt,
    /BEGIN_ANALYZER_EVIDENCE_JSON|completeMethodSource|methodTestPlan|## 允许 import|JVM/
  );
});

test('setter-only data classes do not invent an unavailable getter', async () => {
  const h = executionHarness({
    classKind: 'DATA_SETTER_ONLY',
    modelOutput: batchModelOutput(['setName', 'setAge'])
  });
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];
  h.pages.set(methodIds[0], page(methodIds[0], 'setName'));
  h.pages.set(methodIds[1], page(methodIds[1], 'setAge'));

  await h.service.plan(TASK, methodIds, new AbortController().signal);
  await h.service.execute(
    TASK,
    methodIds,
    Object.fromEntries(methodIds.map((methodId) => [methodId, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  const prompt = h.modelPrompts[0];
  assert.match(prompt, /源码：`public void setName\(String value\) \{ this\.value = value; \}`/);
  assert.match(prompt, /源码：`public void setAge\(String value\) \{ this\.value = value; \}`/);
  assert.match(prompt, /不存在可观察读取接口时不得猜测 getter/);
  assert.doesNotMatch(prompt, /getName\(|getAge\(/);
});

test('Lombok final-field getters do not invent an unavailable setter', async () => {
  const h = executionHarness({
    classKind: 'DATA_LOMBOK',
    modelOutput: batchModelOutput(['getVersion', 'hashCode'])
  });
  const methodId = '3'.repeat(64);
  const companionMethodId = '4'.repeat(64);
  const current = page(methodId, 'getVersion');
  current.method.returnType = 'int';
  current.method.descriptor = '()I';
  current.method.completeMethodSource =
    '/* Lombok generated from field state. */ public int getVersion();';
  current.targetFixturePlan.targetClass = 'example.UserVO';
  current.targetFixturePlan.targetClassDeclaration = [
    'package example;',
    '',
    'import lombok.Data;',
    '',
    '@Data',
    'public class UserVO {',
    '    private final int version;',
    '}'
  ].join('\n');
  current.targetFixturePlan.constructorParameterTypes = ['int'];
  const companion = page(companionMethodId, 'hashCode');
  companion.method.returnType = 'int';
  companion.method.descriptor = '()I';
  companion.method.completeMethodSource =
    '/* Lombok generated from field state. */ public int hashCode();';
  companion.targetFixturePlan = structuredClone(current.targetFixturePlan);
  h.pages.clear();
  h.pages.set(methodId, current);
  h.pages.set(companionMethodId, companion);

  const methodIds = [methodId, companionMethodId];
  await h.service.plan(TASK, methodIds, new AbortController().signal);
  await h.service.execute(
    TASK,
    methodIds,
    Object.fromEntries(methodIds.map((id) => [id, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  const prompt = h.modelPrompts[0];
  assert.match(prompt, /getVersion\(\)/);
  assert.match(prompt, /使用生产源码明确支持的 setter 或构造器准备字段状态/);
  assert.doesNotMatch(prompt, /setVersion\(/);
});

test('failed one-shot Maven verification repairs the same VO candidate and reruns Maven', async () => {
  const initial = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'class UserVOTmp1Test {',
    '  @Test void m01_getName() { org.junit.jupiter.api.Assertions.fail("broken"); }',
    '  @Test void m02_setName() { new UserVO().setName("x"); }',
    '}'
  ].join('\n');
  const repaired = initial.replace(
    'org.junit.jupiter.api.Assertions.fail("broken");',
    'new UserVO().getName();'
  );
  const h = executionHarness({
    captureModelCalls: true,
    modelOutputs: [initial, repaired],
    mavenResults: [{
      status: 'test_failed',
      mavenExecutions: [{
        scope: 'method_candidate',
        phase: 'test',
        command: 'mvn -Dtest=example.UserVOTmp1Test surefire:test',
        exitCode: 1,
        stdout: 'UserVOTmp1Test.m01_getName expected: <true> but was: <false>',
        stderr: '',
        surefireReports: []
      }],
      testReport: {
        reportCount: 1,
        tests: 2,
        failures: 1,
        errors: 0,
        skipped: 0,
        generatedTestClassName: 'example.UserVOTmp1Test',
        generatedTests: 2,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'example.UserVOTmp1Test',
          testClassName: 'example.UserVOTmp1Test',
          testName: 'm01_getName',
          kind: 'failure',
          type: 'org.opentest4j.AssertionFailedError',
          message: 'expected: <true> but was: <false>',
          detail: 'at example.UserVOTmp1Test.m01_getName(UserVOTmp1Test.java:4)'
        }]
      }
    }, {
      status: 'passed',
      mavenExecutions: [],
      testReport: {
        reportCount: 1,
        tests: 2,
        failures: 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName: 'example.UserVOTmp1Test',
        generatedTests: 2,
        generatedSkipped: 0,
        failureDetails: []
      }
    }]
  });
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];
  await h.service.plan(TASK, methodIds, new AbortController().signal);

  await h.service.execute(
    TASK,
    methodIds,
    Object.fromEntries(methodIds.map((methodId) => [methodId, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  assert.equal(h.modelCalls(), 2);
  assert.equal(h.mavenCalls(), 2);
  assert.equal(h.commits.length, 2);
  assert.equal(h.written.size, 1);
  assert.match(h.modelPrompts[1], /\/\/ \[本轮错误\] org\.opentest4j\.AssertionFailedError: expected: <true> but was: <false>/);
  assert.match(h.modelPrompts[1], /m01_getName/);
  assert.equal(
    h.modelLogRecords.filter((record) => record.event.modelCall.callKind === 'repair').length,
    2
  );
});

test('finite VO repair exhaustion comments only failing tests and restores the stable group', async () => {
  const initial = [
    'package example;',
    'import org.junit.jupiter.api.Test;',
    'class UserVOTmp1Test {',
    '  @Test void m01_getName() { org.junit.jupiter.api.Assertions.fail("broken"); }',
    '  @Test void m02_setName() { new UserVO().setName("x"); }',
    '}'
  ].join('\n');
  const failed = {
    status: 'test_failed',
    mavenExecutions: [{
      scope: 'method_candidate',
      phase: 'test',
      command: 'mvn -Dtest=example.UserVOTmp1Test surefire:test',
      exitCode: 1,
      stdout: 'expected: <true> but was: <false>',
      stderr: '',
      surefireReports: []
    }],
    testReport: {
      reportCount: 1,
      tests: 2,
      failures: 1,
      errors: 0,
      skipped: 0,
      generatedTestClassName: 'example.UserVOTmp1Test',
      generatedTests: 2,
      generatedSkipped: 0,
      failureDetails: [{
        suiteName: 'example.UserVOTmp1Test',
        testClassName: 'example.UserVOTmp1Test',
        testName: 'm01_getName',
        kind: 'failure',
        type: 'org.opentest4j.AssertionFailedError',
        message: 'expected: <true> but was: <false>',
        detail: 'at example.UserVOTmp1Test.m01_getName(UserVOTmp1Test.java:4)'
      }]
    }
  };
  const h = executionHarness({
    captureModelCalls: true,
    modelOutputs: [initial, initial],
    mavenResults: [failed, failed, {
      status: 'passed',
      mavenExecutions: [],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName: 'example.UserVOTmp1Test',
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: []
      }
    }]
  });
  const task = { ...TASK, repairAttemptLimit: 1 };
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];
  await h.service.plan(task, methodIds, new AbortController().signal);
  await h.service.execute(
    task,
    methodIds,
    Object.fromEntries(methodIds.map((methodId) => [methodId, {
      completedBatches: [], completedTestMethodPlanIds: []
    }])),
    new AbortController().signal
  );

  assert.equal(h.modelCalls(), 2);
  assert.equal(h.mavenCalls(), 3);
  assert.equal(h.candidateMoves.length, 4);
  assert.deepEqual(
    h.candidateMoves.map(({ sourcePath, targetPath }) => [
      sourcePath.includes('.ai-unit-test'),
      targetPath.includes('.ai-unit-test')
    ]),
    [[false, true], [true, false], [false, true], [true, false]]
  );
  const [finalPath, finalOwned] = [...h.written.entries()][0];
  assert.equal(finalPath.includes('.ai-unit-test'), false);
  assert.match(finalOwned.code, /TODO 当前测试方法需要修复/);
  assert.doesNotMatch(finalOwned.code, /^\s*@Test void m01_getName/m);
  assert.match(finalOwned.code, /^\s*@Test void m02_setName/m);

  const checkpoints = Object.fromEntries(methodIds.map((methodId) => [methodId, {
    completedBatches: h.commits.filter((commit) => commit.methodId === methodId),
    completedTestMethodPlanIds: []
  }]));
  const restored = await h.service.restoreCommittedGroup(
    task,
    methodIds,
    checkpoints,
    new AbortController().signal
  );
  assert.ok(restored);
  assert.deepEqual(
    restored.methodBundles.map((bundle) => bundle.ordinaryTestMethodCount),
    [0, 1]
  );
});

test('failed one-shot batch model calls are logged and propagated without single-method fallback', async () => {
  const failure = Object.assign(new Error('provider timed out'), {
    code: 'MODEL_TIMEOUT'
  });
  const h = executionHarness({
    captureModelCalls: true,
    modelError: failure
  });
  const methodIds = ['1'.repeat(64), '2'.repeat(64)];
  await h.service.plan(TASK, methodIds, new AbortController().signal);

  await assert.rejects(
    h.service.execute(
      TASK,
      methodIds,
      Object.fromEntries(methodIds.map((methodId) => [methodId, {
        completedBatches: [], completedTestMethodPlanIds: []
      }])),
      new AbortController().signal
    ),
    failure
  );

  assert.equal(h.modelCalls(), 1);
  assert.deepEqual(
    h.modelLogRecords.map((record) => record.event.modelCall.phase),
    ['started', 'failed']
  );
  const failed = h.modelLogRecords[1].event.modelCall;
  assert.equal(failed.errorCode, 'MODEL_TIMEOUT');
  assert.equal(failed.errorType, 'Error');
  assert.equal(failed.processingValid, false);
});

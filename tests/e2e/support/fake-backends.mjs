import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  createProductionClassTaskRuntime
} from '../../../src/main/services/class-task-runtime.service.ts';
import {
  decodeMethodGenerationWaveEvent,
  MethodGenerationWaveNotFoundError,
  validateRecoverMethodGenerationWaveRequest,
  validateStartMethodGenerationWaveRequest
} from '../../../src/main/services/method-generation-contract.ts';
import {
  JacocoArtifactsService
} from '../../../src/main/services/jacoco-artifacts.service.ts';
import {
  TestWriterService
} from '../../../src/main/services/test-writer.service.ts';
import { createFakeMaven } from './fake-maven.mjs';

const FIXED_NOW = '2026-08-09T00:00:00.000Z';
const CLASS_NAMES = [
  'AlphaService',
  'BetaService',
  'GammaService',
  'DeltaService',
  'EpsilonService'
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function ragSourceSetFingerprint(fqns) {
  const digest = createHash('sha256');
  for (const fqn of [...fqns].sort()) {
    const encoded = Buffer.from(fqn, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.byteLength);
    digest.update(length);
    digest.update(encoded);
  }
  return digest.digest('hex');
}

function exactCoverage(generated) {
  return generated
    ? {
        lineCovered: 2,
        lineMissed: 0,
        lineTotal: 2,
        branchCovered: 2,
        branchMissed: 0,
        branchTotal: 2
      }
    : {
        lineCovered: 1,
        lineMissed: 1,
        lineTotal: 2,
        branchCovered: 0,
        branchMissed: 2,
        branchTotal: 2
      };
}

function methodIdFor(targetClass, methodIndex = 0) {
  return sha256(methodIndex === 0
    ? `fixture-method:${targetClass}`
    : `fixture-method:${targetClass}:${methodIndex}`);
}

function branchSnapshot({ pairId, report, executionData, targetClass, generated }) {
  const methodId = methodIdFor(targetClass);
  const branchFalse = `${methodId}:branch:false`;
  const branchTrue = `${methodId}:branch:true`;
  return {
    schemaVersion: 1,
    pairId,
    targetClass,
    targetSourceSha256: sha256(`source:${targetClass}`),
    targetClassSha256: sha256(`class:${targetClass}`),
    executionDataSha256: sha256(executionData),
    reportSha256: sha256(report),
    methods: [{
      methodId,
      methodName: 'value',
      descriptor: '(I)I',
      firstLine: 4,
      lastLine: 5,
      mappingStatus: 'EXACT',
      instructions: [],
      decisions: [],
      targets: [
        {
          targetId: `${methodId}:line:4`,
          methodId,
          decisionId: '',
          instructionIndex: 0,
          sourceLine: 4,
          kind: 'LINE_EXECUTE',
          direction: 'EXECUTE',
          covered: true,
          mappingStatus: 'EXACT',
          requiredEdgeIds: []
        },
        {
          targetId: `${methodId}:line:5`,
          methodId,
          decisionId: '',
          instructionIndex: 1,
          sourceLine: 5,
          kind: 'LINE_EXECUTE',
          direction: 'EXECUTE',
          covered: generated,
          mappingStatus: 'EXACT',
          requiredEdgeIds: []
        },
        {
          targetId: branchFalse,
          methodId,
          decisionId: `${methodId}:decision`,
          instructionIndex: 1,
          sourceLine: 5,
          kind: 'BRANCH',
          direction: 'IF_FALSE',
          covered: generated,
          mappingStatus: 'EXACT',
          requiredEdgeIds: [`${methodId}:edge:false`]
        },
        {
          targetId: branchTrue,
          methodId,
          decisionId: `${methodId}:decision`,
          instructionIndex: 1,
          sourceLine: 5,
          kind: 'BRANCH',
          direction: 'IF_TRUE',
          covered: generated,
          mappingStatus: 'EXACT',
          requiredEdgeIds: [`${methodId}:edge:true`]
        }
      ]
    }]
  };
}

function methodSummary(targetClass, generated, methodIndex = 0, dataAccessor = false) {
  const methodName = dataAccessor
    ? `getValue${methodIndex + 1}`
    : methodIndex === 0 ? 'value' : `value${methodIndex + 1}`;
  const descriptor = dataAccessor ? '()I' : '(I)I';
  const parameters = dataAccessor ? '' : 'int input';
  return {
    methodId: methodIdFor(targetClass, methodIndex),
    methodName,
    descriptor,
    displaySignature: `public int ${methodName}(${parameters})`,
    firstLine: 4 + methodIndex * 2,
    lastLine: 5 + methodIndex * 2,
    jacocoOrder: methodIndex,
    lineCovered: generated ? 2 : 1,
    lineMissed: generated ? 0 : 1,
    branchCovered: generated ? 2 : 0,
    branchMissed: generated ? 0 : 2,
    instructionCovered: generated ? 8 : 4,
    instructionMissed: generated ? 0 : 4,
    complexityCovered: generated ? 2 : 1,
    complexityMissed: generated ? 0 : 1,
    coverageGap: !generated,
    generatable: true,
    unavailableReason: null,
    modifiers: ['public']
  };
}

function reportCoverageTotals(generated, methodCount = 1) {
  return {
    instructionCovered: (generated ? 8 : 4) * methodCount,
    instructionMissed: (generated ? 0 : 4) * methodCount,
    branchCovered: (generated ? 2 : 0) * methodCount,
    branchMissed: (generated ? 0 : 2) * methodCount,
    complexityCovered: (generated ? 2 : 1) * methodCount,
    complexityMissed: (generated ? 0 : 1) * methodCount,
    lineCovered: (generated ? 2 : 1) * methodCount,
    lineMissed: (generated ? 0 : 1) * methodCount
  };
}

function workBatch({
  sessionId,
  reportPairId,
  targetClass,
  methodId,
  methodIndex = 0,
  dataAccessor = false
}) {
  const methodName = dataAccessor
    ? `getValue${methodIndex + 1}`
    : methodIndex === 0 ? 'value' : `value${methodIndex + 1}`;
  const descriptor = dataAccessor ? '()I' : '(I)I';
  const batchId = sha256(`fixture-batch:${sessionId}:${methodId}`);
  const scenarioId = `scenario-uncovered-branch-${methodIndex}`;
  const targetId = `${methodId}:branch:true`;
  const pathGroupId = `path-uncovered-branch-${methodIndex}`;
  const testMethodPlanId = `test-plan-uncovered-branch-${methodIndex}`;
  return {
    reportPairId,
    methodId,
    batchId,
    hasWork: true,
    method: {
      methodId,
      declaringType: targetClass,
      methodName,
      descriptor,
      firstLine: 4,
      lastLine: 5,
      completeMethodSource: [
        `public int ${methodName}(${dataAccessor ? '' : 'int input'}) {`,
        `    return ${dataAccessor ? methodIndex + 1 : 'input > 0 ? 1 : 0'};`,
        '}'
      ].join('\n'),
      modifiers: ['public'],
      parameterTypes: dataAccessor ? [] : ['int'],
      returnType: 'int',
      declaredExceptions: [],
      invocationPlan: {
        strategy: 'DIRECT',
        receiverExpression: 'target',
        reflectionMethodName: '',
        parameterClassLiterals: [],
        staticMethod: false,
        returnType: 'int',
        declaredExceptions: [],
        chineseInstruction: '直接调用目标方法。'
      },
      activeScenarioIds: [scenarioId]
    },
    scenarios: [{
      scenarioId,
      scenarioSignature: 'input > 0',
      methodId,
      targetLines: [5],
      targetBranches: [targetId],
      chineseDescription: '覆盖尚未命中的正数分支。',
      inputPreparation: ['input = 1'],
      requiredStubIds: [],
      expectedPath: ['返回 1'],
      loopExitCondition: '',
      loopCoveragePlan: null,
      conditionPathVariants: [],
      coverageTargetIds: [targetId],
      pathConstraints: [],
      status: 'READY'
    }],
    methodTestPlan: {
      methodId,
      analysisStatus: 'READY',
      minimumTestCount: 1,
      remainingTargets: [{
        targetId,
        methodId,
        decisionId: `${methodId}:decision`,
        instructionIndex: 1,
        sourceLine: 5,
        kind: 'BRANCH',
        direction: 'IF_TRUE',
        covered: false,
        mappingStatus: 'EXACT',
        requiredEdgeIds: [`${methodId}:edge:true`]
      }],
      testPathGroups: [{
        groupId: pathGroupId,
        methodId,
        ordinal: 1,
        scenarioIds: [scenarioId],
        targetIds: [targetId],
        constraints: [],
        inputRequirements: ['input = 1'],
        mockRequirements: [],
        expectedExit: 'RETURNS',
        singleTargetInvocation: true,
        status: 'READY'
      }],
      testMethodPlans: [{
        testMethodPlanId,
        methodId,
        ordinal: 1,
        pathGroupIds: [pathGroupId],
        status: 'READY'
      }],
      fallbackReason: ''
    },
    methodStubInventory: {
      methodId,
      status: 'READY',
      requiredCallCount: 0,
      unresolvedRequiredCallCount: 0,
      calls: []
    },
    activeStubPlans: [],
    targetFixturePlan: {
      targetClass,
      targetVariableName: 'target',
      targetClassDeclaration: `${targetClass} target`,
      dependencySourceDeclarations: [],
      constructionMode: 'CONSTRUCTOR',
      constructorParameterTypes: [],
      constructorArgumentFixtureIds: [],
      dependencies: [],
      setupStatements: [`target = new ${basename(targetClass)}()`],
      status: 'READY',
      chineseInstruction: '直接创建目标类。'
    },
    referencedTypes: [],
    necessaryImports: [
      'org.junit.jupiter.api.Test',
      targetClass
    ],
    plannedTestMethods: 1,
    remainingTestMethods: 0,
    warnings: []
  };
}

function noWork({ reportPairId, methodId }) {
  return {
    reportPairId,
    methodId,
    batchId: null,
    hasWork: false,
    method: null,
    scenarios: [],
    methodTestPlan: null,
    methodStubInventory: null,
    activeStubPlans: [],
    targetFixturePlan: null,
    referencedTypes: [],
    necessaryImports: [],
    plannedTestMethods: 0,
    remainingTestMethods: 0,
    warnings: []
  };
}

function waveScenarioId(methodIndex, scenarioNumber) {
  return methodIndex === 0
    ? `scenario-uncovered-branch-${scenarioNumber}`
    : `scenario-uncovered-branch-m${methodIndex + 1}-${scenarioNumber}`;
}

function waveScenario(methodId, methodIndex, scenarioNumber) {
  const scenarioId = waveScenarioId(methodIndex, scenarioNumber);
  const targetId = `${methodId}:branch:wave:${scenarioNumber}`;
  return {
    scenarioId,
    scenarioSignature: `input == ${scenarioNumber}`,
    methodId,
    targetLines: [5],
    targetBranches: [targetId],
    chineseDescription: `覆盖第 ${scenarioNumber} 个未覆盖场景。`,
    inputPreparation: [`input = ${scenarioNumber}`],
    requiredStubIds: [],
    expectedPath: ['返回目标分支结果'],
    loopExitCondition: '',
    loopCoveragePlan: null,
    coverageTargetIds: [targetId],
    pathConstraints: [],
    status: 'READY'
  };
}

function workWavePart({
  sessionId,
  reportPairId,
  targetClass,
  methodId,
  methodIndex = 0,
  dataAccessor = false,
  partIndex,
  scenarioNumbers
}) {
  const base = workBatch({
    sessionId,
    reportPairId,
    targetClass,
    methodId,
    methodIndex,
    dataAccessor
  });
  const scenarios = scenarioNumbers.map((scenarioNumber) => (
    waveScenario(methodId, methodIndex, scenarioNumber)
  ));
  const scenarioIds = scenarios.map((scenario) => scenario.scenarioId);
  const remainingTargets = scenarios.map((scenario, index) => ({
    targetId: scenario.coverageTargetIds[0],
    methodId,
    decisionId: `${methodId}:decision:wave:${scenarioNumbers[index]}`,
    instructionIndex: index + 1,
    sourceLine: 5,
    kind: 'BRANCH',
    direction: 'IF_TRUE',
    covered: false,
    mappingStatus: 'EXACT',
    requiredEdgeIds: [`${methodId}:edge:wave:${scenarioNumbers[index]}`]
  }));
  const testPathGroups = scenarios.map((scenario, index) => ({
    groupId: `wave-path-${partIndex}-${scenarioNumbers[index]}`,
    methodId,
    ordinal: index + 1,
    scenarioIds: [scenario.scenarioId],
    targetIds: [scenario.coverageTargetIds[0]],
    constraints: [],
    inputRequirements: [...scenario.inputPreparation],
    mockRequirements: [],
    expectedExit: 'RETURNS',
    singleTargetInvocation: true,
    status: 'READY'
  }));
  const testMethodPlans = testPathGroups.map((group, index) => ({
    testMethodPlanId: `wave-test-plan-${partIndex}-${scenarioNumbers[index]}`,
    methodId,
    ordinal: index + 1,
    pathGroupIds: [group.groupId],
    status: 'READY'
  }));
  return {
    partIndex,
    partBatchId: sha256(
      `fixture-wave-part:${sessionId}:${methodId}:${partIndex}:${scenarioIds.join(',')}`
    ),
    scenarioIds,
    method: {
      ...base.method,
      activeScenarioIds: scenarioIds
    },
    scenarios,
    methodTestPlan: {
      ...base.methodTestPlan,
      minimumTestCount: testMethodPlans.length,
      remainingTargets,
      testPathGroups,
      testMethodPlans
    },
    methodStubInventory: base.methodStubInventory,
    activeStubPlans: [],
    targetFixturePlan: base.targetFixturePlan,
    referencedTypes: [],
    necessaryImports: [...base.necessaryImports]
  };
}

function noWorkWave({ reportPairId, methodId }) {
  return {
    waveBatchId: null,
    reportPairId,
    methodId,
    hasWork: false,
    selectedScenarioIds: [],
    remainingScenarioCount: 0,
    parts: [],
    warnings: []
  };
}

function nextWorkWave({
  sessionId,
  reportPairId,
  targetClass,
  methodId,
  methodIndex = 0,
  dataAccessor = false,
  completedScenarioIds,
  skippedScenarioIds,
  scenarioCount
}) {
  const terminal = new Set([...completedScenarioIds, ...skippedScenarioIds]);
  const available = Array.from({ length: scenarioCount }, (_, index) => index + 1)
    .filter((scenarioNumber) => (
      !terminal.has(waveScenarioId(methodIndex, scenarioNumber))
    ));
  if (available.length === 0) return noWorkWave({ reportPairId, methodId });
  const selected = available.slice(0, 25);
  const parts = [];
  for (let offset = 0; offset < selected.length; offset += 5) {
    parts.push(workWavePart({
      sessionId,
      reportPairId,
      targetClass,
      methodId,
      methodIndex,
      dataAccessor,
      partIndex: parts.length + 1,
      scenarioNumbers: selected.slice(offset, offset + 5)
    }));
  }
  const selectedScenarioIds = parts.flatMap((part) => part.scenarioIds);
  return {
    waveBatchId: sha256(
      `fixture-wave:${sessionId}:${methodId}:${selectedScenarioIds.join(',')}`
    ),
    reportPairId,
    methodId,
    hasWork: true,
    selectedScenarioIds,
    remainingScenarioCount: available.length - selected.length,
    parts,
    warnings: []
  };
}

function classWaveFromMethodWaves(request, methodWaves) {
  const available = methodWaves.flatMap((wave, methodIndex) => (
    wave.hasWork
      ? wave.parts.flatMap((part) => part.scenarios.map((scenario) => ({
          methodIndex,
          methodId: wave.methodId,
          scenario,
          sourcePart: part
        })))
      : []
  ));
  const selected = available.slice(0, request.maxScenarios);
  const consumedByMethod = new Map();
  for (const entry of selected) {
    consumedByMethod.set(entry.methodId, (consumedByMethod.get(entry.methodId) ?? 0) + 1);
  }
  const remainingScenarioCountByMethod = Object.fromEntries(methodWaves.map((wave) => [
    wave.methodId,
    wave.remainingScenarioCount
      + wave.selectedScenarioIds.length
      - (consumedByMethod.get(wave.methodId) ?? 0)
  ]));
  const completedMethodIds = methodWaves
    .filter((wave) => remainingScenarioCountByMethod[wave.methodId] === 0)
    .map((wave) => wave.methodId);
  const warnings = methodWaves.flatMap((wave) => wave.warnings);
  if (selected.length === 0) {
    return {
      waveBatchId: null,
      reportPairId: request.reportPairId,
      hasWork: false,
      selectedMethodIds: [],
      selectedScenarioIds: [],
      remainingScenarioCountByMethod,
      completedMethodIds,
      parts: [],
      warnings
    };
  }
  const selectedScenarioIds = selected.map((entry) => entry.scenario.scenarioId);
  const selectedMethodIds = [...new Set(selected.map((entry) => entry.methodId))];
  const waveBatchId = sha256(
    `fixture-class-wave:${request.reportPairId}:${selected.map((entry) => (
      `${entry.methodId}:${entry.scenario.scenarioId}`
    )).join(',')}`
  );
  const parts = [];
  for (let offset = 0; offset < selected.length; offset += request.partSize) {
    const entries = selected.slice(offset, offset + request.partSize);
    const partIndex = parts.length + 1;
    const methodSlices = [];
    let sliceStart = 0;
    while (sliceStart < entries.length) {
      const methodId = entries[sliceStart].methodId;
      let sliceEnd = sliceStart + 1;
      while (sliceEnd < entries.length && entries[sliceEnd].methodId === methodId) sliceEnd += 1;
      const methodEntries = entries.slice(sliceStart, sliceEnd);
      const sourcePart = methodEntries[0].sourcePart;
      const sliceScenarioIds = methodEntries.map((entry) => entry.scenario.scenarioId);
      const selectedIds = new Set(sliceScenarioIds);
      const scenarios = sourcePart.scenarios.filter((scenario) => selectedIds.has(scenario.scenarioId));
      const testPathGroups = sourcePart.methodTestPlan.testPathGroups.filter((group) => (
        group.scenarioIds.every((scenarioId) => selectedIds.has(scenarioId))
      ));
      const groupIds = new Set(testPathGroups.map((group) => group.groupId));
      const targetIds = new Set(testPathGroups.flatMap((group) => group.targetIds));
      const testMethodPlans = sourcePart.methodTestPlan.testMethodPlans.filter((plan) => (
        plan.pathGroupIds.every((groupId) => groupIds.has(groupId))
      ));
      const batch = {
        ...structuredClone(sourcePart),
        partIndex,
        partBatchId: sha256(
          `fixture-class-slice:${waveBatchId}:${partIndex}:${methodId}:${sliceScenarioIds.join(',')}`
        ),
        scenarioIds: sliceScenarioIds,
        method: {
          ...structuredClone(sourcePart.method),
          activeScenarioIds: sliceScenarioIds
        },
        scenarios,
        methodTestPlan: {
          ...structuredClone(sourcePart.methodTestPlan),
          minimumTestCount: testMethodPlans.length,
          remainingTargets: sourcePart.methodTestPlan.remainingTargets.filter((target) => (
            targetIds.has(target.targetId)
          )),
          testPathGroups,
          testMethodPlans
        },
        activeStubPlans: sourcePart.activeStubPlans.filter((stub) => (
          selectedIds.has(stub.scenarioId)
        ))
      };
      methodSlices.push({
        methodId,
        testMethodNamePrefix: `m${methodEntries[0].methodIndex + 1}_`,
        batch
      });
      sliceStart = sliceEnd;
    }
    const scenarioIds = entries.map((entry) => entry.scenario.scenarioId);
    parts.push({
      partIndex,
      partBatchId: sha256(
        `fixture-class-part:${waveBatchId}:${partIndex}:${scenarioIds.join(',')}`
      ),
      scenarioIds,
      methodSlices
    });
  }
  return {
    waveBatchId,
    reportPairId: request.reportPairId,
    hasWork: true,
    selectedMethodIds,
    selectedScenarioIds,
    remainingScenarioCountByMethod,
    completedMethodIds,
    parts,
    warnings
  };
}

function configuredWaveScenarioCount(options, targetClass) {
  const configured = typeof options.waveScenarioCount === 'function'
    ? options.waveScenarioCount(targetClass)
    : options.waveScenarioCount && typeof options.waveScenarioCount === 'object'
      ? options.waveScenarioCount[targetClass]
      : options.waveScenarioCount;
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(10_000, configured)
    : 1;
}

function generatedTestCode(packageName, className, options = {}) {
  const requestedNames = Array.isArray(options.testNames)
    ? options.testNames.filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  const testCount = requestedNames.length > 0
    ? requestedNames.length
    : Number.isSafeInteger(options.testCount)
    ? Math.max(1, options.testCount)
    : 1;
  const suffix = Number.isSafeInteger(options.partIndex)
    ? `Part${options.partIndex}`
    : '';
  return [
    `package ${packageName};`,
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    `public class ${className} {`,
    ...Array.from({ length: testCount }, (_, index) => [
      '    @Test',
      `    void ${requestedNames[index] ?? `coversGeneratedPath${suffix}_${index + 1}`}() {`,
      '    }'
    ]).flat(),
    '}',
    ''
  ].join('\n');
}

function waveEvent(waveSessionId, request, eventSequence, eventType, overrides = {}) {
  return {
    waveSessionId,
    eventSequence,
    waveId: request.waveId,
    methodId: request.methodId,
    waveIndex: request.waveIndex,
    eventType,
    occurredAt: new Date().toISOString(),
    partIndex: null,
    partBatchId: null,
    scenarioIds: [],
    childSessionId: null,
    candidateId: null,
    childEvent: null,
    partResult: null,
    completion: null,
    error: null,
    ...overrides
  };
}

function waveCompletion(parts) {
  const accountingReported = parts.some((part) => (
    part.modelCallCount !== undefined
    || part.usageReportedCallCount !== undefined
    || part.aggregateUsage !== undefined
  ));
  const usageParts = parts.flatMap((part) => part.aggregateUsage ? [part.aggregateUsage] : []);
  return {
    parts: [...parts].sort((left, right) => left.partIndex - right.partIndex),
    succeededPartCount: parts.filter((part) => part.status === 'succeeded').length,
    failedPartCount: parts.filter((part) => part.status === 'failed').length,
    cancelledPartCount: parts.filter((part) => part.status === 'cancelled').length,
    ...(accountingReported ? {
      aggregateUsage: usageParts.length === 0 ? null : {
        inputTokens: usageParts.reduce((sum, usage) => sum + usage.inputTokens, 0),
        outputTokens: usageParts.reduce((sum, usage) => sum + usage.outputTokens, 0),
        totalTokens: usageParts.reduce((sum, usage) => sum + usage.totalTokens, 0)
      },
      modelCallCount: parts.reduce((sum, part) => sum + (part.modelCallCount ?? 0), 0),
      usageReportedCallCount: parts.reduce(
        (sum, part) => sum + (part.usageReportedCallCount ?? 0),
        0
      )
    } : {})
  };
}

function waveStatus(waveSessionId, generation, afterEventSequence = 0) {
  return {
    waveSessionId,
    waveId: generation.request.waveId,
    methodId: generation.request.methodId,
    waveIndex: generation.request.waveIndex,
    phase: generation.completion ? 'completed' : generation.phase,
    lastEventSequence: generation.lastEventSequence,
    terminalParts: [...generation.terminalParts]
      .sort((left, right) => left.partIndex - right.partIndex),
    completion: generation.completion,
    terminalError: null,
    events: generation.events.filter((event) => event.eventSequence > afterEventSequence)
  };
}

async function createWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'class-task-e2e-'));
  const moduleRoot = join(workspaceRoot, 'multi-class-module');
  const sourceRoot = join(moduleRoot, 'src', 'main', 'java', 'com', 'example');
  const testRoot = join(moduleRoot, 'src', 'test', 'java', 'com', 'example');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(testRoot, { recursive: true })
  ]);
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>\n', 'utf8');
  const sourceFilePaths = [];
  for (const className of CLASS_NAMES) {
    const sourceFilePath = join(sourceRoot, `${className}.java`);
    await writeFile(sourceFilePath, [
      'package com.example;',
      '',
      `public class ${className} {`,
      '    public int value(int input) {',
      '        return input > 0 ? 1 : 0;',
      '    }',
      '}',
      ''
    ].join('\n'), 'utf8');
    sourceFilePaths.push(sourceFilePath);
  }
  await writeFile(join(testRoot, 'BaselineTest.java'), [
    'package com.example;',
    '',
    'class BaselineTest {',
    ...CLASS_NAMES.map((className, index) => `    ${className} target${index};`),
    '}',
    ''
  ].join('\n'), 'utf8');
  return { workspaceRoot, moduleRoot, sourceFilePaths, testRoot };
}

/**
 * Uses the production class-task composition root with only its process/network
 * boundaries replaced. No backend process, real model, or real Maven is used.
 */
export async function createClassTaskEndToEndHarness(options = {}) {
  const workspace = await createWorkspace();
  const storageDirectory = join(workspace.workspaceRoot, '.workstation-state');
  const fakeMaven = createFakeMaven({
    failGeneratedCompile: options.failGeneratedCompile
  });
  const pairMetadata = new Map();
  const analysisBySession = new Map();
  const candidateIdentityBySession = new Map();
  const waveGenerationBySession = new Map();
  const agentRequests = [];
  const savedMethodOrders = [];
  const methodsPerClass = options.methodsPerClass ?? 1;
  const expectedModelCalls = options.expectedModelCalls ?? CLASS_NAMES.length;
  let batchModelCalls = 0;
  let activeModelCalls = 0;
  let maxConcurrentModelCalls = 0;
  let releaseModelBarrier;
  const modelBarrier = new Promise((resolve) => {
    releaseModelBarrier = resolve;
  });

  async function runMethodGenerationWave(
    request,
    onProgress,
    signal,
    recoveredTerminalParts = []
  ) {
    if (signal?.aborted) throw signal.reason;
    const identity = validateStartMethodGenerationWaveRequest(request);
    const waveSessionId = randomUUID();
    const recoveredByPart = new Map(
      recoveredTerminalParts.map((part) => [part.partIndex, structuredClone(part)])
    );
    const pendingParts = request.parts.filter((part) => !recoveredByPart.has(part.partIndex));
    const generation = {
      request: structuredClone(request),
      phase: 'running',
      lastEventSequence: 0,
      terminalParts: [...recoveredByPart.values()],
      completion: null,
      events: []
    };
    waveGenerationBySession.set(waveSessionId, generation);

    for (const part of pendingParts) {
      const childRequest = part.request;
      await options.onAgentStart?.(structuredClone(childRequest));
      agentRequests.push({
        classTaskId: childRequest.classTaskId,
        methodId: childRequest.methodId,
        outputTestClassName: childRequest.outputTestClassName,
        batch: structuredClone(childRequest.batch),
        waveId: request.waveId,
        waveIndex: request.waveIndex,
        partIndex: part.partIndex,
        scenarioIds: [...part.scenarioIds],
        ...(childRequest.ragContext
          ? { ragContext: structuredClone(childRequest.ragContext) }
          : {})
      });
    }

    activeModelCalls += pendingParts.length;
    maxConcurrentModelCalls = Math.max(maxConcurrentModelCalls, activeModelCalls);
    if (agentRequests.length >= expectedModelCalls) releaseModelBarrier();
    try {
      if (pendingParts.length > 0) {
        const timeout = new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Expected fake model calls did not overlap.')),
            5_000
          );
          timer.unref?.();
        });
        await Promise.race([modelBarrier, timeout]);
      }
      if (signal?.aborted) throw signal.reason;
      const generatedParts = pendingParts.map((part, index) => {
        const configuredOutcome = Array.isArray(options.wavePartOutcomes)
          ? options.wavePartOutcomes[index]
          : undefined;
        if (configuredOutcome === 'failed') {
          return {
            partIndex: part.partIndex,
            partBatchId: part.partBatchId,
            scenarioIds: [...part.scenarioIds],
            status: 'failed',
            childSessionId: null,
            candidate: null,
            error: {
              code: 'MODEL_FAILED',
              message: `fixture Part ${part.partIndex} failed`,
              stage: 'generation'
            }
          };
        }
        const childSessionId = randomUUID();
        const childRequest = part.request;
        const testNames = Array.isArray(childRequest.batch.methodSlices)
          ? childRequest.batch.methodSlices.flatMap((slice) => Array.from(
              { length: slice.batch.methodTestPlan.testMethodPlans.length },
              (_, testIndex) => `${slice.testMethodNamePrefix}case${testIndex + 1}`
            ))
          : [];
        const code = generatedTestCode(
          childRequest.expectedPackageName,
          childRequest.outputTestClassName,
          {
            partIndex: part.partIndex,
            testCount: childRequest.batch.plannedTestMethods,
            testNames
          }
        );
        const candidate = {
          candidateId: randomUUID(),
          candidateVersion: 1,
          repairAttempt: 0,
          methodId: request.methodId,
          batchId: part.partBatchId,
          batchIndex: request.waveIndex,
          testCode: code,
          generatedCodeSha256: sha256(code),
          outputTestClassName: childRequest.outputTestClassName,
          ordinaryTestMethodCount: testNames.length > 0
            ? testNames.length
            : childRequest.batch.plannedTestMethods,
          usage: null
        };
        candidateIdentityBySession.set(childSessionId, {
          methodId: request.methodId,
          batchId: part.partBatchId,
          candidate
        });
        return {
          partIndex: part.partIndex,
          partBatchId: part.partBatchId,
          scenarioIds: [...part.scenarioIds],
          status: 'succeeded',
          childSessionId,
          candidate,
          error: null,
          ...(options.reportWaveUsage ? {
            aggregateUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            modelCallCount: 1,
            usageReportedCallCount: 1
          } : {})
        };
      });
      const terminalParts = [
        ...recoveredByPart.values(),
        ...generatedParts
      ].sort((left, right) => left.partIndex - right.partIndex);
      const completion = waveCompletion(terminalParts);
      const events = [waveEvent(waveSessionId, request, 1, 'wave_started')];
      for (const terminal of generatedParts) {
        events.push(waveEvent(
          waveSessionId,
          request,
          events.length + 1,
          terminal.status === 'succeeded' ? 'part_succeeded' : terminal.status === 'cancelled' ? 'part_cancelled' : 'part_failed',
          {
            partIndex: terminal.partIndex,
            partBatchId: terminal.partBatchId,
            scenarioIds: [...terminal.scenarioIds],
            childSessionId: terminal.childSessionId,
            candidateId: terminal.candidate?.candidateId ?? null,
            partResult: terminal
          }
        ));
      }
      events.push(waveEvent(
        waveSessionId,
        request,
        events.length + 1,
        'wave_completed',
        { completion }
      ));
      let previousEventSequence = 0;
      for (const event of events) {
        decodeMethodGenerationWaveEvent(event, {
          previousEventSequence,
          identity
        });
        previousEventSequence = event.eventSequence;
        await onProgress(event);
      }
      Object.assign(generation, {
        phase: 'completed',
        lastEventSequence: events.at(-1).eventSequence,
        terminalParts,
        completion,
        events
      });
      return {
        waveSessionId,
        eventSequence: generation.lastEventSequence,
        completion
      };
    } finally {
      activeModelCalls -= pendingParts.length;
    }
  }

  const aiClient = {
    async classifyUnitTestTarget() {
      return {
        targetClass: 'com.example.AlphaService',
        packageName: 'com.example',
        className: 'AlphaService',
        classKind: options.dataClassBatch
          ? 'DATA_EXPLICIT_ACCESSORS'
          : 'SERVICE_WITH_DEPENDENCIES',
        features: {
          lombokAnnotations: [],
          hasServiceAnnotation: false,
          hasDependencyInjectionAnnotations: false,
          dataClassName: options.dataClassBatch === true
        }
      };
    },

    async generateUnitTestPrompt(prompt, _modelContext, signal) {
      if (signal?.aborted) throw signal.reason;
      batchModelCalls += 1;
      const className = (
        /Top-level test class name must be exactly:\s*([^\r\n]+)/
          .exec(prompt)?.[1]
        ?? /^- 输出测试类：\s*([^\r\n]+)$/m.exec(prompt)?.[1]
      )?.trim();
      const evidenceText = /BEGIN_ANALYZER_EVIDENCE_JSON\r?\n([\s\S]*?)\r?\nEND_ANALYZER_EVIDENCE_JSON/
        .exec(prompt)?.[1];
      const tests = evidenceText
        ? JSON.parse(evidenceText).methods.flatMap((method) => Array.from(
            { length: method.requiredTestMethodCount },
            (_, index) => `${method.requiredTestMethodNamePrefix}case${index + 1}`
          ))
        : [...prompt.matchAll(/^\d+\.\s+(?:测试名以\s+)?`([^`]+)`[^\r\n]*$/gm)].flatMap((match) => {
            const count = Number(/生成\s+(\d+)\s+个\s+`@Test`/.exec(match[0])?.[1] ?? '1');
            const prefix = match[1].endsWith('_') ? match[1] : `${match[1]}_`;
            return Array.from(
              { length: count },
              (_, index) => `${prefix}case${index + 1}`
            );
          });
      if (!className || tests.length === 0) {
        throw new Error('Fake batch prompt is incomplete.');
      }
      return {
        result: [
          'package com.example;',
          'import org.junit.jupiter.api.Test;',
          `class ${className} {`,
          ...tests.map((name) => `  @Test void ${name}() {}`),
          '}'
        ].join('\n'),
        provider: 'openai-compatible',
        model: 'fixture-only',
        generationMode: 'deterministic_prompt',
        usage: null
      };
    },

    async probeModelToolCalling(modelContext, captureModelCalls, signal) {
      if (signal?.aborted) throw signal.reason;
      await options.onToolCallingProbe?.({
        modelContext: structuredClone(modelContext),
        captureModelCalls
      });
      return structuredClone(options.toolCallingProbeResult ?? {
        supported: true,
        cacheHit: false,
        cacheKeyDigest: 'd'.repeat(64),
        trace: null
      });
    },

    async generateTargetJacocoReport(request, signal) {
      if (signal?.aborted) throw signal.reason;
      const executionData = await readFile(request.executionDataPath);
      const generated = executionData.toString('utf8').includes('|fixture-generated:');
      const report = Buffer.from(
        `<report name="${request.targetClass}" generated="${generated}"/>`,
        'utf8'
      );
      const pairId = sha256(Buffer.concat([
        Buffer.from(`${request.targetClass}:${generated}:`, 'utf8'),
        executionData
      ]));
      const snapshot = branchSnapshot({
        pairId,
        report,
        executionData,
        targetClass: request.targetClass,
        generated
      });
      await mkdir(dirname(request.outputPath), { recursive: true });
      await Promise.all([
        writeFile(request.outputPath, report),
        writeFile(
          request.branchSnapshotOutputPath,
          JSON.stringify(snapshot),
          'utf8'
        )
      ]);
      pairMetadata.set(pairId, { targetClass: request.targetClass, generated });
      return {
        generated: true,
        reportPath: request.outputPath,
        branchSnapshotPath: request.branchSnapshotOutputPath,
        pairId,
        targetClass: request.targetClass,
        generatedAt: FIXED_NOW,
        message: 'fixture report'
      };
    },

    async createMethodAnalysisSession(request, signal) {
      if (signal?.aborted) throw signal.reason;
      await options.onCreateMethodAnalysisSession?.(structuredClone(request));
      analysisBySession.set(request.analysisSessionId, {
        targetClass: request.targetClass,
        reportPairId: request.reportPairId,
        plannedTestClassName: request.plannedTestClassName,
        plannedRelativeTestPath: request.plannedRelativeTestPath
      });
      return {
        analysisSessionId: request.analysisSessionId,
        reportPairId: request.reportPairId,
        sourceSha256: sha256(`source:${request.targetClass}`),
        dependencyContextSha256: sha256(`dependencies:${request.targetClass}`),
        packageName: 'com.example',
        testClassName: request.plannedTestClassName,
        suggestedRelativeTestPath: request.plannedRelativeTestPath,
        warnings: []
      };
    },

    async heartbeatMethodAnalysisSession(sessionId, signal) {
      if (signal?.aborted) throw signal.reason;
      const available = analysisBySession.has(sessionId);
      return options.heartbeatMethodAnalysisSession
        ? options.heartbeatMethodAnalysisSession({ sessionId, available })
        : available;
    },

    async deleteMethodAnalysisSession(sessionId, signal) {
      if (signal?.aborted) throw signal.reason;
      analysisBySession.delete(sessionId);
    },

    async refreshMethodAnalysisCoverage(sessionId, request, signal) {
      if (signal?.aborted) throw signal.reason;
      const analysis = analysisBySession.get(sessionId);
      const pair = pairMetadata.get(request.reportPairId);
      if (!analysis || !pair || pair.targetClass !== analysis.targetClass) {
        throw new Error('Fake Analyzer received an unknown analysis/report identity.');
      }
      analysis.reportPairId = request.reportPairId;
      return {
        reportPairId: request.reportPairId,
        coverage: exactCoverage(pair.generated),
        catalog: {
          analysisSessionId: sessionId,
          reportPairId: request.reportPairId,
          reportCoverageTotals: reportCoverageTotals(pair.generated, methodsPerClass),
          methods: Array.from(
            { length: methodsPerClass },
            (_, methodIndex) => methodSummary(
              pair.targetClass,
              pair.generated,
              methodIndex,
              options.dataClassBatch === true
            )
          ),
          warnings: []
        }
      };
    },

    async nextMethodBatch(sessionId, methodId, request, signal) {
      if (signal?.aborted) throw signal.reason;
      options.onAnalysisBatch?.();
      const analysis = analysisBySession.get(sessionId);
      const methodIndex = analysis
        ? Array.from({ length: methodsPerClass }, (_, index) => (
            methodIdFor(analysis.targetClass, index)
          )).indexOf(methodId)
        : -1;
      if (!analysis || methodIndex < 0) {
        throw new Error('Fake Analyzer received an unknown method identity.');
      }
      if (request.completedTestMethodPlanIds.length > 0) {
        return noWork({ reportPairId: request.reportPairId, methodId });
      }
      return workBatch({
        sessionId,
        reportPairId: request.reportPairId,
        targetClass: analysis.targetClass,
        methodId,
        methodIndex,
        dataAccessor: options.dataClassBatch === true
      });
    },

    async nextMethodWave(sessionId, methodId, request, signal) {
      if (signal?.aborted) throw signal.reason;
      options.onAnalysisBatch?.();
      const analysis = analysisBySession.get(sessionId);
      const methodIndex = analysis
        ? Array.from({ length: methodsPerClass }, (_, index) => (
            methodIdFor(analysis.targetClass, index)
          )).indexOf(methodId)
        : -1;
      if (
        !analysis
        || methodIndex < 0
        || request.reportPairId !== analysis.reportPairId
        || request.maxScenarios !== 25
        || request.partSize !== 5
      ) {
        throw new Error('Fake Analyzer received an unknown method Wave identity.');
      }
      return nextWorkWave({
        sessionId,
        reportPairId: request.reportPairId,
        targetClass: analysis.targetClass,
        methodId,
        methodIndex,
        dataAccessor: options.dataClassBatch === true,
        completedScenarioIds: request.completedScenarioIds,
        skippedScenarioIds: request.skippedScenarioIds,
        scenarioCount: configuredWaveScenarioCount(options, analysis.targetClass)
      });
    },

    async nextClassScenarioWave(sessionId, request, signal) {
      if (signal?.aborted) throw signal.reason;
      options.onAnalysisBatch?.();
      const analysis = analysisBySession.get(sessionId);
      if (
        !analysis
        || request.reportPairId !== analysis.reportPairId
        || request.maxScenarios !== 25
        || request.partSize !== 5
      ) {
        throw new Error('Fake Analyzer received an unknown class Wave identity.');
      }
      const methodWaves = request.methods.map((progress) => {
        const methodIndex = Array.from({ length: methodsPerClass }, (_, index) => (
          methodIdFor(analysis.targetClass, index)
        )).indexOf(progress.methodId);
        if (methodIndex < 0) {
          throw new Error('Fake Analyzer received an unknown class Wave method.');
        }
        return nextWorkWave({
          sessionId,
          reportPairId: request.reportPairId,
          targetClass: analysis.targetClass,
          methodId: progress.methodId,
          methodIndex,
          dataAccessor: options.dataClassBatch === true,
          completedScenarioIds: progress.completedScenarioIds,
          skippedScenarioIds: progress.skippedScenarioIds,
          scenarioCount: configuredWaveScenarioCount(options, analysis.targetClass)
        });
      });
      const classWave = classWaveFromMethodWaves(request, methodWaves);
      return {
        ...classWave,
        methodId: request.methods[0].methodId,
        remainingScenarioCount: 0,
        parts: classWave.parts.map((part) => ({
          ...structuredClone(part.methodSlices[0].batch),
          ...part
        }))
      };
    },

    async startMethodGenerationStream(request, _modelContext, onProgress, signal) {
      if (signal?.aborted) throw signal.reason;
      await options.onAgentStart?.(structuredClone(request));
      agentRequests.push({
        classTaskId: request.classTaskId,
        methodId: request.methodId,
        outputTestClassName: request.outputTestClassName,
        batch: structuredClone(request.batch),
        ...(request.ragContext
          ? { ragContext: structuredClone(request.ragContext) }
          : {})
      });
      activeModelCalls += 1;
      maxConcurrentModelCalls = Math.max(maxConcurrentModelCalls, activeModelCalls);
      if (agentRequests.length >= expectedModelCalls) releaseModelBarrier();
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Five fake model calls did not overlap.')),
          5_000
        );
        timer.unref?.();
      });
      try {
        await Promise.race([modelBarrier, timeout]);
        const sessionId = randomUUID();
        const code = generatedTestCode(
          request.expectedPackageName,
          request.outputTestClassName
        );
        const candidate = {
          candidateId: randomUUID(),
          candidateVersion: 1,
          repairAttempt: 0,
          methodId: request.methodId,
          batchId: request.batchId,
          batchIndex: request.batchIndex,
          testCode: code,
          generatedCodeSha256: sha256(code),
          outputTestClassName: request.outputTestClassName,
          ordinaryTestMethodCount: request.batch.plannedTestMethods,
          usage: null
        };
        candidateIdentityBySession.set(sessionId, {
          methodId: request.methodId,
          batchId: request.batchId,
          candidate
        });
        await onProgress({
          sessionId,
          eventSequence: 1,
          eventType: 'candidate_ready',
          occurredAt: FIXED_NOW,
          progress: null,
          candidate,
          completion: null,
          modelCall: null,
          error: null
        });
        return {
          kind: 'candidate_ready',
          sessionId,
          eventSequence: 1,
          candidate
        };
      } finally {
        activeModelCalls -= 1;
      }
    },

    async recoverMethodGenerationStream(request, _modelContext, onProgress, signal) {
      if (signal?.aborted) throw signal.reason;
      const sessionId = randomUUID();
      const candidate = structuredClone(request.candidate);
      candidateIdentityBySession.set(sessionId, {
        methodId: request.startRequest.methodId,
        batchId: request.startRequest.batchId,
        candidate
      });
      const event = {
        sessionId,
        eventSequence: 1,
        eventType: 'candidate_ready',
        occurredAt: FIXED_NOW,
        progress: null,
        candidate,
        completion: null,
        modelCall: null,
        error: null
      };
      await onProgress(event);
      return {
        kind: 'candidate_ready',
        sessionId,
        eventSequence: 1,
        candidate
      };
    },

    async streamMethodGenerationWave(request, _modelContext, onProgress, signal) {
      return runMethodGenerationWave(request, onProgress, signal);
    },

    async resumeMethodGenerationWaveStream(
      waveSessionId,
      startRequest,
      afterEventSequence,
      onProgress,
      signal
    ) {
      if (signal?.aborted) throw signal.reason;
      const generation = waveGenerationBySession.get(waveSessionId);
      if (!generation) throw new MethodGenerationWaveNotFoundError(waveSessionId);
      const expected = validateStartMethodGenerationWaveRequest(startRequest);
      const actual = validateStartMethodGenerationWaveRequest(generation.request);
      if (
        expected.waveId !== actual.waveId
        || expected.methodId !== actual.methodId
        || expected.waveIndex !== actual.waveIndex
      ) {
        throw new Error('Fake Agent received a mismatched Wave resume identity.');
      }
      for (const event of generation.events) {
        if (event.eventSequence > afterEventSequence) await onProgress(event);
      }
      if (!generation.completion) {
        throw new Error('Fake Agent Wave is not terminal during resume.');
      }
      return {
        waveSessionId,
        eventSequence: generation.lastEventSequence,
        completion: structuredClone(generation.completion)
      };
    },

    async recoverMethodGenerationWaveStream(request, _modelContext, onProgress, signal) {
      validateRecoverMethodGenerationWaveRequest(request);
      return runMethodGenerationWave(
        request.startRequest,
        onProgress,
        signal,
        request.terminalParts
      );
    },

    async acknowledgeMethodGenerationWaveEvents(waveSessionId, eventSequence) {
      const generation = waveGenerationBySession.get(waveSessionId);
      if (!generation) throw new MethodGenerationWaveNotFoundError(waveSessionId);
      return {
        waveSessionId,
        acknowledgedThroughEventSequence: eventSequence,
        lastEventSequence: generation.lastEventSequence
      };
    },

    async cancelMethodGenerationWave(waveSessionId) {
      const generation = waveGenerationBySession.get(waveSessionId);
      if (!generation) throw new MethodGenerationWaveNotFoundError(waveSessionId);
      generation.phase = 'cancelled';
      return { waveSessionId, phase: 'cancelled' };
    },

    async prepareRagRepair(sessionId, request, signal) {
      if (signal?.aborted) throw signal.reason;
      const identity = candidateIdentityBySession.get(sessionId);
      if (!identity) throw new Error('Fake Agent received an unknown RAG repair session.');
      await options.onRagPrepare?.(structuredClone(request));
      return {
        status: 'attributable',
        diagnosticFingerprint: '8'.repeat(64),
        requestedFqns: ['com.example.DiagnosticDependency'],
        originalDiagnosticText: '[ERROR] simulated compile failure',
        targetMethodKey: 'com.example.Fixture#method()V',
        degradationCode: null
      };
    },

    async resumeMethodGenerationStream(sessionId, request, _modelContext, _onProgress, signal) {
      if (signal?.aborted) throw signal.reason;
      const identity = candidateIdentityBySession.get(sessionId);
      if (!identity) throw new Error('Fake Agent received an unknown session identity.');
      await options.onAgentResume?.(structuredClone(request));
      if (options.repairFailedCandidate && request.execution.status !== 'passed') {
        const candidate = {
          ...identity.candidate,
          candidateId: randomUUID(),
          candidateVersion: request.candidateVersion + 1,
          repairAttempt: request.repairAttempt + 1
        };
        identity.candidate = candidate;
        return {
          kind: 'candidate_ready',
          sessionId,
          eventSequence: request.expectedEventSequence + 1,
          candidate
        };
      }
      return {
        kind: 'completed',
        sessionId,
        eventSequence: request.expectedEventSequence + 1,
        completion: {
          methodId: identity.methodId,
          batchId: identity.batchId,
          stopReason: 'verified',
          bestCandidateId: request.candidateId,
          aggregateUsage: null,
          modelCallCount: 1,
          usageReportedCallCount: 0
        }
      };
    },

    async acknowledgeMethodGenerationEvents(sessionId, eventSequence) {
      return {
        sessionId,
        acknowledgedThroughEventSequence: eventSequence,
        lastEventSequence: eventSequence
      };
    },

    async cancelMethodGeneration(sessionId) {
      return { sessionId, phase: 'cancelled' };
    }
  };

  const runtime = createProductionClassTaskRuntime({
    storageDirectory,
    aiClient,
    shellService: fakeMaven.shellService,
    mavenAnalysisContextService: {
      async collect(request) {
        return {
          workspaceRoot: request.workspaceRoot,
          moduleRoot: request.moduleRoot,
          targetSourcePath: request.targetSourcePath,
          targetClass: request.targetClass,
          plannedTestClassName: request.plannedTestClassName,
          plannedRelativeTestPath: request.plannedRelativeTestPath,
          reportPath: request.reportPath,
          branchSnapshotPath: request.branchSnapshotPath,
          reportPairId: request.reportPairId,
          sourceRoots: [join(request.moduleRoot, 'src', 'main', 'java')],
          classpathEntries: [],
          javaHome: 'C:\\fixture-jdk',
          jdkMajorVersion: 21,
          buildContextFingerprint: sha256(`build:${request.moduleRoot}`),
          warnings: []
        };
      }
    },
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: new JacocoArtifactsService(),
    surefireReportService: fakeMaven.surefireReportService,
    buildSettingsService: {
      async get() {
        return {
          mavenHome: 'C:\\fixture-maven',
          javaHome: 'C:\\fixture-jdk',
          validation: {
            valid: true,
            command: 'fake-mvn --version',
            mavenVersion: '3.9.16',
            javaVersion: '21.0.8',
            javaRuntime: 'fake-jdk',
            checkedAt: FIXED_NOW
          }
        };
      },
      async resolveMavenHomeDefaults() {
        return {
          settingsPath: 'C:\\fixture-maven\\conf\\settings.xml',
          localRepository: 'C:\\fixture-home\\.m2\\repository'
        };
      }
    },
    modelInterfacesService: {
      async getView() {
        return {
          schemaVersion: 2,
          activeInterfaceId: 'fixture-model',
          interfaces: [{
            id: 'fixture-model',
            name: 'Fixture model',
            baseUrl: 'http://127.0.0.1:9/v1',
            model: 'fixture-only',
            credentialMode: 'direct',
            hasStoredApiKey: true,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW
          }],
          secureStorageAvailable: true
        };
      },
      async resolveForGeneration() {
        await options.onResolveGenerationModel?.();
        return {
          interfaceId: 'fixture-model',
          interfaceName: 'Fixture model',
          llmConfig: {
            provider: 'custom_openai',
            model: 'fixture-only',
            baseUrl: 'http://127.0.0.1:9/v1',
            credentials: { apiKey: 'fixture-not-used' }
          }
        };
      }
    },
    modelCallLogSettingsService: {
      async get() {
        await options.onModelCallLogSettings?.();
        return { enabled: false };
      }
    },
    ragSettingsService: options.ragSettingsService ?? {
      async get() {
        throw new Error('RAG settings must not be read by an unchecked task.');
      }
    },
    ragEmbeddingInterfacesService: options.ragEmbeddingInterfacesService ?? {
      async resolveRuntime() { return null; }
    },
    ragIndexCoordinator: options.ragIndexCoordinator ?? {
      subscribeInitial() {
        throw new Error('RAG indexing must not start for an unchecked task.');
      },
      async releaseAll() {}
    },
    async ensureRagTaskKnowledge(input) {
      await options.onEnsureRagTaskKnowledge?.(structuredClone({ ...input, signal: undefined }));
      return { status: 'published', addedMethodCount: 1, reusedMethodCount: 0 };
    },
    ragIndexWaitMilliseconds: options.ragIndexWaitMilliseconds,
    broadcast(snapshot) {
      options.onSnapshot?.(structuredClone(snapshot));
    },
    clock: options.clock
  });

  async function prepareFirstClassMethods(ragEnabled = false) {
    await runtime.startup();
    await runtime.addClassTasks({
      workspaceRoot: workspace.workspaceRoot,
      classFilePaths: workspace.sourceFilePaths.slice(0, 1)
    });
    await runtime.flush();
    const [prepared] = await runtime.listClassTasks({
      workspaceRoot: workspace.workspaceRoot
    });
    const catalog = await runtime.getClassTaskMethods({
      workspaceRoot: workspace.workspaceRoot,
      taskId: prepared.id
    });
    const methodOrder = catalog.methods
      .filter((method) => method.generatable && method.coverageGap !== false)
      .map((method) => method.methodId);
    await runtime.saveMethodSelection({
      workspaceRoot: workspace.workspaceRoot,
      taskId: prepared.id,
      selectionMode: 'EXPLICIT',
      selectedMethodIds: methodOrder,
      methodOrder,
      ragEnabled,
      repairAttemptLimit: 5,
      unlimitedRepair: false
    });
    return {
      ...prepared,
      initialCatalog: structuredClone(catalog)
    };
  }

  let closed = false;
  return {
    workspaceRoot: workspace.workspaceRoot,
    sourceFilePaths: [...workspace.sourceFilePaths],
    startup() {
      return runtime.startup();
    },
    addClassTasks(sourceFilePaths = workspace.sourceFilePaths) {
      return runtime.addClassTasks({
        workspaceRoot: workspace.workspaceRoot,
        classFilePaths: sourceFilePaths
      });
    },
    flush() {
      return runtime.flush();
    },
    listClassTasks() {
      return runtime.listClassTasks({ workspaceRoot: workspace.workspaceRoot });
    },
    retryModulePreload(taskId) {
      return runtime.retryModulePreload({
        workspaceRoot: workspace.workspaceRoot,
        taskId
      });
    },
    mavenMetrics() {
      return fakeMaven.metrics();
    },
    listGeneratedTestFiles() {
      return readdir(workspace.testRoot);
    },
    removeGeneratedTestFile(fileName) {
      return rm(join(workspace.testRoot, fileName), { force: true });
    },
    checkClassTaskMethods(taskId, fingerprint) {
      return runtime.checkClassTaskMethods({
        workspaceRoot: workspace.workspaceRoot,
        taskId,
        fingerprint
      });
    },
    getClassTaskMethods(taskId) {
      return runtime.getClassTaskMethods({
        workspaceRoot: workspace.workspaceRoot,
        taskId
      });
    },
    runTask(taskId) {
      return runtime.runTask({
        workspaceRoot: workspace.workspaceRoot,
        taskId
      });
    },
    saveMethodSelection(taskId, methodOrder) {
      return runtime.saveMethodSelection({
        workspaceRoot: workspace.workspaceRoot,
        taskId,
        selectionMode: 'EXPLICIT',
        selectedMethodIds: [...methodOrder],
        methodOrder: [...methodOrder],
        ragEnabled: false,
        repairAttemptLimit: 5,
        unlimitedRepair: false
      });
    },
    agentRequests() {
      return structuredClone(agentRequests);
    },
    acceptTaskResult(taskId) {
      return runtime.acceptTaskResult({
        workspaceRoot: workspace.workspaceRoot,
        taskId
      });
    },
    terminateTask(taskId) {
      return runtime.terminateTask({
        workspaceRoot: workspace.workspaceRoot,
        taskId
      });
    },
    stopModulePreload(taskId) {
      return runtime.stopModulePreload({
        workspaceRoot: workspace.workspaceRoot,
        taskId
      });
    },
    async runFiveClasses() {
      await runtime.startup();
      await runtime.addClassTasks({
        workspaceRoot: workspace.workspaceRoot,
        classFilePaths: workspace.sourceFilePaths
      });
      await runtime.flush();
      const prepared = await runtime.listClassTasks({
        workspaceRoot: workspace.workspaceRoot
      });
      const catalogs = await Promise.all(prepared.map((task) => runtime.getClassTaskMethods({
        workspaceRoot: workspace.workspaceRoot,
        taskId: task.id
      })));
      await Promise.all(prepared.map((task, index) => {
        const selectedMethodIds = catalogs[index].methods
          .filter((method) => method.generatable && method.coverageGap !== false)
          .map((method) => method.methodId);
        const methodOrder = options.reverseMethodOrder
          ? [...selectedMethodIds].reverse()
          : [...selectedMethodIds];
        savedMethodOrders.push([...methodOrder]);
        return runtime.saveMethodSelection({
          workspaceRoot: workspace.workspaceRoot,
          taskId: task.id,
          selectionMode: 'EXPLICIT',
          selectedMethodIds,
          methodOrder,
          ragEnabled: options.ragEnabled === true,
          repairAttemptLimit: 5,
          unlimitedRepair: false
        });
      }));

      await options.onBeforeRunAll?.();
      await runtime.runAll({ workspaceRoot: workspace.workspaceRoot });
      const completed = await runtime.listClassTasks({
        workspaceRoot: workspace.workspaceRoot
      });
      if (completed.some((task) => task.state !== 'COMPLETED')) {
        throw new Error(`Class-task fixture states: ${JSON.stringify(
          completed.map((task) => ({
            className: task.qualifiedClassName,
            state: task.state,
            preloadState: task.preloadState,
            atomicStep: task.currentAtomicStep,
            lastError: task.lastError
          }))
        )}`);
      }
      const first = completed[0];
      const second = completed[1];
      const accepted = await runtime.acceptTaskResult({
        workspaceRoot: workspace.workspaceRoot,
        taskId: first.id
      });
      const revoked = await runtime.revokeTaskResult({
        workspaceRoot: workspace.workspaceRoot,
        taskId: second.id
      });
      const maven = fakeMaven.metrics();

      return {
        completedTasks: completed.filter((task) => task.state === 'COMPLETED').length,
        modulePreloadMavenCalls: maven.modulePreloadMavenCalls,
        classPreloadMavenCalls: maven.classPreloadMavenCalls,
        maxConcurrentModelCalls,
        maxConcurrentSameModuleMavenCalls: maven.maxConcurrentSameModuleMavenCalls,
        agentRequests: structuredClone(agentRequests),
        savedMethodOrders: structuredClone(savedMethodOrders),
        realModelCalls: 0,
        acceptedArtifactCount: accepted.artifacts.length,
        revokedArtifactCount: revoked.artifacts.length
      };
    },

    async runFirstClassMethods() {
      const prepared = await prepareFirstClassMethods();
      const snapshot = await runtime.runTask({
        workspaceRoot: workspace.workspaceRoot,
        taskId: prepared.id
      });
      return {
        snapshot,
        initialCatalog: structuredClone(prepared.initialCatalog),
        agentRequests: structuredClone(agentRequests),
        batchModelCalls,
        maven: fakeMaven.metrics(),
        testFiles: await readdir(workspace.testRoot)
      };
    },

    async runFirstRagClass() {
      const prepared = await prepareFirstClassMethods(true);
      const before = fakeMaven.metrics();
      const snapshot = await runtime.runTask({
        workspaceRoot: workspace.workspaceRoot,
        taskId: prepared.id
      });
      const after = fakeMaven.metrics();
      return {
        snapshot,
        executionMavenCalls:
          (after.modulePreloadMavenCalls - before.modulePreloadMavenCalls)
          + (after.classPreloadMavenCalls - before.classPreloadMavenCalls),
        agentRequests: structuredClone(agentRequests)
      };
    },

    async runFirstClassMethodsWithFinalizationRetry() {
      const prepared = await prepareFirstClassMethods();
      const first = await runtime.runTask({
        workspaceRoot: workspace.workspaceRoot,
        taskId: prepared.id
      });
      const filesAfterFailure = await readdir(workspace.testRoot);
      const modelCallCountAfterFailure = agentRequests.length;
      const second = await runtime.runTask({
        workspaceRoot: workspace.workspaceRoot,
        taskId: prepared.id
      });
      return {
        first,
        second,
        filesAfterFailure,
        modelCallCountAfterFailure,
        agentRequests: structuredClone(agentRequests),
        testFiles: await readdir(workspace.testRoot)
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      await runtime.beforeQuit();
      await rm(workspace.workspaceRoot, { recursive: true, force: true });
    }
  };
}

const E2E_AUTHORIZATION_HEADER = 'Bearer workstation-electron-e2e';

async function recordFixtureEvent(eventLogPath, event) {
  if (!eventLogPath) return;
  await appendFile(eventLogPath, `${JSON.stringify({ event })}\n`, 'utf8');
}

function ragFixtureSourceFile(ownerFqn = 'com.example.RagFixtureSource') {
  const separator = ownerFqn.lastIndexOf('.');
  const packageName = separator < 0 ? '' : ownerFqn.slice(0, separator);
  const simpleName = separator < 0 ? ownerFqn : ownerFqn.slice(separator + 1);
  const sourceSimpleName = simpleName.replaceAll('$', '_');
  const methodName = 'value';
  const descriptor = '(I)I';
  const methodKey = `${ownerFqn}#${methodName}${descriptor}`;
  const canonicalSignature = `public int ${ownerFqn}.${methodName}(int)`;
  const sourceText = [
    ...(packageName ? [`package ${packageName};`] : []),
    `public class ${sourceSimpleName} {`,
    '  public int value(int input) { return input > 0 ? 1 : 0; }',
    '}'
  ].join('\n');
  const contentSha256 = sha256(sourceText);
  const sourcePath = `${ownerFqn.replaceAll('.', '/').replaceAll('$', '/')}.java`;
  const methodLine = packageName ? 3 : 2;
  return {
    fileId: `project:src/main/java/${sourcePath}`,
    origin: 'PROJECT_PRODUCTION',
    projectRelativePath: `src/main/java/${sourcePath}`,
    mavenCoordinate: null,
    dependencyFingerprint: null,
    sourceLineBasis: 'ORIGINAL_SOURCE',
    classpathOrder: 0,
    rawSha256: contentSha256,
    normalizedSha256: contentSha256,
    decommentedSource: sourceText,
    parseStatus: 'RESOLVED',
    types: [{
      fqn: ownerFqn,
      simpleName,
      modifiers: ['public'],
      firstLine: packageName ? 2 : 1,
      lastLine: packageName ? 4 : 3
    }],
    methods: [{
      ownerFqn,
      modifiers: ['public'],
      typeParameters: [],
      returnTypeFqn: 'int',
      methodName,
      parameters: [{ typeFqn: 'int', arrayDimensions: 0, varArgs: false }],
      declaredThrowsFqns: [],
      jvmDescriptor: descriptor,
      canonicalSignature,
      methodKey
    }],
    chunks: [{
      chunkId: `project:rag-fixture:${contentSha256.slice(0, 12)}`,
      sourceLineBasis: 'ORIGINAL_SOURCE',
      packageName,
      classDeclaration: `public class ${sourceSimpleName}`,
      relevantImports: [],
      classContextSource: `public class ${sourceSimpleName}`,
      embeddingContextSource: `${ownerFqn} ${canonicalSignature}`,
      ownerFqn,
      methodKey,
      canonicalSignature,
      declaredThrowsFqns: [],
      methodFirstLine: methodLine,
      methodLastLine: methodLine,
      firstLine: methodLine,
      lastLine: methodLine,
      estimatedTokens: 20,
      contentSha256,
      sourceText: 'public int value(int input) { return input > 0 ? 1 : 0; }'
    }]
  };
}

/**
 * Real loopback HTTP boundaries for Electron Playwright tests. Requests pass
 * through the production AiClient decoders; no model provider is contacted.
 */
export async function startFakeBackendServers(options = {}) {
  const pairMetadata = new Map();
  const analysisBySession = new Map();
  const generationBySession = new Map();
  const waveGenerationBySession = new Map();
  const ragSnapshotsBySession = new Map();
  const activeRagTaskRunIds = new Set();
  const agentRequests = [];
  const waveRequests = [];
  const wavePartResults = [];
  const toolCallingProbes = [];
  const ragPrepareRequests = [];
  const ragResumeRequests = [];
  const repairContextRequests = [];
  const backendErrors = [];
  let analysisSessionCreations = 0;
  let realModelCalls = 0;
  let activeModelCalls = 0;
  let maxConcurrentModelCalls = 0;
  const modelDelayMs = Number.isFinite(options.modelDelayMs)
    ? Math.max(0, Number(options.modelDelayMs))
    : 120;

  const analyzerServer = createServer(async (request, response) => {
    try {
      requireFixtureAuthorization(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      const sourceSetMatch = /^\/api\/generation-analysis\/sessions\/([^/]+)\/rag-source-set$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && sourceSetMatch) {
        const sessionId = decodeURIComponent(sourceSetMatch[1]);
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(sessionId);
        if (!analysis || input.reportPairId !== analysis.reportPairId) {
          return sendJson(response, 404, { error: 'unknown RAG analysis session' });
        }
        if (
          options.failRagRefresh
          && Array.isArray(input.requestedFqns)
          && input.requestedFqns.length > 0
        ) {
          return sendJson(response, 500, { error: 'fixture RAG refresh failure' });
        }
        const allowedFqns = [...new Set([
          analysis.targetClass,
          ...(Array.isArray(input.requestedFqns) ? input.requestedFqns : [])
        ])].sort();
        return sendJson(response, 200, {
          targetClassFqn: analysis.targetClass,
          allowedFqns,
          unresolvedFqns: [],
          requestedSourceSetFingerprint: ragSourceSetFingerprint(allowedFqns)
        });
      }

      if (
        request.method === 'POST'
        && url.pathname === '/api/rag/source-snapshot-sessions'
      ) {
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(input.analysisSessionId);
        if (!analysis || input.reportPairId !== analysis.reportPairId) {
          return sendJson(response, 404, { error: 'unknown RAG analysis session' });
        }
        const allowedFqns = [...new Set([
          analysis.targetClass,
          ...(Array.isArray(input.requestedFqns) ? input.requestedFqns : [])
        ])].sort();
        const requestedSourceSetFingerprint = ragSourceSetFingerprint(allowedFqns);
        if (input.requestedSourceSetFingerprint !== requestedSourceSetFingerprint) {
          return sendJson(response, 409, { error: 'RAG source-set identity mismatch' });
        }
        const sessionId = randomUUID();
        ragSnapshotsBySession.set(sessionId, {
          scopeFingerprintPrefix: String(input.buildFingerprint ?? '').slice(0, 12),
          sources: allowedFqns.map((fqn) => ragFixtureSourceFile(fqn))
        });
        return sendJson(response, 200, {
          sessionId,
          requestedSourceSetFingerprint,
          allowedFqns,
          unresolvedFqns: [],
          upsertCount: allowedFqns.length,
          unchangedCount: 0,
          deletedCount: 0
        });
      }

      let ragMatch = /^\/api\/rag\/source-snapshot-sessions\/([^/]+)\/pages\/(\d+)$/.exec(
        url.pathname
      );
      if (request.method === 'GET' && ragMatch) {
        const sessionId = decodeURIComponent(ragMatch[1]);
        const pageIndex = Number(ragMatch[2]);
        const pageSize = Number(url.searchParams.get('pageSize'));
        const snapshot = ragSnapshotsBySession.get(sessionId);
        if (!snapshot || pageIndex !== 0) {
          return sendJson(response, 404, { error: 'unknown RAG snapshot page' });
        }
        return sendJson(response, 200, {
          sessionId,
          pageIndex,
          pageSize,
          upserts: snapshot.sources,
          unchangedFileIds: [],
          deletedFileIds: [],
          hasMore: false,
          diagnostics: []
        });
      }

      ragMatch = /^\/api\/rag\/source-snapshot-sessions\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'DELETE' && ragMatch) {
        ragSnapshotsBySession.delete(decodeURIComponent(ragMatch[1]));
        response.writeHead(204);
        return response.end();
      }

      if (request.method === 'POST' && url.pathname === '/api/reports/jacoco/target-report') {
        const input = await readJsonRequest(request);
        const executionData = await readFile(input.executionDataPath);
        const generated = executionData.toString('utf8').includes('|fixture-generated:');
        const report = Buffer.from(
          `<report name="${input.targetClass}" generated="${generated}"/>`,
          'utf8'
        );
        const pairId = sha256(Buffer.concat([
          Buffer.from(`${input.targetClass}:${generated}:`, 'utf8'),
          executionData
        ]));
        const snapshot = branchSnapshot({
          pairId,
          report,
          executionData,
          targetClass: input.targetClass,
          generated
        });
        await Promise.all([
          mkdir(dirname(input.outputPath), { recursive: true }),
          mkdir(dirname(input.branchSnapshotOutputPath), { recursive: true })
        ]);
        await Promise.all([
          writeFile(input.outputPath, report),
          writeFile(input.branchSnapshotOutputPath, JSON.stringify(snapshot), 'utf8')
        ]);
        pairMetadata.set(pairId, {
          targetClass: input.targetClass,
          generated,
          reportPath: input.outputPath,
          branchSnapshotPath: input.branchSnapshotOutputPath
        });
        return sendJson(response, 200, {
          generated: true,
          reportPath: input.outputPath,
          branchSnapshotPath: input.branchSnapshotOutputPath,
          pairId,
          targetClass: input.targetClass,
          generatedAt: new Date().toISOString(),
          message: 'fixture report'
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/generation-analysis/sessions') {
        const input = await readJsonRequest(request);
        const pair = pairMetadata.get(input.reportPairId);
        if (!pair || pair.targetClass !== input.targetClass) {
          return sendJson(response, 409, { error: 'unknown report pair' });
        }
        analysisBySession.set(input.analysisSessionId, {
          targetClass: input.targetClass,
          reportPairId: input.reportPairId,
          plannedTestClassName: input.plannedTestClassName,
          plannedRelativeTestPath: input.plannedRelativeTestPath
        });
        analysisSessionCreations += 1;
        const packageName = input.targetClass.includes('.')
          ? input.targetClass.slice(0, input.targetClass.lastIndexOf('.'))
          : '';
        return sendJson(response, 200, {
          analysisSessionId: input.analysisSessionId,
          reportPairId: input.reportPairId,
          sourceSha256: sha256(`source:${input.targetClass}`),
          dependencyContextSha256: sha256(`dependencies:${input.targetClass}`),
          packageName,
          testClassName: input.plannedTestClassName,
          suggestedRelativeTestPath: input.plannedRelativeTestPath,
          warnings: []
        });
      }

      let match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/heartbeat$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        if (!analysisBySession.has(sessionId)) {
          return sendJson(response, 404, {
            code: 'ANALYSIS_SESSION_NOT_FOUND',
            message: 'analysis session expired'
          });
        }
        return sendJson(response, 200, {
          analysisSessionId: sessionId,
          status: 'ACTIVE',
          lastHeartbeatAt: new Date().toISOString()
        });
      }

      match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/methods$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const analysis = analysisBySession.get(sessionId);
        const pair = analysis && pairMetadata.get(analysis.reportPairId);
        if (!analysis || !pair) return sendJson(response, 404, { error: 'unknown session' });
        return sendJson(response, 200, {
          analysisSessionId: sessionId,
          reportPairId: analysis.reportPairId,
          reportCoverageTotals: reportCoverageTotals(pair.generated),
          methods: [methodSummary(analysis.targetClass, pair.generated)],
          warnings: []
        });
      }

      match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/methods\/([^/]+)\/next-batch$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const methodId = decodeURIComponent(match[2]);
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(sessionId);
        if (!analysis || methodId !== methodIdFor(analysis.targetClass)) {
          return sendJson(response, 404, { error: 'unknown method' });
        }
        const body = input.completedTestMethodPlanIds.length > 0
          ? noWork({ reportPairId: input.reportPairId, methodId })
          : workBatch({
              sessionId,
              reportPairId: input.reportPairId,
              targetClass: analysis.targetClass,
              methodId
            });
        return sendJson(response, 200, body);
      }

      match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/methods\/([^/]+)\/next-wave$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const methodId = decodeURIComponent(match[2]);
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(sessionId);
        if (
          !analysis
          || methodId !== methodIdFor(analysis.targetClass)
          || input.reportPairId !== analysis.reportPairId
          || input.maxScenarios !== 25
          || input.partSize !== 5
        ) {
          return sendJson(response, 404, { error: 'unknown method Wave' });
        }
        const body = nextWorkWave({
          sessionId,
          reportPairId: analysis.reportPairId,
          targetClass: analysis.targetClass,
          methodId,
          completedScenarioIds: Array.isArray(input.completedScenarioIds)
            ? input.completedScenarioIds
            : [],
          skippedScenarioIds: Array.isArray(input.skippedScenarioIds)
            ? input.skippedScenarioIds
            : [],
          scenarioCount: configuredWaveScenarioCount(options, analysis.targetClass)
        });
        return sendJson(response, 200, body);
      }

      match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/next-class-wave$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(sessionId);
        if (
          !analysis
          || input.reportPairId !== analysis.reportPairId
          || input.maxScenarios !== 25
          || input.partSize !== 5
          || !Array.isArray(input.methods)
        ) {
          return sendJson(response, 404, { error: 'unknown class Wave' });
        }
        const methodWaves = input.methods.map((progress, methodIndex) => nextWorkWave({
          sessionId,
          reportPairId: analysis.reportPairId,
          targetClass: analysis.targetClass,
          methodId: progress.methodId,
          methodIndex,
          completedScenarioIds: Array.isArray(progress.completedScenarioIds)
            ? progress.completedScenarioIds
            : [],
          skippedScenarioIds: Array.isArray(progress.skippedScenarioIds)
            ? progress.skippedScenarioIds
            : [],
          scenarioCount: configuredWaveScenarioCount(options, analysis.targetClass)
        }));
        return sendJson(response, 200, classWaveFromMethodWaves(input, methodWaves));
      }

      match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/repair-context$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(sessionId);
        if (
          !analysis
          || input.reportPairId !== analysis.reportPairId
          || input.methodId !== methodIdFor(analysis.targetClass)
        ) {
          return sendJson(response, 404, { error: 'unknown repair context' });
        }
        repairContextRequests.push({
          sessionId,
          reportPairId: input.reportPairId,
          methodId: input.methodId,
          currentClassFrameCount: input.currentClassFrames?.length ?? 0,
          relatedTypeFqnCount: input.relatedTypeFqns?.length ?? 0,
          missingSymbolCount: input.missingSymbols?.length ?? 0
        });
        await recordFixtureEvent(options.eventLogPath, 'repair-context');
        return sendJson(response, 200, {
          reportPairId: input.reportPairId,
          sourceSha256: sha256(`source:${analysis.targetClass}`),
          targetMethod: {
            methodId: input.methodId,
            declaringType: analysis.targetClass,
            methodName: 'value',
            descriptor: '(I)I',
            modifiers: ['public'],
            firstLine: 4,
            lastLine: 5,
            sourceFirstLine: 4,
            sourceLastLine: 5,
            sourceText: 'public int value(int input) { return input > 0 ? 1 : 0; }',
            sourceComplete: true,
            parameterTypes: ['int'],
            returnType: 'int',
            declaredExceptions: []
          },
          stackMethods: [],
          referencedTypes: [],
          warnings: [],
          truncated: false
        });
      }

      match = /^\/api\/generation-analysis\/sessions\/([^/]+)\/refresh-coverage$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const input = await readJsonRequest(request);
        const analysis = analysisBySession.get(sessionId);
        const pair = pairMetadata.get(input.reportPairId);
        if (!analysis || !pair || pair.targetClass !== analysis.targetClass) {
          return sendJson(response, 404, { error: 'unknown refreshed pair' });
        }
        analysis.reportPairId = input.reportPairId;
        return sendJson(response, 200, {
          reportPairId: input.reportPairId,
          coverage: exactCoverage(pair.generated),
          catalog: {
            analysisSessionId: sessionId,
            reportPairId: input.reportPairId,
            reportCoverageTotals: reportCoverageTotals(pair.generated),
            methods: [methodSummary(pair.targetClass, pair.generated)],
            warnings: []
          }
        });
      }

      return sendJson(response, 404, { error: 'unknown analyzer route' });
    } catch (error) {
      backendErrors.push({ service: 'analyzer', message: publicErrorMessage(error) });
      return sendJson(response, 500, { error: publicErrorMessage(error) });
    }
  });

  const globalModules = [];
  const globalClasses = [];
  const globalMethods = new Map();
  const cancelledGlobalImports = new Set();
  const globalImportWaiters = new Map();
  const agentServer = createServer(async (request, response) => {
    try {
      requireFixtureAuthorization(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/api/rag/global/knowledge' && request.method === 'POST') {
        const input = await readJsonRequest(request);
        if (input.action === 'cancel-import') {
          if (typeof input.operationId === 'string' && input.operationId) {
            cancelledGlobalImports.add(input.operationId);
            globalImportWaiters.get(input.operationId)?.();
          }
          return sendJson(response,200,{cancelled:true});
        }
        if (input.action === 'modules') return sendJson(response,200,{items:globalModules});
        if (input.action === 'add-poms') {
          const module={moduleId:'module-1',groupId:'com.example',artifactId:'demo',version:'1',coordinate:'com.example:demo:1'};
          if(!globalModules.length)globalModules.push(module);
          return sendJson(response,200,{items:input.files.map(file=>({name:file.name,module}))});
        }
        if (input.action === 'import') {
          const operationId=typeof input.operationId==='string'?input.operationId:'';
          if(options.ragKnowledgeImportDelayMs && !cancelledGlobalImports.has(operationId)) {
            await new Promise(resolve=>{
              const finish=()=>{
                clearTimeout(timer);
                if(operationId)globalImportWaiters.delete(operationId);
                resolve();
              };
              const timer=setTimeout(finish,Math.max(0,Number(options.ragKnowledgeImportDelayMs)));
              if(operationId)globalImportWaiters.set(operationId,finish);
            });
          }
          if(operationId && cancelledGlobalImports.delete(operationId))return sendJson(response,200,{items:[]});
          const items=input.files.map((file,index)=>{
            const name=file.name.replace(/\.(java|class)$/,'');const entryId='entry-'+name;
            if(!globalClasses.some(item=>item.entryId===entryId))globalClasses.push({entryId,simpleName:name,classFqn:'com.example.'+name,versionPath:'com.example:demo:1',binaryLocation:null,moduleNames:[],updatedAt:new Date().toISOString()});
            globalMethods.set(entryId,Array.from({length:60},(_,n)=>({methodId:entryId+'-'+n,methodKey:'com.example.'+name+'#run'+n+'()',ownerFqn:'com.example.'+name,methodName:'run'+n,canonicalSignature:'run'+n+'()',declarationSignature:'public static void run'+n+'() throws java.io.IOException',sourceKind:'DEPENDENCY_SOURCE',chunkCount:1})));
            return {entryId,classFqn:'com.example.'+name,methodCount:60};
          });return sendJson(response,200,{items});
        }
        if (input.action === 'entries' || input.action === 'methods') {
          const all=input.action==='entries'?globalClasses:(globalMethods.get(input.entryId)||[]);
          const filtered=all.filter(item=>JSON.stringify(item).toLowerCase().includes((input.query||'').toLowerCase()));
          const offset=Number(input.cursor||0);
          return sendJson(response,200,{workspaceId:'global',configurationId:'global',indexGeneration:1,items:filtered.slice(offset,offset+50),nextCursor:filtered.length>offset+50?String(offset+50):null});
        }
        if (input.action === 'delete') {
          if(input.methodIds)globalMethods.set(input.entryId,(globalMethods.get(input.entryId)||[]).filter(item=>!input.methodIds.includes(item.methodId)));
          for(const id of input.entryIds||[]) {const index=globalClasses.findIndex(item=>item.entryId===id);if(index>=0)globalClasses.splice(index,1);globalMethods.delete(id);}
          return sendJson(response,200,{deleted:(input.methodIds||input.entryIds||[]).length});
        }
        if(input.action==='source') {
          const method=globalMethods.get(input.entryId).find(item=>item.methodId===input.methodId);
          if (options.ragKnowledgeMethodSourceDelayMs) await delay(Math.max(0, Number(options.ragKnowledgeMethodSourceDelayMs)));
          return sendJson(response,200,{entryId:input.entryId,indexGeneration:1,method,sourceText:`package com.example;\npublic class ${method.ownerFqn.split('.').pop()} {\n private void ${method.methodName}() {}\n}`});
        }
      }
      const ragTaskRunReleaseMatch = /^\/api\/rag\/task-runs\/([^/]+)\/release$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && ragTaskRunReleaseMatch) {
        await readJsonRequest(request);
        activeRagTaskRunIds.delete(decodeURIComponent(ragTaskRunReleaseMatch[1]));
        response.writeHead(204);
        return response.end();
      }

      if (url.pathname.startsWith('/v1/')) {
        realModelCalls += 1;
        return sendJson(response, 500, { error: 'real model access is forbidden in E2E' });
      }

      if (
        request.method === 'POST'
        && url.pathname === '/api/model-capabilities/tool-calling/probe'
      ) {
        const input = await readJsonRequest(request);
        toolCallingProbes.push({
          model: input.llmConfig?.model ?? null,
          captureModelCalls: input.captureModelCalls === true
        });
        await recordFixtureEvent(options.eventLogPath, 'tool-probe');
        const trace = input.captureModelCalls === true
          ? {
              request: {
                systemPrompt: 'fixture tool capability probe',
                userPrompt: 'return the fixture nonce through the tool',
                toolName: 'rag_tool_probe',
                toolChoice: 'auto'
              },
              toolExchange: {
                toolCallId: 'fixture-probe-call',
                toolName: 'rag_tool_probe',
                arguments: { token: 'fixture-nonce' },
                toolMessage: {
                  toolCallId: 'fixture-probe-call',
                  content: 'fixture-nonce'
                }
              },
              finalConfirmation: {
                content: 'fixture-nonce',
                matchesNonce: true
              },
              outcome: 'supported'
            }
          : null;
        return sendJson(response, 200, options.toolCallingProbeResult ?? {
          supported: true,
          cacheHit: false,
          cacheKeyDigest: 'd'.repeat(64),
          trace
        });
      }

      if (
        request.method === 'POST'
        && url.pathname === '/api/unit-tests/method-generation-waves/start/stream'
      ) {
        const input = await readJsonRequest(request);
        const waveSessionId = randomUUID();
        const requestMetric = {
          waveSessionId,
          waveId: input.waveId,
          methodId: input.methodId,
          waveIndex: input.waveIndex,
          parts: input.parts.map((part) => ({
            partIndex: part.partIndex,
            scenarioIds: [...part.scenarioIds]
          }))
        };
        waveRequests.push(requestMetric);
        for (const part of input.parts) {
          const childRequest = part.request;
          agentRequests.push({
            classTaskId: childRequest.classTaskId,
            methodId: childRequest.methodId,
            batchId: childRequest.batchId,
            batchIndex: childRequest.batchIndex,
            batchHasWork: childRequest.batch?.hasWork === true,
            plannedTestMethods: childRequest.batch?.plannedTestMethods ?? 0,
            ragEnabled: childRequest.ragContext?.enabled === true,
            ragBuildFingerprintPrefix:
              childRequest.ragContext?.scope?.buildFingerprint?.slice(0, 12) ?? null,
            hasToolEvidence: [
              'repairContext',
              'ragRepairAttempt',
              'ragEvidence',
              'ragSourceEvidence',
              'toolExchanges'
            ].some((key) => Object.hasOwn(childRequest, key)),
            waveId: input.waveId,
            waveIndex: input.waveIndex,
            partIndex: part.partIndex,
            scenarioIds: [...part.scenarioIds]
          });
          await recordFixtureEvent(options.eventLogPath, 'initial-generation');
        }
        const generation = {
          request: structuredClone(input),
          phase: 'running',
          lastEventSequence: 0,
          terminalParts: [],
          completion: null,
          events: []
        };
        waveGenerationBySession.set(waveSessionId, generation);
        const concurrentParts = input.parts.length;
        activeModelCalls += concurrentParts;
        maxConcurrentModelCalls = Math.max(maxConcurrentModelCalls, activeModelCalls);
        try {
          await delay(modelDelayMs);
          if (response.destroyed || request.aborted) return;
          const terminalParts = input.parts.map((part, index) => {
            const configuredOutcome = Array.isArray(options.wavePartOutcomes)
              ? options.wavePartOutcomes[index]
              : undefined;
            if (configuredOutcome === 'failed') {
              return {
                partIndex: part.partIndex,
                partBatchId: part.partBatchId,
                scenarioIds: [...part.scenarioIds],
                status: 'failed',
                childSessionId: null,
                candidate: null,
                error: {
                  code: 'MODEL_FAILED',
                  message: `fixture Part ${part.partIndex} failed`,
                  stage: 'generation'
                }
              };
            }
            const childSessionId = randomUUID();
            const code = generatedTestCode(
              part.request.expectedPackageName,
              part.request.outputTestClassName,
              {
                partIndex: part.partIndex,
                testCount: part.request.batch.plannedTestMethods
              }
            );
            const candidate = {
              candidateId: randomUUID(),
              candidateVersion: 1,
              repairAttempt: 0,
              methodId: input.methodId,
              batchId: part.partBatchId,
              batchIndex: input.waveIndex,
              testCode: code,
              generatedCodeSha256: sha256(code),
              outputTestClassName: part.request.outputTestClassName,
              ordinaryTestMethodCount: part.request.batch.plannedTestMethods,
              usage: null
            };
            generationBySession.set(childSessionId, {
              methodId: input.methodId,
              batchId: part.partBatchId,
              candidate,
              lastEventSequence: 1
            });
            return {
              partIndex: part.partIndex,
              partBatchId: part.partBatchId,
              scenarioIds: [...part.scenarioIds],
              status: 'succeeded',
              childSessionId,
              candidate,
              error: null
            };
          });
          wavePartResults.push(...terminalParts.map((part) => ({
            waveSessionId,
            waveIndex: input.waveIndex,
            partIndex: part.partIndex,
            scenarioIds: [...part.scenarioIds],
            status: part.status
          })));
          const events = [waveEvent(waveSessionId, input, 1, 'wave_started')];
          for (const terminal of [...terminalParts].reverse()) {
            events.push(waveEvent(
              waveSessionId,
              input,
              events.length + 1,
              terminal.status === 'succeeded' ? 'part_succeeded' : terminal.status === 'cancelled' ? 'part_cancelled' : 'part_failed',
              {
                partIndex: terminal.partIndex,
                partBatchId: terminal.partBatchId,
                scenarioIds: [...terminal.scenarioIds],
                childSessionId: terminal.childSessionId,
                candidateId: terminal.candidate?.candidateId ?? null,
                partResult: terminal
              }
            ));
          }
          const completion = waveCompletion(terminalParts);
          events.push(waveEvent(
            waveSessionId,
            input,
            events.length + 1,
            'wave_completed',
            { completion }
          ));
          generation.phase = 'completed';
          generation.lastEventSequence = events.at(-1).eventSequence;
          generation.terminalParts = terminalParts;
          generation.completion = completion;
          generation.events = events;
          const identity = validateStartMethodGenerationWaveRequest(input);
          let previousEventSequence = 0;
          for (const event of events) {
            try {
              decodeMethodGenerationWaveEvent(event, {
                previousEventSequence,
                identity
              });
            } catch (error) {
              throw new Error(
                `Fake Wave event ${event.eventSequence} violates the production contract: `
                  + `${error instanceof Error ? error.message : String(error)}`
              );
            }
            previousEventSequence = event.eventSequence;
          }
          return sendWaveSse(response, events);
        } finally {
          activeModelCalls -= concurrentParts;
        }
      }

      let waveMatch = /^\/api\/unit-tests\/method-generation-waves\/([^/]+)\/ack$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && waveMatch) {
        const waveSessionId = decodeURIComponent(waveMatch[1]);
        const input = await readJsonRequest(request);
        const generation = waveGenerationBySession.get(waveSessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown Wave session' });
        return sendJson(response, 200, {
          waveSessionId,
          acknowledgedThroughEventSequence: input.throughEventSequence,
          lastEventSequence: generation.lastEventSequence
        });
      }

      waveMatch = /^\/api\/unit-tests\/method-generation-waves\/([^/]+)$/.exec(
        url.pathname
      );
      if (request.method === 'GET' && waveMatch) {
        const waveSessionId = decodeURIComponent(waveMatch[1]);
        const generation = waveGenerationBySession.get(waveSessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown Wave session' });
        return sendJson(response, 200, waveStatus(
          waveSessionId,
          generation,
          Number(url.searchParams.get('afterEventSequence') ?? 0)
        ));
      }
      if (request.method === 'DELETE' && waveMatch) {
        const waveSessionId = decodeURIComponent(waveMatch[1]);
        const generation = waveGenerationBySession.get(waveSessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown Wave session' });
        const cancelledParts = generation.request.parts.map((part) => ({
          partIndex: part.partIndex,
          partBatchId: part.partBatchId,
          scenarioIds: [...part.scenarioIds],
          status: 'cancelled',
          childSessionId: null,
          candidate: null,
          error: null
        }));
        generation.phase = 'cancelled';
        generation.terminalParts = cancelledParts;
        generation.completion = waveCompletion(cancelledParts);
        return sendJson(response, 200, waveStatus(waveSessionId, generation));
      }

      if (
        request.method === 'POST'
        && url.pathname === '/api/unit-tests/method-generation-sessions/recover/stream'
      ) {
        const input = await readJsonRequest(request);
        const startRequest = input.startRequest;
        const candidate = input.candidate;
        if (
          !startRequest
          || !candidate
          || input.recoveryRequestId !== candidate.candidateId
          || candidate.methodId !== startRequest.methodId
          || candidate.batchId !== startRequest.batchId
          || candidate.batchIndex !== startRequest.batchIndex
          || candidate.outputTestClassName !== startRequest.outputTestClassName
        ) {
          return sendJson(response, 400, { error: 'invalid recovered generation candidate' });
        }
        const sessionId = randomUUID();
        generationBySession.set(sessionId, {
          methodId: startRequest.methodId,
          batchId: startRequest.batchId,
          candidate: structuredClone(candidate),
          lastEventSequence: 1
        });
        return sendSse(response, {
          sessionId,
          eventSequence: 1,
          eventType: 'candidate_ready',
          occurredAt: new Date().toISOString(),
          progress: null,
          candidate,
          completion: null,
          modelCall: null,
          error: null
        });
      }

      if (
        request.method === 'POST'
        && url.pathname === '/api/unit-tests/method-generation-sessions/start/stream'
      ) {
        const input = await readJsonRequest(request);
        if (typeof input.ragContext?.taskRunId === 'string') {
          activeRagTaskRunIds.add(input.ragContext.taskRunId);
        }
        agentRequests.push({
          classTaskId: input.classTaskId,
          methodId: input.methodId,
          batchId: input.batchId,
          batchIndex: input.batchIndex,
          batchHasWork: input.batch?.hasWork === true,
          plannedTestMethods: input.batch?.plannedTestMethods ?? 0,
          ragEnabled: input.ragContext?.enabled === true,
          ragBuildFingerprintPrefix: input.ragContext?.scope?.buildFingerprint?.slice(0, 12) ?? null,
          hasToolEvidence: [
            'repairContext',
            'ragRepairAttempt',
            'ragEvidence',
            'ragSourceEvidence',
            'toolExchanges'
          ].some((key) => Object.hasOwn(input, key))
        });
        await recordFixtureEvent(options.eventLogPath, 'initial-generation');
        activeModelCalls += 1;
        maxConcurrentModelCalls = Math.max(maxConcurrentModelCalls, activeModelCalls);
        try {
          await delay(modelDelayMs);
          if (response.destroyed || request.aborted) return;
          const sessionId = randomUUID();
          const code = generatedTestCode(input.expectedPackageName, input.outputTestClassName);
          const candidate = {
            candidateId: randomUUID(),
            candidateVersion: 1,
            repairAttempt: 0,
            methodId: input.methodId,
            batchId: input.batchId,
            batchIndex: input.batchIndex,
            testCode: code,
            generatedCodeSha256: sha256(code),
            outputTestClassName: input.outputTestClassName,
            ordinaryTestMethodCount: input.batch.plannedTestMethods,
            usage: null
          };
          generationBySession.set(sessionId, {
            methodId: input.methodId,
            batchId: input.batchId,
            candidate,
            lastEventSequence: 1
          });
          return sendSse(response, {
            sessionId,
            eventSequence: 1,
            eventType: 'candidate_ready',
            occurredAt: new Date().toISOString(),
            progress: null,
            candidate,
            completion: null,
            modelCall: null,
            error: null
          });
        } finally {
          activeModelCalls -= 1;
        }
      }

      const ragPrepareMatch = /^\/api\/unit-tests\/method-generation-sessions\/([^/]+)\/rag-repair\/prepare$/.exec(
        url.pathname
      );
      if (request.method === 'POST' && ragPrepareMatch) {
        const sessionId = decodeURIComponent(ragPrepareMatch[1]);
        const input = await readJsonRequest(request);
        const generation = generationBySession.get(sessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown generation session' });
        ragPrepareRequests.push({
          sessionId,
          candidateVersion: input.candidateVersion,
          repairAttempt: input.repairAttempt,
          methodId: input.methodId,
          batchId: input.batchId,
          batchIndex: input.batchIndex,
          executionStatus: input.execution?.status ?? null
        });
        await recordFixtureEvent(options.eventLogPath, 'rag-prepare');
        return sendJson(response, 200, {
          status: 'attributable',
          diagnosticFingerprint: sha256(
            `fixture-diagnostic:${sessionId}:${input.candidateVersion}`
          ),
          requestedFqns: ['com.example.DiagnosticDependency'],
          originalDiagnosticText: '[ERROR] simulated compile failure',
          targetMethodKey: 'com.example.AlphaService#value(I)I',
          degradationCode: null
        });
      }

      let match = /^\/api\/unit-tests\/method-generation-sessions\/([^/]+)\/resume\/stream$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const input = await readJsonRequest(request);
        const generation = generationBySession.get(sessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown generation session' });
        const sequence = input.expectedEventSequence + 1;
        if (options.repairFailedCandidate && input.execution?.status !== 'passed') {
          ragResumeRequests.push({
            sessionId,
            repairAttempt: input.repairAttempt,
            ragEnabled: input.ragRepairAttempt !== undefined,
            diagnosticFingerprintPrefix:
              input.ragRepairAttempt?.diagnosticFingerprint?.slice(0, 12) ?? null,
            sourceSetIdPrefix:
              input.ragRepairAttempt?.activeIndex?.sourceSetId?.slice(0, 12) ?? null,
            hasRepairContext: input.repairContext !== undefined
          });
          await recordFixtureEvent(
            options.eventLogPath,
            input.ragRepairAttempt === undefined ? 'no-rag-resume' : 'rag-resume'
          );
          const previous = generation.candidate;
          const repairedCode = `${previous.testCode.trimEnd()}\n// fixture repair ${input.repairAttempt + 1}\n`;
          const candidate = {
            ...previous,
            candidateId: randomUUID(),
            candidateVersion: input.candidateVersion + 1,
            repairAttempt: input.repairAttempt + 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          };
          generation.candidate = candidate;
          generation.lastEventSequence = sequence;
          return sendSse(response, {
            sessionId,
            eventSequence: sequence,
            eventType: 'candidate_ready',
            occurredAt: new Date().toISOString(),
            progress: null,
            candidate,
            completion: null,
            modelCall: null,
            error: null
          });
        }
        const completion = {
          methodId: generation.methodId,
          batchId: generation.batchId,
          stopReason: 'verified',
          bestCandidateId: input.candidateId,
          aggregateUsage: null,
          modelCallCount: 1,
          usageReportedCallCount: 0
        };
        generation.lastEventSequence = sequence;
        generation.completion = completion;
        return sendSse(response, {
          sessionId,
          eventSequence: sequence,
          eventType: 'completed',
          occurredAt: new Date().toISOString(),
          progress: null,
          candidate: null,
          completion,
          modelCall: null,
          error: null
        });
      }

      match = /^\/api\/unit-tests\/method-generation-sessions\/([^/]+)\/ack$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const input = await readJsonRequest(request);
        const generation = generationBySession.get(sessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown generation session' });
        return sendJson(response, 200, {
          sessionId,
          acknowledgedThroughEventSequence: input.throughEventSequence,
          lastEventSequence: generation.lastEventSequence
        });
      }

      match = /^\/api\/unit-tests\/method-generation-sessions\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const generation = generationBySession.get(sessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown generation session' });
        return sendJson(response, 200, generationStatus(sessionId, generation, url));
      }
      if (request.method === 'DELETE' && match) {
        const sessionId = decodeURIComponent(match[1]);
        const generation = generationBySession.get(sessionId);
        if (!generation) return sendJson(response, 404, { error: 'unknown generation session' });
        const completion = {
          methodId: generation.methodId,
          batchId: generation.batchId,
          stopReason: 'stopped',
          bestCandidateId: generation.candidate?.candidateId ?? null,
          aggregateUsage: null,
          modelCallCount: 1,
          usageReportedCallCount: 0
        };
        generation.completion = completion;
        return sendJson(response, 200, {
          sessionId,
          phase: 'cancelled',
          lastEventSequence: generation.lastEventSequence,
          pendingCandidate: null,
          completion,
          terminalError: null,
          events: []
        });
      }

      return sendJson(response, 404, { error: 'unknown agent route' });
    } catch (error) {
      backendErrors.push({ service: 'agent', message: publicErrorMessage(error) });
      return sendJson(response, 500, { error: publicErrorMessage(error) });
    }
  });

  const [javaAnalyzerUrl, agentServiceUrl] = await Promise.all([
    listenLoopback(analyzerServer),
    listenLoopback(agentServer)
  ]);
  let closed = false;
  return {
    javaAnalyzerUrl,
    agentServiceUrl,
    managedAccess: Object.freeze({
      agentServiceUrl,
      agentServiceAuthorizationHeader: E2E_AUTHORIZATION_HEADER,
      javaAnalyzerUrl,
      javaAnalyzerAuthorizationHeader: E2E_AUTHORIZATION_HEADER
    }),
    metrics() {
      return {
        realModelCalls,
        activeModelCalls,
        maxConcurrentModelCalls,
        agentRequests: structuredClone(agentRequests),
        waveRequests: structuredClone(waveRequests),
        wavePartResults: structuredClone(wavePartResults),
        backendErrors: structuredClone(backendErrors),
        toolCallingProbes: structuredClone(toolCallingProbes),
        ragPrepareRequests: structuredClone(ragPrepareRequests),
        ragResumeRequests: structuredClone(ragResumeRequests),
        repairContextRequests: structuredClone(repairContextRequests),
        analysisSessionCreations
      };
    },
    expireAnalysisSessions() {
      analysisBySession.clear();
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([closeServer(analyzerServer), closeServer(agentServer)]);
    }
  };
}

function generationStatus(sessionId, generation, url) {
  const afterEventSequence = Number(url.searchParams.get('afterEventSequence') ?? 0);
  const completion = generation.completion ?? null;
  return {
    sessionId,
    phase: completion ? 'completed' : 'running',
    lastEventSequence: generation.lastEventSequence,
    pendingCandidate: completion ? null : generation.candidate,
    completion,
    terminalError: null,
    events: afterEventSequence < generation.lastEventSequence ? [] : []
  };
}

function requireFixtureAuthorization(request) {
  if (request.headers.authorization !== E2E_AUTHORIZATION_HEADER) {
    const error = new Error('fixture authorization rejected');
    error.statusCode = 401;
    throw error;
  }
}

async function readJsonRequest(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('fixture request is too large');
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString('utf8');
  return source ? JSON.parse(source) : {};
}

function sendJson(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  const source = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(source),
    'Cache-Control': 'no-store'
  });
  response.end(source);
}

function sendSse(response, event) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close'
  });
  response.end(`data: ${JSON.stringify(event)}\n\n`);
}

function sendWaveSse(response, events) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close'
  });
  response.end(events.map((event) => (
    `id: ${event.eventSequence}\n`
      + 'event: method_generation_wave\n'
      + `data: ${JSON.stringify(event)}\n\n`
  )).join(''));
}

function listenLoopback(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPromise(new Error('fake backend did not bind a TCP port'));
        return;
      }
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
    server.closeAllConnections?.();
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function publicErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

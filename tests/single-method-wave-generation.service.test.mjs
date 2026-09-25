import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { MethodWavePartMergerService } from '../src/main/services/method-wave-part-merger.service.ts';
import { MethodWavePartStoreService } from '../src/main/services/method-wave-part-store.service.ts';
import { ClassTaskFileTransactionService } from '../src/main/services/class-task-file-transaction.service.ts';
import { ClassTaskPauseRequestedError } from '../src/main/services/class-task-interruption.ts';
import {
  MethodGenerationRequestError,
  MethodGenerationWaveNotFoundError
} from '../src/main/services/method-generation-contract.ts';
import { SingleMethodGenerationService } from '../src/main/services/single-method-generation.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const METHOD_ID = 'a'.repeat(64);
const SECOND_METHOD_ID = 'd'.repeat(64);
const REPORT_PAIR_ID = 'b'.repeat(64);
const WAVE_ID = 'c'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function scenario(index) {
  return {
    scenarioId: `scenario-${index}`,
    scenarioSignature: `path-${index}`,
    methodId: METHOD_ID,
    targetLines: [10 + index],
    targetBranches: [],
    chineseDescription: `场景 ${index}`,
    inputPreparation: [],
    requiredStubIds: [],
    expectedPath: [],
    loopExitCondition: '',
    loopCoveragePlan: null,
    coverageTargetIds: [`target-${index}`],
    pathConstraints: [],
    status: 'COMPLETE'
  };
}

function wavePart(index) {
  const currentScenario = scenario(index);
  return {
    partIndex: index,
    partBatchId: String(index).repeat(64),
    scenarioIds: [currentScenario.scenarioId],
    method: {
      methodId: METHOD_ID,
      declaringType: 'demo.TaskService',
      methodName: 'run',
      descriptor: '()V',
      firstLine: 10,
      lastLine: 20,
      completeMethodSource: 'public void run() {}',
      modifiers: ['public'],
      parameterTypes: [],
      returnType: 'void',
      declaredExceptions: [],
      invocationPlan: {
        strategy: 'DIRECT',
        receiverExpression: 'target',
        reflectionMethodName: '',
        parameterClassLiterals: [],
        staticMethod: false,
        returnType: 'void',
        declaredExceptions: [],
        chineseInstruction: '直接调用'
      },
      activeScenarioIds: [currentScenario.scenarioId]
    },
    scenarios: [currentScenario],
    methodTestPlan: {
      methodId: METHOD_ID,
      analysisStatus: 'COMPLETE',
      minimumTestCount: 1,
      remainingTargets: [{
        targetId: `target-${index}`,
        methodId: METHOD_ID,
        decisionId: `decision-${index}`,
        instructionIndex: index,
        sourceLine: 10 + index,
        kind: 'LINE',
        direction: 'ENTER',
        covered: false,
        mappingStatus: 'MAPPED',
        requiredEdgeIds: []
      }],
      testPathGroups: [{
        groupId: `group-${index}`,
        methodId: METHOD_ID,
        ordinal: 1,
        scenarioIds: [currentScenario.scenarioId],
        targetIds: [`target-${index}`],
        constraints: [],
        inputRequirements: [],
        mockRequirements: [],
        expectedExit: 'RETURNS',
        singleTargetInvocation: true,
        status: 'COMPLETE'
      }],
      testMethodPlans: [{
        testMethodPlanId: `plan-${index}`,
        methodId: METHOD_ID,
        ordinal: 1,
        pathGroupIds: [`group-${index}`],
        status: 'COMPLETE'
      }],
      fallbackReason: ''
    },
    methodStubInventory: {
      methodId: METHOD_ID,
      status: 'COMPLETE',
      requiredCallCount: 0,
      unresolvedRequiredCallCount: 0,
      calls: []
    },
    activeStubPlans: [],
    targetFixturePlan: {
      targetClass: 'demo.TaskService',
      targetVariableName: 'target',
      targetClassDeclaration: 'private TaskService target;',
      dependencySourceDeclarations: [],
      constructionMode: 'CONSTRUCTOR',
      constructorParameterTypes: [],
      constructorArgumentFixtureIds: [],
      dependencies: [],
      setupStatements: ['target = new TaskService();'],
      status: 'COMPLETE',
      chineseInstruction: '创建测试对象'
    },
    referencedTypes: [],
    necessaryImports: ['org.junit.jupiter.api.Test']
  };
}

function workWave(partCount = 3) {
  const parts = Array.from({ length: partCount }, (_, index) => wavePart(index + 1));
  return {
    waveBatchId: WAVE_ID,
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    hasWork: true,
    selectedScenarioIds: parts.flatMap((part) => part.scenarioIds),
    remainingScenarioCount: 0,
    parts,
    warnings: []
  };
}

function activeWaveCheckpoint(wave) {
  return {
    waveId: wave.waveBatchId,
    waveSessionId: null,
    recoveryRequestId: null,
    eventSequence: 0,
    startRequest: null,
    methodId: wave.methodId,
    waveIndex: 1,
    selectedScenarioIds: [...wave.selectedScenarioIds],
    remainingScenarioCount: wave.remainingScenarioCount,
    wave: structuredClone(wave),
    initialUsageRecorded: false,
    parts: wave.parts.map((part) => ({
      partIndex: part.partIndex,
      partBatchId: part.partBatchId,
      scenarioIds: [...part.scenarioIds],
      status: 'PENDING',
      eventSequence: 0,
      childSessionId: null,
      candidateId: null,
      isolatedFilePath: null,
      fileSha256: null,
      failureReason: null,
      aggregateUsage: null,
      modelCallCount: 0,
      usageReportedCallCount: 0
    }))
  };
}

function testCode(className, methodName = 'generated') {
  return [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    `public class ${className} {`,
    `  @Test void ${methodName}() {}`,
    '}',
    ''
  ].join('\n');
}

function testCodeWithMethods(className, methodNames) {
  return [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    `public class ${className} {`,
    ...methodNames.map((methodName) => `  @Test void ${methodName}() {}`),
    '}',
    ''
  ].join('\n');
}

function candidate(part, code) {
  return {
    candidateId: `22222222-2222-4222-8222-${String(part.partIndex).padStart(12, '0')}`,
    candidateVersion: 1,
    repairAttempt: 0,
    methodId: METHOD_ID,
    batchId: part.partBatchId,
    batchIndex: 1,
    testCode: code,
    generatedCodeSha256: sha256(code),
    outputTestClassName: `TaskServiceTmp1Part${part.partIndex}Test`,
    ordinaryTestMethodCount: 1,
    usage: null
  };
}

function succeeded(part, code) {
  return {
    partIndex: part.partIndex,
    partBatchId: part.partBatchId,
    scenarioIds: [...part.scenarioIds],
    status: 'succeeded',
    childSessionId: `33333333-3333-4333-8333-${String(part.partIndex).padStart(12, '0')}`,
    candidate: candidate(part, code),
    error: null
  };
}

function failed(part) {
  return {
    partIndex: part.partIndex,
    partBatchId: part.partBatchId,
    scenarioIds: [...part.scenarioIds],
    status: 'failed',
    childSessionId: null,
    candidate: null,
    error: { code: 'MODEL_FAILED', message: 'provider failed', stage: 'generation' }
  };
}

function nonModelFailed(part) {
  return {
    ...failed(part),
    error: {
      code: 'METHOD_GENERATION_PART_FAILED',
      message: 'generated Part is invalid',
      stage: 'generation'
    }
  };
}

function failedExecution(testName, message = 'generated test failed') {
  return {
    status: 'test_failed',
    mavenExecutions: [{
      scope: 'method_candidate',
      phase: 'test_compile',
      command: 'mvn test-compile',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }, {
      scope: 'method_candidate',
      phase: 'test',
      command: 'mvn test',
      exitCode: 1,
      stdout: '',
      stderr: message,
      surefireReports: [{ fileName: 'TEST-demo.TaskServiceTmp1Test.xml', content: '<testsuite />' }]
    }],
    testReport: {
      reportCount: 1,
      tests: 1,
      failures: 1,
      errors: 0,
      skipped: 0,
      generatedTestClassName: 'demo.TaskServiceTmp1Test',
      generatedTests: 1,
      generatedSkipped: 0,
      failureDetails: [{
        suiteName: 'TaskServiceTmp1Test',
        testClassName: 'demo.TaskServiceTmp1Test',
        testName,
        kind: 'failure',
        message
      }]
    }
  };
}

function passedExecution(testCount = 1, scope = 'method_candidate') {
  return {
    status: 'passed',
    mavenExecutions: [{
      scope,
      phase: 'test_compile',
      command: 'mvn test-compile',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }, {
      scope,
      phase: 'test',
      command: 'mvn test',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: [{ fileName: 'TEST-demo.TaskServiceTmp1Test.xml', content: '<testsuite />' }]
    }],
    testReport: {
      reportCount: 1,
      tests: testCount,
      failures: 0,
      errors: 0,
      skipped: 0,
      generatedTestClassName: 'demo.TaskServiceTmp1Test',
      generatedTests: testCount,
      generatedSkipped: 0,
      failureDetails: []
    }
  };
}

function compilableEmptyExecution() {
  return {
    status: 'test_failed',
    mavenExecutions: [{
      scope: 'pruned_method_candidate',
      phase: 'test_compile',
      command: 'mvn test-compile',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }, {
      scope: 'pruned_method_candidate',
      phase: 'test',
      command: 'mvn surefire:test',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }]
  };
}

function waveEvent(sequence, wave, eventType, changes = {}) {
  return {
    waveSessionId: '44444444-4444-4444-8444-444444444444',
    eventSequence: sequence,
    waveId: wave.waveBatchId,
    methodId: wave.methodId,
    waveIndex: 1,
    eventType,
    occurredAt: '2026-08-19T00:00:00Z',
    partIndex: null,
    partBatchId: null,
    scenarioIds: [],
    childSessionId: null,
    candidateId: null,
    childEvent: null,
    partResult: null,
    completion: null,
    error: null,
    ...changes
  };
}

function terminalEvent(sequence, wave, result, eventType) {
  return waveEvent(sequence, wave, eventType, {
    partIndex: result.partIndex,
    partBatchId: result.partBatchId,
    scenarioIds: result.scenarioIds,
    childSessionId: result.childSessionId,
    candidateId: result.candidate?.candidateId ?? null,
    partResult: result
  });
}

function childModelEvent(part, sequence) {
  const childSessionId = `33333333-3333-4333-8333-${String(part.partIndex).padStart(12, '0')}`;
  return {
    sessionId: childSessionId,
    eventSequence: sequence,
    eventType: 'model_call',
    occurredAt: '2026-08-19T00:00:00Z',
    progress: null,
    candidate: null,
    completion: null,
    error: null,
    modelCall: {
      sessionId: childSessionId,
      callId: `77777777-7777-4777-8777-${String(part.partIndex).padStart(12, '0')}`,
      parentCallId: null,
      phase: 'started',
      callKind: 'generation',
      methodId: METHOD_ID,
      batchId: part.partBatchId,
      batchIndex: 1,
      repairAttempt: 0,
      candidateVersion: 1,
      modelName: 'fake',
      startedAt: '2026-08-19T00:00:00Z',
      occurredAt: '2026-08-19T00:00:00Z',
      systemPrompt: 'system',
      userPrompt: 'user',
      rawOutput: null,
      processedOutput: null,
      processingValid: null,
      usage: null,
      errorCode: null,
      statusCode: null,
      errorType: null,
      providerCode: null,
      truncated: false
    }
  };
}

async function harness(t, {
  wave,
  runWave,
  mavenExecute,
  agentOverrides = {},
  taskOverrides = {},
  getMethodRepairContext,
  onSaveWaveCandidate,
  beforeContextResolve,
  contextOverrides = {},
  waveProgressMethods = {},
  serviceOverrides = {}
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'single-method-wave-'));
  t.after(async () => rm(workspaceRoot, { recursive: true, force: true }));
  const sourceFilePath = join(
    workspaceRoot,
    'module',
    'src',
    'main',
    'java',
    'demo',
    'TaskService.java'
  );
  const plannedRelativeTestPath = 'module/src/test/java/demo/TaskServiceTest.java';
  const mavenInputs = [];
  const savedWaves = [];
  const savedCandidates = [];
  const acknowledgements = [];
  const waveCancellations = [];
  const cancellations = [];
  const repairAcknowledgements = [];
  const repairCalls = [];
  const ragPrepareRequests = [];
  const modelLogRecords = [];
  const modelUsageIncrements = [];
  const waveSummaryLogs = [];
  const mavenBatchLogs = [];
  const candidateStates = new Map();
  const writer = new TestWriterService();
  let uuid = 500;
  const service = new SingleMethodGenerationService({
    analyzer: {
      async heartbeatMethodAnalysisSession() { return true; },
      async nextMethodBatch() { throw new Error('legacy Analyzer path was not expected'); },
      async nextMethodWave(_sessionId, methodId, request) {
        assert.equal(methodId, METHOD_ID);
        assert.equal(request.reportPairId, REPORT_PAIR_ID);
        return wave;
      },
      async getMethodRepairContext(...args) {
        if (getMethodRepairContext) return getMethodRepairContext(...args);
        throw new Error('repair was not expected');
      }
    },
    agent: {
      async startMethodGenerationStream() { throw new Error('legacy generation was not expected'); },
      async recoverMethodGenerationStream(...args) {
        if (agentOverrides.recoverMethodGenerationStream) {
          return agentOverrides.recoverMethodGenerationStream(...args);
        }
        throw new Error('repair recovery was not expected');
      },
      async prepareRagRepair(...args) {
        ragPrepareRequests.push({
          sessionId: args[0],
          request: structuredClone(args[1])
        });
        if (agentOverrides.prepareRagRepair) {
          return agentOverrides.prepareRagRepair(...args);
        }
        throw new Error('RAG repair was not expected');
      },
      async resumeMethodGenerationStream(...args) {
        repairCalls.push(args[1]);
        if (agentOverrides.resumeMethodGenerationStream) {
          return agentOverrides.resumeMethodGenerationStream(...args);
        }
        throw new Error('repair was not expected');
      },
      async acknowledgeMethodGenerationEvents(sessionId, sequence) {
        repairAcknowledgements.push({ sessionId, sequence });
        return {
          sessionId,
          acknowledgedThroughEventSequence: sequence,
          lastEventSequence: sequence
        };
      },
      async cancelMethodGeneration(sessionId) {
        cancellations.push(sessionId);
        if (agentOverrides.cancelMethodGeneration) {
          return agentOverrides.cancelMethodGeneration(sessionId);
        }
        return { sessionId, phase: 'cancelled' };
      },
      async streamMethodGenerationWave(request, _modelContext, onProgress, signal) {
        return runWave({ request, onProgress, signal });
      },
      async resumeMethodGenerationWaveStream(...args) {
        if (agentOverrides.resumeMethodGenerationWaveStream) {
          return agentOverrides.resumeMethodGenerationWaveStream(...args);
        }
        throw new Error('existing Wave session recovery was not expected');
      },
      async recoverMethodGenerationWaveStream(...args) {
        if (agentOverrides.recoverMethodGenerationWaveStream) {
          return agentOverrides.recoverMethodGenerationWaveStream(...args);
        }
        throw new Error('Wave recovery was not expected');
      },
      async acknowledgeMethodGenerationWaveEvents(sessionId, sequence) {
        acknowledgements.push({ sessionId, sequence });
        return {
          waveSessionId: sessionId,
          acknowledgedThroughEventSequence: sequence,
          lastEventSequence: sequence
        };
      },
      async cancelMethodGenerationWave(sessionId) {
        waveCancellations.push(sessionId);
        if (agentOverrides.cancelMethodGenerationWave) {
          return agentOverrides.cancelMethodGenerationWave(sessionId);
        }
        return { waveSessionId: sessionId, phase: 'cancelled' };
      }
    },
    contextProvider: {
      async resolve() {
        if (beforeContextResolve) await beforeContextResolve();
        return {
          analysisSessionId: '55555555-5555-4555-8555-555555555555',
          reportPairId: REPORT_PAIR_ID,
          sourceSha256: 'd'.repeat(64),
          packageName: 'demo',
          plannedRelativeTestPath,
          moduleRoot: join(workspaceRoot, 'module'),
          buildSettings: {
            mavenHome: 'D:/maven',
            javaHome: 'D:/jdk',
            settingsPath: 'D:/maven/conf/settings.xml',
            localRepository: 'D:/m2'
          },
          buildToolchain: { javaVersion: '21', mavenVersion: '3.9.9' },
          modelContext: {
            llmConfig: {
              provider: 'custom_openai',
              model: 'fake',
              baseUrl: 'https://models.example.com/v1',
              credentials: { apiKey: 'fake' }
            }
          },
          captureModelCalls: true,
          mavenEnvironmentFingerprint: 'e'.repeat(64),
          excludedEnvironmentVariables: [],
          ...contextOverrides
        };
      }
    },
    checkpoints: {
      async beginAtomicStep() {},
      async completeAtomicStep() {},
      async saveInProgressBatch() {},
      async clearInProgressBatch() {},
      async commitBatch() {},
      async addModelUsage(_taskId, increment) {
        modelUsageIncrements.push(structuredClone(increment));
      },
      async saveActiveMethodWave(_taskId, value) {
        savedWaves.push(structuredClone(value));
        return structuredClone(value);
      },
      async saveWaveCandidate(_taskId, value) {
        candidateStates.set(value.candidateId, structuredClone(value));
        savedCandidates.push(structuredClone(value));
        if (onSaveWaveCandidate) await onSaveWaveCandidate(value);
        return structuredClone(value);
      },
      async taskWaveProgress() {
        return {
          methodQueue: [],
          activeMethodId: wave.methodId,
          methods: structuredClone(waveProgressMethods),
          activeWave: savedWaves.length > 0
            ? structuredClone(savedWaves.at(-1))
            : null,
          candidates: Object.fromEntries(
            [...candidateStates].map(([candidateId, value]) => (
              [candidateId, structuredClone(value)]
            ))
          ),
          migrationInterrupted: false
        };
      },
      async beginWaveCandidateModelRepair(_taskId, candidateId) {
        const current = candidateStates.get(candidateId);
        assert.ok(current, 'candidate must be checkpointed before model repair');
        assert.equal(current.status, 'MODEL_REPAIR');
        if (!current.unlimitedRepair
          && current.llmRepairAttemptsUsed >= current.repairAttemptLimit) {
          throw new Error('Wave candidate model repair limit is exhausted.');
        }
        const updated = {
          ...current,
          llmRepairAttemptsUsed: current.llmRepairAttemptsUsed + 1
        };
        candidateStates.set(candidateId, structuredClone(updated));
        savedCandidates.push(structuredClone(updated));
        return structuredClone(updated);
      },
      async rollbackWaveCandidateModelRepair(_taskId, candidateId) {
        const current = candidateStates.get(candidateId);
        assert.ok(current, 'candidate must be checkpointed before rollback');
        assert.equal(current.status, 'MODEL_REPAIR');
        const updated = {
          ...current,
          llmRepairAttemptsUsed: Math.max(0, current.llmRepairAttemptsUsed - 1)
        };
        candidateStates.set(candidateId, structuredClone(updated));
        savedCandidates.push(structuredClone(updated));
        return structuredClone(updated);
      }
    },
    moduleLock: { async runExclusive(_key, operation) { return operation(); } },
    candidateFiles: new ClassTaskFileTransactionService({ writer }),
    writer,
    maven: {
      async execute(input) {
        mavenInputs.push(input);
        if (mavenExecute) {
          return mavenExecute(input, {
            callIndex: mavenInputs.length,
            workspaceRoot
          });
        }
        const testClassName = input.qualifiedTestClassName.split('.').at(-1);
        const code = await readFile(join(
          workspaceRoot,
          'module',
          'src',
          'test',
          'java',
          'demo',
          `${testClassName}.java`
        ), 'utf8');
        const testCount = (code.match(/@Test\b/g) ?? []).length;
        return {
          status: 'passed',
          mavenExecutions: [{
            scope: input.scope,
            phase: 'test_compile',
            command: 'mvn test-compile',
            exitCode: 0,
            stdout: '',
            stderr: '',
            surefireReports: []
          }, {
            scope: input.scope,
            phase: 'test',
            command: 'mvn test',
            exitCode: 0,
            stdout: '',
            stderr: '',
            surefireReports: [{ fileName: 'TEST-demo.TaskServiceTmp1Test.xml', content: '<testsuite />' }]
          }],
          testReport: {
            reportCount: 1,
            tests: testCount,
            failures: 0,
            errors: 0,
            skipped: 0,
            generatedTestClassName: 'demo.TaskServiceTmp1Test',
            generatedTests: testCount,
            generatedSkipped: 0,
            failureDetails: []
          }
        };
      }
    },
    pruner: { prune() { throw new Error('pruner was not expected'); } },
    merger: { merge() { throw new Error('legacy merger was not expected'); } },
    logs: {
      async record(value) { modelLogRecords.push(structuredClone(value)); },
      async recordRepairTelemetry() {},
      async recordWaveSummary(value) { waveSummaryLogs.push(structuredClone(value)); },
      async recordMavenBatch(value) { mavenBatchLogs.push(structuredClone(value)); }
    },
    partStore: new MethodWavePartStoreService(),
    partMerger: new MethodWavePartMergerService(),
    randomUUID: () => `66666666-6666-4666-8666-${String(uuid++).padStart(12, '0')}`,
    ...serviceOverrides
  });
  const task = {
    id: TASK_ID,
    workspaceRoot,
    moduleKey: 'module-key',
    moduleDisplayPath: join(workspaceRoot, 'module'),
    sourceFilePath,
    qualifiedClassName: 'demo.TaskService',
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    ...taskOverrides
  };
  return {
    service,
    task,
    mavenInputs,
    savedWaves,
    savedCandidates,
    acknowledgements,
    waveCancellations,
    repairAcknowledgements,
    repairCalls,
    ragPrepareRequests,
    modelLogRecords,
    modelUsageIncrements,
    waveSummaryLogs,
    mavenBatchLogs,
    cancellations,
    candidateStates,
    workspaceRoot
  };
}

test('forwards out-of-order child model calls with explicit Part identity and records one Wave summary', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'first')
  );
  const second = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'second')
  );
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0,
    aggregateUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    modelCallCount: 2,
    usageReportedCallCount: 2
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(waveEvent(2, wave, 'part_event', {
        partIndex: 2,
        partBatchId: wave.parts[1].partBatchId,
        scenarioIds: [...wave.parts[1].scenarioIds],
        childSessionId: second.childSessionId,
        childEvent: childModelEvent(wave.parts[1], 1)
      }));
      await onProgress(waveEvent(3, wave, 'part_event', {
        partIndex: 1,
        partBatchId: wave.parts[0].partBatchId,
        scenarioIds: [...wave.parts[0].scenarioIds],
        childSessionId: first.childSessionId,
        childEvent: childModelEvent(wave.parts[0], 1)
      }));
      await onProgress(terminalEvent(4, wave, second, 'part_succeeded'));
      await onProgress(terminalEvent(5, wave, first, 'part_succeeded'));
      await onProgress(waveEvent(6, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 6,
        completion
      };
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.deepEqual(h.modelLogRecords.map((record) => ({
    waveIndex: record.waveIndex,
    partIndex: record.partIndex,
    partBatchId: record.partBatchId,
    scenarioIds: record.scenarioIds
  })), [{
    waveIndex: 1,
    partIndex: 2,
    partBatchId: wave.parts[1].partBatchId,
    scenarioIds: wave.parts[1].scenarioIds
  }, {
    waveIndex: 1,
    partIndex: 1,
    partBatchId: wave.parts[0].partBatchId,
    scenarioIds: wave.parts[0].scenarioIds
  }]);
  assert.equal(h.waveSummaryLogs.length, 1);
  assert.deepEqual(h.modelUsageIncrements, [{
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    modelCallCount: 2,
    usageReportedCallCount: 2
  }]);
  assert.equal(h.savedWaves.at(-1).initialUsageRecorded, true);
  assert.equal(h.waveSummaryLogs[0].waveId, wave.waveBatchId);
  assert.deepEqual(
    h.waveSummaryLogs[0].parts.map((part) => [part.partIndex, part.status]),
    [[1, 'succeeded'], [2, 'succeeded']]
  );
  assert.deepEqual(h.waveSummaryLogs[0].skippedScenarioIds, []);
  assert.equal(h.waveSummaryLogs[0].mergedCandidateId, outcome.candidateIds[0]);
});

test('allows one logical-scenario Part to carry more than five internal path plans', async (t) => {
  const wave = workWave(1);
  const part = wave.parts[0];
  for (let ordinal = 2; ordinal <= 6; ordinal += 1) {
    part.methodTestPlan.testPathGroups.push({
      ...structuredClone(part.methodTestPlan.testPathGroups[0]),
      groupId: `group-1-${ordinal}`,
      ordinal
    });
    part.methodTestPlan.testMethodPlans.push({
      testMethodPlanId: `plan-1-${ordinal}`,
      methodId: METHOD_ID,
      ordinal,
      pathGroupIds: [`group-1-${ordinal}`],
      status: 'COMPLETE'
    });
  }
  part.methodTestPlan.minimumTestCount = 6;
  let requestReachedAgent = false;
  const h = await harness(t, {
    wave,
    async runWave({ request }) {
      requestReachedAgent = true;
      assert.equal(request.parts[0].scenarioIds.length, 1);
      assert.equal(request.parts[0].request.batch.plannedTestMethods, 6);
      assert.equal(
        request.parts[0].request.batch.methodTestPlan.testMethodPlans.length,
        6
      );
      throw new Error('stop after Wave request');
    }
  });

  await assert.rejects(
    h.service.executeWave(
      h.task,
      wave,
      { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
      activeWaveCheckpoint(wave),
      new AbortController().signal
    ),
    /stop after Wave request/
  );
  assert.equal(requestReachedAgent, true);
});

test('does not count a recovered Wave completion after its usage checkpoint is durable', async (t) => {
  const wave = workWave(1);
  const part = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'only')
  );
  const completion = {
    parts: [part],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0,
    aggregateUsage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    modelCallCount: 1,
    usageReportedCallCount: 1
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, part, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    }
  });
  const checkpoint = activeWaveCheckpoint(wave);
  checkpoint.initialUsageRecorded = true;

  await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    checkpoint,
    new AbortController().signal
  );

  assert.deepEqual(h.modelUsageIncrements, []);
  assert.equal(h.savedWaves.at(-1).initialUsageRecorded, true);
});

test('waits for every Part terminal result and leaves Wave-owned child sessions to the Agent', async (t) => {
  const wave = workWave(3);
  const releaseTerminal = deferred();
  const partialReached = deferred();
  const valid = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'alpha')
  );
  const failedPart = nonModelFailed(wave.parts[1]);
  const structurallyInvalid = succeeded(
    wave.parts[2],
    'package demo; public class TaskServiceTmp1Part3Test {'
  );
  const completion = {
    parts: [valid, failedPart, structurallyInvalid],
    succeededPartCount: 2,
    failedPartCount: 1,
    cancelledPartCount: 0
  };
  let h;
  h = await harness(t, {
    wave,
    async runWave({ request, onProgress }) {
      assert.deepEqual(request.parts.map((part) => part.partIndex), [1, 2, 3]);
      assert.deepEqual(
        request.parts.map((part) => part.request.outputTestClassName),
        [
          'TaskServiceTmp1Part1Test',
          'TaskServiceTmp1Part2Test',
          'TaskServiceTmp1Part3Test'
        ]
      );
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, valid, 'part_succeeded'));
      partialReached.resolve();
      await releaseTerminal.promise;
      await onProgress(terminalEvent(3, wave, failedPart, 'part_failed'));
      await onProgress(terminalEvent(4, wave, structurallyInvalid, 'part_succeeded'));
      await onProgress(waveEvent(5, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 5,
        completion
      };
    },
    async mavenExecute() {
      const storedPartPaths = h.savedWaves.at(-1).parts.flatMap((part) => (
        part.isolatedFilePath ? [part.isolatedFilePath, `${part.isolatedFilePath}.meta.json`] : []
      ));
      assert.ok(storedPartPaths.length > 0, 'the Wave must persist at least one Part first');
      for (const filePath of storedPartPaths) {
        await assert.rejects(access(filePath), (error) => error?.code === 'ENOENT');
      }
      return passedExecution(1);
    }
  });

  const pending = h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );
  await partialReached.promise;
  assert.equal(h.mavenInputs.length, 0);
  releaseTerminal.resolve();

  const outcome = await pending;

  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
  assert.deepEqual(outcome.skippedScenarioIds, ['scenario-2', 'scenario-3']);
  assert.equal(outcome.candidateIds.length, 1);
  assert.equal(outcome.bundle.sourceMethodId, wave.methodId);
  assert.equal(outcome.bundle.waveIndex, 1);
  assert.equal(outcome.bundle.hasRemainingScenarios, false);
  assert.deepEqual(outcome.bundle.sourceBatchIds, outcome.candidateIds);
  assert.equal(outcome.bundle.ordinaryTestMethodCount, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).managedFile.location, 'PROJECT');
  assert.deepEqual(h.acknowledgements, [{
    sessionId: '44444444-4444-4444-8444-444444444444',
    sequence: 5
  }]);
  assert.deepEqual(h.cancellations, []);
  await access(h.savedCandidates.at(-1).managedFile.path);
});

test('checkpoints the original Wave request and a successful Part before a later Part crashes', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'durable')
  );
  let originalRequest;
  const h = await harness(t, {
    wave,
    async runWave({ request, onProgress }) {
      originalRequest = structuredClone(request);
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      throw new Error('simulated process crash');
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated process crash/);

  const durable = h.savedWaves.at(-1);
  assert.deepEqual(durable.startRequest, originalRequest);
  assert.equal(durable.eventSequence, 2);
  assert.equal(durable.parts[0].status, 'SUCCEEDED');
  assert.equal(durable.parts[0].childSessionId, first.childSessionId);
  assert.equal(await readFile(durable.parts[0].isolatedFilePath, 'utf8'), first.candidate.testCode);
  assert.equal(durable.parts[1].status, 'PENDING');
});

test('pause preserves successful Parts, detaches the old Wave, and resumes only unfinished Parts', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'durable')
  );
  const second = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'resumed')
  );
  const secondStarted = deferred();
  let initialCalls = 0;
  let recoveryRequest;
  const recoveredSessionId = '99999999-9999-4999-8999-999999999999';
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress, signal }) {
      initialCalls += 1;
      if (initialCalls > 1) throw new Error('paused Wave must recover instead of restart');
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'part_started', {
        partIndex: wave.parts[1].partIndex,
        partBatchId: wave.parts[1].partBatchId,
        scenarioIds: [...wave.parts[1].scenarioIds],
        childSessionId: second.childSessionId
      }));
      secondStarted.resolve();
      await new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      throw new Error('unreachable');
    },
    agentOverrides: {
      async cancelMethodGenerationWave() {
        return new Promise(() => {});
      },
      async recoverMethodGenerationWaveStream(request, _modelContext, onProgress) {
        recoveryRequest = structuredClone(request);
        await onProgress(waveEvent(4, wave, 'part_started', {
          waveSessionId: recoveredSessionId,
          partIndex: wave.parts[1].partIndex,
          partBatchId: wave.parts[1].partBatchId,
          scenarioIds: [...wave.parts[1].scenarioIds],
          childSessionId: second.childSessionId
        }));
        await onProgress({
          ...terminalEvent(5, wave, second, 'part_succeeded'),
          waveSessionId: recoveredSessionId
        });
        await onProgress(waveEvent(6, wave, 'wave_completed', {
          waveSessionId: recoveredSessionId,
          completion
        }));
        return {
          waveSessionId: recoveredSessionId,
          eventSequence: 6,
          completion
        };
      }
    }
  });

  const controller = new AbortController();
  const pending = h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    controller.signal
  );
  await secondStarted.promise;
  controller.abort(new ClassTaskPauseRequestedError());

  await Promise.race([
    assert.rejects(pending, (error) => error?.name === 'ClassTaskPauseRequestedError'),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('pause waited for the Agent cancellation response')), 1_000);
    })
  ]);

  const paused = structuredClone(h.savedWaves.at(-1));
  assert.equal(paused.waveSessionId, null);
  assert.match(paused.recoveryRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(paused.parts[0].status, 'SUCCEEDED');
  assert.equal(paused.parts[1].status, 'PENDING');
  assert.deepEqual(h.waveCancellations, ['44444444-4444-4444-8444-444444444444']);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    paused,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.deepEqual(recoveryRequest.terminalParts.map((part) => part.partIndex), [1]);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.equal(outcome.candidateIds.length, 1);
});

test('pausing a recovered Wave rotates its recovery request identity', async (t) => {
  const wave = workWave(1);
  const resumed = deferred();
  const previousRecoveryRequestId = '99999999-9999-4999-8999-999999999999';
  const recoveredSessionId = '88888888-8888-4888-8888-888888888888';
  const h = await harness(t, {
    wave,
    async runWave() {
      throw new Error('a recovered Wave must resume instead of restart');
    },
    agentOverrides: {
      async resumeMethodGenerationWaveStream(_waveSessionId, _request, _sequence, _onProgress, signal) {
        resumed.resolve();
        await new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      }
    }
  });
  const recovered = activeWaveCheckpoint(wave);
  recovered.waveSessionId = recoveredSessionId;
  recovered.recoveryRequestId = previousRecoveryRequestId;
  recovered.eventSequence = 54;
  const controller = new AbortController();
  const pending = h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    recovered,
    controller.signal
  );

  await resumed.promise;
  controller.abort(new ClassTaskPauseRequestedError());
  await assert.rejects(pending, (error) => error?.name === 'ClassTaskPauseRequestedError');

  const paused = h.savedWaves.at(-1);
  assert.equal(paused.waveSessionId, null);
  assert.notEqual(paused.recoveryRequestId, previousRecoveryRequestId);
  assert.match(paused.recoveryRequestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(h.waveCancellations, [recoveredSessionId]);
});

test('pause does not wait for a hung Agent cancellation during merged repair', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairStarted = deferred();
  const repairSessionId = '77777777-7777-4777-8777-777777777777';
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute() {
      return failedExecution('generated');
    },
    getMethodRepairContext() {
      throw new Error('fallback context');
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: repairSessionId,
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(
        _sessionId,
        _request,
        _modelContext,
        _onProgress,
        signal
      ) {
        repairStarted.resolve();
        await new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      },
      async cancelMethodGeneration() {
        return new Promise(() => {});
      }
    }
  });
  const controller = new AbortController();
  const pending = h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    controller.signal
  );
  await repairStarted.promise;
  controller.abort(new ClassTaskPauseRequestedError());

  await Promise.race([
    assert.rejects(pending, (error) => error?.name === 'ClassTaskPauseRequestedError'),
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('pause waited for the repair cancellation response')), 1_000);
    })
  ]);

  assert.deepEqual(h.cancellations, [repairSessionId]);
});

test('resumes an existing Agent Wave after the persisted event sequence without restarting generation', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'durable')
  );
  const second = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'resumed')
  );
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let initialCalls = 0;
  let resumeArgs;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      if (initialCalls > 1) {
        throw new Error('initial Wave generation must not restart');
      }
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      throw new Error('simulated workstation crash');
    },
    agentOverrides: {
      async resumeMethodGenerationWaveStream(
        waveSessionId,
        startRequest,
        afterEventSequence,
        onProgress
      ) {
        resumeArgs = {
          waveSessionId,
          startRequest: structuredClone(startRequest),
          afterEventSequence
        };
        await onProgress(terminalEvent(3, wave, second, 'part_succeeded'));
        await onProgress(waveEvent(4, wave, 'wave_completed', { completion }));
        return {
          waveSessionId,
          eventSequence: 4,
          completion
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated workstation crash/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  assert.deepEqual(h.waveCancellations, []);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.deepEqual(resumeArgs, {
    waveSessionId: '44444444-4444-4444-8444-444444444444',
    startRequest: crashed.startRequest,
    afterEventSequence: 2
  });
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.deepEqual(outcome.skippedScenarioIds, []);
  assert.equal(h.mavenInputs.length, 1);
});

test('restores missing successful Part files from a completed Agent Wave without regenerating', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'restoredFirst')
  );
  const second = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'restoredSecond')
  );
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let initialCalls = 0;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      await onProgress(terminalEvent(3, wave, second, 'part_succeeded'));
      await onProgress(waveEvent(4, wave, 'wave_completed', { completion }));
      throw new Error('simulated cleanup after completed Wave');
    },
    agentOverrides: {
      async resumeMethodGenerationWaveStream(waveSessionId) {
        return {
          waveSessionId,
          eventSequence: 4,
          completion
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated cleanup after completed Wave/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  for (const part of crashed.parts) {
    await Promise.all([
      rm(part.isolatedFilePath, { force: true }),
      rm(`${part.isolatedFilePath}.meta.json`, { force: true })
    ]);
  }

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.deepEqual(outcome.skippedScenarioIds, []);
  assert.equal(h.mavenInputs.length, 1);
});

test('rebuilds a zero-attempt merged candidate whose cleanup removed its TMP identity', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'rebuilt')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const staleCandidateId = '99999999-9999-4999-8999-999999999999';
  let initialCalls = 0;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      throw new Error('simulated cleanup before merged repair seeding');
    },
    agentOverrides: {
      async resumeMethodGenerationWaveStream(waveSessionId) {
        return {
          waveSessionId,
          eventSequence: 3,
          completion
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated cleanup before merged repair seeding/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  h.candidateStates.set(staleCandidateId, {
    candidateId: staleCandidateId,
    methodId: wave.methodId,
    waveId: wave.waveBatchId,
    status: 'MODEL_REPAIR',
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-before-contract-failure',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: null,
    moveTransaction: null
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.deepEqual(outcome.candidateIds, [staleCandidateId]);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
});

test('recreates only unfinished Parts when the persisted Agent Wave session is gone', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'durable')
  );
  const second = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'recreated')
  );
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const recoveredSessionId = '88888888-8888-4888-8888-888888888888';
  let initialCalls = 0;
  let recoveryRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      throw new Error('simulated workstation crash');
    },
    agentOverrides: {
      async resumeMethodGenerationWaveStream(waveSessionId) {
        throw new MethodGenerationWaveNotFoundError(waveSessionId);
      },
      async recoverMethodGenerationWaveStream(request, _modelContext, onProgress) {
        recoveryRequest = structuredClone(request);
        await onProgress({
          ...terminalEvent(3, wave, second, 'part_succeeded'),
          waveSessionId: recoveredSessionId
        });
        await onProgress({
          ...waveEvent(4, wave, 'wave_completed', { completion }),
          waveSessionId: recoveredSessionId
        });
        return {
          waveSessionId: recoveredSessionId,
          eventSequence: 4,
          completion
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated workstation crash/);
  const crashed = structuredClone(h.savedWaves.at(-1));

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.equal(recoveryRequest.lastAcknowledgedEventSequence, 2);
  assert.equal(recoveryRequest.startRequest.waveId, wave.waveBatchId);
  assert.equal(recoveryRequest.terminalParts.length, 1);
  assert.equal(recoveryRequest.terminalParts[0].partIndex, 1);
  assert.equal(recoveryRequest.terminalParts[0].candidate.testCode, first.candidate.testCode);
  assert.equal(recoveryRequest.terminalParts[0].candidate.generatedCodeSha256, sha256(first.candidate.testCode));
  assert.equal(h.savedWaves.at(-1).recoveryRequestId, recoveryRequest.recoveryRequestId);
  assert.equal(h.savedWaves.at(-1).waveSessionId, recoveredSessionId);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.deepEqual(outcome.skippedScenarioIds, []);
  assert.equal(h.mavenInputs.length, 1);
});

test('retries a stale recovery identity once with a new request identity', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'recovered')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const previousRecoveryRequestId = '99999999-9999-4999-8999-999999999999';
  const recoveryRequests = [];
  const h = await harness(t, {
    wave,
    async runWave() {
      throw new Error('a persisted recovery identity must not restart the Wave');
    },
    agentOverrides: {
      async recoverMethodGenerationWaveStream(request, _modelContext, onProgress) {
        recoveryRequests.push(structuredClone(request));
        if (recoveryRequests.length === 1) {
          throw new MethodGenerationRequestError(
            'METHOD_GENERATION_WAVE_IDEMPOTENCY_CONFLICT',
            'A Wave request identity cannot describe different inputs.'
          );
        }
        await onProgress({
          ...terminalEvent(55, wave, partResult, 'part_succeeded'),
          waveSessionId: '88888888-8888-4888-8888-888888888888'
        });
        await onProgress({
          ...waveEvent(56, wave, 'wave_completed', { completion }),
          waveSessionId: '88888888-8888-4888-8888-888888888888'
        });
        return {
          waveSessionId: '88888888-8888-4888-8888-888888888888',
          eventSequence: 56,
          completion
        };
      }
    }
  });
  const stale = activeWaveCheckpoint(wave);
  stale.recoveryRequestId = previousRecoveryRequestId;
  stale.eventSequence = 54;

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    stale,
    new AbortController().signal
  );

  assert.equal(recoveryRequests.length, 2);
  assert.equal(recoveryRequests[0].recoveryRequestId, previousRecoveryRequestId);
  assert.notEqual(recoveryRequests[1].recoveryRequestId, previousRecoveryRequestId);
  assert.equal(recoveryRequests[1].lastAcknowledgedEventSequence, 54);
  assert.equal(h.savedWaves.at(-1).recoveryRequestId, recoveryRequests[1].recoveryRequestId);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
  assert.equal(h.mavenInputs.length, 1);
});

test('clears stale failure metadata when a failed Part starts again', async (t) => {
  const wave = workWave(1);
  const h = await harness(t, { wave, async runWave({ onProgress }) {
    await onProgress(waveEvent(1, wave, 'part_started', {
      partIndex: 1, partBatchId: wave.parts[0].partBatchId, scenarioIds: wave.parts[0].scenarioIds
    }));
    throw new Error('stop after started checkpoint');
  }});
  const checkpoint = activeWaveCheckpoint(wave);
  checkpoint.parts[0].status = 'FAILED';
  checkpoint.parts[0].failureReason = 'MODEL_UNAVAILABLE: disconnected';
  await assert.rejects(h.service.executeWave(h.task, wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    checkpoint, new AbortController().signal), /stop after started checkpoint/);
  const restarted = h.savedWaves.at(-1).parts[0];
  assert.equal(restarted.status, 'RUNNING');
  assert.equal(restarted.failureReason, null);
});

test('retries a terminal model-error Wave with a new recovery request and keeps passed Parts', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'durable')
  );
  const second = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'retried')
  );
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const recoveredSessionId = '88888888-8888-4888-8888-888888888888';
  const previousRecoveryRequestId = '99999999-9999-4999-8999-999999999999';
  let recoveryRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      await onProgress(terminalEvent(3, wave, {
        ...failed(wave.parts[1]),
        error: { code: 'MODEL_UNAVAILABLE', message: 'provider disconnected', stage: 'generation' }
      }, 'part_failed'));
      await onProgress(waveEvent(4, wave, 'error', {
        error: { code: 'MODEL_UNAVAILABLE', message: 'provider disconnected', stage: 'generation' }
      }));
    },
    agentOverrides: {
      async resumeMethodGenerationWaveStream() {
        throw new MethodGenerationRequestError(
          'MODEL_UNAVAILABLE',
          '单方法 Wave 失败：大模型平台当前不可用。'
        );
      },
      async recoverMethodGenerationWaveStream(request, _modelContext, onProgress) {
        recoveryRequest = structuredClone(request);
        await onProgress({
          ...terminalEvent(3, wave, second, 'part_succeeded'),
          waveSessionId: recoveredSessionId
        });
        await onProgress({
          ...waveEvent(4, wave, 'wave_completed', { completion }),
          waveSessionId: recoveredSessionId
        });
        return {
          waveSessionId: recoveredSessionId,
          eventSequence: 4,
          completion
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), (error) => {
    assert.ok(error instanceof MethodGenerationRequestError);
    assert.equal(error.code, 'MODEL_UNAVAILABLE');
    return true;
  });
  const crashed = {
    ...structuredClone(h.savedWaves.at(-1)),
    recoveryRequestId: previousRecoveryRequestId
  };

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.notEqual(recoveryRequest.recoveryRequestId, previousRecoveryRequestId);
  assert.equal(recoveryRequest.lastAcknowledgedEventSequence, 3);
  assert.equal(recoveryRequest.terminalParts.length, 1);
  assert.equal(recoveryRequest.terminalParts[0].partIndex, 1);
  assert.equal(recoveryRequest.terminalParts[0].candidate.testCode, first.candidate.testCode);
  assert.equal(h.savedWaves.at(-1).recoveryRequestId, recoveryRequest.recoveryRequestId);
  assert.equal(h.savedWaves.at(-1).waveSessionId, recoveredSessionId);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.equal(h.mavenInputs.length, 1);
});

test('pauses a partially successful Wave and recovers only its model-failed Part', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'durable')
  );
  const failedSecond = {
    ...failed(wave.parts[1]),
    error: {
      code: 'MODEL_UNAVAILABLE',
      message: 'provider disconnected',
      stage: 'generation'
    }
  };
  const recoveredSecond = succeeded(
    wave.parts[1],
    testCode('TaskServiceTmp1Part2Test', 'recovered')
  );
  const failedCompletion = {
    parts: [first, failedSecond],
    succeededPartCount: 1,
    failedPartCount: 1,
    cancelledPartCount: 0,
    modelCallCount: 1
  };
  const recoveredCompletion = {
    parts: [first, recoveredSecond],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0,
    modelCallCount: 1
  };
  let recoveryRequest;
  const recoveredSessionId = '88888888-8888-4888-8888-888888888888';
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      await onProgress(terminalEvent(3, wave, failedSecond, 'part_failed'));
      await onProgress(waveEvent(4, wave, 'wave_completed', {
        completion: failedCompletion
      }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 4,
        completion: failedCompletion
      };
    },
    agentOverrides: {
      async recoverMethodGenerationWaveStream(request, _modelContext, onProgress) {
        recoveryRequest = structuredClone(request);
        await onProgress({
          ...terminalEvent(5, wave, recoveredSecond, 'part_succeeded'),
          waveSessionId: recoveredSessionId
        });
        await onProgress({
          ...waveEvent(6, wave, 'wave_completed', { completion: recoveredCompletion }),
          waveSessionId: recoveredSessionId
        });
        return {
          waveSessionId: recoveredSessionId,
          eventSequence: 6,
          completion: recoveredCompletion
        };
      }
    }
  });

  const firstOutcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.deepEqual(firstOutcome, {
    completedScenarioIds: [],
    skippedScenarioIds: [],
    candidateIds: [],
    modelFailure: failedSecond.error
  });
  assert.equal(h.mavenInputs.length, 0);
  assert.deepEqual(h.savedCandidates, []);
  assert.equal(h.acknowledgements.length, 1);
  const pausedWave = structuredClone(h.savedWaves.at(-1));
  assert.equal(pausedWave.waveSessionId, null);
  assert.match(pausedWave.recoveryRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(pausedWave.parts[0].status, 'SUCCEEDED');
  assert.equal(pausedWave.parts[1].status, 'FAILED');
  await access(pausedWave.parts[0].isolatedFilePath);

  const recoveredOutcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    pausedWave,
    new AbortController().signal
  );

  assert.equal(recoveryRequest.recoveryRequestId, pausedWave.recoveryRequestId);
  assert.equal(recoveryRequest.lastAcknowledgedEventSequence, 4);
  assert.deepEqual(
    recoveryRequest.terminalParts.map((part) => part.partIndex),
    [1]
  );
  assert.deepEqual(recoveredOutcome.completedScenarioIds, ['scenario-1', 'scenario-2']);
  assert.deepEqual(recoveredOutcome.skippedScenarioIds, []);
  assert.equal(h.mavenInputs.length, 1);
});

test('reuses a persisted passing Wave TMP after the Analyzer report pair changes', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let initialCalls = 0;
  let crashedAfterPassingCheckpoint = false;
  let currentReportPairId = REPORT_PAIR_ID;
  const contextOverrides = {};
  Object.defineProperty(contextOverrides, 'reportPairId', {
    enumerable: true,
    get: () => currentReportPairId
  });
  const h = await harness(t, {
    wave,
    contextOverrides,
    async runWave({ onProgress }) {
      initialCalls += 1;
      if (initialCalls > 1) throw new Error('passing Wave must not regenerate');
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async onSaveWaveCandidate(value) {
      if (value.status === 'PASSED' && !crashedAfterPassingCheckpoint) {
        crashedAfterPassingCheckpoint = true;
        throw new Error('simulated crash after PASSED checkpoint');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated crash after PASSED checkpoint/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  const passing = h.savedCandidates.at(-1);
  assert.equal(passing.status, 'PASSED');
  assert.equal(h.mavenInputs.length, 1);
  currentReportPairId = 'f'.repeat(64);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.deepEqual(outcome.candidateIds, [passing.candidateId]);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
  assert.deepEqual(outcome.skippedScenarioIds, []);
  assert.equal(outcome.bundle.code, await readFile(passing.managedFile.path, 'utf8'));
  assert.equal(outcome.bundle.ordinaryTestMethodCount, 1);
});

test('recovers a published passing Wave after coverage refresh changes the report pair', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let currentReportPairId = REPORT_PAIR_ID;
  let crashedAfterPassingCheckpoint = false;
  let publishedRecoveryCalls = 0;
  const contextOverrides = {};
  Object.defineProperty(contextOverrides, 'reportPairId', {
    enumerable: true,
    get: () => currentReportPairId
  });
  const h = await harness(t, {
    wave,
    contextOverrides,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async onSaveWaveCandidate(value) {
      if (value.status === 'PASSED' && !crashedAfterPassingCheckpoint) {
        crashedAfterPassingCheckpoint = true;
        throw new Error('simulated crash after formal publication checkpoint');
      }
    },
    serviceOverrides: {
      publishedWaveRecovery: {
        async restore({ candidate }) {
          publishedRecoveryCalls += 1;
          return {
            methodId: METHOD_ID,
            sourceMethodId: METHOD_ID,
            waveIndex: 1,
            hasRemainingScenarios: false,
            methodName: 'run',
            displaySignature: 'run()',
            jacocoOrder: 1,
            code: testCode('TaskService5Test', 'generated'),
            ordinaryTestMethodCount: 1,
            passedTestMethods: ['generated'],
            sourceBatchIds: [candidate.candidateId]
          };
        }
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated crash after formal publication checkpoint/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  const passing = h.savedCandidates.at(-1);
  h.candidateStates.set(passing.candidateId, {
    ...structuredClone(passing),
    managedFile: null,
    moveTransaction: null
  });
  currentReportPairId = 'f'.repeat(64);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(publishedRecoveryCalls, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.deepEqual(outcome.candidateIds, [passing.candidateId]);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
  assert.equal(outcome.bundle.code, testCode('TaskService5Test', 'generated'));
});

test('a persisted BLOCKED Wave preserves its source and does not call Agent or Maven again', async (t) => {
  // Mutation caught: omitting BLOCKED from candidate recovery falls through to the
  // initial Agent Wave path and repeats generation for a user-actionable project failure.
  const wave = workWave(1);
  let initialWaveCalls = 0;
  const h = await harness(t, {
    wave,
    async runWave() {
      initialWaveCalls += 1;
      throw new Error('BLOCKED Wave must not restart Agent generation.');
    }
  });
  const candidateId = '77777777-7777-4777-8777-777777777777';
  const filePath = join(
    h.workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'demo',
    'TaskServiceTmp1Test.java'
  );
  const code = testCode('TaskServiceTmp1Test', 'preservedBlockedSource');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, code, 'utf8');
  h.candidateStates.set(candidateId, {
    candidateId,
    methodId: wave.methodId,
    waveId: wave.waveBatchId,
    status: 'BLOCKED',
    llmRepairAttemptsUsed: 5,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-blocked',
    stableRepair: {
      phase: 'BLOCKED',
      iteration: 3,
      annotatedMemberIds: ['method:generated:1']
    },
    managedFile: {
      path: filePath,
      sha256: sha256(code),
      location: 'PROJECT'
    },
    moveTransaction: null
  });
  const active = activeWaveCheckpoint(wave);
  Object.assign(active.parts[0], {
    status: 'SUCCEEDED',
    candidateId: '88888888-8888-4888-8888-888888888888',
    isolatedFilePath: join(h.workspaceRoot, '.ai-unit-test', 'part.java'),
    fileSha256: 'f'.repeat(64)
  });

  await assert.rejects(
    h.service.executeWave(
      h.task,
      wave,
      { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
      active,
      new AbortController().signal
    ),
    /preserved.*resolve.*manually/i
  );

  assert.equal(initialWaveCalls, 0);
  assert.equal(h.mavenInputs.length, 0);
  assert.equal(h.repairCalls.length, 0);
  assert.equal(h.savedCandidates.length, 0);
  assert.equal(await readFile(filePath, 'utf8'), code);
});

test('continues a persisted READY Wave candidate with Maven instead of regenerating its Parts', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let initialCalls = 0;
  let crashedAtReady = false;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      if (initialCalls > 1) throw new Error('READY Wave must not regenerate');
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async onSaveWaveCandidate(value) {
      if (value.status === 'READY_FOR_MAVEN' && !crashedAtReady) {
        crashedAtReady = true;
        throw new Error('simulated crash at READY_FOR_MAVEN');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated crash at READY_FOR_MAVEN/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  const ready = h.savedCandidates.at(-1);
  assert.equal(ready.status, 'READY_FOR_MAVEN');
  assert.equal(h.mavenInputs.length, 0);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.deepEqual(outcome.candidateIds, [ready.candidateId]);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
});

test('continues a persisted READY Wave after coverage refresh without regenerating its Parts', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let currentReportPairId = REPORT_PAIR_ID;
  let initialCalls = 0;
  let crashedAtReady = false;
  const contextOverrides = {};
  Object.defineProperty(contextOverrides, 'reportPairId', {
    enumerable: true,
    get: () => currentReportPairId
  });
  const h = await harness(t, {
    wave,
    contextOverrides,
    async runWave({ onProgress }) {
      initialCalls += 1;
      if (initialCalls > 1) throw new Error('READY Wave must not regenerate');
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async onSaveWaveCandidate(value) {
      if (value.status === 'READY_FOR_MAVEN' && !crashedAtReady) {
        crashedAtReady = true;
        throw new Error('simulated crash at READY_FOR_MAVEN');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated crash at READY_FOR_MAVEN/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  currentReportPairId = 'f'.repeat(64);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
});

test('isolates a persisted MAVEN_RUNNING project TMP before rebuilding its recovery context', async (t) => {
  const wave = workWave(1);
  const candidateId = '99999999-9999-4999-8999-999999999999';
  const code = testCode('TaskServiceTmp1Test', 'resumed');
  let projectFilePath;
  let contextResolveCount = 0;
  const h = await harness(t, {
    wave,
    async runWave() {
      throw new Error('MAVEN_RUNNING Wave must not regenerate');
    },
    async beforeContextResolve() {
      contextResolveCount += 1;
      await assert.rejects(
        access(projectFilePath),
        (error) => error?.code === 'ENOENT'
      );
    },
    serviceOverrides: {
      mavenReadyQueue: {
        async enqueue(request) {
          await assert.rejects(access(request.projectFilePath));
          await access(request.isolationFilePath);
          await request.onBatchStart('maven-batch-recovered');
          await request.activate();
          return {
            candidateId: request.candidateId,
            ...passedExecution(1)
          };
        }
      }
    }
  });
  projectFilePath = join(
    h.workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'demo',
    'TaskServiceTmp1Test.java'
  );
  await mkdir(dirname(projectFilePath), { recursive: true });
  await writeFile(projectFilePath, code, 'utf8');
  h.candidateStates.set(candidateId, {
    candidateId,
    methodId: wave.methodId,
    waveId: wave.waveBatchId,
    status: 'MAVEN_RUNNING',
    llmRepairAttemptsUsed: 0,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-before-restart',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: projectFilePath,
      sha256: sha256(code),
      location: 'PROJECT'
    },
    moveTransaction: null
  });
  const active = activeWaveCheckpoint(wave);
  Object.assign(active.parts[0], {
    status: 'SUCCEEDED',
    childSessionId: '33333333-3333-4333-8333-000000000001',
    candidateId: '22222222-2222-4222-8222-000000000001',
    isolatedFilePath: join(h.workspaceRoot, '.ai-unit-test', 'part.java'),
    fileSha256: 'f'.repeat(64)
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    active,
    new AbortController().signal
  );

  assert.equal(contextResolveCount, 1);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).managedFile.location, 'PROJECT');
  assert.deepEqual(outcome.candidateIds, [candidateId]);
});

test('resumes a persisted MODEL_REPAIR candidate from fresh Maven evidence without initial regeneration', async (t) => {
  const wave = workWave(1);
  const initialCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void generated() { MissingType value = null; }',
    '}',
    ''
  ].join('\n');
  const partResult = succeeded(wave.parts[0], initialCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '  @Test void generated() { Object value = null; }',
    '}',
    ''
  ].join('\n');
  let initialCalls = 0;
  let seedCalls = 0;
  let seed;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      if (initialCalls > 1) throw new Error('MODEL_REPAIR Wave must not regenerate');
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(_input, { callIndex }) {
      return callIndex < 3
        ? failedExecution('generated', `failure-${callIndex}`)
        : passedExecution(1);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seedCalls += 1;
        if (seedCalls === 1) {
          throw new Error('simulated crash before repair seed');
        }
        seed = structuredClone(request);
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        if (request.execution.status === 'passed') {
          return {
            kind: 'completed',
            sessionId: '77777777-7777-4777-8777-777777777777',
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: seed.candidate.candidateId,
              aggregateUsage: null,
              modelCallCount: 1,
              usageReportedCallCount: 0
            }
          };
        }
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated crash before repair seed/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  assert.equal(h.savedCandidates.at(-1).status, 'MODEL_REPAIR');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 0);
  assert.equal(h.mavenInputs.length, 1);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.equal(seedCalls, 2);
  assert.equal(h.mavenInputs.length, 3);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.deepEqual(outcome.candidateIds, [seed.candidate.candidateId]);
});

for (const modelFailure of [
  new Error('model quota exhausted'),
  new MethodGenerationRequestError('MODEL_OUTPUT_BUDGET_EXHAUSTED', 'model returned no test code')
]) {
test(`rolls back a Wave repair attempt without pruning tests: ${modelFailure.message}`, async (t) => {
  const wave = workWave(1);
  const initialCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void generated() { MissingType value = null; }',
    '}',
    ''
  ].join('\n');
  const partResult = succeeded(wave.parts[0], initialCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '  @Test void generated() { Object value = null; }',
    '}',
    ''
  ].join('\n');
  let initialCalls = 0;
  const seedRequests = [];
  let repairResumeCalls = 0;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      initialCalls += 1;
      if (initialCalls > 1) throw new Error('MODEL_REPAIR Wave must not regenerate');
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(_input, { callIndex }) {
      return callIndex < 3
        ? failedExecution('generated', `failure-${callIndex}`)
        : passedExecution(1);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seedRequests.push(structuredClone(request));
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-000000000005',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairResumeCalls += 1;
        if (repairResumeCalls === 1) {
          assert.equal(request.candidateVersion, 1);
          assert.equal(request.repairAttempt, 0);
          throw modelFailure;
        }
        if (request.execution.status === 'passed') {
          assert.equal(request.candidateVersion, 2);
          assert.equal(request.repairAttempt, 1);
          return {
            kind: 'completed',
            sessionId: '77777777-7777-4777-8777-000000000005',
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: seedRequests.at(-1).candidate.candidateId,
              aggregateUsage: null,
              modelCallCount: 1,
              usageReportedCallCount: 0
            }
          };
        }
        assert.equal(request.candidateVersion, 1);
        assert.equal(request.repairAttempt, 0);
        const seed = seedRequests.at(-1).candidate;
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-000000000005',
          eventSequence: 2,
          candidate: {
            ...seed,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), (error) => error === modelFailure);
  const crashed = structuredClone(h.savedWaves.at(-1));
  assert.equal(h.savedCandidates.at(-1).status, 'MODEL_REPAIR');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 0);
  assert.equal(h.mavenInputs.length, 1);

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  );

  assert.equal(initialCalls, 1);
  assert.equal(seedRequests.length, 2);
  assert.deepEqual(seedRequests.map((request) => request.candidate.candidateVersion), [1, 1]);
  assert.deepEqual(seedRequests.map((request) => request.candidate.repairAttempt), [0, 0]);
  assert.equal(h.mavenInputs.length, 3);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.deepEqual(outcome.candidateIds, [seedRequests.at(-1).candidate.candidateId]);
});
}

function classMethodSlice(methodId, methodName, testMethodNamePrefix, count, offset) {
  const part = structuredClone(wavePart(offset + 1));
  part.partIndex = 1;
  part.partBatchId = sha256(`${methodId}:class-part`);
  part.method.methodId = methodId;
  part.method.methodName = methodName;
  part.method.completeMethodSource = `public void ${methodName}() {}`;
  part.methodTestPlan.methodId = methodId;
  part.methodStubInventory.methodId = methodId;
  part.necessaryImports = [
    'org.junit.jupiter.api.Test',
    methodId === METHOD_ID ? 'java.util.List' : 'java.util.Map'
  ];
  part.scenarios = [];
  part.scenarioIds = [];
  part.methodTestPlan.remainingTargets = [];
  part.methodTestPlan.testPathGroups = [];
  part.methodTestPlan.testMethodPlans = [];
  for (let index = 1; index <= count; index += 1) {
    const ordinal = offset + index;
    const current = scenario(ordinal);
    current.methodId = methodId;
    current.scenarioId = `${testMethodNamePrefix}scenario-${index}`;
    current.scenarioSignature = `${methodName}-path-${index}`;
    current.coverageTargetIds = [`${testMethodNamePrefix}target-${index}`];
    part.scenarios.push(current);
    part.scenarioIds.push(current.scenarioId);
    part.methodTestPlan.remainingTargets.push({
      targetId: `${testMethodNamePrefix}target-${index}`,
      methodId,
      decisionId: `${testMethodNamePrefix}decision-${index}`,
      instructionIndex: ordinal,
      sourceLine: 10 + ordinal,
      kind: 'LINE',
      direction: 'ENTER',
      covered: false,
      mappingStatus: 'MAPPED',
      requiredEdgeIds: []
    });
    part.methodTestPlan.testPathGroups.push({
      groupId: `${testMethodNamePrefix}group-${index}`,
      methodId,
      ordinal: index,
      scenarioIds: [current.scenarioId],
      targetIds: [`${testMethodNamePrefix}target-${index}`],
      constraints: [],
      inputRequirements: [],
      mockRequirements: [],
      expectedExit: 'RETURNS',
      singleTargetInvocation: true,
      status: 'COMPLETE'
    });
    part.methodTestPlan.testMethodPlans.push({
      testMethodPlanId: `${testMethodNamePrefix}plan-${index}`,
      methodId,
      ordinal: index,
      pathGroupIds: [`${testMethodNamePrefix}group-${index}`],
      status: 'COMPLETE'
    });
  }
  part.method.activeScenarioIds = [...part.scenarioIds];
  part.methodTestPlan.minimumTestCount = count;
  return { methodId, testMethodNamePrefix, batch: part };
}

function analyzerRepairContextForSlice(slice) {
  const method = slice.batch.method;
  return {
    reportPairId: REPORT_PAIR_ID,
    sourceSha256: 'd'.repeat(64),
    targetMethod: {
      methodId: method.methodId,
      declaringType: method.declaringType,
      methodName: method.methodName,
      descriptor: method.descriptor,
      modifiers: [...method.modifiers],
      firstLine: method.firstLine,
      lastLine: method.lastLine,
      sourceFirstLine: method.firstLine,
      sourceLastLine: method.lastLine,
      sourceText: method.completeMethodSource,
      sourceComplete: true,
      parameterTypes: [...method.parameterTypes],
      returnType: method.returnType,
      declaredExceptions: [...method.declaredExceptions]
    },
    stackMethods: [],
    referencedTypes: [],
    warnings: [],
    truncated: false
  };
}

function failedExecutionForTests(testNames) {
  const execution = failedExecution(testNames[0]);
  execution.testReport.tests = testNames.length;
  execution.testReport.failures = testNames.length;
  execution.testReport.generatedTests = testNames.length;
  execution.testReport.failureDetails = testNames.map((testName) => ({
    suiteName: 'TaskServiceTmp1Test',
    testClassName: 'demo.TaskServiceTmp1Test',
    testName,
    kind: 'failure',
    message: `${testName} failed`
  }));
  return execution;
}

function compileFailedExecution(filePath, line) {
  return {
    status: 'compile_failed',
    mavenExecutions: [{
      scope: 'method_candidate',
      phase: 'test_compile',
      command: 'mvn test-compile',
      exitCode: 1,
      stdout: [
        `[ERROR] /${filePath.replace(/\\/g, '/')}:[${line},15] cannot find symbol`,
        '[ERROR] symbol: class MissingType'
      ].join('\n'),
      stderr: '',
      surefireReports: []
    }]
  };
}

function classWorkWave() {
  const first = classMethodSlice(METHOD_ID, 'alpha', 'm1_', 3, 0);
  const second = classMethodSlice(SECOND_METHOD_ID, 'beta', 'm2_', 2, 3);
  const scenarioIds = [first, second].flatMap((slice) => slice.batch.scenarioIds);
  return {
    waveBatchId: WAVE_ID,
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    remainingScenarioCount: 0,
    hasWork: true,
    selectedMethodIds: [METHOD_ID, SECOND_METHOD_ID],
    selectedScenarioIds: scenarioIds,
    remainingScenarioCountByMethod: {
      [METHOD_ID]: 0,
      [SECOND_METHOD_ID]: 0
    },
    completedMethodIds: [METHOD_ID, SECOND_METHOD_ID],
    parts: [{
      ...structuredClone(first.batch),
      partIndex: 1,
      partBatchId: '1'.repeat(64),
      scenarioIds,
      methodSlices: [first, second]
    }],
    warnings: []
  };
}

test('class Wave sends one mixed A3+B2 Part and returns source-method bundles without a post-repair merge', async (t) => {
  const wave = classWorkWave();
  const methodNames = [
    'm1_alphaOne', 'm1_alphaTwo', 'm1_alphaThree',
    'm2_betaOne', 'm2_betaTwo'
  ];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp1Part1Test', methodNames)
  );
  result.candidate.ordinaryTestMethodCount = methodNames.length;
  const completion = {
    parts: [result],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    contextOverrides: {
      methodCatalog: [{
        methodId: METHOD_ID,
        methodName: 'alpha',
        displaySignature: 'public void alpha()',
        jacocoOrder: 0
      }, {
        methodId: SECOND_METHOD_ID,
        methodName: 'beta',
        displaySignature: 'public void beta()',
        jacocoOrder: 1
      }]
    },
    async runWave({ request, onProgress }) {
      const batch = request.parts[0].request.batch;
      assert.ok('methodSlices' in batch);
      assert.equal(batch.plannedTestMethods, 5);
      assert.deepEqual(
        batch.methodSlices.map((slice) => [
          slice.methodId,
          slice.testMethodNamePrefix,
          slice.batch.plannedTestMethods
        ]),
        [[METHOD_ID, 'm1_', 3], [SECOND_METHOD_ID, 'm2_', 2]]
      );
      assert.deepEqual(
        batch.necessaryImports,
        ['org.junit.jupiter.api.Test', 'java.util.List', 'java.util.Map']
      );
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(h.mavenInputs.length, 1);
  assert.deepEqual(outcome.completedScenarioIds, wave.selectedScenarioIds);
  assert.deepEqual(
    outcome.bundles.map((bundle) => ({
      methodId: bundle.sourceMethodId,
      count: bundle.ordinaryTestMethodCount,
      tests: bundle.passedTestMethods
    })),
    [{
      methodId: METHOD_ID,
      count: 3,
      tests: methodNames.slice(0, 3)
    }, {
      methodId: SECOND_METHOD_ID,
      count: 2,
      tests: methodNames.slice(3)
    }]
  );
  assert.equal(outcome.bundles[0].code, outcome.bundles[1].code);
});

test('class Wave stable repair keeps a zero-test formalization bundle for an accepted method', async (t) => {
  const slice = classMethodSlice(METHOD_ID, 'alpha', 'm1_', 1, 0);
  const wave = {
    waveBatchId: WAVE_ID,
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    remainingScenarioCount: 0,
    hasWork: true,
    selectedMethodIds: [METHOD_ID],
    selectedScenarioIds: [...slice.batch.scenarioIds],
    remainingScenarioCountByMethod: { [METHOD_ID]: 0 },
    completedMethodIds: [METHOD_ID],
    parts: [{
      ...structuredClone(slice.batch),
      partIndex: 1,
      partBatchId: '1'.repeat(64),
      scenarioIds: [...slice.batch.scenarioIds],
      methodSlices: [slice]
    }],
    warnings: []
  };
  const partCode = testCodeWithMethods(
    'TaskServiceTmp1Part1Test',
    ['m1_alphaScenario']
  );
  const partResult = succeeded(wave.parts[0], partCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 0 },
    contextOverrides: {
      methodCatalog: [{
        methodId: METHOD_ID,
        methodName: 'alpha',
        displaySignature: 'public void alpha()',
        jacocoOrder: 0
      }]
    },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute(_input, { callIndex }) {
      return callIndex === 1
        ? failedExecution('m1_alphaScenario')
        : compilableEmptyExecution();
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(outcome.bundles.length, 1);
  assert.equal(outcome.bundles[0].sourceMethodId, METHOD_ID);
  assert.equal(outcome.bundles[0].ordinaryTestMethodCount, 0);
  assert.deepEqual(outcome.bundles[0].passedTestMethods, []);
  assert.equal(outcome.candidateIds.length, 1);
  assert.deepEqual(outcome.completedScenarioIds, wave.selectedScenarioIds);
  assert.deepEqual(outcome.skippedScenarioIds, []);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  const finalCode = await readFile(h.savedCandidates.at(-1).managedFile.path, 'utf8');
  assert.match(finalCode, /\/\/ TODO/);
  assert.equal((finalCode.match(/^\s*@Test\b/gm) ?? []).length, 0);
});

test('class Wave preserves processed scenario IDs when coverage report pair changes', async (t) => {
  const wave = classWorkWave();
  const refreshedPairId = 'e'.repeat(64);
  const analyzerRequests = [];
  const h = await harness(t, {
    wave,
    async runWave() { throw new Error('generation was not expected'); },
    contextOverrides: { reportPairId: refreshedPairId },
    serviceOverrides: {
      analyzer: {
        async nextClassScenarioWave(_sessionId, request) {
          analyzerRequests.push(structuredClone(request));
          return {
            waveBatchId: null,
            reportPairId: request.reportPairId,
            methodId: METHOD_ID,
            remainingScenarioCount: 0,
            hasWork: false,
            selectedMethodIds: [],
            selectedScenarioIds: [],
            remainingScenarioCountByMethod: {},
            completedMethodIds: [],
            parts: [],
            warnings: []
          };
        }
      }
    }
  });
  const staleRequest = {
    reportPairId: REPORT_PAIR_ID,
    methods: [{
      methodId: METHOD_ID,
      completedScenarioIds: ['old-completed'],
      skippedScenarioIds: ['old-skipped']
    }],
    maxScenarios: 25,
    partSize: 5
  };

  await h.service.nextClassWave(
    h.task,
    staleRequest,
    new AbortController().signal
  );
  await h.service.nextClassWave(
    h.task,
    { ...staleRequest, reportPairId: refreshedPairId },
    new AbortController().signal
  );

  assert.deepEqual(analyzerRequests, [{
    ...staleRequest,
    reportPairId: refreshedPairId
  }, {
    ...staleRequest,
    reportPairId: refreshedPairId
  }]);
});

test('single-method Wave preserves processed scenario IDs when coverage report pair changes', async (t) => {
  const wave = workWave(1);
  const refreshedPairId = 'e'.repeat(64);
  const analyzerRequests = [];
  const h = await harness(t, {
    wave,
    async runWave() { throw new Error('generation was not expected'); },
    contextOverrides: { reportPairId: refreshedPairId },
    serviceOverrides: {
      analyzer: {
        async nextMethodWave(_sessionId, methodId, request) {
          analyzerRequests.push({ methodId, request: structuredClone(request) });
          return {
            waveBatchId: null,
            reportPairId: request.reportPairId,
            methodId,
            hasWork: false,
            selectedScenarioIds: [],
            remainingScenarioCount: 0,
            parts: [],
            warnings: []
          };
        }
      }
    }
  });
  const staleRequest = {
    reportPairId: REPORT_PAIR_ID,
    completedScenarioIds: ['old-completed'],
    skippedScenarioIds: ['old-skipped'],
    maxScenarios: 25,
    partSize: 5
  };

  await h.service.nextWave(
    h.task,
    METHOD_ID,
    staleRequest,
    new AbortController().signal
  );

  assert.deepEqual(analyzerRequests, [{
    methodId: METHOD_ID,
    request: {
      ...staleRequest,
      reportPairId: refreshedPairId
    }
  }]);
});

test('class Wave gives a newly supplemented method its first method-local Wave index', async (t) => {
  const wave = classWorkWave();
  const methodNames = [
    'm1_alphaOne', 'm1_alphaTwo', 'm1_alphaThree',
    'm2_betaOne', 'm2_betaTwo'
  ];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp2Part1Test', methodNames)
  );
  result.candidate.batchIndex = 2;
  result.candidate.outputTestClassName = 'TaskServiceTmp2Part1Test';
  result.candidate.ordinaryTestMethodCount = methodNames.length;
  const completion = {
    parts: [result],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    contextOverrides: {
      methodCatalog: [{
        methodId: METHOD_ID,
        methodName: 'alpha',
        displaySignature: 'public void alpha()',
        jacocoOrder: 0
      }, {
        methodId: SECOND_METHOD_ID,
        methodName: 'beta',
        displaySignature: 'public void beta()',
        jacocoOrder: 1
      }]
    },
    waveProgressMethods: {
      [METHOD_ID]: {
        completedScenarioIds: ['previous-scenario'],
        skippedScenarioIds: [],
        nextWaveIndex: 2,
        remainingScenarioCount: 3,
        completedWaves: [{ waveId: 'prior-owner-wave' }]
      },
      [SECOND_METHOD_ID]: {
        completedScenarioIds: ['previous-supplement-scenario'],
        skippedScenarioIds: [],
        nextWaveIndex: 1,
        remainingScenarioCount: 3,
        completedWaves: [{ waveId: 'prior-supplement-wave' }]
      }
    },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started', { waveIndex: 2 }));
      await onProgress({
        ...terminalEvent(2, wave, result, 'part_succeeded'),
        waveIndex: 2
      });
      await onProgress(waveEvent(3, wave, 'wave_completed', {
        waveIndex: 2,
        completion
      }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    }
  });
  const checkpoint = activeWaveCheckpoint(wave);
  checkpoint.waveIndex = 2;

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    checkpoint,
    new AbortController().signal
  );

  assert.ok(outcome.bundles, JSON.stringify(outcome));
  assert.deepEqual(
    outcome.bundles.map((bundle) => [bundle.sourceMethodId, bundle.waveIndex]),
    [[METHOD_ID, 2], [SECOND_METHOD_ID, 1]]
  );
  assert.match(outcome.bundles[0].code, /class TaskServiceTmp3Test\b/u);
});

test('class Wave repair seed keeps every source-method slice in the one candidate session', async (t) => {
  const wave = classWorkWave();
  const names = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp1Part1Test', names)
  );
  result.candidate.ordinaryTestMethodCount = names.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  let recovery;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute() { return failedExecution('m2_b1'); },
    getMethodRepairContext() { throw new Error('fallback context'); },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        recovery = structuredClone(request);
        throw new Error('stop after class Wave repair seed');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /stop after class Wave repair seed/);

  assert.equal(recovery.startRequest.batch.plannedTestMethods, 5);
  assert.deepEqual(
    recovery.startRequest.batch.methodSlices.map((slice) => [
      slice.methodId,
      slice.testMethodNamePrefix,
      slice.batch.plannedTestMethods
    ]),
    [[METHOD_ID, 'm1_', 3], [SECOND_METHOD_ID, 'm2_', 2]]
  );
});

test('class Wave repair analyzes and merges every production method with a failing test', async (t) => {
  const wave = classWorkWave();
  const names = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp1Part1Test', names)
  );
  result.candidate.ordinaryTestMethodCount = names.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  const analyzerMethodIds = [];
  let repairRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute() {
      return failedExecutionForTests(['m1_a1', 'm2_b1']);
    },
    getMethodRepairContext(_sessionId, request) {
      analyzerMethodIds.push(request.methodId);
      const slice = wave.parts[0].methodSlices.find(
        (item) => item.methodId === request.methodId
      );
      assert.ok(slice);
      return analyzerRepairContextForSlice(slice);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairRequest = structuredClone(request);
        throw new Error('stop after merged multi-method repair request');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /stop after merged multi-method repair request/);

  assert.deepEqual(analyzerMethodIds, [METHOD_ID, SECOND_METHOD_ID]);
  assert.deepEqual(repairRequest.repairContext.affectedTestNames, ['m1_a1', 'm2_b1']);
  assert.equal(repairRequest.repairContext.targetMethod.methodId, METHOD_ID);
  assert.deepEqual(
    repairRequest.repairContext.stackMethods.map((method) => method.methodId),
    [SECOND_METHOD_ID]
  );
});

test('class Wave repair retains all twenty-five production methods from failing tests', async (t) => {
  const slices = Array.from({ length: 25 }, (_, index) => {
    const ordinal = index + 1;
    return classMethodSlice(
      index === 0 ? METHOD_ID : sha256(`method-${ordinal}`),
      `method${String(ordinal).padStart(2, '0')}`,
      `m${String(ordinal).padStart(2, '0')}_`,
      1,
      0
    );
  });
  const scenarioIds = slices.flatMap((slice) => slice.batch.scenarioIds);
  const parts = Array.from({ length: 5 }, (_, partOffset) => {
    const partIndex = partOffset + 1;
    const methodSlices = slices.slice(partOffset * 5, partIndex * 5);
    return {
      ...structuredClone(methodSlices[0].batch),
      partIndex,
      partBatchId: String(partIndex).repeat(64),
      scenarioIds: methodSlices.flatMap((slice) => slice.batch.scenarioIds),
      methodSlices
    };
  });
  const wave = {
    waveBatchId: WAVE_ID,
    reportPairId: REPORT_PAIR_ID,
    methodId: slices[0].methodId,
    remainingScenarioCount: 0,
    hasWork: true,
    selectedMethodIds: slices.map((slice) => slice.methodId),
    selectedScenarioIds: scenarioIds,
    remainingScenarioCountByMethod: Object.fromEntries(
      slices.map((slice) => [slice.methodId, 0])
    ),
    completedMethodIds: slices.map((slice) => slice.methodId),
    parts,
    warnings: []
  };
  const names = slices.map((slice) => `${slice.testMethodNamePrefix}case`);
  const results = parts.map((part) => {
    const partNames = part.methodSlices.map((slice) => (
      `${slice.testMethodNamePrefix}case`
    ));
    const result = succeeded(
      part,
      testCodeWithMethods(
        `TaskServiceTmp1Part${part.partIndex}Test`,
        partNames
      )
    );
    result.candidate.ordinaryTestMethodCount = partNames.length;
    return result;
  });
  const completion = {
    parts: results,
    succeededPartCount: results.length,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const analyzerMethodIds = [];
  let repairRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      for (const [index, result] of results.entries()) {
        await onProgress(terminalEvent(index + 2, wave, result, 'part_succeeded'));
      }
      await onProgress(waveEvent(7, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 7,
        completion
      };
    },
    async mavenExecute() { return failedExecutionForTests(names); },
    getMethodRepairContext(_sessionId, request) {
      analyzerMethodIds.push(request.methodId);
      const slice = slices.find((item) => item.methodId === request.methodId);
      assert.ok(slice);
      return analyzerRepairContextForSlice(slice);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: '79797979-7979-4797-8797-797979797979',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairRequest = structuredClone(request);
        throw new Error('stop after twenty-five-method repair request');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /stop after twenty-five-method repair request/);

  assert.deepEqual(analyzerMethodIds, slices.map((slice) => slice.methodId));
  assert.deepEqual(
    [
      repairRequest.repairContext.targetMethod.methodId,
      ...repairRequest.repairContext.stackMethods.map((method) => method.methodId)
    ],
    slices.map((slice) => slice.methodId)
  );
});

test('class Wave repair ignores a shared helper frame and analyzes the concrete failing test method', async (t) => {
  const wave = classWorkWave();
  const names = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp1Part1Test', names)
  );
  result.candidate.ordinaryTestMethodCount = names.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  const analyzerMethodIds = [];
  let repairRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute() {
      const execution = failedExecution('');
      execution.testReport = undefined;
      execution.mavenExecutions[1].stderr = [
        'java.lang.AssertionError: beta failed',
        '\tat demo.TaskServiceTmp1Test.sharedHelper(TaskServiceTmp1Test.java:8)',
        '\tat demo.TaskServiceTmp1Test.m2_b1(TaskServiceTmp1Test.java:13)',
        '\tat demo.TaskService.beta(TaskService.java:40)'
      ].join('\n');
      return execution;
    },
    getMethodRepairContext(_sessionId, request) {
      analyzerMethodIds.push(request.methodId);
      const slice = wave.parts[0].methodSlices.find(
        (item) => item.methodId === request.methodId
      );
      assert.ok(slice);
      return analyzerRepairContextForSlice(slice);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: '78787878-7878-4787-8787-787878787878',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairRequest = structuredClone(request);
        throw new Error('stop after helper-frame repair request');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /stop after helper-frame repair request/);

  assert.deepEqual(analyzerMethodIds, [SECOND_METHOD_ID]);
  assert.equal(repairRequest.repairContext.targetMethod.methodId, SECOND_METHOD_ID);
  assert.deepEqual(repairRequest.repairContext.stackMethods, []);
});

test('class Wave compile repair maps an error line to the owning production method', async (t) => {
  const wave = classWorkWave();
  const names = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const partCode = testCodeWithMethods('TaskServiceTmp1Part1Test', names);
  // The Part merger renders a blank line between members; m2_b1 is line 13
  // in the complete candidate that Maven compiles.
  const betaLine = 13;
  const result = succeeded(wave.parts[0], partCode);
  result.candidate.ordinaryTestMethodCount = names.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  const analyzerMethodIds = [];
  let repairRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute(_input, { workspaceRoot }) {
      return compileFailedExecution(
        join(
          workspaceRoot,
          'module',
          'src',
          'test',
          'java',
          'demo',
          'TaskServiceTmp1Test.java'
        ),
        betaLine
      );
    },
    getMethodRepairContext(_sessionId, request) {
      analyzerMethodIds.push(request.methodId);
      const slice = wave.parts[0].methodSlices.find(
        (item) => item.methodId === request.methodId
      );
      assert.ok(slice);
      return analyzerRepairContextForSlice(slice);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: '88888888-8888-4888-8888-888888888888',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairRequest = structuredClone(request);
        throw new Error('stop after line-attributed repair request');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /stop after line-attributed repair request/);

  assert.deepEqual(analyzerMethodIds, [SECOND_METHOD_ID]);
  assert.equal(repairRequest.repairContext.targetMethod.methodId, SECOND_METHOD_ID);
  assert.deepEqual(repairRequest.repairContext.stackMethods, []);
});

test('class Wave compile repair retains every production method for a shared import error', async (t) => {
  const wave = classWorkWave();
  const names = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const partCode = testCodeWithMethods('TaskServiceTmp1Part1Test', names);
  const result = succeeded(wave.parts[0], partCode);
  result.candidate.ordinaryTestMethodCount = names.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  const analyzerMethodIds = [];
  let repairRequest;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute(_input, { workspaceRoot }) {
      return compileFailedExecution(
        join(
          workspaceRoot,
          'module',
          'src',
          'test',
          'java',
          'demo',
          'TaskServiceTmp1Test.java'
        ),
        2
      );
    },
    getMethodRepairContext(_sessionId, request) {
      analyzerMethodIds.push(request.methodId);
      const slice = wave.parts[0].methodSlices.find(
        (item) => item.methodId === request.methodId
      );
      assert.ok(slice);
      return analyzerRepairContextForSlice(slice);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: '99999999-9999-4999-8999-999999999999',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairRequest = structuredClone(request);
        throw new Error('stop after shared-error repair request');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /stop after shared-error repair request/);

  assert.deepEqual(analyzerMethodIds, [METHOD_ID, SECOND_METHOD_ID]);
  assert.equal(repairRequest.repairContext.targetMethod.methodId, METHOD_ID);
  assert.deepEqual(
    repairRequest.repairContext.stackMethods.map((method) => method.methodId),
    [SECOND_METHOD_ID]
  );
});

test('class Wave rejects pruned repair output and recovers with every planned test', async (t) => {
  const wave = classWorkWave();
  const initialNames = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const retainedNames = ['m1_a1', 'm1_a2', 'm2_b1'];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp1Part1Test', initialNames)
  );
  result.candidate.ordinaryTestMethodCount = initialNames.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  const retainedCode = testCodeWithMethods('TaskServiceTmp1Test', retainedNames).replace(
    '\n}',
    '\n  // [删除无用测试] m1_a3\n  // [删除无用测试] m2_b2\n}'
  );
  let recoveryCount = 0;
  let resumedSeedRequest;
  let repairResumeCount = 0;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute() {
      return failedExecution('m2_b1');
    },
    getMethodRepairContext() {
      throw new Error('fallback context');
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        recoveryCount += 1;
        if (recoveryCount === 2) {
          resumedSeedRequest = structuredClone(request);
          throw new Error('stop after resumed class Wave repair seed');
        }
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairResumeCount += 1;
        if (repairResumeCount === 1) {
          return {
            kind: 'candidate_ready',
            sessionId: '77777777-7777-4777-8777-777777777777',
            eventSequence: 2,
            candidate: {
              ...structuredClone(request),
              candidateId: request.candidateId,
              candidateVersion: 2,
              repairAttempt: 1,
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              batchIndex: 1,
              testCode: retainedCode,
              generatedCodeSha256: sha256(retainedCode),
              outputTestClassName: 'TaskServiceTmp1Test',
              ordinaryTestMethodCount: retainedNames.length,
              usage: null
            }
          };
        }
        throw new Error('simulated interruption after pruned class Wave repair');
      }
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /simulated interruption after pruned class Wave repair/);
  const crashed = structuredClone(h.savedWaves.at(-1));
  assert.equal(h.savedCandidates.at(-1).status, 'MODEL_REPAIR');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.deepEqual(
    h.repairCalls.map((request) => request.feedbackKind),
    ['execution', 'candidate_rejected']
  );
  assert.deepEqual(
    h.repairCalls[1].candidateRejection.violationCodes,
    ['TEST_METHOD_DELETED']
  );
  assert.deepEqual(
    h.repairCalls[1].candidateRejection.memberNames,
    ['m1_a3', 'm2_b2']
  );
  assert.match(h.repairCalls[1].candidateRejection.acceptedTestCode, /void m1_a3\(\)/);
  assert.match(h.repairCalls[1].candidateRejection.acceptedTestCode, /void m2_b2\(\)/);

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    crashed,
    new AbortController().signal
  ), /stop after resumed class Wave repair seed/);

  assert.equal(recoveryCount, 2);
  assert.equal(resumedSeedRequest.startRequest.batch.plannedTestMethods, initialNames.length);
  assert.deepEqual(
    resumedSeedRequest.startRequest.batch.methodSlices.map((slice) => [
      slice.methodId,
      slice.testMethodNamePrefix,
      slice.batch.plannedTestMethods
    ]),
    [[METHOD_ID, 'm1_', 3], [SECOND_METHOD_ID, 'm2_', 2]]
  );
  assert.deepEqual(
    resumedSeedRequest.startRequest.batch.methodSlices.map((slice) => (
      slice.batch.methodTestPlan.testMethodPlans.map((plan) => plan.testMethodPlanId)
    )),
    [
      ['m1_plan-1', 'm1_plan-2', 'm1_plan-3'],
      ['m2_plan-1', 'm2_plan-2']
    ]
  );
});
test('class Wave rejects a generated test that has no source-method prefix', async (t) => {
  const wave = classWorkWave();
  const names = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'missingPrefix'];
  const result = succeeded(
    wave.parts[0],
    testCodeWithMethods('TaskServiceTmp1Part1Test', names)
  );
  result.candidate.ordinaryTestMethodCount = names.length;
  const completion = {
    parts: [result], succeededPartCount: 1, failedPartCount: 0, cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, result, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    }
  });

  await assert.rejects(h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  ), /without a source-method prefix/);
});

test('resumes a persisted MODEL_REPAIR candidate with consumed repair attempts preserved', async (t) => {
  const wave = workWave(1);
  const code = testCode('TaskServiceTmp1Test', 'needsRepair');
  const repairedCode = code.replace(
    'void needsRepair() {}',
    'void needsRepair() { int repaired = 1; }'
  );
  const candidateId = '99999999-9999-4999-8999-000000000004';
  let seedRequest;
  const repairRequests = [];
  const h = await harness(t, {
    wave,
    async runWave() {
      throw new Error('MODEL_REPAIR recovery must not regenerate');
    },
    async mavenExecute(_input, { callIndex }) {
      return callIndex === 1
        ? failedExecution('needsRepair', 'fourth repair still failing')
        : passedExecution(1);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seedRequest = structuredClone(request);
        assert.equal(request.candidate.candidateVersion, 5);
        assert.equal(request.candidate.repairAttempt, 4);
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-000000000004',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairRequests.push(structuredClone(request));
        if (request.execution.status === 'passed') {
          assert.equal(request.candidateVersion, 6);
          assert.equal(request.repairAttempt, 5);
          return {
            kind: 'completed',
            sessionId: '77777777-7777-4777-8777-000000000004',
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: candidateId,
              aggregateUsage: null,
              modelCallCount: 1,
              usageReportedCallCount: 0
            }
          };
        }
        assert.equal(request.candidateVersion, 5);
        assert.equal(request.repairAttempt, 4);
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-000000000004',
          eventSequence: 2,
          candidate: {
            ...seedRequest.candidate,
            candidateVersion: 6,
            repairAttempt: 5,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });
  const filePath = join(
    h.workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'demo',
    'TaskServiceTmp1Test.java'
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, code, 'utf8');
  h.candidateStates.set(candidateId, {
    candidateId,
    methodId: wave.methodId,
    waveId: wave.waveBatchId,
    status: 'MODEL_REPAIR',
    llmRepairAttemptsUsed: 4,
    repairAttemptLimit: 8,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-before-pause',
    stableRepair: {
      phase: 'NOT_STARTED',
      iteration: 0,
      annotatedMemberIds: []
    },
    managedFile: {
      path: filePath,
      sha256: sha256(code),
      location: 'PROJECT'
    },
    moveTransaction: null
  });
  const active = activeWaveCheckpoint(wave);
  Object.assign(active.parts[0], {
    status: 'SUCCEEDED',
    childSessionId: '33333333-3333-4333-8333-000000000001',
    candidateId: '22222222-2222-4222-8222-000000000001',
    isolatedFilePath: join(h.workspaceRoot, '.ai-unit-test', 'part.java'),
    fileSha256: 'f'.repeat(64)
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    active,
    new AbortController().signal
  );

  assert.equal(repairRequests.length, 2);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 5);
  assert.deepEqual(outcome.candidateIds, [candidateId]);
});
test('resumes stable repair from its persisted iteration without model calls or a MAVEN_RUNNING downgrade', async (t) => {
  const wave = workWave(1);
  const code = testCode('TaskServiceTmp1Test', 'retained');
  const candidateId = '99999999-9999-4999-8999-999999999999';
  let stableInput;
  const h = await harness(t, {
    wave,
    async runWave() {
      throw new Error('stable repair recovery must not regenerate');
    },
    async mavenExecute() {
      return failedExecution('retained', 'still failing');
    },
    serviceOverrides: {
      stableRepair: {
        async repair(input) {
          stableInput = input;
          assert.equal(h.savedCandidates.at(-1).status, 'STABLE_REPAIR');
          await input.saveCheckpoint({
            phase: 'PASSED',
            iteration: 3,
            annotatedMemberIds: ['method:retained:3']
          });
          return {
            status: 'passed',
            code: input.code,
            execution: passedExecution(1),
            phase: 'PASSED',
            iteration: 3,
            annotatedMemberIds: ['method:retained:3']
          };
        }
      }
    }
  });
  const filePath = join(
    h.workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'demo',
    'TaskServiceTmp1Test.java'
  );
  await mkdir(join(
    h.workspaceRoot,
    'module',
    'src',
    'test',
    'java',
    'demo'
  ), { recursive: true });
  await writeFile(filePath, code, 'utf8');
  h.candidateStates.set(candidateId, {
    candidateId,
    methodId: wave.methodId,
    waveId: wave.waveBatchId,
    status: 'STABLE_REPAIR',
    llmRepairAttemptsUsed: 5,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    lastMavenBatchId: 'maven-batch-before-crash',
    stableRepair: {
      phase: 'TEST_METHODS',
      iteration: 2,
      annotatedMemberIds: ['method:retained:3']
    },
    managedFile: {
      path: filePath,
      sha256: sha256(code),
      location: 'PROJECT'
    },
    moveTransaction: null
  });
  const active = activeWaveCheckpoint(wave);
  Object.assign(active.parts[0], {
    status: 'SUCCEEDED',
    childSessionId: '33333333-3333-4333-8333-000000000001',
    candidateId: '22222222-2222-4222-8222-000000000001',
    isolatedFilePath: join(h.workspaceRoot, '.ai-unit-test', 'part.java'),
    fileSha256: 'f'.repeat(64)
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    active,
    new AbortController().signal
  );

  assert.equal(stableInput.initialIteration, 2);
  assert.deepEqual(stableInput.annotatedMemberIds, ['method:retained:3']);
  assert.equal(h.repairCalls.length, 0);
  assert.equal(h.modelLogRecords.length, 0);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(
    h.savedCandidates.some((candidate) => candidate.status === 'MAVEN_RUNNING'),
    false
  );
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.deepEqual(outcome.candidateIds, [candidateId]);
});

test('routes a merged Wave candidate through READY queue and leaves a passing TMP in the project', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const readyRequests = [];
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute() {
      throw new Error('the Wave path must not execute Maven directly');
    },
    serviceOverrides: {
      mavenReadyQueue: {
        async enqueue(request) {
          readyRequests.push(request);
          await assert.rejects(access(request.projectFilePath));
          await access(request.isolationFilePath);
          await request.onBatchStart('maven-batch-1');
          await request.activate();
          await access(request.projectFilePath);
          await assert.rejects(access(request.isolationFilePath));
          return {
            candidateId: request.candidateId,
            ...passedExecution(1),
            trace: {
              mavenBatchId: 'maven-batch-1',
              moduleRoot: request.moduleRoot,
              startedAt: '2026-08-19T00:00:10.000Z',
              completedAt: '2026-08-19T00:00:12.000Z',
              durationMs: 2_000,
              candidates: [{
                candidateId: request.candidateId,
                filePath: request.filePath,
                qualifiedTestClassName: request.qualifiedTestClassName
              }],
              steps: [{
                sequence: 1,
                candidateIds: [request.candidateId],
                phase: 'test_compile',
                command: 'mvn test-compile',
                exitCode: 0,
                stdout: '',
                stderr: '',
                surefireReports: [],
                attribution: null,
                fallback: 'NONE'
              }],
              results: [{ candidateId: request.candidateId, status: 'passed' }]
            }
          };
        }
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(readyRequests.length, 1);
  assert.equal(h.mavenInputs.length, 0);
  assert.equal(outcome.candidateIds.length, 1);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).managedFile.location, 'PROJECT');
  assert.equal(h.mavenBatchLogs.length, 1);
  assert.equal(h.mavenBatchLogs[0].waveIndex, 1);
  assert.equal(h.mavenBatchLogs[0].candidateId, outcome.candidateIds[0]);
  assert.equal(h.mavenBatchLogs[0].trace.mavenBatchId, 'maven-batch-1');
  await access(h.savedCandidates.at(-1).managedFile.path);
});

test('keeps one Wave checkpoint and Maven identity while Agent rotates repaired candidate IDs', async (t) => {
  const wave = workWave(1);
  const initialCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  private String shared = "before";',
    '  @Test void generated() { MissingType value = null; }',
    '}',
    ''
  ].join('\n');
  const partResult = succeeded(wave.parts[0], initialCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '  private Object shared = "after";',
    '  @Test void generated() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const secondRepairedCode = repairedCode.replace(
    'assertTrue(true)',
    'assertEquals(1, 1)'
  );
  const firstAgentRepairCandidateId = '88888888-8888-4888-8888-888888888888';
  const secondAgentRepairCandidateId = '99999999-9999-4999-8999-999999999999';
  const readyRequests = [];
  let repairCandidateId;
  let repairResumeCount = 0;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        repairCandidateId = request.candidate.candidateId;
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairResumeCount += 1;
        if (repairResumeCount === 1) {
          const firstReady = readyRequests[0];
          await access(firstReady.isolationFilePath);
          await assert.rejects(access(firstReady.projectFilePath));
          assert.deepEqual(request.repairContext.compilerErrors, [{
            filePath: `/${firstReady.projectFilePath.replace(/\\/g, '/')}`,
            line: 7,
            column: 15,
            category: 'cannot_find_symbol',
            message: 'cannot find symbol; symbol: class MissingType'
          }]);
          assert.equal(request.candidateId, repairCandidateId);
          return {
            kind: 'candidate_ready',
            sessionId: '77777777-7777-4777-8777-777777777777',
            eventSequence: 2,
            candidate: {
              candidateId: firstAgentRepairCandidateId,
              candidateVersion: 2,
              repairAttempt: 1,
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              batchIndex: 1,
              testCode: repairedCode,
              generatedCodeSha256: sha256(repairedCode),
              outputTestClassName: 'TaskServiceTmp1Test',
              ordinaryTestMethodCount: 1,
              usage: null
            }
          };
        }
        if (repairResumeCount === 2) {
          assert.equal(request.candidateId, firstAgentRepairCandidateId);
          return {
            kind: 'candidate_ready',
            sessionId: '77777777-7777-4777-8777-777777777777',
            eventSequence: 3,
            candidate: {
              candidateId: secondAgentRepairCandidateId,
              candidateVersion: 3,
              repairAttempt: 2,
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              batchIndex: 1,
              testCode: secondRepairedCode,
              generatedCodeSha256: sha256(secondRepairedCode),
              outputTestClassName: 'TaskServiceTmp1Test',
              ordinaryTestMethodCount: 1,
              usage: null
            }
          };
        }
        assert.equal(request.candidateId, secondAgentRepairCandidateId);
        return {
          kind: 'completed',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 4,
          completion: {
            stopReason: 'verified',
            aggregateUsage: null,
            modelCallCount: 1,
            usageReportedCallCount: 0
          }
        };
      }
    },
    async mavenExecute() {
      throw new Error('the Wave repair path must not execute Maven directly');
    },
    serviceOverrides: {
      mavenReadyQueue: {
        async enqueue(request) {
          readyRequests.push(request);
          repairCandidateId ??= request.candidateId;
          assert.equal(request.candidateId, repairCandidateId);
          await access(request.isolationFilePath);
          await assert.rejects(access(request.projectFilePath));
          if (readyRequests.length > 1) {
            assert.equal(
              h.savedCandidates.at(-1).managedFile.location,
              'ISOLATED',
              'rewriting an isolated repair candidate must not change its persisted location'
            );
          }
          await request.onBatchStart(`maven-batch-${readyRequests.length}`);
          await request.activate();
          if (readyRequests.length <= 2) {
            await access(request.projectFilePath);
            await assert.rejects(access(request.isolationFilePath));
            await request.isolate();
            return {
              candidateId: request.candidateId,
              status: 'compile_failed',
              mavenExecutions: [{
                scope: 'method_candidate',
                phase: 'test_compile',
                command: 'mvn test-compile',
                exitCode: 1,
                stdout: [
                  `[ERROR] /${request.projectFilePath.replace(/\\/g, '/')}:[7,15] cannot find symbol`,
                  '[ERROR] symbol: class MissingType'
                ].join('\n'),
                stderr: '',
                surefireReports: []
              }]
            };
          }
          await access(request.projectFilePath);
          await assert.rejects(access(request.isolationFilePath));
          return {
            candidateId: request.candidateId,
            ...passedExecution(1)
          };
        }
      }
    }
  });

  await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(readyRequests.length, 3);
  assert.equal(h.mavenInputs.length, 0);
  assert.equal(h.repairCalls.length, 3);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 2);
  assert.equal(h.savedCandidates.at(-1).managedFile.location, 'PROJECT');
});

test('an attributed fork crash without Surefire XML enters Wave model repair', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'startsApplication')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = testCode('TaskServiceTmp1Test', 'startsApplication').replace(
    'void startsApplication() {}',
    'void startsApplication() { int isolatedStartup = 1; }'
  );
  const readyRequests = [];
  let repairCandidateId;
  let repairResumeCount = 0;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        repairCandidateId = request.candidate.candidateId;
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairResumeCount += 1;
        if (repairResumeCount === 1) {
          assert.equal(request.candidateId, repairCandidateId);
          assert.equal(request.execution.status, 'test_failed');
          assert.equal('testReport' in request.execution, false);
          assert.match(
            request.execution.mavenExecutions.at(-1).stdout,
            /Crashed tests:/
          );
          return {
            kind: 'candidate_ready',
            sessionId: '77777777-7777-4777-8777-777777777777',
            eventSequence: 2,
            candidate: {
              candidateId: '88888888-8888-4888-8888-888888888888',
              candidateVersion: 2,
              repairAttempt: 1,
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              batchIndex: 1,
              testCode: repairedCode,
              generatedCodeSha256: sha256(repairedCode),
              outputTestClassName: 'TaskServiceTmp1Test',
              ordinaryTestMethodCount: 1,
              usage: null
            }
          };
        }
        assert.equal(request.candidateId, '88888888-8888-4888-8888-888888888888');
        assert.equal(request.execution.status, 'passed');
        return {
          kind: 'completed',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 3,
          completion: {
            stopReason: 'verified',
            aggregateUsage: null,
            modelCallCount: 1,
            usageReportedCallCount: 0
          }
        };
      }
    },
    async mavenExecute() {
      throw new Error('the Wave repair path must not execute Maven directly');
    },
    serviceOverrides: {
      mavenReadyQueue: {
        async enqueue(request) {
          readyRequests.push(request);
          repairCandidateId ??= request.candidateId;
          assert.equal(request.candidateId, repairCandidateId);
          await request.onBatchStart(`maven-batch-${readyRequests.length}`);
          await request.activate();
          if (readyRequests.length === 1) {
            await request.isolate();
            return {
              candidateId: request.candidateId,
              status: 'test_failed',
              mavenExecutions: [{
                scope: 'method_candidate',
                phase: 'test_compile',
                command: 'mvn test-compile',
                exitCode: 0,
                stdout: '',
                stderr: '',
                surefireReports: []
              }, {
                scope: 'method_candidate',
                phase: 'test',
                command: 'mvn surefire:test',
                exitCode: 1,
                stdout: [
                  'java.lang.IllegalStateException: application startup failed',
                  '\\tat demo.TaskService.main(TaskService.java:43)',
                  '\\tat demo.TaskServiceTmp1Test.startsApplication(TaskServiceTmp1Test.java:23)',
                  '[ERROR] The forked VM terminated without properly saying goodbye.',
                  '[ERROR] Crashed tests:',
                  '[ERROR] demo.TaskServiceTmp1Test'
                ].join('\n'),
                stderr: '',
                surefireReports: []
              }]
            };
          }
          return {
            candidateId: request.candidateId,
            ...passedExecution(1)
          };
        }
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(readyRequests.length, 2);
  assert.equal(h.repairCalls.length, 2);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).managedFile.location, 'PROJECT');
  assert.equal(outcome.candidateIds.length, 1);
});

test('an unproven READY result stays isolated and never consumes a model repair attempt', async (t) => {
  const wave = workWave(1);
  const partResult = succeeded(
    wave.parts[0],
    testCode('TaskServiceTmp1Part1Test', 'generated')
  );
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    serviceOverrides: {
      mavenReadyQueue: {
        async enqueue(request) {
          await request.onBatchStart('maven-batch-unproven');
          await request.activate();
          await request.isolate();
          return {
            candidateId: request.candidateId,
            status: 'unproven',
            mavenExecutions: []
          };
        }
      }
    }
  });

  await assert.rejects(
    h.service.executeWave(
      h.task,
      wave,
      { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
      activeWaveCheckpoint(wave),
      new AbortController().signal
    ),
    /could not prove/i
  );

  assert.equal(h.repairCalls.length, 0);
  assert.ok(h.savedCandidates.every((item) => item.llmRepairAttemptsUsed === 0));
  assert.equal(h.savedCandidates.at(-1).managedFile.location, 'ISOLATED');
  await access(h.savedCandidates.at(-1).managedFile.path);
});

test('all model-failed Parts remain pending without creating a TMP or running Maven', async (t) => {
  const wave = workWave(2);
  const first = failed(wave.parts[0]);
  const second = failed(wave.parts[1]);
  const completion = {
    parts: [first, second],
    succeededPartCount: 0,
    failedPartCount: 2,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_failed'));
      await onProgress(terminalEvent(3, wave, second, 'part_failed'));
      await onProgress(waveEvent(4, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 4,
        completion
      };
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.deepEqual(outcome, {
    completedScenarioIds: [],
    skippedScenarioIds: [],
    candidateIds: [],
    modelFailure: {
      code: 'MODEL_FAILED',
      message: 'provider failed',
      stage: 'generation'
    }
  });
  assert.equal(h.mavenInputs.length, 0);
  assert.deepEqual(h.savedCandidates, []);
  assert.equal(h.savedWaves.at(-1).waveSessionId, null);
  assert.match(h.savedWaves.at(-1).recoveryRequestId, /^[0-9a-f-]{36}$/);
});

test('all invalid successful Parts remain retryable without consuming scenarios', async (t) => {
  const wave = workWave(2);
  const first = succeeded(
    wave.parts[0],
    'package demo; public class TaskServiceTmp1Part1Test {'
  );
  const second = succeeded(
    wave.parts[1],
    'package demo; public class TaskServiceTmp1Part2Test {'
  );
  const completion = {
    parts: [first, second],
    succeededPartCount: 2,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, first, 'part_succeeded'));
      await onProgress(terminalEvent(3, wave, second, 'part_succeeded'));
      await onProgress(waveEvent(4, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 4,
        completion
      };
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.deepEqual(outcome.completedScenarioIds, []);
  assert.deepEqual(outcome.skippedScenarioIds, []);
  assert.deepEqual(outcome.candidateIds, []);
  assert.deepEqual(outcome.modelFailure, {
    code: 'GENERATED_TEST_INVALID',
    message: '生成的测试代码无效，没有可用的测试候选。',
    stage: 'generation'
  });
  assert.equal(h.mavenInputs.length, 0);
  assert.deepEqual(h.savedCandidates, []);
  assert.equal(h.savedWaves.at(-1).waveSessionId, null);
  assert.match(h.savedWaves.at(-1).recoveryRequestId, /^[0-9a-f-]{36}$/);
});

test('merged repair retains the ordered union of accepted Parts type API members', async (t) => {
  const wave = workWave(3);
  wave.parts[0].referencedTypes = [{
    qualifiedName: 'demo.Shared', kind: 'CLASS', constructors: ['public Shared()'],
    methods: ['public void setFirst(String)', 'public String common()'], enumConstants: []
  }, {
    qualifiedName: 'demo.Mode', kind: 'ENUM', constructors: [], methods: [], enumConstants: ['FIRST']
  }];
  wave.parts[1].referencedTypes = [{
    qualifiedName: 'demo.Shared', kind: 'CLASS',
    constructors: ['public Shared()', 'public Shared(String)'],
    methods: ['public String common()', 'public void setSecond(int)'], enumConstants: []
  }, {
    qualifiedName: 'demo.Mode', kind: 'ENUM', constructors: [], methods: [], enumConstants: ['FIRST', 'SECOND']
  }, {
    qualifiedName: 'other.Shared', kind: 'CLASS', constructors: [],
    methods: ['public boolean onlyOtherPackage()'], enumConstants: []
  }];
  wave.parts[2].referencedTypes = [{
    qualifiedName: 'demo.Shared', kind: 'CLASS', constructors: [],
    methods: ['public void excludedFailedPart()'], enumConstants: []
  }];
  const before = structuredClone(wave);
  const results = [
    succeeded(wave.parts[0], testCode('TaskServiceTmp1Part1Test', 'first')),
    succeeded(wave.parts[1], testCode('TaskServiceTmp1Part2Test', 'second')),
    nonModelFailed(wave.parts[2])
  ];
  const completion = { parts: results, succeededPartCount: 2, failedPartCount: 1, cancelledPartCount: 0 };
  let recovery;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      for (const [index, result] of results.entries()) {
        await onProgress(terminalEvent(index + 2, wave, result,
          result.status === 'succeeded' ? 'part_succeeded' : 'part_failed'));
      }
      await onProgress(waveEvent(5, wave, 'wave_completed', { completion }));
      return { waveSessionId: '44444444-4444-4444-8444-444444444444', eventSequence: 5, completion };
    },
    async mavenExecute() { return failedExecution('first'); },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        recovery = structuredClone(request);
        throw new Error('stop after inspecting the real merged repair request');
      }
    }
  });
  await assert.rejects(h.service.executeWave(h.task, wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave), new AbortController().signal), /stop after inspecting/);
  assert.deepEqual(recovery.startRequest.batch.referencedTypes, [{
    qualifiedName: 'demo.Shared', kind: 'CLASS',
    constructors: ['public Shared()', 'public Shared(String)'],
    methods: ['public void setFirst(String)', 'public String common()', 'public void setSecond(int)'],
    enumConstants: []
  }, {
    qualifiedName: 'demo.Mode', kind: 'ENUM', constructors: [], methods: [], enumConstants: ['FIRST', 'SECOND']
  }, {
    qualifiedName: 'other.Shared', kind: 'CLASS', constructors: [],
    methods: ['public boolean onlyOtherPackage()'], enumConstants: []
  }]);
  assert.equal(recovery.startRequest.batchId, WAVE_ID);
  assert.equal(recovery.startRequest.methodId, METHOD_ID);
  assert.equal(recovery.startRequest.batch.plannedTestMethods, 2);
  assert.deepEqual(recovery.startRequest.batch.scenarios.map((item) => item.scenarioId), ['scenario-1', 'scenario-2']);
  assert.deepEqual(wave, before, 'merging must not modify prepared Part facts');
});

test('a merged Wave candidate uses one seeded repair session and increments only the real model repair request', async (t) => {
  const wave = workWave(1);
  const initialCode = testCode('TaskServiceTmp1Part1Test', 'generated');
  const partResult = succeeded(wave.parts[0], initialCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '  @Test void generated() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  let seed;
  let candidateId;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(_input, { callIndex }) {
      return callIndex === 1
        ? failedExecution('generated')
        : passedExecution(1);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seed = request;
        candidateId = request.candidate.candidateId;
        assert.equal(request.startRequest.batchId, WAVE_ID);
        assert.equal(request.startRequest.batch.plannedTestMethods, 1);
        assert.equal(request.candidate.outputTestClassName, 'TaskServiceTmp1Test');
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        if (request.execution.status === 'passed') {
          return {
            kind: 'completed',
            sessionId: '77777777-7777-4777-8777-777777777777',
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: candidateId,
              aggregateUsage: null,
              modelCallCount: 1,
              usageReportedCallCount: 0
            }
          };
        }
        assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
        return {
          kind: 'candidate_ready',
          sessionId: '77777777-7777-4777-8777-777777777777',
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.repairCalls.length, 2, 'the pass acknowledgement is not a repair attempt');
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
  assert.deepEqual(h.repairAcknowledgements, [{
    sessionId: '77777777-7777-4777-8777-777777777777',
    sequence: 3
  }]);
});

test('a five-Part Wave with twenty-eight merged tests enters one seeded repair session', async (t) => {
  const planCounts = [6, 6, 6, 5, 5];
  const wave = workWave(planCounts.length);
  const partResults = wave.parts.map((part, partOffset) => {
    const planCount = planCounts[partOffset];
    for (let ordinal = 2; ordinal <= planCount; ordinal += 1) {
      const groupId = `group-${part.partIndex}-${ordinal}`;
      part.methodTestPlan.testPathGroups.push({
        ...structuredClone(part.methodTestPlan.testPathGroups[0]),
        groupId,
        ordinal
      });
      part.methodTestPlan.testMethodPlans.push({
        testMethodPlanId: `plan-${part.partIndex}-${ordinal}`,
        methodId: METHOD_ID,
        ordinal,
        pathGroupIds: [groupId],
        status: 'COMPLETE'
      });
    }
    part.methodTestPlan.minimumTestCount = planCount;
    const code = testCodeWithMethods(
      `TaskServiceTmp1Part${part.partIndex}Test`,
      Array.from(
        { length: planCount },
        (_, methodOffset) => `generated${part.partIndex}_${methodOffset + 1}`
      )
    );
    const result = succeeded(part, code);
    result.candidate.ordinaryTestMethodCount = planCount;
    return result;
  });
  const completion = {
    parts: partResults,
    succeededPartCount: partResults.length,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let seededRepairRequest;
  let candidateId;
  const h = await harness(t, {
    wave,
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      for (const [offset, result] of partResults.entries()) {
        await onProgress(terminalEvent(offset + 2, wave, result, 'part_succeeded'));
      }
      await onProgress(waveEvent(7, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 7,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(_input, { callIndex }) {
      return callIndex === 1
        ? failedExecution('generated1_1')
        : passedExecution(28);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seededRepairRequest = request;
        candidateId = request.candidate.candidateId;
        return {
          kind: 'candidate_ready',
          sessionId: '88888888-8888-4888-8888-888888888888',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        if (request.execution.status === 'passed') {
          return {
            kind: 'completed',
            sessionId: '88888888-8888-4888-8888-888888888888',
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: candidateId,
              aggregateUsage: null,
              modelCallCount: 1,
              usageReportedCallCount: 0
            }
          };
        }
        const repairedCode = request.effectiveTestCode.replace(
          /\n\}\s*$/u,
          '\n  // repaired\n}\n'
        );
        return {
          kind: 'candidate_ready',
          sessionId: '88888888-8888-4888-8888-888888888888',
          eventSequence: 2,
          candidate: {
            ...seededRepairRequest.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(seededRepairRequest.startRequest.batch.plannedTestMethods, 28);
  assert.equal(
    seededRepairRequest.startRequest.batch.methodTestPlan.testMethodPlans.length,
    28
  );
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(outcome.completedScenarioIds.length, 5);
});

test('RAG Wave repair prepares indexed evidence and sends it on the single repair request', async (t) => {
  const wave = classWorkWave();
  const methodNames = ['m1_a1', 'm1_a2', 'm1_a3', 'm2_b1', 'm2_b2'];
  const partCode = testCodeWithMethods('TaskServiceTmp1Part1Test', methodNames);
  const partResult = succeeded(wave.parts[0], partCode);
  partResult.candidate.ordinaryTestMethodCount = methodNames.length;
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = partCode
    .replaceAll('TaskServiceTmp1Part1Test', 'TaskServiceTmp1Test')
    .replace(
      '@Test void m2_b1() {}',
      '@Test void m2_b1() { org.junit.jupiter.api.Assertions.assertTrue(true); }'
    );
  const activeIndex = {
    workspaceId: 'd'.repeat(64),
    scopeId: 'e'.repeat(64),
    indexVersion: 2,
    sourceSetId: 'f'.repeat(64),
    requestedSourceSetFingerprint: '1'.repeat(64),
    allowedFqns: ['demo.TaskService']
  };
  const ragContext = {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: ['D:\\work\\module\\target\\classes'],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: '2'.repeat(64)
    },
    activeIndex
  };
  const ragSubscription = {
    context: ragContext,
    ready: Promise.resolve(),
    async release() {}
  };
  const ragEmbeddingConfig = {
    provider: 'custom_openai',
    model: 'embedding-model',
    baseUrl: 'https://embeddings.example/v1',
    credentials: { apiKey: 'embedding-secret' }
  };
  let seed;
  let candidateId;
  const refreshes = [];
  const h = await harness(t, {
    wave,
    taskOverrides: { ragEnabled: true },
    contextOverrides: {
      ragContext,
      ragSubscription,
      ragEmbeddingConfig
    },
    serviceOverrides: {
      ragIndexCoordinator: {
        async refresh(subscription, requestedFqns, _signal, requestedMethods) {
          refreshes.push({
            subscription,
            requestedFqns: [...requestedFqns],
            requestedMethods: structuredClone(requestedMethods)
          });
          return {
            status: 'reused',
            vectorStatus: 'ready',
            workspaceId: activeIndex.workspaceId,
            scopeId: activeIndex.scopeId,
            buildFingerprint: ragContext.scope.buildFingerprint,
            pageCount: 1,
            addedCount: 0,
            updatedCount: 0,
            deletedCount: 0,
            skippedDependencyCount: 0,
            degradationCode: null
          };
        }
      }
    },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext(_sessionId, request) {
      assert.equal(request.methodId, SECOND_METHOD_ID);
      return analyzerRepairContextForSlice(wave.parts[0].methodSlices[1]);
    },
    async mavenExecute(_input, { callIndex }) {
      if (callIndex !== 1) return passedExecution(5);
      const failed = failedExecution('m2_b1');
      failed.testReport.failureDetails[0].detail = [
        'java.lang.AssertionError: beta failed',
        '\tat demo.TaskServiceTmp1Test.sharedHelper(TaskServiceTmp1Test.java:8)',
        '\tat demo.TaskServiceTmp1Test.m2_b1(TaskServiceTmp1Test.java:13)',
        '\tat demo.TaskService.beta(TaskService.java:40)'
      ].join('\n');
      return failed;
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seed = request;
        candidateId = request.candidate.candidateId;
        assert.deepEqual(request.startRequest.ragContext, ragContext);
        return {
          kind: 'candidate_ready',
          sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async prepareRagRepair(_sessionId, request) {
        assert.equal(request.candidateId, candidateId);
        assert.equal(request.methodId, METHOD_ID);
        assert.equal(request.execution.status, 'test_failed');
        assert.equal(request.repairContext?.status, 'test_failed');
        assert.deepEqual(request.repairContext?.affectedTestNames, ['m2_b1']);
        assert.equal(request.repairContext?.targetMethod.methodName, 'beta');
        return {
          status: 'attributable',
          diagnosticFingerprint: '3'.repeat(64),
          requestedFqns: ['demo.DirectDependency'],
          requestedMethods: [{
            ownerFqn: 'demo.TaskService',
            methodName: 'beta',
            descriptor: wave.parts[0].methodSlices[1].batch.method.descriptor,
            sourceLine: null
          }],
          originalDiagnosticText: 'm2_b1 failed',
          targetMethodKey: 'demo.TaskService#beta()V',
          degradationCode: null
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        if (request.execution.status === 'passed') {
          return {
            kind: 'completed',
            sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: candidateId,
              aggregateUsage: null,
              modelCallCount: 1,
              usageReportedCallCount: 0
            }
          };
        }
        assert.equal('repairContext' in request, false);
        assert.deepEqual(request.ragRepairAttempt, {
          diagnosticFingerprint: '3'.repeat(64),
          activeIndex
        });
        assert.deepEqual(request.ragEmbeddingConfig, ragEmbeddingConfig);
        return {
          kind: 'candidate_ready',
          sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });

  await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(h.ragPrepareRequests.length, 1);
  assert.deepEqual(refreshes, [{
    subscription: ragSubscription,
    requestedFqns: ['demo.DirectDependency'],
    requestedMethods: [{
      ownerFqn: 'demo.TaskService',
      methodName: 'beta',
      descriptor: wave.parts[0].methodSlices[1].batch.method.descriptor,
      sourceLine: null
    }]
  }]);
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
});

test('scope-changing Wave repair is written and Maven-run as the next execution attempt', async (t) => {
  const wave = workWave(1);
  const partCode = testCode('TaskServiceTmp1Part1Test', 'generated');
  const partResult = succeeded(wave.parts[0], partCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const acceptedCode = partCode.replaceAll(
    'TaskServiceTmp1Part1Test',
    'TaskServiceTmp1Test'
  );
  const rejectedCode = acceptedCode.replace(
    '\n}',
    '\n  private void unrelatedHelper() {}\n}'
  );
  let seed;
  let candidateId;
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 2 },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(_input, { callIndex }) {
      return callIndex === 1
        ? failedExecution('generated')
        : passedExecution(1);
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seed = request;
        candidateId = request.candidate.candidateId;
        return {
          kind: 'candidate_ready',
          sessionId: '99999999-9999-4999-8999-999999999999',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        if (request.execution.status === 'passed') {
          return {
            kind: 'completed',
            sessionId: '99999999-9999-4999-8999-999999999999',
            eventSequence: 4,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'verified',
              bestCandidateId: candidateId,
              aggregateUsage: null,
              modelCallCount: 2,
              usageReportedCallCount: 0
            }
          };
        }
        assert.notEqual(request.feedbackKind, 'candidate_rejected');
        assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
        return {
          kind: 'candidate_ready',
          sessionId: '99999999-9999-4999-8999-999999999999',
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: rejectedCode,
            generatedCodeSha256: sha256(rejectedCode)
          }
        };
      }
    }
  });

  await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(
    h.repairCalls.map((request) => request.feedbackKind),
    ['execution', 'execution']
  );
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  const finalCode = await readFile(h.savedCandidates.at(-1).managedFile.path, 'utf8');
  assert.match(finalCode, /unrelatedHelper/);
});

test('the final scope-changing Wave repair runs Maven before stable repair', async (t) => {
  const wave = workWave(1);
  wave.parts[0].methodTestPlan.minimumTestCount = 2;
  wave.parts[0].methodTestPlan.testPathGroups.push({
    ...structuredClone(wave.parts[0].methodTestPlan.testPathGroups[0]),
    groupId: 'group-1-b',
    ordinal: 2
  });
  wave.parts[0].methodTestPlan.testMethodPlans.push({
    testMethodPlanId: 'plan-1-b',
    methodId: METHOD_ID,
    ordinal: 2,
    pathGroupIds: ['group-1-b'],
    status: 'COMPLETE'
  });
  const partCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void broken() { org.junit.jupiter.api.Assertions.fail("broken"); }',
    '  @Test void remainsActive() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const partResult = {
    ...succeeded(wave.parts[0], partCode),
    candidate: {
      ...candidate(wave.parts[0], partCode),
      ordinaryTestMethodCount: 2
    }
  };
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const acceptedCode = partCode.replaceAll(
    'TaskServiceTmp1Part1Test',
    'TaskServiceTmp1Test'
  );
  const rejectedCode = acceptedCode.replace(
    '\n}',
    '\n  private void unrelatedHelper() {}\n}'
  );
  let seed;
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 1 },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(input, { callIndex, workspaceRoot }) {
      if (callIndex === 1) return failedExecution('broken');
      if (callIndex === 2) {
        assert.equal(input.scope, 'method_candidate');
        const repaired = await readFile(join(
          workspaceRoot,
          'module',
          'src',
          'test',
          'java',
          'demo',
          'TaskServiceTmp1Test.java'
        ), 'utf8');
        assert.match(repaired, /unrelatedHelper/);
        return failedExecution('broken');
      }
      assert.equal(input.scope, 'pruned_method_candidate');
      const code = await readFile(join(
        workspaceRoot,
        'module',
        'src',
        'test',
        'java',
        'demo',
        'TaskServiceTmp1Test.java'
      ), 'utf8');
      assert.match(code, /\/\/ TODO 当前测试方法需要修复\n\s*\/\/ @Test/);
      assert.match(code, /void remainsActive\(\)/);
      assert.match(code, /unrelatedHelper/);
      return passedExecution(1, 'pruned_method_candidate');
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seed = request;
        return {
          kind: 'candidate_ready',
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        assert.equal(request.feedbackKind, 'execution');
        return {
          kind: 'candidate_ready',
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: rejectedCode,
            generatedCodeSha256: sha256(rejectedCode)
          }
        };
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(h.repairCalls.length, 1);
  assert.equal(h.mavenInputs.length, 3);
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.equal(h.savedCandidates.at(-1).stableRepair.phase, 'PASSED');
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
});

test('Agent exhaustion after a scope-changing Maven attempt stabilizes that attempted code', async (t) => {
  const wave = workWave(1);
  wave.parts[0].methodTestPlan.minimumTestCount = 2;
  wave.parts[0].methodTestPlan.testPathGroups.push({
    ...structuredClone(wave.parts[0].methodTestPlan.testPathGroups[0]),
    groupId: 'group-1-b',
    ordinal: 2
  });
  wave.parts[0].methodTestPlan.testMethodPlans.push({
    testMethodPlanId: 'plan-1-b',
    methodId: METHOD_ID,
    ordinal: 2,
    pathGroupIds: ['group-1-b'],
    status: 'COMPLETE'
  });
  const partCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void broken() { org.junit.jupiter.api.Assertions.fail("broken"); }',
    '  @Test void remainsActive() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const partResult = {
    ...succeeded(wave.parts[0], partCode),
    candidate: {
      ...candidate(wave.parts[0], partCode),
      ordinaryTestMethodCount: 2
    }
  };
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const acceptedCode = partCode.replaceAll(
    'TaskServiceTmp1Part1Test',
    'TaskServiceTmp1Test'
  );
  const rejectedCode = acceptedCode.replace(
    '\n}',
    '\n  private void unrelatedHelper() {}\n}'
  );
  let seed;
  let repairResumeCount = 0;
  const repairSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 2 },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(input, { callIndex, workspaceRoot }) {
      if (callIndex === 1) return failedExecution('broken');
      if (callIndex === 2) {
        assert.equal(input.scope, 'method_candidate');
        const repaired = await readFile(join(
          workspaceRoot,
          'module',
          'src',
          'test',
          'java',
          'demo',
          'TaskServiceTmp1Test.java'
        ), 'utf8');
        assert.match(repaired, /unrelatedHelper/);
        return failedExecution('broken');
      }
      assert.equal(input.scope, 'pruned_method_candidate');
      const code = await readFile(join(
        workspaceRoot,
        'module',
        'src',
        'test',
        'java',
        'demo',
        'TaskServiceTmp1Test.java'
      ), 'utf8');
      assert.match(code, /\/\/ TODO 当前测试方法需要修复/);
      assert.match(code, /unrelatedHelper/);
      return passedExecution(1, 'pruned_method_candidate');
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seed = request;
        return {
          kind: 'candidate_ready',
          sessionId: repairSessionId,
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        repairResumeCount += 1;
        assert.equal(request.feedbackKind, 'execution');
        if (repairResumeCount > 1) {
          return {
            kind: 'completed',
            sessionId: repairSessionId,
            eventSequence: 3,
            completion: {
              methodId: METHOD_ID,
              batchId: WAVE_ID,
              stopReason: 'repair_exhausted',
              bestCandidateId: null,
              aggregateUsage: null,
              modelCallCount: 2,
              usageReportedCallCount: 0
            }
          };
        }
        return {
          kind: 'candidate_ready',
          sessionId: repairSessionId,
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: rejectedCode,
            generatedCodeSha256: sha256(rejectedCode)
          }
        };
      }
    }
  });

  await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.deepEqual(
    h.repairCalls.map((request) => request.feedbackKind),
    ['execution', 'execution']
  );
  assert.equal(h.mavenInputs.length, 3);
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 2);
  assert.equal(h.savedCandidates.at(-1).stableRepair.phase, 'PASSED');
  assert.deepEqual(h.repairAcknowledgements, [{
    sessionId: repairSessionId,
    sequence: 3
  }]);
});

test('Wave stable repair retains an empty compiled test class without Surefire XML', async (t) => {
  const wave = workWave(1);
  const partCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void generated() { throw new IllegalStateException("failed"); }',
    '}',
    ''
  ].join('\n');
  const partResult = succeeded(wave.parts[0], partCode);
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 0 },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    async mavenExecute(_input, { callIndex }) {
      return callIndex === 1
        ? failedExecution('generated')
        : compilableEmptyExecution();
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(h.repairCalls.length, 0);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).stableRepair.phase, 'PASSED');
  const finalCode = await readFile(h.savedCandidates.at(-1).managedFile.path, 'utf8');
  assert.match(finalCode, /\/\/ TODO 当前测试方法需要修复/);
  assert.equal((finalCode.match(/@Test\b/g) ?? []).length, 1);
  assert.equal((finalCode.match(/^\s*@Test\b/gm) ?? []).length, 0);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
});

test('finite Wave repair exhaustion enters deterministic stable repair without another model call', async (t) => {
  const wave = workWave(1);
  wave.parts[0].methodTestPlan.minimumTestCount = 2;
  wave.parts[0].methodTestPlan.testPathGroups.push({
    ...structuredClone(wave.parts[0].methodTestPlan.testPathGroups[0]),
    groupId: 'group-1-b',
    ordinal: 2
  });
  wave.parts[0].methodTestPlan.testMethodPlans.push({
    testMethodPlanId: 'plan-1-b',
    methodId: METHOD_ID,
    ordinal: 2,
    pathGroupIds: ['group-1-b'],
    status: 'COMPLETE'
  });
  const initialCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void broken() { org.junit.jupiter.api.Assertions.fail("broken"); }',
    '  @Test void remainsActive() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const partResult = {
    ...succeeded(wave.parts[0], initialCode),
    candidate: {
      ...candidate(wave.parts[0], initialCode),
      ordinaryTestMethodCount: 2
    }
  };
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  const repairedCode = initialCode.replaceAll(
    'TaskServiceTmp1Part1Test',
    'TaskServiceTmp1Test'
  );
  let seed;
  let modelRepairRequests = 0;
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 1 },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(input, { callIndex, workspaceRoot }) {
      if (callIndex <= 2) return failedExecution('broken');
      assert.equal(input.scope, 'pruned_method_candidate');
      const code = await readFile(join(
        workspaceRoot,
        'module',
        'src',
        'test',
        'java',
        'demo',
        'TaskServiceTmp1Test.java'
      ), 'utf8');
      assert.match(code, /\/\/ TODO 当前测试方法需要修复\n\s*\/\/ @Test/);
      assert.match(code, /void remainsActive\(\)/);
      return passedExecution(1, 'pruned_method_candidate');
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        seed = request;
        return {
          kind: 'candidate_ready',
          sessionId: '88888888-8888-4888-8888-888888888888',
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream(_sessionId, request) {
        assert.notEqual(request.execution.status, 'passed');
        modelRepairRequests += 1;
        return {
          kind: 'candidate_ready',
          sessionId: '88888888-8888-4888-8888-888888888888',
          eventSequence: 2,
          candidate: {
            ...seed.candidate,
            candidateVersion: 2,
            repairAttempt: 1,
            testCode: repairedCode,
            generatedCodeSha256: sha256(repairedCode)
          }
        };
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(modelRepairRequests, 1);
  assert.equal(h.mavenInputs.length, 3);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.equal(h.savedCandidates.at(-1).stableRepair.phase, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).stableRepair.iteration, 1);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
});

test('invalid repair output after Agent retries falls back to deterministic stable repair', async (t) => {
  const wave = workWave(1);
  wave.parts[0].methodTestPlan.minimumTestCount = 2;
  wave.parts[0].methodTestPlan.testPathGroups.push({
    ...structuredClone(wave.parts[0].methodTestPlan.testPathGroups[0]),
    groupId: 'group-1-b',
    ordinal: 2
  });
  wave.parts[0].methodTestPlan.testMethodPlans.push({
    testMethodPlanId: 'plan-1-b',
    methodId: METHOD_ID,
    ordinal: 2,
    pathGroupIds: ['group-1-b'],
    status: 'COMPLETE'
  });
  const initialCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Part1Test {',
    '  @Test void broken() { org.junit.jupiter.api.Assertions.fail("broken"); }',
    '  @Test void remainsActive() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const partResult = {
    ...succeeded(wave.parts[0], initialCode),
    candidate: {
      ...candidate(wave.parts[0], initialCode),
      ordinaryTestMethodCount: 2
    }
  };
  const completion = {
    parts: [partResult],
    succeededPartCount: 1,
    failedPartCount: 0,
    cancelledPartCount: 0
  };
  let repairResumeCount = 0;
  const repairSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const h = await harness(t, {
    wave,
    taskOverrides: { repairAttemptLimit: 5 },
    async runWave({ onProgress }) {
      await onProgress(waveEvent(1, wave, 'wave_started'));
      await onProgress(terminalEvent(2, wave, partResult, 'part_succeeded'));
      await onProgress(waveEvent(3, wave, 'wave_completed', { completion }));
      return {
        waveSessionId: '44444444-4444-4444-8444-444444444444',
        eventSequence: 3,
        completion
      };
    },
    getMethodRepairContext() { throw new Error('fallback context'); },
    async mavenExecute(input, { callIndex, workspaceRoot }) {
      if (callIndex === 1) return failedExecution('broken');
      assert.equal(input.scope, 'pruned_method_candidate');
      const code = await readFile(join(
        workspaceRoot,
        'module',
        'src',
        'test',
        'java',
        'demo',
        'TaskServiceTmp1Test.java'
      ), 'utf8');
      assert.match(code, /\/\/ TODO 当前测试方法需要修复\n\s*\/\/ @Test/);
      assert.match(code, /void remainsActive\(\)/);
      return passedExecution(1, 'pruned_method_candidate');
    },
    agentOverrides: {
      async recoverMethodGenerationStream(request) {
        return {
          kind: 'candidate_ready',
          sessionId: repairSessionId,
          eventSequence: 1,
          candidate: structuredClone(request.candidate)
        };
      },
      async resumeMethodGenerationStream() {
        repairResumeCount += 1;
        throw new MethodGenerationRequestError(
          'GENERATED_TEST_INVALID',
          '单方法生成失败：模型输出包含 import 白名单外的类型。'
        );
      }
    }
  });

  const outcome = await h.service.executeWave(
    h.task,
    wave,
    { completedTestMethodPlanIds: [], completedBatches: [], inProgressBatch: null },
    activeWaveCheckpoint(wave),
    new AbortController().signal
  );

  assert.equal(repairResumeCount, 1);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.savedCandidates.at(-1).status, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).llmRepairAttemptsUsed, 1);
  assert.equal(h.savedCandidates.at(-1).stableRepair.phase, 'PASSED');
  assert.equal(h.savedCandidates.at(-1).stableRepair.iteration, 1);
  assert.deepEqual(outcome.completedScenarioIds, ['scenario-1']);
});

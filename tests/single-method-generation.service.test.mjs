import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SingleMethodGenerationService
} from '../src/main/services/single-method-generation.service.ts';
import {
  GeneratedTestFailurePrunerService
} from '../src/main/services/generated-test-failure-pruner.service.ts';
import {
  ClassTaskApplicationInterruptedError
} from '../src/main/services/class-task-interruption.ts';
import {
  ClassTaskPausedAtBoundaryError
} from '../src/main/services/class-task-checkpoint.service.ts';
import {
  resolveRagSourceSetFingerprint
} from '../src/main/services/rag-index-contract.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const METHOD_ID = 'b'.repeat(64);
const REPORT_PAIR_ID = 'a'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function activeRagIndex(allowedFqns, indexVersion = 1) {
  return {
    workspaceId: 'a'.repeat(64),
    scopeId: 'b'.repeat(64),
    indexVersion,
    sourceSetId: sha256(`source-set:${allowedFqns.join('\0')}`),
    requestedSourceSetFingerprint: resolveRagSourceSetFingerprint(allowedFqns),
    allowedFqns: [...allowedFqns]
  };
}

function task(overrides = {}) {
  return {
    id: TASK_ID,
    workspaceRoot: 'D:\\work',
    sourceFilePath: 'D:\\work\\module\\src\\main\\java\\demo\\TaskService.java',
    qualifiedClassName: 'demo.TaskService',
    moduleKey: 'd:/work/module/pom.xml',
    moduleDisplayPath: 'D:\\work\\module',
    state: 'RUNNING',
    preloadState: 'READY',
    ragEnabled: false,
    repairAttemptLimit: 5,
    unlimitedRepair: false,
    selectionMode: 'ALL_BY_DEFAULT',
    selectedMethodIds: [],
    methodOrder: [METHOD_ID],
    currentMethodIndex: -1,
    currentAtomicStep: 'IDLE',
    generatedArtifacts: [],
    coverageBaseline: null,
    coverageCurrent: null,
    coverageContributions: [],
    completionAttentionPending: false,
    startedAt: '2026-08-09T00:00:00.000Z',
    finishedAt: null,
    lastError: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides
  };
}

function testCode(className, names) {
  return [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    `public class ${className} {`,
    ...names.flatMap((name) => [
      '    @Test',
      `    void ${name}() {}`,
      ''
    ]),
    '}',
    ''
  ].join('\n');
}

function versionedRuntimeRepairCandidate(candidate) {
  if (candidate.candidateVersion === 1) return candidate;
  const code = candidate.testCode.replace(
    'void failsAtRuntime() {}',
    `void failsAtRuntime() { int repairAttempt = ${candidate.candidateVersion}; }`
  );
  return {
    ...candidate,
    testCode: code,
    generatedCodeSha256: sha256(code)
  };
}

function page(batchIndex, plannedTestMethods, remainingTestMethods, planOffset) {
  const planIds = Array.from(
    { length: plannedTestMethods },
    (_, index) => `plan-${planOffset + index + 1}`
  );
  return {
    batchId: String(batchIndex).repeat(64),
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    hasWork: true,
    method: {
      methodId: METHOD_ID,
      declaringType: 'demo.TaskService',
      methodName: 'getChildZipFile',
      descriptor: '(Ljava/lang/String;)V',
      firstLine: 10,
      lastLine: 20,
      completeMethodSource: 'public void getChildZipFile(String value) {}',
      modifiers: ['public'],
      parameterTypes: ['java.lang.String'],
      returnType: 'void',
      declaredExceptions: ['java.io.IOException'],
      invocationPlan: {}
    },
    scenarios: [],
    methodTestPlan: {
      testMethodPlans: planIds.map((testMethodPlanId) => ({ testMethodPlanId }))
    },
    methodStubInventory: {},
    activeStubPlans: [],
    targetFixturePlan: {},
    referencedTypes: [],
    necessaryImports: [],
    plannedTestMethods,
    remainingTestMethods,
    warnings: []
  };
}

function noWork() {
  return {
    batchId: null,
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
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

function failedExecution(status = 'test_failed') {
  if (status === 'compile_failed') {
    return {
      status,
      mavenExecutions: [{
        scope: 'method_candidate',
        phase: 'test_compile',
        command: 'mvn test-compile',
        exitCode: 1,
        stdout: '',
        stderr: 'failure',
        surefireReports: []
      }]
    };
  }
  return {
    status,
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
      stdout: '',
      stderr: 'failure',
      surefireReports: []
    }]
  };
}

function testFailedExecution(message = 'report unit was null') {
  const detail = [
    `java.lang.NullPointerException: ${message}`,
    '    at demo.TaskService.getChildZipFile(TaskService.java:15)',
    '    at demo.TaskServiceTmp1Test.failsAtRuntime(TaskServiceTmp1Test.java:7)'
  ].join('\n');
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
      command: 'mvn surefire:test',
      exitCode: 1,
      stdout: detail,
      stderr: '',
      surefireReports: [{ fileName: 'TEST-demo.TaskServiceTmp1Test.xml', content: '<testsuite />' }]
    }],
    testReport: {
      reportCount: 1,
      tests: 1,
      failures: 0,
      errors: 1,
      skipped: 0,
      generatedTestClassName: 'demo.TaskServiceTmp1Test',
      generatedTests: 1,
      generatedSkipped: 0,
      failureDetails: [{
        suiteName: 'demo.TaskServiceTmp1Test',
        testClassName: 'demo.TaskServiceTmp1Test',
        testName: 'failsAtRuntime',
        kind: 'error',
        type: 'java.lang.NullPointerException',
        message,
        detail
      }]
    }
  };
}

function assertionFailedExecution(testLine = 10) {
  const detail = [
    'org.opentest4j.AssertionFailedError: expected: <2> but was: <1>',
    `    at demo.TaskServiceTmp1Test.failsAtRuntime(TaskServiceTmp1Test.java:${testLine})`
  ].join('\n');
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
      command: 'mvn surefire:test',
      exitCode: 1,
      stdout: detail,
      stderr: '',
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
        suiteName: 'demo.TaskServiceTmp1Test',
        testClassName: 'demo.TaskServiceTmp1Test',
        testName: 'failsAtRuntime',
        kind: 'failure',
        type: 'org.opentest4j.AssertionFailedError',
        message: 'expected: <2> but was: <1>',
        detail
      }]
    }
  };
}

function passedExecution(testCount) {
  return {
    status: 'passed',
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
      generatedTestClassName: 'demo.TaskServiceTmpTest',
      generatedTests: testCount,
      generatedSkipped: 0,
      failureDetails: []
    }
  };
}

function harness({
  pageCounts,
  mavenResults,
  pruneResult = null,
  candidateTransform = (candidate) => candidate,
  pageTransform = (value) => value,
  ragContext = null,
  ragEmbeddingConfig = null,
  ragPrepareResults = [],
  ragRefreshResults = [],
  ragIndexRefreshWaitMilliseconds = undefined,
  repairContextError = null,
  onRepairContext = null,
  resumeDelayMs = 0,
  analysisHeartbeatIntervalMs = undefined,
  existingFiles = [],
  onMavenExecute = null,
  invokeMavenPhaseCallbacks = false,
  onBeginAtomicStep = null,
  completionUsage = null,
  forceRepairExhaustionOnFeedbackKind = null
}) {
  let moduleLockDepth = 0;
  const operations = [];
  const analyzerRequests = [];
  const repairContextRequests = [];
  const heartbeatRequests = [];
  const pages = [];
  let offset = 0;
  for (let index = 0; index < pageCounts.length; index += 1) {
    const count = pageCounts[index];
    const remaining = pageCounts.slice(index + 1).reduce((sum, value) => sum + value, 0);
    pages.push(pageTransform(
      page(index + 1, count, remaining, offset),
      index
    ));
    offset += count;
  }
  pages.push(noWork());
  const analyzer = {
    async heartbeatMethodAnalysisSession(sessionId, signal) {
      heartbeatRequests.push({ sessionId, signal });
      return true;
    },
    async nextMethodBatch(sessionId, methodId, request, signal) {
      assert.equal(moduleLockDepth, 0);
      analyzerRequests.push({ sessionId, methodId, request, signal });
      return pages.shift();
    },
    async getMethodRepairContext(sessionId, request, signal) {
      assert.equal(moduleLockDepth, 0);
      operations.push('analyzer:repair-context');
      repairContextRequests.push({ sessionId, request, signal });
      if (repairContextError) throw repairContextError;
      const value = {
        reportPairId: REPORT_PAIR_ID,
        sourceSha256: 'd'.repeat(64),
        targetMethod: {
          methodId: METHOD_ID,
          declaringType: 'demo.TaskService',
          methodName: 'getChildZipFile',
          descriptor: '(Ljava/lang/String;)V',
          modifiers: ['public'],
          firstLine: 10,
          lastLine: 20,
          sourceFirstLine: 10,
          sourceLastLine: 20,
          sourceText: 'public void getChildZipFile(String value) {}',
          sourceComplete: true,
          parameterTypes: ['java.lang.String'],
          returnType: 'void',
          declaredExceptions: ['java.io.IOException']
        },
        stackMethods: [],
        referencedTypes: [],
        warnings: [],
        truncated: false
      };
      onRepairContext?.(value, request);
      return value;
    }
  };

  const startRequests = [];
  const recoveryRequests = [];
  const feedbackRequests = [];
  const ragPrepareRequests = [];
  const ragRefreshRequests = [];
  const queuedRagPrepareResults = [...ragPrepareResults];
  const queuedRagRefreshResults = [...ragRefreshResults];
  const ragSubscription = ragContext
    ? {
        context: ragContext,
        ready: Promise.resolve(),
        async release() {}
      }
    : null;
  const acknowledgements = [];
  const cancellations = [];
  let repairCalls = 0;
  const candidateFor = (request, version) => {
    const repairAttempt = version - 1;
    const names = Array.from(
      { length: request.batch.plannedTestMethods },
      (_, index) => (
        index === request.batch.plannedTestMethods - 1 && request.batchIndex === 1
          ? 'failsAtRuntime'
          : `batch${request.batchIndex}Test${index + 1}`
      )
    );
    const code = testCode(request.outputTestClassName, names);
    return candidateTransform({
      candidateId: `${String(request.batchIndex).padStart(8, '0')}-0000-4000-8000-${String(version).padStart(12, '0')}`,
      candidateVersion: version,
      repairAttempt,
      methodId: METHOD_ID,
      batchId: request.batchId,
      batchIndex: request.batchIndex,
      testCode: code,
      generatedCodeSha256: sha256(code),
      outputTestClassName: request.outputTestClassName,
      ordinaryTestMethodCount: request.batch.plannedTestMethods,
      usage: null
    });
  };
  const sessionFor = (batchIndex) => (
    `${String(batchIndex).padStart(8, '0')}-0000-4000-8000-000000000000`
  );
  const agent = {
    async startMethodGenerationStream(request, _modelContext, onProgress, signal) {
      assert.equal(moduleLockDepth, 0);
      startRequests.push({ request, signal });
      const sessionId = sessionFor(request.batchIndex);
      const candidate = candidateFor(request, 1);
      await onProgress({
        sessionId,
        eventSequence: 1,
        eventType: 'candidate_ready',
        occurredAt: '2026-08-09T00:00:00Z',
        progress: null,
        candidate,
        completion: null,
        modelCall: null,
        error: null
      });
      return { kind: 'candidate_ready', sessionId, eventSequence: 1, candidate };
    },
    async recoverMethodGenerationStream(request, _modelContext, onProgress, signal) {
      assert.equal(moduleLockDepth, 0);
      operations.push('agent:recover');
      recoveryRequests.push({ request, signal });
      const sessionId = '99999999-0000-4000-8000-000000000000';
      const candidate = structuredClone(request.candidate);
      await onProgress({
        sessionId,
        eventSequence: 1,
        eventType: 'candidate_ready',
        occurredAt: '2026-08-09T00:00:00Z',
        progress: null,
        candidate,
        completion: null,
        modelCall: null,
        error: null
      });
      return { kind: 'candidate_ready', sessionId, eventSequence: 1, candidate };
    },
    async prepareRagRepair(sessionId, request, signal) {
      assert.equal(moduleLockDepth, 0);
      operations.push('agent:prepare-rag');
      ragPrepareRequests.push({ sessionId, request: structuredClone(request), signal });
      const queued = queuedRagPrepareResults.shift();
      if (queued instanceof Error) throw queued;
      if (queued) return structuredClone(queued);
      const sequence = ragPrepareRequests.length;
      return {
        status: 'attributable',
        diagnosticFingerprint: String(sequence).repeat(64),
        requestedFqns: ['com.example.Order'],
        originalDiagnosticText: '[ERROR] cannot find symbol',
        targetMethodKey: 'com.example.Order#run()V',
        degradationCode: null
      };
    },
    async resumeMethodGenerationStream(sessionId, request, _modelContext, _onProgress, signal) {
      assert.equal(moduleLockDepth, 0);
      operations.push(`agent:resume:${request.feedbackKind ?? 'legacy'}`);
      feedbackRequests.push({ sessionId, request, signal });
      if (resumeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, resumeDelayMs));
      }
      const start = startRequests.at(-1)?.request
        ?? recoveryRequests.at(-1)?.request.startRequest;
      assert.ok(start, 'a resumed session must have an initial or recovered start request');
      const repairExhausted = forceRepairExhaustionOnFeedbackKind === request.feedbackKind
        || start.unlimitedRepair !== true
        && request.repairAttempt >= (start.repairAttemptLimit ?? 5);
      if (request.execution.status === 'passed' || repairExhausted) {
        return {
          kind: 'completed',
          sessionId,
          eventSequence: request.expectedEventSequence + 1,
          completion: {
            methodId: METHOD_ID,
            batchId: request.effectiveFileSha256 === 'never'
              ? '0'.repeat(64)
              : start.batchId,
            stopReason: request.execution.status === 'passed'
              ? 'verified'
              : 'repair_exhausted',
            bestCandidateId: request.candidateId,
            aggregateUsage: completionUsage,
            modelCallCount: request.candidateVersion,
            usageReportedCallCount: completionUsage ? request.candidateVersion : 0
          }
        };
      }
      repairCalls += 1;
      const candidate = request.feedbackKind === 'candidate_rejected'
        ? (() => {
            const accepted = request.candidateRejection.acceptedTestCode;
            return candidateTransform({
              ...candidateFor(start, request.candidateVersion + 1),
              testCode: accepted,
              generatedCodeSha256: sha256(accepted)
            });
          })()
        : candidateFor(start, request.candidateVersion + 1);
      return {
        kind: 'candidate_ready',
        sessionId,
        eventSequence: request.expectedEventSequence + 1,
        candidate
      };
    },
    async acknowledgeMethodGenerationEvents(sessionId, sequence, signal) {
      acknowledgements.push({ sessionId, sequence, signal });
      return {
        sessionId,
        acknowledgedThroughEventSequence: sequence,
        lastEventSequence: sequence
      };
    },
    async cancelMethodGeneration(sessionId, signal) {
      cancellations.push({ sessionId, signal });
      return { sessionId, phase: 'cancelled' };
    },
    async getMethodGenerationStatus() {
      throw new Error('status recovery was not expected');
    }
  };

  const classNames = [];
  const files = new Map();
  for (const entry of existingFiles) {
    files.set(entry.filePath, {
      code: entry.code,
      sha256: sha256(entry.code)
    });
  }
  const writer = {
    async inspectExistingMethodBatchTemporaryGeneratedTest(input) {
      const filePath = `D:\\work\\module\\src\\test\\java\\demo\\${input.outputTestClassName}.java`;
      const current = files.get(filePath);
      if (!current) return null;
      return {
        workspaceRoot: input.workspaceRoot,
        testFilePath: filePath,
        relativePath: `module/src/test/java/demo/${input.outputTestClassName}.java`,
        testClassName: input.outputTestClassName,
        content: current.code,
        sha256: current.sha256,
        bytesWritten: Buffer.byteLength(current.code)
      };
    },
    async prepareMethodBatchTemporaryGeneratedTest(input) {
      assert.equal(moduleLockDepth, 1);
      classNames.push(input.outputTestClassName);
      return {
        workspaceRoot: input.workspaceRoot,
        testFilePath: `D:\\work\\module\\src\\test\\java\\demo\\${input.outputTestClassName}.java`,
        relativePath: `module/src/test/java/demo/${input.outputTestClassName}.java`,
        testClassName: input.outputTestClassName,
        content: input.content,
        sha256: sha256(input.content),
        bytesWritten: Buffer.byteLength(input.content)
      };
    },
    async writePreparedGeneratedTest(prepared) {
      assert.equal(moduleLockDepth, 1);
      operations.push('writer:initial');
      files.set(prepared.testFilePath, { code: prepared.content, sha256: prepared.sha256 });
      return {
        testFilePath: prepared.testFilePath,
        relativePath: prepared.relativePath,
        bytesWritten: prepared.bytesWritten,
        testClassName: prepared.testClassName,
        sha256: prepared.sha256
      };
    },
    prepareReplacement(input) {
      assert.equal(moduleLockDepth, 1);
      return {
        testClassName: input.filePath.match(/([^\\]+)\.java$/)[1],
        content: input.content,
        sha256: sha256(input.content),
        bytesWritten: Buffer.byteLength(input.content)
      };
    },
    async replacePreparedGeneratedTest(input) {
      assert.equal(moduleLockDepth, 1);
      operations.push('writer:replacement');
      assert.equal(files.get(input.filePath).sha256, input.expectedSha256);
      files.set(input.filePath, {
        code: input.prepared.content,
        sha256: input.prepared.sha256
      });
      return {
        sha256: input.prepared.sha256,
        bytesWritten: input.prepared.bytesWritten
      };
    },
    async loadOwnedGeneratedTest(input) {
      const current = files.get(input.filePath);
      assert.equal(current.sha256, input.expectedSha256);
      return current.code;
    },
    async deleteGeneratedTest(input) {
      assert.equal(moduleLockDepth, 1);
      assert.equal(files.get(input.filePath).sha256, input.expectedSha256);
      files.delete(input.filePath);
    }
  };

  const mavenInputs = [];
  const queuedMavenResults = [...mavenResults];
  const maven = {
    async execute(input) {
      assert.equal(moduleLockDepth, 1);
      operations.push(`maven:${input.scope}`);
      mavenInputs.push(input);
      onMavenExecute?.(input);
      const result = queuedMavenResults.shift();
      if (!result) throw new Error('unexpected Maven execution');
      if (result instanceof Error) throw result;
      if (invokeMavenPhaseCallbacks) {
        for (const execution of result.mavenExecutions ?? []) {
          await input.onPhaseStart?.(execution.phase);
          await input.onPhaseComplete?.(execution.phase);
        }
      }
      return result;
    }
  };
  const pruneInputs = [];
  const defaultPruner = new GeneratedTestFailurePrunerService();
  const pruner = {
    prune(input) {
      pruneInputs.push(structuredClone(input));
      return pruneResult ?? defaultPruner.prune(input);
    }
  };
  const committedBatches = [];
  const savedInProgressBatches = [];
  const clearedInProgressBatches = [];
  const atomicSteps = [];
  const modelUsageUpdates = [];
  const checkpoints = {
    async beginAtomicStep(taskId, step) {
      atomicSteps.push(['begin', step]);
      await onBeginAtomicStep?.(taskId, step);
    },
    async completeAtomicStep(_taskId, step) { atomicSteps.push(['complete', step]); },
    async saveInProgressBatch(value) {
      savedInProgressBatches.push(structuredClone(value));
    },
    async clearInProgressBatch(taskId, methodId, batchId) {
      clearedInProgressBatches.push({ taskId, methodId, batchId });
    },
    async commitBatch(value) { committedBatches.push(structuredClone(value)); },
    async addModelUsage(taskId, value) {
      modelUsageUpdates.push({ taskId, ...structuredClone(value) });
    }
  };
  const moduleLock = {
    async runExclusive(_moduleKey, operation, signal) {
      if (signal) assert.equal(signal.aborted, false);
      assert.equal(moduleLockDepth, 0);
      moduleLockDepth += 1;
      try {
        return await operation();
      } finally {
        moduleLockDepth -= 1;
      }
    }
  };
  const mergeCalls = [];
  const merger = {
    merge(methodId, verified) {
      mergeCalls.push({ methodId, verified: structuredClone(verified) });
      return {
        methodId,
        code: verified.map((item) => item.code).join('\n'),
        ordinaryTestMethodCount: verified.reduce(
          (sum, item) => sum + item.ordinaryTestMethodCount,
          0
        ),
        passedTestMethods: verified.flatMap((item) => item.passedTestMethods),
        sourceBatchIds: verified.map((item) => item.batchId)
      };
    }
  };
  const loggedEvents = [];
  const repairTelemetry = [];
  const service = new SingleMethodGenerationService({
    analyzer,
    agent,
    contextProvider: {
      async resolve() {
        return {
          analysisSessionId: '123e4567-e89b-42d3-a456-426614174000',
          reportPairId: REPORT_PAIR_ID,
          sourceSha256: 'd'.repeat(64),
          packageName: 'demo',
          plannedRelativeTestPath: 'module/src/test/java/demo/TaskServiceTest.java',
          moduleRoot: 'D:\\work\\module',
          buildSettings: {
            mavenHome: 'D:\\maven',
            javaHome: 'D:\\jdk',
            settingsPath: 'D:\\maven\\conf\\settings.xml',
            localRepository: 'D:\\m2'
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
          ...(ragContext ? { ragContext } : {}),
          ...(ragSubscription ? { ragSubscription } : {}),
          ...(ragEmbeddingConfig ? { ragEmbeddingConfig } : {}),
          excludedEnvironmentVariables: ['DEEPSEEK_API_KEY']
        };
      }
    },
    checkpoints,
    moduleLock,
    writer,
    maven,
    pruner,
    merger,
    logs: {
      async record(value) { loggedEvents.push(value); },
      async recordRepairTelemetry(value) { repairTelemetry.push(value); }
    },
    ragIndexCoordinator: {
      async refresh(subscription, diagnosticFqns, signal) {
        assert.equal(moduleLockDepth, 0);
        operations.push('rag:refresh');
        ragRefreshRequests.push({
          subscription,
          diagnosticFqns: [...diagnosticFqns],
          signal
        });
        const queued = queuedRagRefreshResults.shift();
        if (queued instanceof Error) throw queued;
        const resolved = queued && typeof queued.then === 'function'
          ? await queued
          : queued;
        const result = resolved ?? {
          status: 'published',
          vectorStatus: 'ready',
          workspaceId: 'a'.repeat(64),
          scopeId: 'b'.repeat(64),
          buildFingerprint: ragContext?.scope.buildFingerprint ?? 'f'.repeat(64),
          pageCount: 1,
          addedCount: 1,
          updatedCount: 0,
          deletedCount: 0,
          skippedDependencyCount: 0,
          degradationCode: null
        };
        if (
          (result.status === 'published' || result.status === 'reused')
          && result.vectorStatus === 'ready'
          && ragContext
        ) {
          const allowedFqns = [...new Set([
            ...(ragContext.activeIndex?.allowedFqns ?? []),
            ...diagnosticFqns
          ])].sort();
          ragContext.activeIndex = activeRagIndex(
            allowedFqns,
            (ragContext.activeIndex?.indexVersion ?? 0) + 1
          );
        }
        return structuredClone(result);
      }
    },
    ...(ragIndexRefreshWaitMilliseconds === undefined
      ? {}
      : { ragIndexRefreshWaitMilliseconds }),
    randomUUID: (() => {
      let value = 100;
      return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`;
    })(),
    ...(analysisHeartbeatIntervalMs === undefined
      ? {}
      : { analysisHeartbeatIntervalMs })
  });

  return {
    service,
    analyzerRequests,
    repairContextRequests,
    heartbeatRequests,
    startRequests,
    recoveryRequests,
    feedbackRequests,
    ragPrepareRequests,
    ragRefreshRequests,
    acknowledgements,
    cancellations,
    get repairCalls() { return repairCalls; },
    classNames,
    files,
    mavenInputs,
    pruneInputs,
    committedBatches,
    savedInProgressBatches,
    clearedInProgressBatches,
    atomicSteps,
    modelUsageUpdates,
    loggedEvents,
    repairTelemetry,
    mergeCalls,
    operations
  };
}

test('a completed single-method session persists its authoritative aggregate token usage once', async () => {
  const completionUsage = { inputTokens: 900, outputTokens: 100, totalTokens: 1_000 };
  const h = harness({
    pageCounts: [1],
    mavenResults: [passedExecution(1)],
    completionUsage
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.deepEqual(h.modelUsageUpdates, [{
    taskId: TASK_ID,
    tokenUsage: completionUsage,
    modelCallCount: 1,
    usageReportedCallCount: 1
  }]);
});

test('adds an unambiguous Analyzer type import before the first Maven execution', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [passedExecution(1)],
    pageTransform(value) {
      return {
        ...value,
        necessaryImports: [
          ...value.necessaryImports,
          'import com.dtsz.model.entity.report.Task;'
        ]
      };
    },
    candidateTransform(candidate) {
      const code = [
        'package demo;',
        '',
        'import org.junit.jupiter.api.Test;',
        '',
        `public class ${candidate.outputTestClassName} {`,
        '    private Task task;',
        '',
        '    @Test',
        '    void generatedScenario() { task.toString(); }',
        '}',
        ''
      ].join('\n');
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(h.mavenInputs.length, 1);
  assert.match(
    h.mergeCalls[0].verified[0].code,
    /import com\.dtsz\.model\.entity\.report\.Task;/
  );
});

test('repairs an exact unreported exception and reruns Maven without consuming a model repair attempt', async () => {
  const candidateCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Test',
    '    void failsAtRuntime() {',
    '        setUpPublicStubs();',
    '    }',
    '',
    '    private void setUpPublicStubs() throws demo.ReportException {',
    '        TaskService.class.getDeclaredMethod("hidden");',
    '    }',
    '}',
    ''
  ].join('\n');
  const compileFailure = failedExecution('compile_failed');
  compileFailure.mavenExecutions[0].stderr = [
    '[ERROR] /D:/work/module/src/test/java/demo/TaskServiceTmp1Test.java:',
    '[12,51] 未报告的异常错误 java.lang.NoSuchMethodException；必须对其进行捕获或声明以便抛出'
  ].join('');
  const h = harness({
    pageCounts: [1],
    mavenResults: [compileFailure, passedExecution(1)],
    candidateTransform(candidate) {
      return {
        ...candidate,
        testCode: candidateCode,
        generatedCodeSha256: sha256(candidateCode)
      };
    }
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.repairCalls, 0);
  assert.equal(h.feedbackRequests.length, 1);
  assert.equal(h.feedbackRequests[0].request.execution.status, 'passed');
  assert.equal(h.feedbackRequests[0].request.repairAttempt, 0);
  assert.match(
    bundle.code,
    /throws demo\.ReportException, java\.lang\.NoSuchMethodException \{/
  );
});

test('Maven interruption rolls back the uncheckpointed TMP file and cancels the Agent session', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [new Error('Maven process was interrupted')]
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /Maven process was interrupted/
  );

  assert.equal(h.files.size, 0);
  assert.deepEqual(
    h.cancellations.map(({ sessionId, signal }) => ({ sessionId, signal })),
    [{ sessionId: '00000001-0000-4000-8000-000000000000', signal: undefined }]
  );
  assert.equal(h.committedBatches.length, 0);
});

test('Workstation shutdown preserves the current TMP candidate and its resume checkpoint', async () => {
  const controller = new AbortController();
  const interruption = new ClassTaskApplicationInterruptedError();
  const h = harness({
    pageCounts: [1],
    mavenResults: [interruption],
    onMavenExecute: () => controller.abort(interruption)
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      controller.signal
    ),
    /Workstation is closing/
  );

  assert.equal(h.files.size, 1);
  assert.equal(h.savedInProgressBatches.length, 1);
  assert.equal(h.savedInProgressBatches[0].candidate.candidateVersion, 1);
  assert.equal(h.clearedInProgressBatches.length, 0);
  assert.equal(h.cancellations.length, 0);
  assert.equal(h.committedBatches.length, 0);
});

test('pause boundary after a model response preserves the durable TMP candidate for resume', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [passedExecution(1)],
    invokeMavenPhaseCallbacks: true,
    onBeginAtomicStep(_taskId, step) {
      if (step === 'MAVEN_COMPILE') throw new ClassTaskPausedAtBoundaryError();
    }
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    ClassTaskPausedAtBoundaryError
  );

  assert.equal(h.files.size, 1, 'the last durable TMP candidate must remain on disk');
  assert.equal(h.savedInProgressBatches.length, 1);
  assert.equal(h.clearedInProgressBatches.length, 0);
  assert.equal(h.cancellations.length, 1);
  assert.equal(h.committedBatches.length, 0);
});

test('reopening resumes the persisted TMP candidate with Maven and repair instead of initial generation', async () => {
  const recoveredPage = page(1, 1, 0, 0);
  const outputTestClassName = 'TaskServiceTmp2Test';
  const recoveredCode = testCode(outputTestClassName, ['failsAtRuntime']);
  const recoveredPath = `D:\\work\\module\\src\\test\\java\\demo\\${outputTestClassName}.java`;
  const recoveredCandidate = {
    candidateId: '22222222-2222-4222-8222-222222222222',
    candidateVersion: 2,
    repairAttempt: 1,
    methodId: METHOD_ID,
    batchId: recoveredPage.batchId,
    batchIndex: 1,
    testCode: recoveredCode,
    generatedCodeSha256: sha256(recoveredCode),
    outputTestClassName,
    ordinaryTestMethodCount: 1,
    usage: null
  };
  const startRequest = {
    clientRequestId: '33333333-3333-4333-8333-333333333333',
    classTaskId: TASK_ID,
    methodId: METHOD_ID,
    batchId: recoveredPage.batchId,
    batchIndex: 1,
    outputTestClassName,
    expectedPackageName: 'demo',
    buildToolchain: { javaVersion: '21', mavenVersion: '3.9.9' },
    batch: recoveredPage,
    captureModelCalls: true,
    repairAttemptLimit: 5,
    unlimitedRepair: false
  };
  const h = harness({
    pageCounts: [],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    existingFiles: [{ filePath: recoveredPath, code: recoveredCode }],
    candidateTransform: versionedRuntimeRepairCandidate
  });

  const generated = await h.service.generateBatches(
    task(),
    METHOD_ID,
    {
      completedBatches: [],
      completedTestMethodPlanIds: [],
      inProgressBatch: {
        taskId: TASK_ID,
        methodId: METHOD_ID,
        batchId: recoveredPage.batchId,
        batchIndex: 1,
        sourceSha256: 'd'.repeat(64),
        startRequest,
        candidate: recoveredCandidate,
        tmpFilePath: recoveredPath,
        tmpFileSha256: sha256(recoveredCode)
      }
    },
    new AbortController().signal,
    { temporaryBatchIndexOffset: 1 }
  );

  assert.ok(generated);
  assert.equal(h.startRequests.length, 0, 'recovery must not call initial generation');
  assert.equal(h.recoveryRequests.length, 1);
  assert.equal(h.recoveryRequests[0].request.candidate.candidateVersion, 2);
  assert.equal(h.classNames.length, 0, 'the owned TMP file must be reused');
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.feedbackRequests[0].request.candidateVersion, 2);
  assert.equal(h.feedbackRequests[0].request.repairAttempt, 1);
  assert.equal(h.feedbackRequests[1].request.candidateVersion, 3);
  assert.equal(h.committedBatches[0].candidateVersion, 3);
  assert.equal(h.files.size, 1);
});

test('legacy restart adopts an existing deterministic TMP file without repeating initial generation', async () => {
  const outputTestClassName = 'TaskServiceTmp2Test';
  const existingCode = testCode(outputTestClassName, ['failsAtRuntime']);
  const existingPath = `D:\\work\\module\\src\\test\\java\\demo\\${outputTestClassName}.java`;
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    existingFiles: [{ filePath: existingPath, code: existingCode }],
    candidateTransform: versionedRuntimeRepairCandidate
  });

  const generated = await h.service.generateBatches(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal,
    { temporaryBatchIndexOffset: 1 }
  );

  assert.ok(generated);
  assert.equal(h.startRequests.length, 0);
  assert.equal(h.recoveryRequests.length, 1);
  assert.equal(h.classNames.length, 0);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.savedInProgressBatches[0].tmpFilePath, existingPath);
  assert.equal(h.feedbackRequests[0].request.candidateVersion, 1);
  assert.equal(h.committedBatches[0].candidateVersion, 2);
});

test('twenty-nine planned tests use 12, 12, and 5 TMP batches for one method', async () => {
  const h = harness({
    pageCounts: [12, 12, 5],
    mavenResults: [passedExecution(12), passedExecution(12), passedExecution(5)]
  });

  const signal = new AbortController().signal;
  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    signal
  );

  assert.deepEqual(
    h.startRequests.map(({ request }) => request.batch.plannedTestMethods),
    [12, 12, 5]
  );
  assert.deepEqual(h.classNames, [
    'TaskServiceTmp1Test',
    'TaskServiceTmp2Test',
    'TaskServiceTmp3Test'
  ]);
  assert.ok(h.analyzerRequests.every(({ request }) => request.maxTestMethods === 20_000));
  assert.ok(h.analyzerRequests.every((request) => request.signal === signal));
  assert.ok(h.startRequests.every((request) => request.signal === signal));
  assert.ok(h.startRequests.every(({ request }) => request.repairAttemptLimit === 5));
  assert.ok(h.startRequests.every(({ request }) => request.unlimitedRepair === false));
  assert.ok(h.startRequests.every(({ request }) => !('assertionPolicy' in request)));
  assert.ok(h.feedbackRequests.every((request) => request.signal === signal));
  assert.ok(h.mavenInputs.every((input) => input.signal === signal));
  assert.equal(h.loggedEvents[0].className, 'TaskService');
  assert.equal(h.loggedEvents[0].qualifiedClassName, 'demo.TaskService');
  assert.equal(h.loggedEvents[0].methodName, 'getChildZipFile');
  assert.equal(h.loggedEvents[0].descriptor, '(Ljava/lang/String;)V');
  assert.equal(
    h.loggedEvents[0].displaySignature,
    'public void getChildZipFile(java.lang.String) throws java.io.IOException'
  );
  assert.equal(bundle.ordinaryTestMethodCount, 29);
  assert.equal(bundle.sourceBatchIds.length, 3);
  assert.equal(h.committedBatches.length, 3);
});

test('TMP class numbering continues after batches retained by earlier source methods', async () => {
  const h = harness({
    pageCounts: [2, 1],
    mavenResults: [passedExecution(2), passedExecution(1)]
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal,
    { temporaryBatchIndexOffset: 3 }
  );

  assert.deepEqual(h.classNames, [
    'TaskServiceTmp4Test',
    'TaskServiceTmp5Test'
  ]);
  assert.deepEqual(
    h.committedBatches.map((batch) => batch.batchIndex),
    [1, 2],
    'checkpoint batch indexes remain local to the source method'
  );
});

test('generation can retain verified TMP batches without merging them before class finalization', async () => {
  const h = harness({
    pageCounts: [12, 4],
    mavenResults: [passedExecution(12), passedExecution(4)]
  });

  assert.equal(
    typeof h.service.generateBatches,
    'function',
    'SingleMethodGenerationService must expose a non-merging production path'
  );
  const generated = await h.service.generateBatches(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal,
    { temporaryBatchIndexOffset: 2 }
  );

  assert.ok(generated);
  assert.equal(generated.methodId, METHOD_ID);
  assert.equal(generated.methodName, 'getChildZipFile');
  assert.deepEqual(
    generated.batches.map((batch) => batch.ordinaryTestMethodCount),
    [12, 4]
  );
  assert.deepEqual(h.classNames, ['TaskServiceTmp3Test', 'TaskServiceTmp4Test']);
  assert.equal(h.mergeCalls.length, 0);
});

test('finite repair count comes from the class task instead of a fixed five-attempt limit', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), testFailedExecution(), passedExecution(1)],
    candidateTransform: versionedRuntimeRepairCandidate
  });

  await h.service.execute(
    task({ repairAttemptLimit: 2 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.startRequests[0].request.repairAttemptLimit, 2);
  assert.equal(h.repairCalls, 2);
  assert.equal(h.feedbackRequests.length, 3);
  assert.equal(h.pruneInputs.length, 0);
  const modelSteps = h.atomicSteps
    .filter(([phase, step]) => phase === 'begin' && ['MODEL_GENERATION', 'MODEL_REPAIR', 'CONFIRM_RESULT'].includes(step))
    .map(([, step]) => step);
  assert.deepEqual(modelSteps, ['MODEL_GENERATION', 'MODEL_REPAIR', 'MODEL_REPAIR', 'CONFIRM_RESULT']);
});

test('rejects an initial candidate that claims a repair before any Maven execution', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [passedExecution(1)],
    candidateTransform(candidate) {
      if (candidate.candidateVersion !== 1) return candidate;
      return {
        ...candidate,
        candidateVersion: 2,
        repairAttempt: 1
      };
    }
  });

  await assert.rejects(
    h.service.execute(
      task({ repairAttemptLimit: 5 }),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /inconsistent identity/
  );

  assert.equal(h.mavenInputs.length, 0);
  assert.equal(h.files.size, 0);
  assert.equal(h.committedBatches.length, 0);
});

test('repair can delete a marked placeholder and commit the retained test', async () => {
  const h = harness({
    pageCounts: [2],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      if (candidate.repairAttempt === 0) return candidate;
      const code = candidate.testCode.replace(
        '    @Test\n    void failsAtRuntime() {}',
        '    // [删除无用测试] failsAtRuntime'
      );
      return { ...candidate, testCode: code, generatedCodeSha256: sha256(code), ordinaryTestMethodCount: 1 };
    }
  });
  const bundle = await h.service.execute(
    task(), METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );
  assert.equal(h.repairCalls, 1);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.match(bundle.code, /void batch1Test1\(\)/);
  assert.doesNotMatch(bundle.code, /void failsAtRuntime\(\)/);
  assert.equal(h.committedBatches[0].ordinaryTestMethodCount, 1);
});

test('accepts a forward candidate-version jump when invalid Agent repairs consumed rounds', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      const versioned = versionedRuntimeRepairCandidate(candidate);
      if (candidate.candidateVersion !== 2) return versioned;
      return {
        ...versioned,
        candidateVersion: 6,
        repairAttempt: 5
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 5 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.repairCalls, 1);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.equal(h.committedBatches[0].candidateVersion, 6);
});

test('rejects an Agent candidate-version jump beyond the finite repair limit', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [failedExecution()],
    candidateTransform(candidate) {
      if (candidate.candidateVersion !== 2) return candidate;
      return {
        ...candidate,
        candidateVersion: 7,
        repairAttempt: 6
      };
    }
  });

  await assert.rejects(
    h.service.execute(
      task({ repairAttemptLimit: 5 }),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /inconsistent identity/
  );

  assert.equal(h.mavenInputs.length, 1);
});

test('unlimited repair continues beyond the former five-attempt boundary until Maven passes', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [
      testFailedExecution(), testFailedExecution(), testFailedExecution(),
      testFailedExecution(), testFailedExecution(), testFailedExecution(),
      testFailedExecution(), passedExecution(1)
    ],
    candidateTransform: versionedRuntimeRepairCandidate
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: null, unlimitedRepair: true }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.startRequests[0].request.unlimitedRepair, true);
  assert.equal(h.repairCalls, 7);
  assert.equal(h.feedbackRequests.length, 8);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.equal(h.pruneInputs.length, 0);
});

test('long model repair keeps the Analyzer session alive and stops heartbeats after completion', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    resumeDelayMs: 35,
    analysisHeartbeatIntervalMs: 5,
    candidateTransform: versionedRuntimeRepairCandidate
  });
  const signal = new AbortController().signal;

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    signal
  );

  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.ok(h.heartbeatRequests.length >= 2);
  assert.ok(h.heartbeatRequests.every(({ sessionId }) => (
    sessionId === '123e4567-e89b-42d3-a456-426614174000'
  )));
  assert.ok(h.heartbeatRequests.every((request) => request.signal === signal));
  const completedHeartbeatCount = h.heartbeatRequests.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.heartbeatRequests.length, completedHeartbeatCount);
});

test('no-RAG Maven failures rebuild structured Analyzer repair context before every repair', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [
      testFailedExecution('first failure'),
      testFailedExecution('second failure'),
      passedExecution(1)
    ],
    candidateTransform: versionedRuntimeRepairCandidate
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.repairContextRequests.length, 2);
  assert.deepEqual(h.repairContextRequests[0].request, {
    reportPairId: REPORT_PAIR_ID,
    methodId: METHOD_ID,
    currentClassFrames: [{
      ownerFqn: 'demo.TaskService',
      methodName: 'getChildZipFile',
      descriptor: null,
      sourceLine: 15
    }],
    relatedTypeFqns: ['java.lang.NullPointerException'],
    missingSymbols: []
  });
  assert.equal(h.feedbackRequests[0].request.feedbackKind, 'execution');
  assert.equal(h.feedbackRequests[0].request.repairContext.analyzerStatus, 'available');
  assert.equal(h.feedbackRequests[0].request.repairContext.sourceSha256, 'd'.repeat(64));
  assert.equal(
    h.feedbackRequests[0].request.repairContext.exceptions[0].message,
    'first failure'
  );
  assert.equal(
    h.feedbackRequests[1].request.repairContext.exceptions[0].message,
    'second failure'
  );
  assert.equal('repairContext' in h.feedbackRequests[2].request, false);
  assert.equal(h.repairTelemetry.length, 2);
  assert.ok(h.repairTelemetry.every((entry) => Number.isFinite(entry.mavenDurationMs)));
  assert.ok(h.repairTelemetry.every((entry) => Number.isFinite(entry.analyzerDurationMs)));
  assert.ok(h.repairTelemetry.every((entry) => !('testCode' in entry)));
  assert.deepEqual(h.operations.slice(0, 8), [
    'writer:initial',
    'maven:method_candidate',
    'analyzer:repair-context',
    'agent:resume:execution',
    'writer:replacement',
    'maven:method_candidate',
    'analyzer:repair-context',
    'agent:resume:execution'
  ]);
});

test('scope-rejected no-RAG candidate is neither written nor executed and retries from accepted code', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      const code = candidate.candidateVersion === 2
        ? candidate.testCode.replace(
            '\n}',
            '\n    private void unrelatedHelper() {}\n}'
          )
        : candidate.candidateVersion === 3
          ? candidate.testCode.replace(
              '    void failsAtRuntime() {}',
              '    void failsAtRuntime() { new Object(); }'
            )
          : candidate.testCode;
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(h.operations, [
    'writer:initial',
    'maven:method_candidate',
    'analyzer:repair-context',
    'agent:resume:execution',
    'agent:resume:candidate_rejected',
    'writer:replacement',
    'maven:method_candidate',
    'agent:resume:execution'
  ]);
  const executionFeedback = h.feedbackRequests[0].request;
  const rejectionFeedback = h.feedbackRequests[1].request;
  assert.equal(rejectionFeedback.feedbackKind, 'candidate_rejected');
  assert.match(rejectionFeedback.effectiveTestCode, /unrelatedHelper/);
  assert.doesNotMatch(
    rejectionFeedback.candidateRejection.acceptedTestCode,
    /unrelatedHelper/
  );
  assert.equal(
    rejectionFeedback.candidateRejection.acceptedFileSha256,
    sha256(rejectionFeedback.candidateRejection.acceptedTestCode)
  );
  assert.ok(rejectionFeedback.candidateRejection.violationCodes.includes(
    'UNRELATED_METHOD_CHANGED'
  ));
  assert.equal(rejectionFeedback.execution, executionFeedback.execution);
  assert.equal(rejectionFeedback.repairContext, executionFeedback.repairContext);
});

test('no-RAG repair passes Analyzer import whitelist to wildcard scope validation', async () => {
  const h = harness({
    pageCounts: [1],
    pageTransform(value) {
      return {
        ...value,
        necessaryImports: ['org.mockito.Mockito.*']
      };
    },
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      if (candidate.candidateVersion === 1) return candidate;
      const code = candidate.testCode
        .replace(
          'import org.junit.jupiter.api.Test;',
          'import org.junit.jupiter.api.Test;\nimport static org.mockito.Mockito.*;'
        )
        .replace(
          '    void failsAtRuntime() {}',
          '    void failsAtRuntime() { mock(TaskService.class); }'
        );
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'execution']
  );
  assert.match(bundle.code, /import static org\.mockito\.Mockito\.\*;/);
});

test('no-RAG repair permits standard Mockito wildcard imports when Analyzer omits them', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      if (candidate.candidateVersion === 1) return candidate;
      const code = candidate.testCode
        .replace(
          'import org.junit.jupiter.api.Test;',
          'import org.junit.jupiter.api.Test;\nimport static org.mockito.Mockito.*;'
        )
        .replace(
          '    void failsAtRuntime() {}',
          '    void failsAtRuntime() { mock(TaskService.class); }'
        );
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'execution']
  );
  assert.match(bundle.code, /import static org\.mockito\.Mockito\.\*;/);
});

test('no-RAG repair accepts redundant import cleanup instead of wasting a repair attempt', async () => {
  const originalCode = [
    'package demo;',
    '',
    'import static org.mockito.Mockito.mockStatic;',
    'import static org.mockito.Mockito.*;',
    'import org.junit.jupiter.api.Test;',
    'import demo.TaskService;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private TaskService service;',
    '',
    '    private void unrelatedHelper() {',
    '        mockStatic(String.class);',
    '    }',
    '',
    '    private void failingHelper() {',
    '        throw new NullPointerException("broken");',
    '    }',
    '',
    '    @Test',
    '    void failsAtRuntime() {',
    '        failingHelper();',
    '    }',
    '}',
    ''
  ].join('\n');
  const repairedCodeWithCleanedImports = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import static org.mockito.Mockito.*;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private TaskService service;',
    '',
    '    private void unrelatedHelper() {',
    '        mockStatic(String.class);',
    '    }',
    '',
    '    private void failingHelper() {',
    '    }',
    '',
    '    @Test',
    '    void failsAtRuntime() {',
    '        failingHelper();',
    '    }',
    '}',
    ''
  ].join('\n');
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      const code = candidate.candidateVersion === 1
        ? originalCode
        : repairedCodeWithCleanedImports;
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 1 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'execution']
  );
  assert.doesNotMatch(bundle.code, /import static org\.mockito\.Mockito\.mockStatic;/);
  assert.doesNotMatch(bundle.code, /import demo\.TaskService;/);
  assert.match(bundle.code, /import static org\.mockito\.Mockito\.\*;/);
  assert.doesNotMatch(bundle.code, /throw new NullPointerException/);
});

test('no-RAG runtime repair preserves a removed wildcard import before scope validation', async () => {
  const originalCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mockito;',
    'import static org.mockito.Mockito.*;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private void failingHelper() {',
    '        when(null);',
    '        throw new NullPointerException("broken");',
    '    }',
    '',
    '    @Test',
    '    void failsAtRuntime() {',
    '        failingHelper();',
    '    }',
    '}',
    ''
  ].join('\n');
  const repairedCodeWithoutWildcard = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mockito;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private void failingHelper() {',
    '        Mockito.lenient();',
    '    }',
    '',
    '    @Test',
    '    void failsAtRuntime() {',
    '        failingHelper();',
    '    }',
    '}',
    ''
  ].join('\n');
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform(candidate) {
      const code = candidate.candidateVersion === 1
        ? originalCode
        : repairedCodeWithoutWildcard;
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 1 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'execution']
  );
  assert.match(bundle.code, /import static org\.mockito\.Mockito\.\*;/);
  assert.doesNotMatch(bundle.code, /throw new NullPointerException/);
});

test('no-RAG compile repair preserves a removed wildcard import before scope validation', async () => {
  const originalCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import com.example.postvos.*;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Test',
    '    void failsAtRuntime() {',
    '    }',
    '}',
    ''
  ].join('\n');
  const repairedCodeWithoutWildcard = originalCode.replace(
    'import com.example.postvos.*;\n',
    ''
  ).replace(
    '    void failsAtRuntime() {\n    }',
    '    void failsAtRuntime() {\n        int repaired = 1;\n    }'
  );
  const compileFailure = failedExecution('compile_failed');
  compileFailure.mavenExecutions[0].stderr = [
    '[ERROR] /D:/work/module/src/test/java/demo/TaskServiceTmp1Test.java:',
    '[8,5] cannot find symbol'
  ].join('');
  const h = harness({
    pageCounts: [1],
    mavenResults: [compileFailure, passedExecution(1)],
    candidateTransform(candidate) {
      const code = candidate.candidateVersion === 1
        ? originalCode
        : repairedCodeWithoutWildcard;
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 1 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.equal(h.mavenInputs.length, 2);
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'execution']
  );
  const repairedExecutionFeedback = h.feedbackRequests[1].request;
  assert.match(
    repairedExecutionFeedback.effectiveTestCode,
    /import com\.example\.postvos\.\*;/
  );
  assert.equal(
    repairedExecutionFeedback.effectiveFileSha256,
    sha256(repairedExecutionFeedback.effectiveTestCode)
  );
  assert.match(bundle.code, /import com\.example\.postvos\.\*;/);
});

test('final scope-rejected repair returns the fully commented source for formal-file packing', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), failedExecution('test_failed')],
    candidateTransform(candidate) {
      if (candidate.candidateVersion !== 2) return candidate;
      const code = candidate.testCode.replace(
        '\n}',
        '\n    private void unrelatedHelper() {}\n}'
      );
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 1 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 0);
  assert.deepEqual(bundle.passedTestMethods, []);
  assert.match(bundle.code, /\/\/ TODO 当前测试方法需要修复/);
  assert.match(bundle.code, /\/\/ void failsAtRuntime\(\) \{/);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'candidate_rejected']
  );
  assert.equal(h.pruneInputs.length, 1);
  assert.equal(h.files.size, 1);
  assert.match([...h.files.values()][0].code, /\/\/ TODO 当前测试方法需要修复/);
  assert.equal(h.committedBatches[0].outcome, 'RETAINED');
  assert.notEqual(h.committedBatches[0].tmpFilePath, null);
});

test('Agent repair exhaustion after internal invalid execution repairs enters final pruning immediately', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), failedExecution('test_failed')],
    forceRepairExhaustionOnFeedbackKind: 'execution'
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 5 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 0);
  assert.equal(h.feedbackRequests.length, 1);
  assert.equal(h.feedbackRequests[0].request.feedbackKind, 'execution');
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.equal(h.committedBatches[0].outcome, 'RETAINED');
});

test('Agent repair exhaustion after a scope rejection enters final pruning even when the accepted candidate attempt is lower', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), failedExecution('test_failed')],
    forceRepairExhaustionOnFeedbackKind: 'candidate_rejected',
    candidateTransform(candidate) {
      if (candidate.candidateVersion !== 2) return candidate;
      const code = candidate.testCode.replace(
        '\n}',
        '\n    private void unrelatedHelper() {}\n}'
      );
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 5 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 0);
  assert.deepEqual(
    h.feedbackRequests.map(({ request }) => request.feedbackKind),
    ['execution', 'candidate_rejected']
  );
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.equal(h.committedBatches[0].outcome, 'RETAINED');
});

test('final compile failure on an invalid import retains unaffected tests instead of dropping the batch', async () => {
  const candidateCode = [
    'package demo;',
    '',
    'import wrong.package.ReportUnit;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Test',
    '    void batch1Test1() {',
    '        String value = "ok";',
    '    }',
    '',
    '    @Test',
    '    void failsAtRuntime() {',
    '        ReportUnit reportUnit = new ReportUnit();',
    '    }',
    '}',
    ''
  ].join('\n');
  const compileFailure = failedExecution('compile_failed');
  compileFailure.mavenExecutions[0].stderr = [
    '[ERROR] /D:/work/module/src/test/java/demo/TaskServiceTmp1Test.java:',
    '[3,33] cannot find symbol'
  ].join('');
  const h = harness({
    pageCounts: [2],
    mavenResults: [compileFailure, passedExecution(1)],
    candidateTransform(candidate) {
      return {
        ...candidate,
        testCode: candidateCode,
        generatedCodeSha256: sha256(candidateCode)
      };
    }
  });

  const bundle = await h.service.execute(
    task({ repairAttemptLimit: 0 }),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.deepEqual(bundle.passedTestMethods, ['batch1Test1']);
  assert.match(bundle.code, /^\/\/ import wrong\.package\.ReportUnit;$/m);
  assert.match(bundle.code, /\/\/ TODO 当前测试方法需要修复/);
  assert.match(bundle.code, /\/\/ void failsAtRuntime\(\) \{/);
  assert.match(bundle.code, /^\s*void batch1Test1\(\) \{/m);
  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.equal(h.committedBatches[0].outcome, 'PASSED');
  assert.equal(h.committedBatches[0].ordinaryTestMethodCount, 1);
});

test('fully commented final candidate is dropped and stops before the next batch when support does not compile', async () => {
  const h = harness({
    pageCounts: [1, 1],
    mavenResults: [testFailedExecution(), failedExecution('compile_failed')]
  });

  await assert.rejects(
    h.service.execute(
      task({ repairAttemptLimit: 0 }),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /without a safely retained formal test result/
  );

  assert.equal(h.mavenInputs.length, 2);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.equal(h.committedBatches[0].outcome, 'DROPPED');
  assert.equal(h.committedBatches[0].ordinaryTestMethodCount, 0);
  assert.equal(h.analyzerRequests.length, 1);
});

test('Analyzer repair-context failure safely falls back to the current batch target method', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    repairContextError: new Error('Analyzer context unavailable')
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  const context = h.feedbackRequests[0].request.repairContext;
  assert.equal(context.analyzerStatus, 'fallback');
  assert.equal(context.sourceSha256, 'd'.repeat(64));
  assert.equal(context.targetMethod.methodId, METHOD_ID);
  assert.equal(context.targetMethod.sourceText, page(
    1, 1, 0, 0
  ).method.completeMethodSource);
  assert.equal(context.targetMethod.sourceComplete, true);
  assert.deepEqual(context.stackMethods, []);
  assert.match(context.analyzerWarnings[0], /Analyzer context unavailable/);
});

test('unchecked method generation omits ragContext from every initial request', async () => {
  const h = harness({
    pageCounts: [1, 1],
    mavenResults: [passedExecution(1), passedExecution(1)]
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.startRequests.length, 2);
  assert.equal(h.startRequests.every(({ request }) => !('ragContext' in request)), true);
});

test('enabled method generation prepares and refreshes fresh RAG evidence before every failed resume', async () => {
  const ragContext = {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: ['D:\\work\\module\\target\\classes'],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: 'f'.repeat(64)
    },
    activeIndex: activeRagIndex(['com.example.Order'])
  };
  const ragEmbeddingConfig = {
    provider: 'custom_openai',
    model: 'text-embedding-local',
    baseUrl: 'https://embeddings.example/v1',
    credentials: { apiKey: 'embedding-secret' }
  };
  const h = harness({
    pageCounts: [1],
    mavenResults: [failedExecution(), failedExecution(), passedExecution(1)],
    ragContext,
    ragEmbeddingConfig,
    ragPrepareResults: [
      {
        status: 'attributable',
        diagnosticFingerprint: '8'.repeat(64),
        requestedFqns: ['com.example.FirstFailure'],
        originalDiagnosticText: '[ERROR] first failure',
        targetMethodKey: 'demo.TaskService#getChildZipFile(Ljava/lang/String;)V',
        degradationCode: null
      },
      {
        status: 'attributable',
        diagnosticFingerprint: '7'.repeat(64),
        requestedFqns: ['com.example.SecondFailure'],
        originalDiagnosticText: '[ERROR] second failure',
        targetMethodKey: 'demo.TaskService#getChildZipFile(Ljava/lang/String;)V',
        degradationCode: null
      }
    ]
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.deepEqual(h.startRequests[0].request.ragContext, ragContext);
  assert.equal('ragEmbeddingConfig' in h.startRequests[0].request, false);
  assert.equal('ragContext' in h.feedbackRequests[0].request, false);
  assert.equal('ragContext' in h.feedbackRequests[1].request, false);
  assert.equal('ragContext' in h.feedbackRequests[2].request, false);
  assert.equal(h.ragPrepareRequests.length, 2);
  assert.equal(h.ragRefreshRequests.length, 2);
  assert.deepEqual(
    h.ragPrepareRequests.map(({ request }) => ({
      candidateVersion: request.candidateVersion,
      repairAttempt: request.repairAttempt,
      batchIndex: request.batchIndex,
      executionStatus: request.execution.status
    })),
    [
      {
        candidateVersion: 1,
        repairAttempt: 0,
        batchIndex: 1,
        executionStatus: 'test_failed'
      },
      {
        candidateVersion: 2,
        repairAttempt: 1,
        batchIndex: 1,
        executionStatus: 'test_failed'
      }
    ]
  );
  assert.deepEqual(
    h.ragRefreshRequests.map(({ diagnosticFqns }) => diagnosticFqns),
    [['com.example.FirstFailure'], ['com.example.SecondFailure']]
  );
  assert.deepEqual(
    h.feedbackRequests.slice(0, 2).map(({ request }) => request.ragRepairAttempt),
    [
      {
        diagnosticFingerprint: '8'.repeat(64),
        activeIndex: activeRagIndex(
          ['com.example.FirstFailure', 'com.example.Order'],
          2
        )
      },
      {
        diagnosticFingerprint: '7'.repeat(64),
        activeIndex: activeRagIndex(
          ['com.example.FirstFailure', 'com.example.Order', 'com.example.SecondFailure'],
          3
        )
      }
    ]
  );
  assert.deepEqual(h.feedbackRequests[0].request.ragEmbeddingConfig, ragEmbeddingConfig);
  assert.deepEqual(h.feedbackRequests[1].request.ragEmbeddingConfig, ragEmbeddingConfig);
  assert.equal('ragEmbeddingConfig' in h.feedbackRequests[2].request, false);
  assert.deepEqual(
    h.operations.filter((value) => (
      value.startsWith('maven:')
      || value === 'agent:prepare-rag'
      || value === 'rag:refresh'
      || value === 'agent:resume:execution'
    )),
    [
      'maven:method_candidate',
      'agent:prepare-rag',
      'rag:refresh',
      'agent:resume:execution',
      'maven:method_candidate',
      'agent:prepare-rag',
      'rag:refresh',
      'agent:resume:execution',
      'maven:method_candidate',
      'agent:resume:execution'
    ]
  );
});

test('RAG preparation and index failures fall back to the exact current no-RAG repair context', async () => {
  const baseline = harness({
    pageCounts: [1],
    mavenResults: [testFailedExecution(), passedExecution(1)],
    candidateTransform: versionedRuntimeRepairCandidate
  });
  await baseline.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );
  const expectedRepairContext = baseline.feedbackRequests[0].request.repairContext;

  const cases = [
    {
      name: 'not attributable',
      prepare: [{
        status: 'not_attributable',
        diagnosticFingerprint: '6'.repeat(64),
        requestedFqns: [],
        originalDiagnosticText: '',
        targetMethodKey: null,
        degradationCode: 'RAG_DIAGNOSTIC_ENVIRONMENT_FAILURE'
      }],
      refresh: []
    },
    {
      name: 'prepare exception',
      prepare: [new Error('prepare unavailable')],
      refresh: []
    },
    {
      name: 'index refresh degraded',
      prepare: [],
      refresh: [{
        status: 'degraded',
        vectorStatus: 'degraded',
        workspaceId: 'a'.repeat(64),
        scopeId: 'b'.repeat(64),
        buildFingerprint: 'f'.repeat(64),
        pageCount: 0,
        addedCount: 0,
        updatedCount: 0,
        deletedCount: 0,
        skippedDependencyCount: 0,
        degradationCode: 'RAG_INDEX_PREPARATION_FAILED'
      }]
    },
    {
      name: 'index refresh exception',
      prepare: [],
      refresh: [new Error('refresh unavailable')]
    },
    {
      name: 'embedding runtime unavailable',
      prepare: [],
      refresh: [],
      embedding: false
    }
  ];

  for (const item of cases) {
    const ragContext = {
      enabled: true,
      scope: {
        workspaceRoot: 'D:\\work',
        moduleRoot: 'D:\\work\\module',
        productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
        classpathEntries: ['D:\\work\\module\\target\\classes'],
        localRepository: 'D:\\m2\\repository',
        jdkMajorVersion: 21,
        buildFingerprint: 'f'.repeat(64)
      },
      activeIndex: activeRagIndex(['com.example.Order'])
    };
    const h = harness({
      pageCounts: [1],
      mavenResults: [testFailedExecution(), passedExecution(1)],
      candidateTransform: versionedRuntimeRepairCandidate,
      ragContext,
      ...(item.embedding === false
        ? {}
        : {
            ragEmbeddingConfig: {
              provider: 'custom_openai',
              model: 'text-embedding-local',
              baseUrl: 'https://embeddings.example/v1',
              credentials: { apiKey: 'embedding-secret' }
            }
          }),
      ragPrepareResults: item.prepare,
      ragRefreshResults: item.refresh
    });

    await h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    );

    assert.deepEqual(
      h.feedbackRequests[0].request.repairContext,
      expectedRepairContext,
      item.name
    );
    assert.equal('ragRepairAttempt' in h.feedbackRequests[0].request, false, item.name);
    assert.equal('ragEmbeddingConfig' in h.feedbackRequests[0].request, false, item.name);
    assert.equal(h.repairContextRequests.length, 1, item.name);
  }
});

test('RAG index refresh timeout degrades to no-RAG without stalling Maven verification', async () => {
  const delayedRefresh = new Promise((resolve) => {
    setTimeout(() => resolve({
      status: 'published',
      vectorStatus: 'ready',
      workspaceId: 'a'.repeat(64),
      scopeId: 'b'.repeat(64),
      buildFingerprint: 'f'.repeat(64),
      pageCount: 1,
      addedCount: 1,
      updatedCount: 0,
      deletedCount: 0,
      skippedDependencyCount: 0,
      degradationCode: null
    }), 40);
  });
  const ragContext = {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: ['D:\\work\\module\\target\\classes'],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: 'f'.repeat(64)
    },
    activeIndex: activeRagIndex(['com.example.Order'])
  };
  const h = harness({
    pageCounts: [1],
    mavenResults: [failedExecution(), passedExecution(1)],
    ragContext,
    ragEmbeddingConfig: {
      provider: 'custom_openai',
      model: 'text-embedding-local',
      baseUrl: 'https://embeddings.example/v1',
      credentials: { apiKey: 'embedding-secret' }
    },
    ragRefreshResults: [delayedRefresh],
    ragIndexRefreshWaitMilliseconds: 5
  });

  await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.ragRefreshRequests.length, 1);
  assert.equal(h.repairContextRequests.length, 1);
  assert.ok(h.feedbackRequests[0].request.repairContext);
  assert.equal('ragRepairAttempt' in h.feedbackRequests[0].request, false);
  assert.equal('ragEmbeddingConfig' in h.feedbackRequests[0].request, false);
});

test('accepts multiple Surefire invocations produced by one parameterized test method', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [passedExecution(2)],
    candidateTransform(candidate) {
      const code = [
        'package demo;',
        'import org.junit.jupiter.params.ParameterizedTest;',
        'import org.junit.jupiter.params.provider.ValueSource;',
        `public class ${candidate.outputTestClassName} {`,
        '    @ParameterizedTest',
        '    @ValueSource(ints = {1, 2})',
        '    void coversValues(int value) {}',
        '}',
        ''
      ].join('\n');
      return {
        ...candidate,
        testCode: code,
        generatedCodeSha256: sha256(code)
      };
    }
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.deepEqual(bundle.passedTestMethods, ['coversValues']);
});

test('finite repair exhaustion reports an unattributable failed test without deleting its source', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution()
    ]
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /without a safely retained formal test result/
  );

  assert.equal(h.repairCalls, 5);
  assert.equal(h.feedbackRequests.length, 6);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.mavenInputs.every((input) => input.scope === 'method_candidate'), true);
  assert.equal(h.committedBatches[0].outcome, 'DROPPED');
  assert.equal(h.files.size, 1);
  assert.equal(h.pruneInputs.length, 1);
  assert.equal('commentAllWhenUnattributable' in h.pruneInputs[0], false);
  const [retained] = [...h.files.entries()];
  assert.doesNotMatch(retained[1].code, /\/\/ TODO 当前测试方法需要修复/);
  assert.match(retained[1].code, /^\s*void failsAtRuntime\(\) \{\}$/m);
  assert.equal(h.committedBatches[0].tmpFilePath, retained[0]);
  assert.equal(h.committedBatches[0].tmpFileSha256, retained[1].sha256);
  assert.equal(h.committedBatches[0].ordinaryTestMethodCount, 0);
  assert.equal(h.committedBatches[0].candidateVersion, 1);
});

test('finite repair exhaustion comments only failed tests and re-verifies surviving tests', async () => {
  const h = harness({
    pageCounts: [2],
    mavenResults: [
      testFailedExecution(),
      testFailedExecution(),
      testFailedExecution(),
      testFailedExecution(),
      testFailedExecution(),
      testFailedExecution(),
      passedExecution(1)
    ],
    candidateTransform: versionedRuntimeRepairCandidate
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.repairCalls, 5);
  assert.equal(h.pruneInputs.length, 1);
  assert.equal(h.mavenInputs.length, 7);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.deepEqual(bundle.passedTestMethods, ['batch1Test1']);
  assert.match(bundle.code, /\/\/ TODO 当前测试方法需要修复/);
  assert.match(bundle.code, /\/\/ void failsAtRuntime\(\) \{/);
  assert.equal(h.committedBatches[0].outcome, 'PASSED');
  assert.equal(h.files.size, 1);
});

test('finite repair exhaustion keeps P01 and support while pruning P02 through P12 before merge', async () => {
  const candidateLines = [
    'package demo;',
    '',
    'import static org.mockito.Mockito.when;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private Dependency dependency;',
    '',
    '    private Object newTask() {',
    '        return new Object();',
    '    }',
    '',
    '    private void helperForFailedTests() {}',
    '',
    '    @Test',
    '    void getChildZipFile_P01() {',
    '        Object task = newTask();',
    '        when(dependency.load()).thenReturn("unused");',
    '        task.toString();',
    '    }',
    '',
    ...Array.from({ length: 11 }, (_, index) => {
      const suffix = String(index + 2).padStart(2, '0');
      return [
        '    @Test',
        `    void getChildZipFile_P${suffix}() {`,
        '        helperForFailedTests();',
        '        throw new IllegalStateException("failed");',
        '    }',
        ''
      ];
    }).flat(),
    '}',
    ''
  ];
  const candidateCode = candidateLines.join('\n');
  const candidateTransform = (candidate) => {
    const versionedCode = candidate.candidateVersion === 1
      ? candidateCode
      : candidateCode.replaceAll(
          'throw new IllegalStateException("failed");',
          `int repairAttempt = ${candidate.candidateVersion};\n        throw new IllegalStateException("failed");`
        );
    return {
      ...candidate,
      testCode: versionedCode,
      generatedCodeSha256: sha256(versionedCode)
    };
  };
  const failures = Array.from({ length: 11 }, (_, index) => {
    const suffix = String(index + 2).padStart(2, '0');
    return {
      suiteName: 'demo.TaskServiceTmp1Test',
      testClassName: 'demo.TaskServiceTmp1Test',
      testName: `getChildZipFile_P${suffix}`,
      kind: 'error',
      type: 'java.lang.IllegalStateException',
      message: 'failed'
    };
  });
  const elevenFailures = {
    status: 'test_failed',
    mavenExecutions: [
      {
        scope: 'method_candidate',
        phase: 'test_compile',
        command: 'mvn test-compile',
        exitCode: 0,
        stdout: '',
        stderr: '',
        surefireReports: []
      },
      {
        scope: 'method_candidate',
        phase: 'test',
        command: 'mvn surefire:test',
        exitCode: 1,
        stdout: '',
        stderr: '',
        surefireReports: [{ fileName: 'TEST-demo.TaskServiceTmp1Test.xml', content: '<testsuite />' }]
      }
    ],
    testReport: {
      reportCount: 1,
      tests: 12,
      failures: 0,
      errors: 11,
      skipped: 0,
      generatedTestClassName: 'demo.TaskServiceTmp1Test',
      generatedTests: 12,
      generatedSkipped: 0,
      failureDetails: failures
    }
  };
  const stubbingLine = candidateLines.findIndex((line) => (
    line.includes('when(dependency.load())')
  )) + 1;
  const stubbingDetail = [
    'org.mockito.exceptions.misusing.UnnecessaryStubbingException:',
    'Following stubbings are unnecessary:',
    `  1. -> at demo.TaskServiceTmp1Test.getChildZipFile_P01(TaskServiceTmp1Test.java:${stubbingLine})`
  ].join('\n');
  const unnecessaryStubbing = {
    ...elevenFailures,
    testReport: {
      ...elevenFailures.testReport,
      tests: 1,
      errors: 1,
      generatedTests: 1,
      failureDetails: [{
        suiteName: 'demo.TaskServiceTmp1Test',
        testClassName: 'demo.TaskServiceTmp1Test',
        testName: 'getChildZipFile_P01',
        kind: 'error',
        type: 'org.mockito.exceptions.misusing.UnnecessaryStubbingException',
        detail: stubbingDetail
      }]
    }
  };
  const h = harness({
    pageCounts: [12],
    mavenResults: [
      elevenFailures,
      elevenFailures,
      elevenFailures,
      elevenFailures,
      elevenFailures,
      elevenFailures,
      unnecessaryStubbing,
      passedExecution(1)
    ],
    candidateTransform
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.repairCalls, 5);
  assert.equal(h.pruneInputs.length, 2);
  assert.equal(h.mavenInputs.length, 8);
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.deepEqual(bundle.passedTestMethods, ['getChildZipFile_P01']);
  assert.match(bundle.code, /private Object newTask\(\)/);
  assert.match(bundle.code, /private void helperForFailedTests\(\)/);
  assert.match(bundle.code, /^\s*void getChildZipFile_P01\(\) \{$/m);
  assert.match(bundle.code, /^\s*\/\/ when\(dependency\.load\(\)\)\.thenReturn\("unused"\);$/m);
  assert.equal(
    [...bundle.code.matchAll(/^\s*\/\/ TODO 当前测试方法需要修复\s*$/gm)].length,
    11
  );
  assert.equal(h.committedBatches[0].outcome, 'PASSED');
});

test('finite repair exhaustion comments only a failing assertion and keeps the test method active', async () => {
  const assertionCandidate = (candidate) => {
    const code = [
      'package demo;',
      '',
      'import static org.junit.jupiter.api.Assertions.assertEquals;',
      'import org.junit.jupiter.api.Test;',
      '',
      `public class ${candidate.outputTestClassName} {`,
      '    @Test',
      '    void failsAtRuntime() {',
      `        int repairAttempt = ${candidate.candidateVersion};`,
      '        int actual = 1;',
      '        assertEquals(2, actual);',
      '    }',
      '}',
      ''
    ].join('\n');
    return {
      ...candidate,
      testCode: code,
      generatedCodeSha256: sha256(code)
    };
  };
  const assertionFailure = assertionFailedExecution(11);
  const h = harness({
    pageCounts: [1],
    mavenResults: [
      assertionFailure,
      assertionFailure,
      assertionFailure,
      assertionFailure,
      assertionFailure,
      assertionFailure,
      passedExecution(1)
    ],
    candidateTransform: assertionCandidate
  });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    { completedBatches: [], completedTestMethodPlanIds: [] },
    new AbortController().signal
  );

  assert.equal(h.repairCalls, 5);
  assert.equal(h.pruneInputs.length, 1);
  assert.equal(h.mavenInputs.length, 7);
  assert.equal(h.mavenInputs.at(-1).scope, 'pruned_method_candidate');
  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.deepEqual(bundle.passedTestMethods, ['failsAtRuntime']);
  assert.match(bundle.code, /import static org\.junit\.jupiter\.api\.Assertions\.assertEquals;/);
  assert.match(bundle.code, /import org\.junit\.jupiter\.api\.Test;/);
  assert.match(bundle.code, /^\s*\/\/ assertEquals\(2, actual\);$/m);
  assert.doesNotMatch(bundle.code, /TODO 当前测试方法需要修复/);
  assert.match(bundle.code, /^\s*void failsAtRuntime\(\) \{$/m);
  assert.equal(h.committedBatches[0].outcome, 'PASSED');
});

test('shutdown during final pruned Maven verification preserves the updated TMP digest', async () => {
  const assertionCandidate = (candidate) => {
    const code = [
      'package demo;',
      '',
      'import static org.junit.jupiter.api.Assertions.assertEquals;',
      'import org.junit.jupiter.api.Test;',
      '',
      `public class ${candidate.outputTestClassName} {`,
      '    @Test',
      '    void failsAtRuntime() {',
      '        int actual = 1;',
      '        assertEquals(2, actual);',
      '    }',
      '}',
      ''
    ].join('\n');
    return {
      ...candidate,
      testCode: code,
      generatedCodeSha256: sha256(code)
    };
  };
  const controller = new AbortController();
  const interruption = new ClassTaskApplicationInterruptedError();
  let mavenCalls = 0;
  const h = harness({
    pageCounts: [1],
    mavenResults: [assertionFailedExecution(10), interruption],
    candidateTransform: assertionCandidate,
    onMavenExecute: () => {
      mavenCalls += 1;
      if (mavenCalls === 2) controller.abort(interruption);
    }
  });

  await assert.rejects(
    h.service.execute(
      task({ repairAttemptLimit: 0 }),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      controller.signal
    ),
    /Workstation is closing/
  );

  const retained = [...h.files.values()][0];
  const saved = h.savedInProgressBatches.at(-1);
  assert.equal(saved.tmpFileSha256, retained.sha256);
  assert.equal(saved.candidate.generatedCodeSha256, retained.sha256);
  assert.match(retained.code, /^\s*\/\/ assertEquals\(2, actual\);$/m);
  assert.equal(h.clearedInProgressBatches.length, 0);
});

test('unattributable failure stops the method even when an earlier batch passed', async () => {
  const h = harness({
    pageCounts: [1, 2],
    mavenResults: [
      passedExecution(1),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution()
    ]
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /without a safely retained formal test result/
  );

  assert.deepEqual(
    h.committedBatches.map(({ outcome }) => outcome),
    ['PASSED', 'DROPPED']
  );
  assert.equal(h.files.size, 2);
  assert.notEqual(h.committedBatches[1].tmpFilePath, null);
});

test('invalid deterministic prune output fails safely without another Maven run', async () => {
  const ragContext = {
    enabled: true,
    scope: {
      workspaceRoot: 'D:\\work',
      moduleRoot: 'D:\\work\\module',
      productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
      classpathEntries: ['D:\\work\\module\\target\\classes'],
      localRepository: 'D:\\m2\\repository',
      jdkMajorVersion: 21,
      buildFingerprint: 'f'.repeat(64)
    },
    activeIndex: {
      workspaceId: 'a'.repeat(64),
      scopeId: 'b'.repeat(64),
      indexVersion: 1,
      sourceSetId: 'c'.repeat(64),
      requestedSourceSetFingerprint: '84ca98d235db68f4737289d37526f870dfc4bce041f0ed0cfaec751d66a6e344',
      allowedFqns: ['com.example.Order']
    }
  };
  const ragEmbeddingConfig = {
    provider: 'custom_openai',
    model: 'text-embedding-local',
    baseUrl: 'https://embeddings.example/v1',
    credentials: { apiKey: 'embedding-secret' }
  };
  const h = harness({
    pageCounts: [1],
    mavenResults: [
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution(),
      failedExecution()
    ],
    pruneResult: {
      code: 'not valid Java',
      commentedMethods: ['failsAtRuntime']
    },
    ragContext,
    ragEmbeddingConfig
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /without a safely retained formal test result/
  );

  assert.equal(h.mavenInputs.length, 6);
  assert.equal(h.committedBatches[0].outcome, 'DROPPED');
  assert.equal(h.files.size, 1);
  assert.notEqual(h.committedBatches[0].tmpFilePath, null);
});

test('invalid repair candidate fails immediately and removes the previously owned TMP file', async () => {
  const invalidCode = 'not valid Java';
  const h = harness({
    pageCounts: [1],
    mavenResults: [failedExecution()],
    candidateTransform(candidate) {
      return candidate.candidateVersion === 2
        ? {
            ...candidate,
            testCode: invalidCode,
            generatedCodeSha256: sha256(invalidCode)
          }
        : candidate;
    }
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /candidate|Java source|class name/i
  );

  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.feedbackRequests.length, 1);
  assert.equal(h.files.size, 0);
});

test('restores verified checkpoint batches without repeating model or Maven work', async () => {
  const h = harness({ pageCounts: [], mavenResults: [] });
  const filePath = (
    'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java'
  );
  const code = testCode('TaskServiceTmp1Test', ['restoredScenario']);
  const digest = sha256(code);
  h.files.set(filePath, { code, sha256: digest });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    {
      completedBatches: [{
        taskId: TASK_ID,
        methodId: METHOD_ID,
        batchId: '1'.repeat(64),
        batchIndex: 1,
        completedTestMethodPlanIds: ['plan-1'],
        outcome: 'PASSED',
        candidateVersion: 1,
        tmpFilePath: filePath,
        tmpFileSha256: digest,
        ordinaryTestMethodCount: 1
      }],
      completedTestMethodPlanIds: ['plan-1']
    },
    new AbortController().signal
  );

  assert.equal(bundle.ordinaryTestMethodCount, 1);
  assert.deepEqual(bundle.passedTestMethods, ['restoredScenario']);
  assert.deepEqual(bundle.sourceBatchIds, ['1'.repeat(64)]);
  assert.equal(h.startRequests.length, 0);
  assert.equal(h.mavenInputs.length, 0);
  assert.equal(h.committedBatches.length, 0);
});

test('finalization restores retained TMP batches without Analyzer, model, Maven, or early merge work', async () => {
  const h = harness({ pageCounts: [], mavenResults: [] });
  const filePath = (
    'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp4Test.java'
  );
  const code = testCode('TaskServiceTmp4Test', ['restoredScenario']);
  const digest = sha256(code);
  h.files.set(filePath, { code, sha256: digest });
  const checkpoint = {
    completedBatches: [{
      taskId: TASK_ID,
      methodId: METHOD_ID,
      batchId: '4'.repeat(64),
      batchIndex: 1,
      completedTestMethodPlanIds: ['plan-1'],
      outcome: 'PASSED',
      candidateVersion: 1,
      tmpFilePath: filePath,
      tmpFileSha256: digest,
      ordinaryTestMethodCount: 1
    }],
    completedTestMethodPlanIds: ['plan-1']
  };

  assert.equal(typeof h.service.restoreGeneratedBatches, 'function');
  const restored = await h.service.restoreGeneratedBatches(
    task(),
    METHOD_ID,
    checkpoint,
    new AbortController().signal,
    { temporaryBatchIndexOffset: 3 }
  );

  assert.ok(restored);
  assert.deepEqual(restored.batches.map((batch) => batch.filePath), [filePath]);
  assert.equal(h.analyzerRequests.length, 0);
  assert.equal(h.startRequests.length, 0);
  assert.equal(h.mavenInputs.length, 0);
  assert.equal(h.mergeCalls.length, 0);
});

test('restores a fully commented retained checkpoint batch for formal-file packing', async () => {
  const h = harness({ pageCounts: [], mavenResults: [] });
  const filePath = (
    'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java'
  );
  const code = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private Object newTask() { return new Object(); }',
    '',
    '    // TODO 当前测试方法需要修复',
    '    // @Test',
    '    // void unresolvedScenario() {',
    '    //     newTask();',
    '    // }',
    '}',
    ''
  ].join('\n');
  const digest = sha256(code);
  h.files.set(filePath, { code, sha256: digest });

  const bundle = await h.service.execute(
    task(),
    METHOD_ID,
    {
      completedBatches: [{
        taskId: TASK_ID,
        methodId: METHOD_ID,
        batchId: '1'.repeat(64),
        batchIndex: 1,
        completedTestMethodPlanIds: ['plan-1'],
        outcome: 'RETAINED',
        candidateVersion: 6,
        tmpFilePath: filePath,
        tmpFileSha256: digest,
        ordinaryTestMethodCount: 0
      }],
      completedTestMethodPlanIds: ['plan-1']
    },
    new AbortController().signal
  );

  assert.ok(bundle);
  assert.equal(bundle.ordinaryTestMethodCount, 0);
  assert.deepEqual(bundle.passedTestMethods, []);
  assert.match(bundle.code, /\/\/ TODO 当前测试方法需要修复/);
  assert.match(bundle.code, /private Object newTask\(\)/);
  assert.equal(h.startRequests.length, 0);
  assert.equal(h.mavenInputs.length, 0);
  assert.equal(h.committedBatches.length, 0);
});

test('rejects a hash-valid checkpoint TMP file outside the deterministic task batch identity', async () => {
  const h = harness({ pageCounts: [], mavenResults: [] });
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\UserOwnedTest.java';
  const code = testCode('UserOwnedTest', ['unrelatedScenario']);
  const digest = sha256(code);
  h.files.set(filePath, { code, sha256: digest });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      {
        completedBatches: [{
          taskId: TASK_ID,
          methodId: METHOD_ID,
          batchId: '1'.repeat(64),
          batchIndex: 1,
          completedTestMethodPlanIds: ['plan-1'],
          outcome: 'PASSED',
          candidateVersion: 1,
          tmpFilePath: filePath,
          tmpFileSha256: digest,
          ordinaryTestMethodCount: 1
        }],
        completedTestMethodPlanIds: ['plan-1']
      },
      new AbortController().signal
    ),
    /checkpoint.*TMP.*identity/i
  );

  assert.equal(h.startRequests.length, 0);
  assert.equal(h.mavenInputs.length, 0);
});

test('rejects a repair candidate that changes its batch identity before Maven', async () => {
  const h = harness({
    pageCounts: [1],
    mavenResults: [failedExecution()],
    candidateTransform(candidate) {
      return candidate.candidateVersion === 2
        ? { ...candidate, batchIndex: 2 }
        : candidate;
    }
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /identity/i
  );

  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.files.size, 0);
});

test('rejects a later Analyzer page that repeats an already completed plan ID', async () => {
  const h = harness({
    pageCounts: [1, 1],
    mavenResults: [passedExecution(1)],
    pageTransform(value, index) {
      if (index !== 1) return value;
      return {
        ...value,
        methodTestPlan: {
          ...value.methodTestPlan,
          testMethodPlans: [{ testMethodPlanId: 'plan-1' }]
        }
      };
    }
  });

  await assert.rejects(
    h.service.execute(
      task(),
      METHOD_ID,
      { completedBatches: [], completedTestMethodPlanIds: [] },
      new AbortController().signal
    ),
    /completed|plan ID/i
  );

  assert.equal(h.startRequests.length, 1);
  assert.equal(h.mavenInputs.length, 1);
  assert.equal(h.committedBatches.length, 1);
});

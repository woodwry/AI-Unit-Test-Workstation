import assert from 'node:assert/strict';
import { appendFile, rm } from 'node:fs/promises';
import test from 'node:test';

import {
  createClassTaskEndToEndHarness
} from './e2e/support/fake-backends.mjs';
import { resolveRagSourceSetFingerprint } from '../src/main/services/rag-index-contract.ts';

test('five class tasks use class-only preload, parallelize model work, and retain result ownership', async (t) => {
  const harness = await createClassTaskEndToEndHarness();
  t.after(() => harness.close());

  const result = await harness.runFiveClasses();

  assert.equal(result.completedTasks, 5);
  assert.equal(result.modulePreloadMavenCalls, 0);
  assert.equal(result.classPreloadMavenCalls, 5);
  assert.equal(result.maxConcurrentModelCalls, 5);
  assert.equal(result.maxConcurrentSameModuleMavenCalls, 1);
  assert.equal(result.agentRequests.every((item) => (
    Array.isArray(item.batch.methodSlices)
      && item.batch.methodSlices.length >= 1
      && item.batch.methodSlices.every((slice) => (
        slice.batch.hasWork === true
          && slice.batch.method != null
          && slice.batch.plannedTestMethods >= 1
          && slice.batch.plannedTestMethods <= 5
      ))
  )), true);
  assert.equal(result.agentRequests.every((item) => !('ragContext' in item)), true);
  assert.equal(result.realModelCalls, 0);
  assert.equal(result.acceptedArtifactCount, 1);
  assert.equal(result.revokedArtifactCount, 0);
});

test('stopping preload at the READY commit boundary never publishes READY', async (t) => {
  // Mutation caught: a plain signal check before markPreloadReady lets a stop
  // arriving during the final transition persist and broadcast READY anyway.
  const broadcasts = [];
  let taskId = null;
  let stopArmed = false;
  let stopPromise = null;
  let harness;
  harness = await createClassTaskEndToEndHarness({
    onSnapshot(snapshot) {
      broadcasts.push(structuredClone(snapshot));
      taskId ??= snapshot.id;
      if (
        snapshot.id === taskId
        && snapshot.state === 'PRELOADING'
        && snapshot.coverageBaseline !== null
        && snapshot.coverageCurrent !== null
      ) {
        stopArmed = true;
      }
    },
    clock() {
      if (stopArmed && taskId && !stopPromise) {
        stopArmed = false;
        stopPromise = harness.stopModulePreload(taskId);
      }
      return new Date('2026-08-09T00:00:00.000Z');
    }
  });
  t.after(() => harness.close());

  await harness.startup();
  await harness.addClassTasks(harness.sourceFilePaths.slice(0, 1));
  await harness.flush();
  await stopPromise;

  const [stopped] = await harness.listClassTasks();
  assert.deepEqual(
    {
      state: stopped.state,
      preloadState: stopped.preloadState,
      readyBroadcasts: broadcasts.filter((snapshot) => snapshot.state === 'READY').length
    },
    {
      state: 'PRELOADING',
      preloadState: 'IDLE',
      readyBroadcasts: 0
    }
  );
});

test('RAG-enabled class tasks preflight before index preparation and pass credential-free scope', async (t) => {
  const events = [];
  const subscriptions = [];
  let releaseCalls = 0;
  const allowedFqns = ['com.example.Fixture'];
  const requestedSourceSetFingerprint = resolveRagSourceSetFingerprint(allowedFqns);
  const harness = await createClassTaskEndToEndHarness({
    ragEnabled: true,
    methodsPerClass: 2,
    expectedModelCalls: 5,
    reverseMethodOrder: true,
    ragEmbeddingInterfacesService: {
      async resolveRuntime() {
        events.push('rag-embedding');
        return {
          interfaceId: 'fixture-embedding',
          interfaceName: 'Fixture embedding',
          embeddingModel: 'fixture-embedding',
          embeddingConfig: {
            provider: 'custom_openai',
            model: 'fixture-embedding',
            baseUrl: 'https://embeddings.example/v1',
            credentials: { apiKey: 'fixture-embedding-secret' }
          }
        };
      }
    },
    ragIndexCoordinator: {
      subscribeInitial(input) {
        subscriptions.push(input);
        events.push('rag-index-begin');
        const context = structuredClone(input.context);
        const ready = Promise.resolve().then(() => {
          events.push('rag-index-publish');
          context.activeIndex = {
            workspaceId: 'a'.repeat(64),
            scopeId: 'b'.repeat(64),
            indexVersion: 1,
            sourceSetId: 'c'.repeat(64),
            requestedSourceSetFingerprint,
            allowedFqns
          };
          return {
            status: 'published',
            vectorStatus: 'ready',
            workspaceId: 'a'.repeat(64),
            scopeId: 'b'.repeat(64),
            buildFingerprint: input.context.scope.buildFingerprint,
            pageCount: 1,
            addedCount: 1,
            updatedCount: 0,
            deletedCount: 0,
            skippedDependencyCount: 0,
            degradationCode: null
          };
        });
        return {
          context,
          ready,
          async release() { releaseCalls += 1; }
        };
      },
      async releaseAll() {}
    },
    onModelCallLogSettings() { events.push('detailed-log'); },
    onResolveGenerationModel() { events.push('generation-model'); },
    onToolCallingProbe() { events.push('tool-calling-probe'); },
    onEnsureRagTaskKnowledge() { events.push('rag-knowledge-ensure'); },
    onBeforeRunAll() { events.length = 0; },
    onAnalysisBatch() { events.push('method-analysis-next-batch'); },
    onAgentStart() { events.push('agent-initial-generation'); }
  });
  t.after(() => harness.close());

  const result = await harness.runFiveClasses();

  assert.equal(result.completedTasks, 5);
  assert.equal(subscriptions.length, 5);
  assert.equal(releaseCalls, 5);
  const canonicalizeTaskMethodOrders = (orders) => [...orders].sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
  assert.deepEqual(
    canonicalizeTaskMethodOrders(subscriptions.map(({ methodIds }) => methodIds)),
    canonicalizeTaskMethodOrders(result.savedMethodOrders),
    'the production composition must pass each saved task.methodOrder to subscribeInitial'
  );
  assert.equal(
    result.agentRequests.every((request) => !('ragContext' in request)),
    true,
    'initial Wave generation must not receive repair-only RAG context'
  );
  assert.equal(subscriptions.every(({ context }) => (
    context.enabled === true      && context.scope.localRepository === 'C:\\fixture-home\\.m2\\repository'
      && context.scope.productionSourceRoots.length === 1
      && context.scope.buildFingerprint.length === 64
      && !JSON.stringify(context).includes('fixture-not-used')
      && !JSON.stringify(context).includes('fixture-embedding-secret')
  )), true);
  assert.equal(subscriptions.every(({ embeddingContext }) => (
    embeddingContext?.embeddingConfig.model === 'fixture-embedding'
      && embeddingContext.embeddingConfig.credentials.apiKey === 'fixture-embedding-secret'
  )), true);
  assert.ok(events.indexOf('detailed-log') >= 0);
  assert.ok(events.indexOf('detailed-log') < events.indexOf('generation-model'));
  assert.ok(events.indexOf('generation-model') < events.indexOf('rag-embedding'));
  assert.ok(events.indexOf('generation-model') < events.indexOf('rag-embedding'));
  assert.equal(events.includes('tool-calling-probe'), false);
  assert.ok(events.indexOf('rag-embedding') < events.indexOf('rag-knowledge-ensure'));
  assert.ok(events.indexOf('rag-embedding') < events.indexOf('rag-knowledge-ensure'));
  assert.ok(events.indexOf('rag-knowledge-ensure') < events.indexOf('rag-index-begin'));
  assert.ok(events.indexOf('rag-index-begin') >= 0);
  assert.ok(events.indexOf('rag-index-begin') < events.indexOf('rag-index-publish'));
  assert.ok(events.indexOf('rag-index-publish') < events.indexOf('method-analysis-next-batch'));
  assert.ok(events.indexOf('method-analysis-next-batch') < events.indexOf('agent-initial-generation'));
});

test('RAG preflight follows rebuilding an expired prepared Analyzer session', async (t) => {
  // Mutation caught: preflighting before the heartbeat lets resetPrepared() erase the
  // captured RAG state, so prepareIndex() fails with the internal preflight error.
  const events = [];
  let heartbeatCalls = 0;
  const allowedFqns = ['com.example.Fixture'];
  const requestedSourceSetFingerprint = resolveRagSourceSetFingerprint(allowedFqns);
  const harness = await createClassTaskEndToEndHarness({
    expectedModelCalls: 1,
    onCreateMethodAnalysisSession() {
      events.push('analyzer-session-created');
    },
    heartbeatMethodAnalysisSession({ available }) {
      heartbeatCalls += 1;
      const result = heartbeatCalls === 1 ? false : available;
      events.push(result ? 'analyzer-heartbeat-ready' : 'analyzer-heartbeat-expired');
      return result;
    },
    ragEmbeddingInterfacesService: {
      async resolveRuntime() {
        events.push('rag-embedding');
        return {
          interfaceId: 'fixture-embedding',
          interfaceName: 'Fixture embedding',
          embeddingModel: 'fixture-embedding',
          embeddingConfig: {
            provider: 'custom_openai',
            model: 'fixture-embedding',
            baseUrl: 'https://embeddings.example/v1',
            credentials: { apiKey: 'fixture-embedding-secret' }
          }
        };
      }
    },
    ragIndexCoordinator: {
      subscribeInitial(input) {
        events.push('rag-index-begin');
        const context = structuredClone(input.context);
        context.activeIndex = {
          workspaceId: 'a'.repeat(64),
          scopeId: 'b'.repeat(64),
          indexVersion: 1,
          sourceSetId: 'c'.repeat(64),
          requestedSourceSetFingerprint,
          allowedFqns
        };
        return {
          context,
          ready: Promise.resolve({
            status: 'reused',
            vectorStatus: 'ready',
            workspaceId: 'a'.repeat(64),
            scopeId: 'b'.repeat(64),
            buildFingerprint: input.context.scope.buildFingerprint,
            pageCount: 0,
            addedCount: 0,
            updatedCount: 0,
            deletedCount: 0,
            skippedDependencyCount: 0,
            degradationCode: null
          }),
          async release() {}
        };
      },
      async releaseAll() {}
    }
  });
  t.after(() => harness.close());

  const result = await harness.runFirstRagClass();

  assert.equal(result.snapshot.state, 'COMPLETED', JSON.stringify(result.snapshot.lastError));
  assert.equal(
    events.filter((event) => event === 'analyzer-session-created').length,
    2,
    'the expired prepared Analyzer session must be rebuilt exactly once'
  );
  assert.ok(
    events.indexOf('analyzer-heartbeat-expired')
      < events.lastIndexOf('analyzer-session-created')
  );
  assert.ok(events.lastIndexOf('analyzer-session-created') < events.indexOf('rag-embedding'));
  assert.ok(events.indexOf('rag-embedding') < events.indexOf('rag-index-begin'));
});

test('production class-task composition refreshes its live RAG subscription before repair resume', async (t) => {
  const events = [];
  const resumeRequests = [];
  const initialAllowedFqns = ['com.example.Fixture'];
  const harness = await createClassTaskEndToEndHarness({
    ragEnabled: true,
    expectedModelCalls: 1,
    repairFailedCandidate: true,
    failGeneratedCompile: ({ call, testClassName }) => (
      call === 1 && testClassName.includes('Tmp')
    ),
    ragEmbeddingInterfacesService: {
      async resolveRuntime() {
        return {
          interfaceId: 'fixture-embedding',
          interfaceName: 'Fixture embedding',
          embeddingModel: 'fixture-embedding',
          embeddingConfig: {
            provider: 'custom_openai',
            model: 'fixture-embedding',
            baseUrl: 'https://embeddings.example/v1',
            credentials: { apiKey: 'fixture-embedding-secret' }
          }
        };
      }
    },
    ragIndexCoordinator: {
      subscribeInitial(input) {
        const context = structuredClone(input.context);
        context.activeIndex = {
          workspaceId: 'a'.repeat(64),
          scopeId: 'b'.repeat(64),
          indexVersion: 1,
          sourceSetId: 'c'.repeat(64),
          requestedSourceSetFingerprint: resolveRagSourceSetFingerprint(initialAllowedFqns),
          allowedFqns: initialAllowedFqns
        };
        return {
          context,
          ready: Promise.resolve({
            status: 'reused',
            vectorStatus: 'ready',
            workspaceId: 'a'.repeat(64),
            scopeId: 'b'.repeat(64),
            buildFingerprint: input.context.scope.buildFingerprint,
            pageCount: 0,
            addedCount: 0,
            updatedCount: 0,
            deletedCount: 0,
            skippedDependencyCount: 0,
            degradationCode: null
          }),
          async release() {}
        };
      },
      async refresh(subscription, diagnosticFqns) {
        events.push(`refresh:${diagnosticFqns.join(',')}`);
        const allowedFqns = [...new Set([
          ...subscription.context.activeIndex.allowedFqns,
          ...diagnosticFqns
        ])].sort();
        subscription.context.activeIndex = {
          workspaceId: 'a'.repeat(64),
          scopeId: 'b'.repeat(64),
          indexVersion: 2,
          sourceSetId: 'd'.repeat(64),
          requestedSourceSetFingerprint: resolveRagSourceSetFingerprint(allowedFqns),
          allowedFqns
        };
        return {
          status: 'published',
          vectorStatus: 'ready',
          workspaceId: 'a'.repeat(64),
          scopeId: 'b'.repeat(64),
          buildFingerprint: subscription.context.scope.buildFingerprint,
          pageCount: 1,
          addedCount: 1,
          updatedCount: 0,
          deletedCount: 0,
          skippedDependencyCount: 0,
          degradationCode: null
        };
      },
      async releaseAll() {}
    },
    onRagPrepare() { events.push('prepare'); },
    onAgentResume(request) {
      events.push(`resume:${request.execution.status}`);
      resumeRequests.push(request);
    }
  });
  t.after(() => harness.close());

  const result = await harness.runFirstRagClass();

  assert.equal(result.snapshot.state, 'COMPLETED', JSON.stringify(result.snapshot.lastError));
  assert.deepEqual(events, [
    'prepare',
    'refresh:com.example.DiagnosticDependency',
    'resume:compile_failed',
    'resume:passed'
  ]);
  assert.deepEqual(resumeRequests[0].ragRepairAttempt, {
    diagnosticFingerprint: '8'.repeat(64),
    activeIndex: {
      workspaceId: 'a'.repeat(64),
      scopeId: 'b'.repeat(64),
      indexVersion: 2,
      sourceSetId: 'd'.repeat(64),
      requestedSourceSetFingerprint: resolveRagSourceSetFingerprint([
        'com.example.DiagnosticDependency',
        'com.example.Fixture'
      ]),
      allowedFqns: ['com.example.DiagnosticDependency', 'com.example.Fixture']
    }
  });
  assert.equal('repairContext' in resumeRequests[0], false);
  assert.equal('ragRepairAttempt' in resumeRequests[1], false);
});

test('tool-calling capability metadata does not block a RAG class task', async (t) => {
  let subscriptions = 0;
  let probeCalls = 0;
  const allowedFqns = ['com.example.Fixture'];
  const requestedSourceSetFingerprint = resolveRagSourceSetFingerprint(allowedFqns);
  const harness = await createClassTaskEndToEndHarness({
    ragEnabled: true,
    expectedModelCalls: 1,
    toolCallingProbeResult: {
      supported: false,
      cacheHit: false,
      cacheKeyDigest: 'd'.repeat(64),
      trace: null
    },
    onToolCallingProbe() { probeCalls += 1; },
    ragEmbeddingInterfacesService: {
      async resolveRuntime() {
        return {
          interfaceId: 'fixture-embedding',
          interfaceName: 'Fixture embedding',
          embeddingModel: 'fixture-embedding',
          embeddingConfig: {
            provider: 'custom_openai',
            model: 'fixture-embedding',
            baseUrl: 'https://embeddings.example/v1',
            credentials: { apiKey: 'fixture-embedding-secret' }
          }
        };
      }
    },
    ragIndexCoordinator: {
      subscribeInitial(input) {
        subscriptions += 1;
        const context = structuredClone(input.context);
        context.activeIndex = {
          workspaceId: 'a'.repeat(64),
          scopeId: 'b'.repeat(64),
          indexVersion: 1,
          sourceSetId: 'c'.repeat(64),
          requestedSourceSetFingerprint,
          allowedFqns
        };
        return {
          context,
          ready: Promise.resolve({
            status: 'reused',
            vectorStatus: 'ready',
            workspaceId: 'a'.repeat(64),
            scopeId: 'b'.repeat(64),
            buildFingerprint: input.context.scope.buildFingerprint,
            pageCount: 1,
            addedCount: 0,
            updatedCount: 0,
            deletedCount: 0,
            skippedDependencyCount: 0,
            degradationCode: null
          }),
          async release() {}
        };
      },
      async releaseAll() {}
    }
  });
  t.after(() => harness.close());

  const result = await harness.runFirstRagClass();

  assert.equal(result.snapshot.state, 'COMPLETED', JSON.stringify(result.snapshot.lastError));
  assert.equal(probeCalls, 0);
  assert.equal(subscriptions, 1);
  assert.equal(result.agentRequests.length, 1);
});

test('one class Wave publishes all selected methods with one coverage refresh', async (t) => {
  const filesAtModelStart = [];
  let harness;
  harness = await createClassTaskEndToEndHarness({
    methodsPerClass: 2,
    expectedModelCalls: 1,
    async onAgentStart(request) {
      filesAtModelStart.push({
        outputTestClassName: request.outputTestClassName,
        files: await harness.listGeneratedTestFiles()
      });
    }
  });
  t.after(() => harness.close());

  const result = await harness.runFirstClassMethods();

  assert.equal(
    result.snapshot.state,
    'COMPLETED',
    JSON.stringify(result.snapshot.lastError)
  );
  assert.deepEqual(
    filesAtModelStart.map((entry) => entry.outputTestClassName),
    ['AlphaServiceTmp1Part1Test']
  );
  assert.deepEqual(
    result.testFiles.filter((name) => /^AlphaService/.test(name)),
    ['AlphaService1Test.java']
  );
  assert.equal(result.snapshot.generatedArtifacts.length, 1);
  assert.equal(result.snapshot.generatedArtifacts[0].methodIds.length, 2);
  assert.equal(result.snapshot.generatedArtifacts[0].ordinaryTestMethodCount, 2);
  assert.equal(
    result.maven.taskJacocoAppendCalls,
    1,
    'one verified class Wave must publish one coverage snapshot'
  );
  assert.ok(
    result.snapshot.coverageCurrent.lineCovered
      > result.snapshot.coverageBaseline.lineCovered,
    'verified generated tests must increase the persisted JaCoCo line coverage'
  );
});

test('data-class methods use the shared class Wave path and publish one formal file', async (t) => {
  const generatedCompileClasses = [];
  const harness = await createClassTaskEndToEndHarness({
    methodsPerClass: 2,
    dataClassBatch: true,
    expectedModelCalls: 1,
    failGeneratedCompile({ testClassName, call }) {
      generatedCompileClasses.push(testClassName.split('.').at(-1));
      return false;
    }
  });
  t.after(() => harness.close());

  const result = await harness.runFirstClassMethods();

  assert.equal(result.snapshot.state, 'COMPLETED', JSON.stringify(result.snapshot.lastError));
  assert.equal(result.batchModelCalls, 0);
  assert.equal(result.agentRequests.length, 1);
  assert.deepEqual(
    generatedCompileClasses,
    [
      'AlphaServiceTmp1Test',
      'AlphaService1Test'
    ]
  );
  assert.equal(result.maven.generatedCompileCalls, 2);
  assert.deepEqual(
    result.testFiles.filter((name) => /^AlphaService/.test(name)),
    ['AlphaService1Test.java']
  );
  assert.equal(result.snapshot.generatedArtifacts[0].methodIds.length, 2);
});

test('a data class with over twenty scenarios becomes one formal file without splitting', async (t) => {
  // Mutation caught: restoring the shared TMP as per-method bundles lets the generic
  // twenty-test packer split one already-verified Java file into multiple formal files.
  const harness = await createClassTaskEndToEndHarness({
    methodsPerClass: 21,
    dataClassBatch: true,
    expectedModelCalls: 5
  });
  t.after(() => harness.close());

  const result = await harness.runFirstClassMethods();

  assert.equal(result.snapshot.state, 'COMPLETED', JSON.stringify(result.snapshot.lastError));
  assert.equal(result.batchModelCalls, 0);
  assert.equal(result.agentRequests.length, 5);
  assert.deepEqual(
    result.testFiles.filter((name) => /^AlphaService/.test(name)),
    ['AlphaService1Test.java']
  );
  assert.equal(result.snapshot.generatedArtifacts.length, 1);
  assert.equal(result.snapshot.generatedArtifacts[0].ordinaryTestMethodCount, 21);
  assert.equal(result.snapshot.generatedArtifacts[0].methodIds.length, 21);
});

test('retry drops a missing unaccepted artifact before task JaCoCo recalculation', async (t) => {
  // Mutation caught: retrying with the stale transaction artifact invokes Surefire for a
  // generated class whose source file no longer exists, permanently returning to PRELOAD_FAILED.
  const harness = await createClassTaskEndToEndHarness({ expectedModelCalls: 1 });
  t.after(() => harness.close());
  const completed = await harness.runFirstClassMethods();
  const artifact = completed.snapshot.generatedArtifacts[0];
  assert.ok(artifact);
  const beforeRetry = harness.mavenMetrics();
  await rm(artifact.filePath, { force: true });

  await harness.retryModulePreload(completed.snapshot.id);

  const [retried] = await harness.listClassTasks();
  const afterRetry = harness.mavenMetrics();
  assert.equal(
    afterRetry.taskJacocoAppendCalls,
    beforeRetry.taskJacocoAppendCalls,
    'retry must not execute task JaCoCo for a generated test file that no longer exists'
  );
  assert.equal(retried.state, 'READY', JSON.stringify(retried.lastError));
  assert.deepEqual(retried.generatedArtifacts, []);
  assert.deepEqual(retried.coverageContributions, []);
  assert.deepEqual(retried.coverageCurrent, retried.coverageBaseline);
});

test('method refresh drops a deleted unaccepted result before reloading coverage', async (t) => {
  const harness = await createClassTaskEndToEndHarness({ expectedModelCalls: 1 });
  t.after(() => harness.close());
  const completed = await harness.runFirstClassMethods();
  const artifact = completed.snapshot.generatedArtifacts[0];
  assert.ok(artifact);
  assert.ok(completed.initialCatalog?.fingerprint);
  await rm(artifact.filePath, { force: true });

  const freshness = await harness.checkClassTaskMethods(
    completed.snapshot.id,
    completed.initialCatalog.fingerprint
  );

  assert.equal(freshness.current, false);
  await harness.getClassTaskMethods(completed.snapshot.id);
  const [refreshed] = await harness.listClassTasks();
  assert.equal(refreshed.state, 'COMPLETED', JSON.stringify(refreshed.lastError));
  assert.deepEqual(refreshed.generatedArtifacts, []);
  assert.deepEqual(refreshed.coverageContributions, []);
  assert.deepEqual(refreshed.coverageCurrent, refreshed.coverageBaseline);
  assert.equal(refreshed.completionAttentionPending, false);
});

test('method refresh relinquishes a modified unaccepted result and keeps the user file', async (t) => {
  const harness = await createClassTaskEndToEndHarness({ expectedModelCalls: 1 });
  t.after(() => harness.close());
  const completed = await harness.runFirstClassMethods();
  const artifact = completed.snapshot.generatedArtifacts[0];
  assert.ok(artifact);
  assert.ok(completed.initialCatalog?.fingerprint);
  await appendFile(artifact.filePath, '\n// user edit\n', 'utf8');

  const freshness = await harness.checkClassTaskMethods(
    completed.snapshot.id,
    completed.initialCatalog.fingerprint
  );

  assert.equal(freshness.current, false);
  await harness.getClassTaskMethods(completed.snapshot.id);
  const [refreshed] = await harness.listClassTasks();
  assert.equal(refreshed.state, 'COMPLETED', JSON.stringify(refreshed.lastError));
  assert.deepEqual(refreshed.generatedArtifacts, []);
  assert.deepEqual(refreshed.coverageContributions, []);
  assert.deepEqual(refreshed.coverageCurrent, refreshed.coverageBaseline);
  assert.equal(refreshed.completionAttentionPending, false);
  assert.ok((await harness.listGeneratedTestFiles()).includes('AlphaService1Test.java'));
});

test('a failed class Wave publication deletes TMP scratch and retries from a fresh run', async (t) => {
  const harness = await createClassTaskEndToEndHarness({
    methodsPerClass: 2,
    expectedModelCalls: 1,
    reportWaveUsage: true,
    failGeneratedCompile({ testClassName, call }) {
      return testClassName.endsWith('.AlphaService1Test') && call === 1;
    }
  });
  t.after(() => harness.close());

  const result = await harness.runFirstClassMethodsWithFinalizationRetry();

  assert.equal(result.first.state, 'FAILED');
  assert.equal(result.first.generatedArtifacts.length, 0);
  assert.deepEqual(
    result.filesAfterFailure.filter((name) => /^AlphaService/.test(name)),
    []
  );
  assert.equal(result.modelCallCountAfterFailure, 1);

  assert.equal(result.second.state, 'COMPLETED');
  assert.equal(result.agentRequests.length, 2, 'retry must freshly generate the class Wave');
  assert.equal(
    result.second.modelCallCount,
    2,
    'a failed retry with a different model must retain calls from the previous attempt'
  );
  assert.equal(
    result.second.usageReportedCallCount,
    2,
    'reported usage from every model configuration must remain cumulative'
  );
  assert.deepEqual(
    result.testFiles.filter((name) => /^AlphaService/.test(name)),
    ['AlphaService1Test.java']
  );
  assert.equal(result.second.generatedArtifacts.length, 1);
  assert.deepEqual(
    result.second.generatedArtifacts.map((artifact) => artifact.methodIds.length),
    [2]
  );
  assert.equal(
    result.second.generatedArtifacts.reduce(
      (total, artifact) => total + artifact.ordinaryTestMethodCount,
      0
    ),
    2
  );
});

test('running a failed task refreshes after terminal cleanup removed its TMP scratch', async (t) => {
  const states = [];
  const harness = await createClassTaskEndToEndHarness({
    methodsPerClass: 2,
    expectedModelCalls: 1,
    onSnapshot(snapshot) {
      states.push(snapshot.state);
    },
    failGeneratedCompile({ testClassName, call }) {
      return testClassName.endsWith('.AlphaService1Test') && call === 1;
    }
  });
  t.after(() => harness.close());

  const first = await harness.runFirstClassMethods();
  assert.equal(first.snapshot.state, 'FAILED');
  assert.equal(first.testFiles.includes('AlphaServiceTmp1Test.java'), false);

  const refreshStateOffset = states.length;
  const refreshed = await harness.runTask(first.snapshot.id);

  assert.equal(refreshed.state, 'COMPLETED', JSON.stringify(refreshed.lastError));
  assert.equal(refreshed.lastError, null);
  assert.ok(states.slice(refreshStateOffset).includes('PRELOADING'));
  assert.ok(states.slice(refreshStateOffset).includes('READY'));
  assert.deepEqual(
    (await harness.listGeneratedTestFiles()).filter((name) => /^AlphaService/.test(name)),
    ['AlphaService1Test.java']
  );
  assert.equal(refreshed.generatedArtifacts.length, 1);
  assert.equal(refreshed.generatedArtifacts[0].methodIds.length, 2);
});

test('changing a failed task method selection discards its otherwise recoverable run', async (t) => {
  // Mutation caught: treating durable recovery files as sufficient after the saved method order
  // changes reuses completed methods from the old order and publishes an out-of-range index.
  const harness = await createClassTaskEndToEndHarness({
    methodsPerClass: 2,
    expectedModelCalls: 1,
    failGeneratedCompile({ testClassName, call }) {
      return testClassName.endsWith('.AlphaService1Test') && call === 1;
    }
  });
  t.after(() => harness.close());

  const first = await harness.runFirstClassMethods();
  assert.equal(first.snapshot.state, 'FAILED');
  assert.equal(first.snapshot.methodOrder.length, 2);
  assert.equal(first.snapshot.generatedArtifacts.length, 0);
  assert.equal(first.testFiles.includes('AlphaService1Test.java'), false);

  const selectedMethodId = first.snapshot.methodOrder[0];
  await harness.saveMethodSelection(first.snapshot.id, [selectedMethodId]);
  const modelCallsBeforeRetry = harness.agentRequests().length;

  const retried = await harness.runTask(first.snapshot.id);

  assert.equal(retried.state, 'COMPLETED', JSON.stringify(retried.lastError));
  assert.equal(retried.lastError, null);
  assert.deepEqual(retried.methodOrder, [selectedMethodId]);
  assert.deepEqual(retried.generatedArtifacts.flatMap((artifact) => artifact.methodIds), [
    selectedMethodId
  ]);
  assert.equal(
    harness.agentRequests().length,
    modelCallsBeforeRetry + 1,
    'the changed selection must start a fresh generation instead of reusing the old result'
  );
});

test('rerunning after a deleted accepted result replaces stale artifact ownership for the reused path', async (t) => {
  // Mutation caught: merging artifacts only by id persists the old accepted record and the
  // new pending record for AlphaService1Test.java, so IPC validation rejects duplicate paths.
  // A multi-Part wave also proves that the accepted run's completed Wave checkpoint is reset:
  // every Part must call generation again instead of falling through to empty finalization.
  const harness = await createClassTaskEndToEndHarness({
    expectedModelCalls: 3,
    waveScenarioCount: 14
  });
  t.after(() => harness.close());

  const first = await harness.runFirstClassMethods();
  await harness.acceptTaskResult(first.snapshot.id);
  await harness.removeGeneratedTestFile('AlphaService1Test.java');
  const modelCallsBeforeRerun = harness.agentRequests().length;

  const rerun = await harness.runTask(first.snapshot.id);

  assert.equal(rerun.state, 'COMPLETED', JSON.stringify(rerun.lastError));
  assert.equal(rerun.lastError, null);
  assert.equal(modelCallsBeforeRerun, 3);
  assert.equal(
    harness.agentRequests().length,
    modelCallsBeforeRerun + 3,
    'all Parts must be generated again after the accepted formal file is deleted'
  );
  assert.equal(rerun.generatedArtifacts.length, 1);
  assert.equal(rerun.generatedArtifacts[0].accepted, false);
  assert.match(rerun.generatedArtifacts[0].filePath, /AlphaService1Test\.java$/);
  assert.deepEqual(
    (await harness.listGeneratedTestFiles()).filter((name) => /^AlphaService/.test(name)),
    ['AlphaService1Test.java']
  );
});

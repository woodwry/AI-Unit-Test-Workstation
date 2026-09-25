import assert from 'node:assert/strict';
import test from 'node:test';

import { RagIndexCoordinator } from '../src/main/services/rag-index-coordinator.service.ts';
import { resolveRagSourceSetFingerprint } from '../src/main/services/rag-index-contract.ts';

const ANALYSIS_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TASK_RUN_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_PAIR_ID = 'a'.repeat(64);
const METHOD_ID = 'b'.repeat(64);
const BUILD_FINGERPRINT = 'c'.repeat(64);

const scope = {
  workspaceRoot: 'D:\\work',
  moduleRoot: 'D:\\work\\module',
  productionSourceRoots: ['D:\\work\\module\\src\\main\\java'],
  classpathEntries: ['D:\\work\\module\\target\\classes'],
  localRepository: 'D:\\repo',
  jdkMajorVersion: 21,
  buildFingerprint: BUILD_FINGERPRINT
};

function activeIndex(allowedFqns = ['com.example.Order'], indexVersion = 1) {
  return {
    workspaceId: 'd'.repeat(64),
    scopeId: 'e'.repeat(64),
    indexVersion,
    sourceSetId: 'f'.repeat(64),
    requestedSourceSetFingerprint: resolveRagSourceSetFingerprint(allowedFqns),
    allowedFqns
  };
}

function context() {
  return {
    enabled: true,
    scope,
    activeIndex: null,
    taskRunId: TASK_RUN_ID,
    revokedFqns: []
  };
}

function embeddingContext() {
  return {
    embeddingConfig: {
      provider: 'custom_openai',
      model: 'embed-model',
      baseUrl: 'https://embeddings.example/v1',
      credentials: { apiKey: 'embedding-secret' }
    }
  };
}

function input(overrides = {}) {
  return {
    context: context(),
    embeddingContext: embeddingContext(),
    analysisSessionId: ANALYSIS_SESSION_ID,
    reportPairId: REPORT_PAIR_ID,
    methodIds: [METHOD_ID],
    ...overrides
  };
}

function harness({ refreshError = null } = {}) {
  const prepareCalls = [];
  const resolveCalls = [];
  const snapshotCalls = [];
  const refreshCalls = [];
  const cancelledSessions = [];
  let generation = 0;
  const requestedFqns = ['com.example.Dependency', 'com.example.Order'];
  const fingerprint = resolveRagSourceSetFingerprint(requestedFqns);
  const coordinator = new RagIndexCoordinator({
    async globalKnowledge(repairContext, modelContext) {
      prepareCalls.push({ repairContext: structuredClone(repairContext), modelContext });
      generation += 1;
      return activeIndex(requestedFqns, generation);
    },
    async globalKnowledgeRefresh(value) {
      refreshCalls.push(value.page.pageIndex);
      if (refreshError) throw refreshError;
      return {
        status: value.page.pageIndex === 0 ? 'published' : 'reused',
        addedMethodCount: value.page.pageIndex === 0 ? 2 : 0,
        reusedMethodCount: 0
      };
    },
    analyzer: {
      async resolveRagSourceSet(analysisSessionId, request) {
        resolveCalls.push({ analysisSessionId, request: structuredClone(request) });
        return {
          targetClassFqn: 'com.example.Order',
          allowedFqns: requestedFqns,
          unresolvedFqns: [],
          requestedSourceSetFingerprint: fingerprint
        };
      },
      async createRagSourceSnapshotSession(request) {
        snapshotCalls.push(structuredClone(request));
        return {
          sessionId: SNAPSHOT_SESSION_ID,
          requestedSourceSetFingerprint: fingerprint,
          allowedFqns: requestedFqns,
          unresolvedFqns: [],
          upsertCount: 2,
          unchangedCount: 0,
          deletedCount: 0
        };
      },
      async getRagSourceSnapshotPage(sessionId, pageIndex, pageSize) {
        assert.equal(sessionId, SNAPSHOT_SESSION_ID);
        assert.equal(pageSize, 50);
        return {
          sessionId,
          pageIndex,
          pageSize,
          upserts: [],
          unchangedFileIds: [],
          deletedFileIds: [],
          hasMore: pageIndex === 0,
          diagnostics: []
        };
      },
      async cancelRagSourceSnapshotSession(sessionId) {
        cancelledSessions.push(sessionId);
      }
    }
  });
  return {
    coordinator,
    prepareCalls,
    resolveCalls,
    snapshotCalls,
    refreshCalls,
    cancelledSessions
  };
}

test('initial subscription prepares the tenant PostgreSQL knowledge identity', async () => {
  const h = harness();
  const subscription = await h.coordinator.subscribeInitial(input());
  const result = await subscription.ready;

  assert.equal(h.prepareCalls.length, 1);
  assert.equal(result.status, 'reused');
  assert.equal(result.vectorStatus, 'ready');
  assert.equal(subscription.context.activeIndex?.indexVersion, 1);
  assert.equal(JSON.stringify(h.prepareCalls).includes('embedding-secret'), true);
  assert.equal('databaseRoot' in subscription.context, false);
});

test('diagnostic refresh snapshots only requested source and appends every page to global knowledge', async () => {
  const h = harness();
  const subscription = await h.coordinator.subscribeInitial(input());
  const result = await h.coordinator.refresh(
    subscription,
    ['com.example.Dependency'],
    undefined,
    [{
      ownerFqn: 'com.example.Dependency',
      methodName: 'load',
      descriptor: '()V',
      sourceLine: 12
    }]
  );

  assert.equal(result.status, 'published');
  assert.equal(result.pageCount, 2);
  assert.equal(result.addedCount, 2);
  assert.deepEqual(h.refreshCalls, [0, 1]);
  assert.equal(h.resolveCalls.length, 1);
  assert.deepEqual(h.resolveCalls[0].request.requestedFqns, ['com.example.Dependency']);
  assert.equal(h.snapshotCalls[0].requestedMethods[0].methodName, 'load');
  assert.deepEqual(h.cancelledSessions, [SNAPSHOT_SESSION_ID]);
  assert.equal(subscription.context.activeIndex?.indexVersion, 2);
});

test('refresh failure degrades safely and preserves the previous active identity', async () => {
  const h = harness({ refreshError: new Error('PostgreSQL unavailable') });
  const subscription = await h.coordinator.subscribeInitial(input());
  const previous = structuredClone(subscription.context.activeIndex);
  const result = await h.coordinator.refresh(subscription, ['com.example.Dependency']);

  assert.equal(result.status, 'degraded');
  assert.equal(result.degradationCode, 'RAG_INDEX_PREPARATION_FAILED');
  assert.deepEqual(subscription.context.activeIndex, previous);
  assert.deepEqual(h.cancelledSessions, [SNAPSHOT_SESSION_ID]);
});

test('released subscriptions cannot be refreshed', async () => {
  const h = harness();
  const subscription = await h.coordinator.subscribeInitial(input());
  await subscription.release();
  await assert.rejects(
    h.coordinator.refresh(subscription, ['com.example.Dependency']),
    /no longer active/
  );
});

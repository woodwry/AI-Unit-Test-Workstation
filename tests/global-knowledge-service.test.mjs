import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cancelGlobalKnowledgeImport,
  ensureGlobalSnapshotPage,
  ensureGlobalTaskKnowledge,
  executeGlobalKnowledge
} from '../src/main/services/global-knowledge.service.ts';
import { resolveRagEmbeddingModelFingerprint } from '../src/main/services/rag-index-contract.ts';

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rag-ensure-'));
  const moduleRoot = join(workspaceRoot, 'module');
  const sourceRoot = join(moduleRoot, 'src', 'main', 'java', 'a');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project><groupId>a</groupId><artifactId>b</artifactId><version>1</version></project>');
  const targetSourcePath = join(sourceRoot, 'Target.java');
  await writeFile(targetSourcePath, 'package a; class Target { void run() {} }');
  return { workspaceRoot, moduleRoot, targetSourcePath };
}

test('generation ensure sends only the trusted task POM and Java source', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.workspaceRoot, { recursive: true, force: true }));
  const calls = [];
  const signal = new AbortController().signal;
  const embeddingConfig = { provider: 'custom_openai', model: 'embed', baseUrl: 'https://embed.example/v1', credentials: { apiKey: 'secret' } };
  const result = await ensureGlobalTaskKnowledge({
    ...paths,
    targetClass: 'a.Target',
    embeddingConfig,
    signal
  }, {
    async globalKnowledge(...args) {
      calls.push(args);
      return { status: 'published', entryId: 'entry', classFqn: 'a.Target', addedMethodCount: 1, reusedMethodCount: 0, indexGeneration: 2 };
    }
  });
  assert.equal(result.addedMethodCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].action, 'ensure');
  assert.equal(calls[0][0].targetClass, 'a.Target');
  assert.equal(calls[0][0].files[0].name, 'Target.java');
  assert.equal(
    calls[0][0].embeddingModelFingerprint,
    resolveRagEmbeddingModelFingerprint(embeddingConfig)
  );
  assert.equal(Buffer.from(calls[0][0].files[0].content, 'base64').toString(), 'package a; class Target { void run() {} }');
  assert.equal(calls[0][1], embeddingConfig);
  assert.equal(calls[0][2], signal);
});

test('knowledge browsing sends the active vector model fingerprint without credentials', async () => {
  const calls = [];
  const active = {
    id: 'embedding-b',
    baseUrl: 'https://embed.example/v1/',
    embeddingModel: 'embedding-b'
  };
  await executeGlobalKnowledge({ action: 'entries', query: '', cursor: null }, {
    aiClient: { async globalKnowledge(...args) { calls.push(args); return { items: [] }; } },
    embeddings: {
      async getView() { return { activeInterfaceId: active.id, interfaces: [active] }; },
      async resolveRuntime() { throw new Error('browsing must not resolve credentials'); }
    }
  });
  assert.equal(
    calls[0][0].embeddingModelFingerprint,
    resolveRagEmbeddingModelFingerprint({ baseUrl: active.baseUrl, model: active.embeddingModel })
  );
  assert.equal(calls[0][1], undefined);
  assert.equal(JSON.stringify(calls).includes('apiKey'), false);
});

test('generation ensure rejects a source outside the Maven module', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.workspaceRoot, { recursive: true, force: true }));
  const outside = join(paths.workspaceRoot, 'Outside.java');
  await writeFile(outside, 'class Outside {}');
  await assert.rejects(ensureGlobalTaskKnowledge({
    ...paths,
    targetSourcePath: outside,
    targetClass: 'Outside',
    embeddingConfig: { provider: 'custom_openai', model: 'embed', baseUrl: 'https://embed.example/v1', credentials: { apiKey: 'secret' } }
  }, { async globalKnowledge() { throw new Error('must not be called'); } }), /Maven 模块/);
});

test('repair snapshot ensures project and Maven dependency classes through the global store', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.workspaceRoot, { recursive: true, force: true }));
  const calls = [];
  const embeddingConfig = { provider: 'custom_openai', model: 'embed', baseUrl: 'https://embed.example/v1', credentials: { apiKey: 'secret' } };
  const result = await ensureGlobalSnapshotPage({
    moduleRoot: paths.moduleRoot,
    page: {
      upserts: [
        { decommentedSource: 'package a; class Project { void run() {} }', mavenCoordinate: null, methods: [{ ownerFqn: 'a.Project' }] },
        { decommentedSource: 'package dep; class External { void call() {} }', mavenCoordinate: 'g:dependency:2', methods: [{ ownerFqn: 'dep.External' }] }
      ]
    },
    embeddingConfig
  }, {
    async globalKnowledge(request, actualEmbeddingConfig) {
      calls.push({ request, actualEmbeddingConfig });
      return {
        status: calls.length === 1 ? 'published' : 'reused',
        entryId: `entry-${calls.length}`,
        classFqn: request.targetClass,
        addedMethodCount: calls.length === 1 ? 1 : 0,
        reusedMethodCount: calls.length === 1 ? 0 : 1,
        indexGeneration: 3
      };
    }
  });
  assert.deepEqual(result, { status: 'published', addedMethodCount: 1, reusedMethodCount: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.targetClass, 'a.Project');
  assert.match(calls[0].request.modulePom, /<artifactId>b<\/artifactId>/);
  assert.equal(calls[1].request.targetClass, 'dep.External');
  assert.match(calls[1].request.modulePom, /<groupId>g<\/groupId>/);
  assert.match(calls[1].request.modulePom, /<version>2<\/version>/);
  assert.equal(calls[1].actualEmbeddingConfig, embeddingConfig);
});

test('manual import forwards its operation id and abort signal', async (t) => {
  const paths = await fixture();
  t.after(() => rm(paths.workspaceRoot, { recursive: true, force: true }));
  const calls = [];
  const signal = new AbortController().signal;
  const embeddingConfig = {
    provider: 'custom_openai',
    model: 'embed',
    baseUrl: 'https://embed.example/v1',
    credentials: { apiKey: 'secret' }
  };

  const result = await executeGlobalKnowledge({
    action: 'import',
    moduleId: 'module-1',
    paths: [paths.targetSourcePath]
  }, {
    aiClient: {
      async globalKnowledge(...args) {
        calls.push(args);
        return { items: [] };
      }
    },
    embeddings: { async resolveRuntime() { return { embeddingConfig }; } },
    operationId: 'operation-1',
    signal
  });

  assert.deepEqual(result, { items: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].action, 'import');
  assert.equal(calls[0][0].operationId, 'operation-1');
  assert.equal(calls[0][0].files[0].name, 'Target.java');
  assert.equal(calls[0][1], embeddingConfig);
  assert.equal(calls[0][2], signal);
});

test('manual import cancellation targets the current operation', async () => {
  const calls = [];
  const cancelled = await cancelGlobalKnowledgeImport('operation-1', {
    aiClient: {
      async globalKnowledge(...args) {
        calls.push(args);
        return { cancelled: true };
      }
    }
  });

  assert.equal(cancelled, true);
  assert.deepEqual(calls, [[{
    action: 'cancel-import',
    operationId: 'operation-1'
  }]]);
});

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AiClient,
  MANAGED_BACKEND_NOT_READY_ERROR
} from '../src/main/services/ai-client.ts';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
function jsonResponse(status, value) {
  return new Response(
    typeof value === 'string' ? value : JSON.stringify(value),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

function managedAccess(portOffset = 0) {
  return {
    agentServiceUrl: `http://127.0.0.1:${30100 + portOffset}`,
    javaAnalyzerUrl: `http://127.0.0.1:${30200 + portOffset}`,
    agentServiceAuthorizationHeader: `Bearer agent-token-${portOffset}`,
    javaAnalyzerAuthorizationHeader: `Bearer analyzer-token-${portOffset}`
  };
}

function authorization(init) {
  return new Headers(init.headers).get('authorization');
}

function restoreEnvironment(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

test('目标覆盖报告请求和响应始终携带分支快照路径与 pairId', async () => {
  let submitted;
  const client = new AiClient(async (_url, init) => {
    submitted = JSON.parse(init.body);
    return jsonResponse(200, {
      generated: true,
      reportPath: 'D:\\work\\target\\after.xml',
      branchSnapshotPath: 'D:\\work\\target\\after.branches.json',
      pairId: 'b'.repeat(64),
      targetClass: 'demo.Demo',
      generatedAt: '2026-08-03T10:00:00Z',
      message: 'ok'
    });
  });
  client.setManagedBackendAccessProvider(() => managedAccess());

  const result = await client.generateTargetJacocoReport({
    projectPath: 'D:\\work',
    targetFilePath: 'D:\\work\\src\\Demo.java',
    targetClass: 'demo.Demo',
    executionDataPath: 'D:\\work\\target\\jacoco.exec',
    outputPath: 'D:\\work\\target\\after.xml',
    branchSnapshotOutputPath: 'D:\\work\\target\\after.branches.json'
  });

  assert.equal(
    submitted.branchSnapshotOutputPath,
    'D:\\work\\target\\after.branches.json'
  );
  assert.deepEqual(result, {
    generated: true,
    reportPath: 'D:\\work\\target\\after.xml',
    branchSnapshotPath: 'D:\\work\\target\\after.branches.json',
    pairId: 'b'.repeat(64),
    targetClass: 'demo.Demo',
    generatedAt: '2026-08-03T10:00:00Z',
    message: 'ok'
  });
});


test('远程 Java Analyzer 通过上传最小 JaCoCo 文件包生成报告并写回本地文件', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'aiut-remote-jacoco-'));
  const sourcePath = join(projectRoot, 'src', 'main', 'java', 'demo', 'Demo.java');
  const classPath = join(projectRoot, 'target', 'classes', 'demo', 'Demo.class');
  const executionDataPath = join(projectRoot, 'target', 'ai-unit-test', 'jacoco.exec');
  const outputPath = join(projectRoot, 'target', 'ai-unit-test', 'report.xml');
  const branchSnapshotOutputPath = join(projectRoot, 'target', 'ai-unit-test', 'report.branches.json');
  await mkdir(join(projectRoot, 'src', 'main', 'java', 'demo'), { recursive: true });
  await mkdir(join(projectRoot, 'target', 'classes', 'demo'), { recursive: true });
  await mkdir(join(projectRoot, 'target', 'ai-unit-test'), { recursive: true });
  await writeFile(sourcePath, 'package demo; public class Demo {}', 'utf8');
  await writeFile(classPath, Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  await writeFile(executionDataPath, Buffer.from('exec-data'));

  let submittedUrl = '';
  let submittedAuthorization = null;
  let submittedManifest;
  let submittedBundle;
  const reportXml = '<report name="Demo" />';
  const branchSnapshotJson = '{"pairId":"' + 'c'.repeat(64) + '"}';
  const client = new AiClient(async (url, init) => {
    submittedUrl = String(url);
    submittedAuthorization = authorization(init);
    assert.ok(init.body instanceof FormData);
    submittedManifest = JSON.parse(await init.body.get('request').text());
    submittedBundle = Buffer.from(await init.body.get('bundle').arrayBuffer());
    return jsonResponse(200, {
      generated: true,
      reportPath: '/tmp/server-workspace/target/ai-unit-test/report.xml',
      branchSnapshotPath: '/tmp/server-workspace/target/ai-unit-test/report.branches.json',
      pairId: 'c'.repeat(64),
      targetClass: 'demo.Demo',
      generatedAt: '2026-09-24T05:00:00Z',
      message: 'generated from uploaded artifacts',
      reportXmlBase64: Buffer.from(reportXml, 'utf8').toString('base64'),
      branchSnapshotJsonBase64: Buffer.from(branchSnapshotJson, 'utf8').toString('base64')
    });
  });
  client.setBackendSettings({
    agentServiceUrl: 'https://woodwry.cn',
    javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer'
  });
  client.setUserAccessTokenProvider(() => 'u'.repeat(64));

  const result = await client.generateTargetJacocoReport({
    projectPath: projectRoot,
    targetFilePath: sourcePath,
    targetClass: 'demo.Demo',
    executionDataPath,
    outputPath,
    branchSnapshotOutputPath
  });

  assert.equal(submittedUrl, 'https://woodwry.cn/java-analyzer/api/reports/jacoco/target-report/artifacts');
  assert.equal(submittedAuthorization, `Bearer ${'u'.repeat(64)}`);
  assert.deepEqual(submittedManifest, {
    targetSourceRelativePath: 'src/main/java/demo/Demo.java',
    targetClass: 'demo.Demo',
    executionDataRelativePath: 'target/ai-unit-test/jacoco.exec',
    outputRelativePath: 'target/ai-unit-test/report.xml',
    branchSnapshotOutputRelativePath: 'target/ai-unit-test/report.branches.json'
  });
  assert.ok(submittedBundle.includes(Buffer.from('src/main/java/demo/Demo.java')));
  assert.ok(submittedBundle.includes(Buffer.from('target/classes/demo/Demo.class')));
  assert.ok(submittedBundle.includes(Buffer.from('target/ai-unit-test/jacoco.exec')));
  assert.deepEqual(result, {
    generated: true,
    reportPath: outputPath,
    branchSnapshotPath: branchSnapshotOutputPath,
    pairId: 'c'.repeat(64),
    targetClass: 'demo.Demo',
    generatedAt: '2026-09-24T05:00:00Z',
    message: 'generated from uploaded artifacts'
  });
  assert.equal(await readFile(outputPath, 'utf8'), reportXml);
  assert.equal(await readFile(branchSnapshotOutputPath, 'utf8'), branchSnapshotJson);
});
test('远程 Java Analyzer 通过上传分析产物创建方法分析会话', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'aiut-remote-analysis-'));
  const moduleRoot = join(projectRoot, 'module');
  const sourceRoot = join(moduleRoot, 'src', 'main', 'java');
  const emptyGeneratedSourceRoot = join(moduleRoot, 'target', 'generated-sources', 'annotations');
  const missingGeneratedSourceRoot = join(moduleRoot, 'target', 'generated-sources', 'missing');
  const sourcePath = join(sourceRoot, 'demo', 'Demo.java');
  const classPath = join(moduleRoot, 'target', 'classes', 'demo', 'Demo.class');
  const reportPath = join(moduleRoot, 'target', 'ai-unit-test', 'report.xml');
  const branchSnapshotPath = join(moduleRoot, 'target', 'ai-unit-test', 'report.branches.json');
  await mkdir(join(sourceRoot, 'demo'), { recursive: true });
  await mkdir(emptyGeneratedSourceRoot, { recursive: true });
  await mkdir(join(moduleRoot, 'target', 'classes', 'demo'), { recursive: true });
  await mkdir(join(moduleRoot, 'target', 'ai-unit-test'), { recursive: true });
  await writeFile(sourcePath, 'package demo; public class Demo { public int value(){ return 1; } }', 'utf8');
  await writeFile(classPath, Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  await writeFile(reportPath, '<report name="Demo" />', 'utf8');
  await writeFile(branchSnapshotPath, '{"pairId":"' + 'd'.repeat(64) + '"}', 'utf8');

  const submissions = [];
  let submittedUrl = '';
  let submittedManifest;
  let submittedBundle;
  const client = new AiClient(async (url, init) => {
    submittedUrl = String(url);
    assert.ok(init.body instanceof FormData);
    submittedManifest = JSON.parse(await init.body.get('request').text());
    submittedBundle = Buffer.from(await init.body.get('bundle').arrayBuffer());
    submissions.push({ url: submittedUrl, manifest: submittedManifest, bundle: submittedBundle });
    if (String(url).endsWith('/refresh-coverage/artifacts')) {
      return jsonResponse(200, {
        reportPairId: 'd'.repeat(64),
        coverage: {
          lineCovered: 1,
          lineMissed: 0,
          lineTotal: 1,
          branchCovered: 0,
          branchMissed: 0,
          branchTotal: 0
        },
        catalog: {
          analysisSessionId: SESSION_ID,
          reportPairId: 'd'.repeat(64),
          reportCoverageTotals: {
            instructionCovered: 1,
            instructionMissed: 0,
            branchCovered: 0,
            branchMissed: 0,
            complexityCovered: 1,
            complexityMissed: 0,
            lineCovered: 1,
            lineMissed: 0
          },
          methods: [],
          warnings: []
        }
      });
    }
    return jsonResponse(201, {
      analysisSessionId: SESSION_ID,
      reportPairId: 'd'.repeat(64),
      sourceSha256: 'e'.repeat(64),
      dependencyContextSha256: 'f'.repeat(64),
      packageName: 'demo',
      testClassName: 'demo.DemoTest',
      suggestedRelativeTestPath: 'module/src/test/java/demo/DemoTest.java',
      warnings: []
    });
  });
  client.setBackendSettings({
    agentServiceUrl: 'https://woodwry.cn',
    javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer'
  });

  const result = await client.createMethodAnalysisSession({
    analysisSessionId: SESSION_ID,
    workspaceRoot: projectRoot,
    moduleRoot,
    targetSourcePath: sourcePath,
    targetClass: 'demo.Demo',
    plannedTestClassName: 'DemoTest',
    plannedRelativeTestPath: 'module/src/test/java/demo/DemoTest.java',
    reportPath,
    branchSnapshotPath,
    reportPairId: 'd'.repeat(64),
    sourceRoots: [sourceRoot, emptyGeneratedSourceRoot, missingGeneratedSourceRoot],
    classpathEntries: [
      join(moduleRoot, 'target', 'classes'),
      join(tmpdir(), 'external.jar')
    ],
    javaHome: 'D:/java/jdk1.8',
    jdkMajorVersion: 8,
    buildContextFingerprint: 'build-fingerprint'
  });

  assert.equal(submittedUrl, 'https://woodwry.cn/java-analyzer/api/generation-analysis/sessions/artifacts');
  assert.deepEqual(submittedManifest, {
    analysisSessionId: SESSION_ID,
    moduleRelativePath: 'module',
    targetSourceRelativePath: 'module/src/main/java/demo/Demo.java',
    targetClass: 'demo.Demo',
    plannedTestClassName: 'DemoTest',
    plannedRelativeTestPath: 'module/src/test/java/demo/DemoTest.java',
    reportRelativePath: 'module/target/ai-unit-test/report.xml',
    branchSnapshotRelativePath: 'module/target/ai-unit-test/report.branches.json',
    reportPairId: 'd'.repeat(64),
    sourceRootRelativePaths: ['module/src/main/java'],
    classpathEntryRelativePaths: ['module/target/classes'],
    jdkMajorVersion: 8,
    buildContextFingerprint: 'build-fingerprint'
  });
  assert.ok(submittedBundle.includes(Buffer.from('module/src/main/java/demo/Demo.java')));
  assert.ok(submittedBundle.includes(Buffer.from('module/target/classes/demo/Demo.class')));
  assert.ok(submittedBundle.includes(Buffer.from('module/target/ai-unit-test/report.xml')));
  assert.equal(result.analysisSessionId, SESSION_ID);
  assert.equal(result.reportPairId, 'd'.repeat(64));

  const refresh = await client.refreshMethodAnalysisCoverage(SESSION_ID, {
    reportPath,
    branchSnapshotPath,
    reportPairId: 'd'.repeat(64)
  });

  assert.equal(submissions[1].url, `https://woodwry.cn/java-analyzer/api/generation-analysis/sessions/${SESSION_ID}/refresh-coverage/artifacts`);
  assert.deepEqual(submissions[1].manifest, {
    reportRelativePath: 'module/target/ai-unit-test/report.xml',
    branchSnapshotRelativePath: 'module/target/ai-unit-test/report.branches.json',
    reportPairId: 'd'.repeat(64)
  });
  assert.ok(submissions[1].bundle.includes(Buffer.from('module/target/ai-unit-test/report.xml')));
  assert.ok(submissions[1].bundle.includes(Buffer.from('module/target/ai-unit-test/report.branches.json')));
  assert.equal(refresh.reportPairId, 'd'.repeat(64));
});

test('java-analyzer 缺少文件对身份时拒绝继续生成', async () => {
  const client = new AiClient(async () => jsonResponse(200, {
    generated: true,
    reportPath: 'D:\\work\\target\\after.xml',
    targetClass: 'demo.Demo'
  }));
  client.setManagedBackendAccessProvider(() => managedAccess());

  await assert.rejects(
    client.generateTargetJacocoReport({
      projectPath: 'D:\\work',
      targetFilePath: 'D:\\work\\src\\Demo.java',
      targetClass: 'demo.Demo',
      executionDataPath: 'D:\\work\\target\\jacoco.exec',
      outputPath: 'D:\\work\\target\\after.xml',
      branchSnapshotOutputPath: 'D:\\work\\target\\after.branches.json'
    }),
    /文件对|分支快照|pairId/
  );
});

test('已设置 provider 但尚未 ready 时不回退环境变量或持久化 settings', async () => {
  const previous = process.env.AI_BACKEND_URL;
  process.env.AI_BACKEND_URL = 'http://127.0.0.1:39001';
  let fetchCalls = 0;
  try {
    const client = new AiClient(async () => {
      fetchCalls += 1;
      return jsonResponse(500, 'unexpected');
    });
    client.setBackendSettings({
      agentServiceUrl: 'http://127.0.0.1:38001',
      javaAnalyzerUrl: 'http://127.0.0.1:38002'
    });
    client.setManagedBackendAccessProvider(() => null);

    await assert.rejects(
      client.getMethodGenerationStatus(SESSION_ID, 0),
      (error) => error.message === MANAGED_BACKEND_NOT_READY_ERROR
    );
    await assert.rejects(
      client.getMethodCatalog(SESSION_ID),
      (error) => error.message === MANAGED_BACKEND_NOT_READY_ERROR
    );

    const throwingClient = new AiClient(async () => {
      fetchCalls += 1;
      return jsonResponse(500, 'unexpected');
    });
    throwingClient.setManagedBackendAccessProvider(() => {
      throw new Error('provider internal secret');
    });
    await assert.rejects(
      throwingClient.getMethodGenerationStatus(SESSION_ID, 0),
      (error) => {
        assert.equal(error.message, MANAGED_BACKEND_NOT_READY_ERROR);
        assert.doesNotMatch(error.message, /provider internal secret/);
        return true;
      }
    );
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment('AI_BACKEND_URL', previous);
  }
});

test('单方法请求每次读取最新托管快照且无效响应不泄露令牌', async () => {
  const methodId = 'b'.repeat(64);
  const reportPairId = 'a'.repeat(64);
  const accesses = [managedAccess(8), {
    ...managedAccess(9),
    agentServiceAuthorizationHeader: 'Bearer v2-secret-token'
  }];
  const calls = [];
  const client = new AiClient(async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/generation-analysis/')) {
      return jsonResponse(200, {
        analysisSessionId: SESSION_ID,
        reportPairId,
        reportCoverageTotals: {
          instructionCovered: 0,
          instructionMissed: 4,
          branchCovered: 0,
          branchMissed: 0,
          complexityCovered: 0,
          complexityMissed: 1,
          lineCovered: 0,
          lineMissed: 2
        },
        methods: [{
          methodId,
          methodName: 'run',
          descriptor: '()V',
          displaySignature: 'run()',
          firstLine: 1,
          lastLine: 2,
          jacocoOrder: 0,
          lineCovered: 0,
          lineMissed: 2,
          branchCovered: 0,
          branchMissed: 0,
          instructionCovered: 0,
          instructionMissed: 4,
          complexityCovered: 0,
          complexityMissed: 1,
          coverageGap: true,
          generatable: true,
          unavailableReason: null,
          modifiers: ['public']
        }],
        warnings: []
      });
    }
    return jsonResponse(200, {
      sessionId: SESSION_ID,
      phase: 'running',
      lastEventSequence: 0,
      pendingCandidate: null,
      completion: null,
      terminalError: null,
      events: [],
      unexpected: 'v2-secret-token'
    });
  });
  client.setManagedBackendAccessProvider(() => accesses.shift() ?? null);

  await client.getMethodCatalog(SESSION_ID);
  await assert.rejects(
    client.getMethodGenerationStatus(SESSION_ID, 0),
    (error) => {
      assert.match(error.message, /单方法生成响应无效/);
      assert.doesNotMatch(error.message, /v2-secret-token/);
      return true;
    }
  );

  assert.deepEqual(calls.map(({ url }) => url), [
    `http://127.0.0.1:30208/api/generation-analysis/sessions/${SESSION_ID}/methods`,
    `http://127.0.0.1:30109/api/unit-tests/method-generation-sessions/${SESSION_ID}?afterEventSequence=0`
  ]);
  assert.deepEqual(calls.map(({ init }) => authorization(init)), [
    'Bearer analyzer-token-8',
    'Bearer v2-secret-token'
  ]);
});

test('external client routes both backend services through configured remote endpoints', async () => {
  const calls = [];
  const client = new AiClient(async (url, init) => {
    calls.push({ url: String(url), authorization: authorization(init) });
    const path = new URL(url).pathname;
    if (path === '/api/auth/login') {
      return jsonResponse(200, { accessToken: 'x'.repeat(64) });
    }
    if (path === '/api/auth/task-executions') {
      return jsonResponse(200, { taskExecutionCount: 8 });
    }
    if (path.endsWith('/api/health')) {
      return jsonResponse(200, { status: 'ok', service: 'java-analyzer' });
    }
    return jsonResponse(404, { code: 'NOT_FOUND', message: 'not found' });
  });
  client.setBackendSettings({
    agentServiceUrl: 'https://woodwry.cn',
    javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer'
  });
  client.setUserAccessTokenProvider(() => 'u'.repeat(64));

  await client.loginUser('admin', 'temporary-password');
  assert.equal(await client.isJavaAnalyzerHealthy(), true);
  assert.equal(await client.recordTaskExecution(), 8);

  assert.deepEqual(calls, [
    { url: 'https://woodwry.cn/api/auth/login', authorization: null },
    { url: 'https://woodwry.cn/java-analyzer/api/health', authorization: null },
    { url: 'https://woodwry.cn/api/auth/task-executions', authorization: `Bearer ${'u'.repeat(64)}` }
  ]);
});

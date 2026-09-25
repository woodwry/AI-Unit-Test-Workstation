import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import { startFakeBackendServers } from './e2e/support/fake-backends.mjs';

test('loopback fake Analyzer and Agent satisfy the production AiClient contracts', async (t) => {
  const backends = await startFakeBackendServers({ modelDelayMs: 5 });
  const root = await mkdtemp(join(tmpdir(), 'fake-http-backends-'));
  t.after(async () => {
    await backends.close();
    await rm(root, { recursive: true, force: true });
  });

  const sourcePath = join(root, 'src', 'main', 'java', 'com', 'example', 'AlphaService.java');
  const executionDataPath = join(root, 'target', 'fixture', 'jacoco.exec');
  const reportPath = join(root, 'target', 'fixture', 'jacoco.xml');
  const branchSnapshotPath = join(root, 'target', 'fixture', 'jacoco.branches.json');
  await mkdir(join(root, 'src', 'main', 'java', 'com', 'example'), { recursive: true });
  await mkdir(join(root, 'target', 'fixture'), { recursive: true });
  await writeFile(sourcePath, 'package com.example; public class AlphaService {}\n', 'utf8');
  await writeFile(executionDataPath, 'fixture-baseline-exec', 'utf8');

  const client = new AiClient();
  client.setManagedBackendAccessProvider(() => backends.managedAccess);
  const report = await client.generateTargetJacocoReport({
    projectPath: root,
    targetFilePath: sourcePath,
    targetClass: 'com.example.AlphaService',
    executionDataPath,
    outputPath: reportPath,
    branchSnapshotOutputPath: branchSnapshotPath
  });
  assert.equal(report.generated, true);
  assert.ok((await stat(reportPath)).size > 0);
  assert.ok((await stat(branchSnapshotPath)).size > 0);

  const analysisSessionId = randomUUID();
  const created = await client.createMethodAnalysisSession({
    analysisSessionId,
    workspaceRoot: root,
    moduleRoot: root,
    targetSourcePath: sourcePath,
    targetClass: 'com.example.AlphaService',
    plannedTestClassName: 'AlphaServiceGenerated1Test',
    plannedRelativeTestPath: 'src/test/java/com/example/AlphaServiceGenerated1Test.java',
    reportPath,
    branchSnapshotPath,
    reportPairId: report.pairId,
    sourceRoots: [join(root, 'src', 'main', 'java')],
    classpathEntries: [],
    javaHome: join(root, 'jdk-21'),
    jdkMajorVersion: 21,
    buildContextFingerprint: 'a'.repeat(64),
    warnings: []
  });
  assert.equal(created.analysisSessionId, analysisSessionId);

  const catalog = await client.getMethodCatalog(analysisSessionId);
  assert.equal(catalog.methods.length, 1);

  const batch = await client.nextMethodBatch(
    analysisSessionId,
    catalog.methods[0].methodId,
    {
      reportPairId: report.pairId,
      completedTestMethodPlanIds: [],
      maxTestMethods: 12
    }
  );
  assert.equal(batch.hasWork, true);
  assert.equal(batch.plannedTestMethods, 1);

  const modelContext = {
    llmConfig: {
      provider: 'custom_openai',
      model: 'fixture-only',
      baseUrl: `${backends.agentServiceUrl}/v1`,
      credentials: { apiKey: 'fixture-not-used' }
    }
  };
  const started = await client.startMethodGenerationStream({
    clientRequestId: randomUUID(),
    classTaskId: randomUUID(),
    methodId: batch.methodId,
    batchId: batch.batchId,
    batchIndex: 1,
    outputTestClassName: 'AlphaServiceGenerated1Test',
    expectedPackageName: 'com.example',
    buildToolchain: { javaVersion: '21.0.11', mavenVersion: '3.9.9' },
    batch,
    captureModelCalls: false,
    repairAttemptLimit: 5,
    unlimitedRepair: false
  }, modelContext, () => {});
  assert.equal(started.kind, 'candidate_ready');

  const completed = await client.resumeMethodGenerationStream(
    started.sessionId,
    {
      feedbackId: randomUUID(),
      expectedEventSequence: started.eventSequence,
      candidateId: started.candidate.candidateId,
      candidateVersion: started.candidate.candidateVersion,
      repairAttempt: started.candidate.repairAttempt,
      effectiveTestCode: started.candidate.testCode,
      effectiveFileSha256: started.candidate.generatedCodeSha256,
      feedbackKind: 'execution',
      execution: {
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
          surefireReports: [{ fileName: 'TEST-com.example.AlphaServiceGenerated1Test.xml', content: '<testsuite />' }]
        }],
        testReport: {
          reportCount: 1,
          tests: 1,
          failures: 0,
          errors: 0,
          skipped: 0,
          generatedTestClassName: 'com.example.AlphaServiceGenerated1Test',
          generatedTests: 1,
          generatedSkipped: 0,
          failureDetails: []
        }
      }
    },
    modelContext,
    () => {}
  );
  assert.equal(completed.kind, 'completed');
  assert.equal(completed.completion.stopReason, 'verified');

  const metrics = backends.metrics();
  assert.equal(metrics.realModelCalls, 0);
  assert.equal(metrics.agentRequests.length, 1);
  assert.equal(metrics.agentRequests[0].methodId, catalog.methods[0].methodId);
  assert.ok(metrics.agentRequests[0].plannedTestMethods <= 12);
});

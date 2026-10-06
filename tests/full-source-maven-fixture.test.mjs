import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { FullSourceGenerationService } from '../src/main/services/full-source-generation.service.ts';
import { ClassTaskCheckpointService } from '../src/main/services/class-task-checkpoint.service.ts';
import { ClassTaskFileTransactionService } from '../src/main/services/class-task-file-transaction.service.ts';
import { FormalTestFilePackerService } from '../src/main/services/formal-test-file-packer.service.ts';
import { GeneratedTestNameReservationService } from '../src/main/services/generated-test-name-reservation.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';
import { MavenCandidateExecutorService } from '../src/main/services/maven-candidate-executor.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import { SurefireReportService } from '../src/main/services/surefire-report.service.ts';
import { attributeFullSourceResults } from '../src/main/services/full-source-result-attribution.ts';
import { sourceSha256 } from '../src/main/services/full-source-generation-contract.ts';
import { fullSourceFacts } from './fixtures/full-source.mjs';

const mavenExe = process.env.FULL_SOURCE_FIXTURE_MAVEN_EXECUTABLE;
const javaHome = process.env.FULL_SOURCE_FIXTURE_JAVA_HOME;
test('isolated real Maven verifies one initial full-source generation, one repair and precise formal publication', {
  timeout: 300000, skip: !mavenExe || !javaHome ? 'Configure FULL_SOURCE_FIXTURE_MAVEN_EXECUTABLE and FULL_SOURCE_FIXTURE_JAVA_HOME for real Maven' : false
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'full-source-real-maven-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp('fixtures/multi-class-generation/pom.xml', join(root, 'pom.xml'));
  await cp('fixtures/multi-class-generation/src/main', join(root, 'src/main'), { recursive: true });
  await mkdir(join(root, 'src/test/java/com/example'), { recursive: true });
  const targetSource = 'package com.example; public class AlphaService { public int increment(int n) { return n + 1; } public int doubled(int n) { return n * 2; } }';
  const sourceFilePath = join(root, 'src/main/java/com/example/AlphaService.java');
  await writeFile(sourceFilePath, targetSource);
  const facts = fullSourceFacts(2); facts.declaringType = 'com.example.AlphaService'; facts.sourceSha256 = sourceSha256(targetSource);
  facts.targetFixturePlan.targetClass = facts.declaringType; facts.targetFixturePlan.targetClassDeclaration = 'public class AlphaService {}';
  facts.methods.forEach((m, i) => { m.declaringType = facts.declaringType; m.methodName = i ? 'doubled' : 'increment';
    m.descriptor = '(I)I'; m.parameterTypes = ['int']; m.returnType = 'int';
    m.completeMethodSource = i ? 'public int doubled(int n) { return n * 2; }' : 'public int increment(int n) { return n + 1; }';
    m.invocationPlan.returnType = 'int'; });
  let task = { id: randomUUID(), workspaceRoot: root, sourceFilePath, qualifiedClassName: facts.declaringType,
    moduleKey: 'fixture', moduleDisplayPath: root, ragEnabled: false, state: 'RUNNING', currentAtomicStep: 'IDLE', currentMethodIndex: -1,
    repairAttemptLimit: 6, unlimitedRepair: false, methodOrder: facts.methods.map(m => m.methodId),
    activeGenerationBatch: null, modelCallCount: 0, usageReportedCallCount: 0, tokenUsage: null };
  const checkpoints = new ClassTaskCheckpointService({ storagePath: join(root, 'checkpoint.json'),
    taskState: { snapshot: () => structuredClone(task), save: async next => (task = structuredClone(next)) } });
  const checkpoint = await checkpoints.prepareFullSourceRun(task.id, { analysisSessionId: randomUUID(), reportPairId: facts.reportPairId,
    methodIds: task.methodOrder, repairAttemptLimit: 6, unlimitedRepair: false });
  const settings = { mavenHome: dirname(dirname(mavenExe)), javaHome };
  const shell = new ShellService();
  const toolchain = await shell.validateBuildSettings(settings, root);
  assert.equal(toolchain.valid, true, JSON.stringify(toolchain));
  const writer = new TestWriterService(), moduleLock = new ModuleOperationLock();
  const transaction = new ClassTaskFileTransactionService({ writer });
  const maven = new MavenCandidateExecutorService(shell, new SurefireReportService());
  const sessionId = randomUUID(), candidateId = randomUUID();
  let initialCalls = 0, repairCalls = 0, request;
  const code = (name, broken) => `package com.example; import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*;
    public class ${name} { private final AlphaService target = new AlphaService(); ${broken ? 'UnknownType broken;' : ''}
      @Test void m1_positive() { assertEquals(3, target.increment(2)); }
      @Test void m2_zero() { assertEquals(0, target.doubled(0)); } }`;
  const candidate = (attempt) => { const testCode = code(request.outputTestClassName, attempt === 0);
    return { generationMode: 'FULL_SOURCE', candidateId, candidateVersion: attempt + 1, repairAttempt: attempt,
      methodId: request.methodId, batchId: request.batchId, batchIndex: 1, outputTestClassName: request.outputTestClassName,
      testCode, generatedCodeSha256: sourceSha256(testCode), ordinaryTestMethodCount: 2, usage: null }; };
  const executor = new FullSourceGenerationService({ checkpoints, writer, moduleLock, candidateFiles: transaction, maven,
    skillRulesSha256: 'a'.repeat(64), analyzer: { fullSourceGenerationFacts: async () => facts },
    contextProvider: { resolve: async () => ({ analysisSessionId: checkpoint.identity.analysisSessionId,
      reportPairId: facts.reportPairId, sourceSha256: facts.sourceSha256, packageName: 'com.example',
      plannedRelativeTestPath: 'src/test/java/com/example/AlphaServiceTest.java', moduleRoot: root, buildSettings: settings,
      buildToolchain: { javaVersion: '21', mavenVersion: '3.9.9' }, modelContext: {}, captureModelCalls: false }) },
    agent: {
      startFullSourceGenerationStream: async value => { request = value; initialCalls++;
        return { kind: 'candidate_ready', sessionId, eventSequence: 1, candidate: candidate(0) }; },
      resumeFullSourceGenerationStream: async (_session, feedback) => {
        assert.equal(feedback.feedbackKind, 'maven');
        if (feedback.execution.status === 'compile_failed') {
          assert.match(feedback.execution.mavenExecutions[0].stdout, /UnknownType/); repairCalls++;
          return { kind: 'candidate_ready', sessionId, eventSequence: 2, candidate: candidate(1) };
        }
        assert.equal(feedback.execution.status, 'passed');
        return { kind: 'completed', sessionId, eventSequence: 3, completion: { methodId: request.methodId, batchId: request.batchId,
          stopReason: 'verified', bestCandidateId: candidateId, aggregateUsage: null, modelCallCount: 2, usageReportedCallCount: 0 } };
      }
    }
  });
  const outcome = await executor.execute(task, task.methodOrder, checkpoint, new AbortController().signal);
  assert.equal(initialCalls, 1); assert.equal(repairCalls, 1); assert.equal(outcome.terminalStatus, 'PASSED');
  const passedCheckpoint = await checkpoints.fullSourceProgress(task.id);
  assert.equal(passedCheckpoint.repairAttemptsUsed, 1); assert.equal(passedCheckpoint.execution.testReport.generatedTests, 2);
  let formalExecution;
  const packer = new FormalTestFilePackerService({ taskId: task.id, workspaceRoot: root, moduleRoot: root, moduleKey: 'fixture',
    targetFilePath: sourceFilePath, qualifiedClassName: facts.declaringType, buildSettings: settings,
    writer, reservations: new GeneratedTestNameReservationService(), transaction, moduleLock, maven,
    onFormalVerified: async (_artifact, execution) => { formalExecution = execution; } });
  const artifact = await packer.appendSharedTemporaryGroup({ code: outcome.bundles[0].code, bundles: outcome.bundles });
  const formalSource = await readFile(artifact.filePath, 'utf8'); assert.equal(sourceSha256(formalSource), artifact.sha256);
  const results = attributeFullSourceResults(facts, formalSource, passedCheckpoint.execution, formalExecution,
    { retainedFailureMembers: [], deletedTests: [] });
  assert.deepEqual(results.map(m => m.passedTestNames), [['m1_positive'], ['m2_zero']]);
  assert.deepEqual(artifact.methodIds, task.methodOrder);
  assert.ok(artifact.methodResults.every(m => m.fullSource.factsId === facts.factsId && m.fullSource.candidateId === candidateId));
  await executor.execute(task, task.methodOrder, passedCheckpoint, new AbortController().signal);
  assert.equal(initialCalls, 1); assert.equal(repairCalls, 1);
  const execPath = join(root, 'target', 'full-source-fixture.exec');
  const coverageCommand = await shell.runMavenDirectTestsWithJacoco(root, settings,
    [`com.example.${artifact.testClassName}`], execPath, join(root, 'target', 'full-source-coverage-surefire'));
  assert.equal(coverageCommand.exitCode, 0, coverageCommand.stdout + coverageCommand.stderr);
  // Report-only goal: the normal ShellService runner keeps toolchain/environment handling identical.
  const reportCommand = await shell.runMaven(root, settings,
    ['-B', `-Djacoco.dataFile=${execPath}`, 'jacoco:report']);
  assert.equal(reportCommand.exitCode, 0, reportCommand.stdout + reportCommand.stderr);
  const coverageXml = await readFile(join(root, 'target/site/jacoco/jacoco.xml'), 'utf8');
  const doc = new DOMParser().parseFromString(coverageXml, 'application/xml');
  const target = [...doc.getElementsByTagName('class')].find(c => c.getAttribute('name') === 'com/example/AlphaService');
  assert.ok(target, 'Real JaCoCo must contain the production class');
  for (const name of ['increment', 'doubled']) {
    const method = [...target.getElementsByTagName('method')].find(m => m.getAttribute('name') === name);
    assert.equal(method.getAttribute('desc'), '(I)I');
    const instructions = [...method.getElementsByTagName('counter')].find(c => c.getAttribute('type') === 'INSTRUCTION');
    assert.ok(Number(instructions.getAttribute('covered')) > 0, `No real coverage for ${name}`);
    assert.equal(Number(instructions.getAttribute('missed')), 0);
  }
  const evidence = join('.superpowers/sdd/2026-10-06-full-source-unit-test-skill-implementation', `real-maven-${randomUUID()}`);
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'candidate.java'), outcome.bundles[0].code);
  await writeFile(join(evidence, 'formal.java'), formalSource);
  await writeFile(join(evidence, 'verified.json'), JSON.stringify({ initialCalls, repairCalls, artifact, results,
    candidateExecution: passedCheckpoint.execution, formalExecution, coverageCommand, reportCommand,
    coverageXmlSha256: sourceSha256(coverageXml), executionDataSha256: sourceSha256(await readFile(execPath)) }, null, 2));
  await writeFile(join(evidence, 'jacoco.xml'), coverageXml);
  for (const [label, execution] of [['candidate', passedCheckpoint.execution], ['formal', formalExecution]]) {
    for (const report of execution.mavenExecutions.at(-1).surefireReports) if (report.fileName.endsWith('.xml')) {
      await writeFile(join(evidence, `${label}-${basename(report.fileName)}`), report.content);
    }
  }
});

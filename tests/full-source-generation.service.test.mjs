import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FullSourceGenerationService } from '../src/main/services/full-source-generation.service.ts';
import { ClassTaskCheckpointService } from '../src/main/services/class-task-checkpoint.service.ts';
import { ClassTaskFileTransactionService } from '../src/main/services/class-task-file-transaction.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';
import { sourceSha256 } from '../src/main/services/full-source-generation-contract.ts';
import { JavaTestStructureService } from '../src/main/services/java-test-structure.service.ts';
import { fullSourceFacts } from './fixtures/full-source.mjs';
import { MethodGenerationSessionNotFoundError } from '../src/main/services/method-generation-contract.ts';

async function setup(t, repairAttemptLimit = 6) {
  const root = await mkdtemp(join(tmpdir(), 'full-source-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/test/java/example'), { recursive: true });
  const facts = fullSourceFacts();
  const productionSource = 'package example;\nclass Target {\n' + facts.methods.map(m=>m.completeMethodSource).join('\n') + '\n}\n';
  facts.sourceSha256 = sourceSha256(productionSource);
  await mkdir(join(root,'src/main/java/example'),{recursive:true});
  await writeFile(join(root,'src/main/java/example/Target.java'),productionSource);
  let task = { id: randomUUID(), workspaceRoot: root, sourceFilePath: join(root, 'src/main/java/example/Target.java'),
    qualifiedClassName: 'example.Target', moduleKey: 'fixture', moduleDisplayPath: root, ragEnabled: false,
    repairAttemptLimit, unlimitedRepair: false, state: 'RUNNING', currentAtomicStep: 'IDLE', currentMethodIndex: -1,
    activeGenerationBatch: null, modelCallCount: 0, usageReportedCallCount: 0, tokenUsage: null,
    methodOrder: facts.methods.map(m => m.methodId) };
  const checkpoints = new ClassTaskCheckpointService({ storagePath: join(root, 'checkpoint.json'),
    taskState: { snapshot: () => structuredClone(task), save: async v => (task = structuredClone(v)) } });
  const cp = await checkpoints.prepareFullSourceRun(task.id, { analysisSessionId: randomUUID(),
    reportPairId: facts.reportPairId, methodIds: task.methodOrder, repairAttemptLimit, unlimitedRepair: false });
  const writer = new TestWriterService(); const sessionId = randomUUID(), candidateId = randomUUID();
  const trace = { facts: 0, starts: 0, corrections: 0, passFeedback: 0, maven: 0 };
  let currentCode, currentRequest;
  const completion = () => ({ methodId: currentRequest.methodId, batchId: currentRequest.batchId,
    stopReason: 'verified', bestCandidateId: candidateId, aggregateUsage: null, modelCallCount: 2, usageReportedCallCount: 0 });
  const options = { checkpoints, writer, moduleLock: new ModuleOperationLock(),
    candidateFiles: new ClassTaskFileTransactionService({ writer }),
    contextProvider: { resolve: async () => ({ analysisSessionId: cp.identity.analysisSessionId,
      reportPairId: facts.reportPairId, sourceSha256: facts.sourceSha256, packageName: 'example',
      plannedRelativeTestPath: 'src/test/java/example/TargetTest.java', moduleRoot: root, buildSettings: {},
      buildToolchain: { javaVersion: '21', mavenVersion: '3.9.9' }, modelContext: {}, captureModelCalls: false }) },
    analyzer: { fullSourceGenerationFacts: async () => { trace.facts++; return facts; } },
    skillRulesSha256: 'a'.repeat(64),
    agent: {
      startFullSourceGenerationStream: async request => { trace.starts++; currentRequest = request;
        return { kind: 'output_invalid', sessionId, eventSequence: 1, outputInvalid: {
          generationMode: 'FULL_SOURCE', candidateId, candidateVersion: 1, repairAttempt: 0,
          invalidOutput: '', invalidOutputSha256: sourceSha256(''), validationErrors: [{ code: 'EMPTY', message: 'empty' }] } }; },
      resumeFullSourceGenerationStream: async (_id, feedback) => {
        if (feedback.feedbackKind === 'maven') { trace.passFeedback++; return { kind: 'completed', sessionId,
          eventSequence: 3, completion: completion() }; }
        trace.corrections++;
        currentCode = `package example; class ${currentRequest.outputTestClassName} { Target target = new Target();`
          + facts.methods.map(m => `@org.junit.jupiter.api.Test void ${m.testMethodNamePrefix}ok() {
              target.${m.methodName}(); org.junit.jupiter.api.Assertions.assertNotNull(target); }`).join('\n') + '}';
        return { kind: 'candidate_ready', sessionId, eventSequence: 2, candidate: { generationMode: 'FULL_SOURCE',
          candidateId, candidateVersion: 2, repairAttempt: 1, methodId: currentRequest.methodId,
          batchId: currentRequest.batchId, batchIndex: 1, testCode: currentCode,
          generatedCodeSha256: sourceSha256(currentCode), outputTestClassName: currentRequest.outputTestClassName,
          ordinaryTestMethodCount: 30, usage: null } };
      }
    }, maven: { execute: async input => { trace.maven++; const names = facts.methods.map(m => `${m.testMethodNamePrefix}ok`);
      return { status: 'passed', mavenExecutions: [ { scope: 'method_candidate', phase: 'test_compile', command: 'mvn test-compile',
          exitCode: 0, stdout: '', stderr: '', surefireReports: [] },
        { scope: 'method_candidate', phase: 'test', command: 'mvn surefire:test', exitCode: 0, stdout: '', stderr: '',
          surefireReports: [{ fileName: `TEST-${input.qualifiedTestClassName}.xml`, content:
            `<testsuite name="${input.qualifiedTestClassName}" tests="30" failures="0" errors="0" skipped="0">`
              + names.map(n => `<testcase name="${n}" classname="${input.qualifiedTestClassName}"/>`).join('') + '</testsuite>' }] } ],
        testReport: { reportCount: 1, tests: 30, failures: 0, errors: 0, skipped: 0,
          generatedTestClassName: input.qualifiedTestClassName, generatedTests: 30, generatedSkipped: 0, failureDetails: [] } }; } }
  };
  return { task, cp, checkpoints, options, trace,
    resumeTask() { task = { ...task, state: 'RUNNING', currentAtomicStep: 'IDLE' }; } };
}

test('known accepted candidate survives lost server session without another initial generation', async t => {
  const f = await setup(t), resume = f.options.agent.resumeFullSourceGenerationStream;
  let lost = false, recovered = 0;
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback) => {
    if (feedback.feedbackKind === 'maven' && !lost) {
      lost = true; throw new MethodGenerationSessionNotFoundError(id);
    }
    const turn = await resume(id, feedback);
    if (lost && turn.kind === 'completed') {
      const cp = await f.checkpoints.fullSourceProgress(f.task.id);
      return { ...turn, eventSequence: cp.eventSequence + 1 };
    }
    return turn;
  };
  f.options.agent.recoverFullSourceGenerationStream = async (_request, candidate) => {
    recovered++;
    const cp = await f.checkpoints.fullSourceProgress(f.task.id);
    return { kind: 'candidate_ready', sessionId: cp.sessionId, eventSequence: cp.eventSequence + 1, candidate };
  };
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    f.cp, new AbortController().signal);
  assert.equal(outcome.terminalStatus, 'PASSED');
  assert.equal(recovered, 1); assert.equal(f.trace.starts, 1); assert.equal(f.trace.corrections, 1);
});

test('invalid output plus lost server stops instead of generating another initial candidate', async t => {
  const f = await setup(t); let recovered = 0;
  f.options.agent.resumeFullSourceGenerationStream = async id => { throw new MethodGenerationSessionNotFoundError(id); };
  f.options.agent.recoverFullSourceGenerationStream = async () => { recovered++; throw new Error('must not recover invalid source'); };
  await assert.rejects(new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    f.cp, new AbortController().signal), MethodGenerationSessionNotFoundError);
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.initialCallState, 'RESULT_RECEIVED');
  assert.ok(saved.outputFailure); assert.equal(f.trace.starts, 1); assert.equal(recovered, 0);
});

test('full-source pauses after the initial response and resumes the same durable request', async t => {
  const f = await setup(t), start = f.options.agent.startFullSourceGenerationStream;
  f.options.agent.startFullSourceGenerationStream = async request => {
    const turn = await start(request);
    await f.checkpoints.requestPause(f.task.id);
    return turn;
  };
  await assert.rejects(new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    f.cp, new AbortController().signal), { name: 'ClassTaskPausedAtBoundaryError' });
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.ok(saved.outputFailure); assert.equal(f.trace.starts, 1); assert.equal(f.trace.corrections, 0);
  f.resumeTask();
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    saved, new AbortController().signal);
  assert.equal(outcome.terminalStatus, 'PASSED');
  assert.equal(f.trace.starts, 1); assert.equal(f.trace.corrections, 1);
});

test('pause before initial atomic stage does not mark an unissued model request as lost', async t => {
  const f = await setup(t), begin = f.checkpoints.beginAtomicStep.bind(f.checkpoints);
  let pause = true;
  f.checkpoints.beginAtomicStep = async (id, step, ...rest) => {
    if (step === 'MODEL_GENERATION' && pause) { pause = false; await f.checkpoints.requestPause(id); }
    return begin(id, step, ...rest);
  };
  await assert.rejects(new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    f.cp, new AbortController().signal), { name: 'ClassTaskPausedAtBoundaryError' });
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.initialCallState, 'NOT_ISSUED'); assert.equal(f.trace.starts, 0);
  f.resumeTask();
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    saved, new AbortController().signal);
  assert.equal(outcome.terminalStatus, 'PASSED'); assert.equal(f.trace.starts, 1);
});
test('thirty selected methods use one initial call, budgeted correction, one Maven candidate and durable resume', async t => {
  const f = await setup(t); const service = new FullSourceGenerationService(f.options);
  const result = await service.execute(f.task, f.task.methodOrder, f.cp, new AbortController().signal);
  assert.equal(result.methodOutcomes.length, 30); assert.equal(result.terminalStatus, 'PASSED');
  assert.deepEqual(f.trace, { facts: 1, starts: 1, corrections: 1, passFeedback: 1, maven: 1 });
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.initialCallState, 'RESULT_RECEIVED'); assert.equal(saved.repairAttemptsUsed, 1);
  await service.execute(f.task, f.task.methodOrder, saved, new AbortController().signal);
  assert.equal(f.trace.starts, 1); assert.equal(f.trace.corrections, 1); assert.equal(f.trace.maven, 1);
});

test('streamed correction start preserves the preceding invalid output until its replacement arrives', async t => {
  const f = await setup(t), resume = f.options.agent.resumeFullSourceGenerationStream;
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback, request, model, onEvent) => {
    if (feedback.feedbackKind === 'output_validation') {
      const before = await f.checkpoints.fullSourceProgress(f.task.id);
      await onEvent({ sessionId: id, eventSequence: before.eventSequence + 1,
        eventType: 'model_call', occurredAt: new Date().toISOString(), progress: null,
        candidate: null, outputInvalid: null, completion: null, error: null,
        modelCall: { phase: 'started', repairAttempt: 1 } });
      const during = await f.checkpoints.fullSourceProgress(f.task.id);
      assert.equal(during.repairAttemptsUsed, 1);
      assert.equal(during.outputFailure.repairAttempt, 0);
      assert.equal(during.pendingFeedback.feedbackId, feedback.feedbackId);
    }
    const turn = await resume(id, feedback);
    const current = await f.checkpoints.fullSourceProgress(f.task.id);
    return { ...turn, eventSequence: current.eventSequence + 1 };
  };
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    f.cp, new AbortController().signal);
  assert.equal(outcome.terminalStatus, 'PASSED');
  assert.equal(f.trace.starts, 1);
  assert.equal(f.trace.corrections, 1);
});

test('exhausted full-source Stable preserves whole failed test and audits the source before change', async t => {
  const f = await setup(t, 1), execute = f.options.maven.execute, resume = f.options.agent.resumeFullSourceGenerationStream;
  let failed = false;
  f.options.maven.execute = async input => {
    const execution = await execute(input);
    if (!failed) {
      failed = true;
      const last = execution.mavenExecutions.at(-1);
      last.exitCode = 1;
      last.surefireReports[0].content = last.surefireReports[0].content.replace('errors="0"', 'errors="1"')
        .replace(/(<testcase name="m1_ok"[^>]+)\/>/, '$1><error type="java.lang.NullPointerException" message="fixture"/></testcase>');
      return { ...execution, status: 'test_failed', testReport: { ...execution.testReport, errors: 1,
        failureDetails: [{ suiteName: input.qualifiedTestClassName, testClassName: input.qualifiedTestClassName,
          testName: 'm1_ok', kind: 'error', type: 'java.lang.NullPointerException', message: 'fixture' }] } };
    }
    const cp = await f.checkpoints.fullSourceProgress(f.task.id);
    const source = await readFile(cp.managedFile.path, 'utf8');
    const names = new JavaTestStructureService().findTestMethods(source).map(m => m.name);
    const report = execution.mavenExecutions.at(-1).surefireReports[0];
    report.content = `<testsuite name="${input.qualifiedTestClassName}" tests="${names.length}" failures="0" errors="0" skipped="0">`
      + names.map(name => `<testcase name="${name}" classname="${input.qualifiedTestClassName}"/>`).join('') + '</testsuite>';
    return { ...execution, testReport: { ...execution.testReport, tests: names.length, generatedTests: names.length } };
  };
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback) => {
    const turn = await resume(id, feedback);
    if (turn.kind === 'completed') turn.completion.stopReason = 'repair_exhausted';
    return turn;
  };
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder, f.cp,
    new AbortController().signal);
  assert.equal(outcome.terminalStatus, 'RETAINED_FAILURE');
  assert.equal(outcome.bundles.length, 29);
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.stableRepair.phase, 'PASSED');
  assert.equal(saved.stableRepair.iteration, 1);
  assert.equal(saved.deletedTests.length, 0);
  assert.equal(saved.methodOutcomes[0].status, 'RETAINED_FAILURE');
  const directory = join(f.task.workspaceRoot, '.ai-unit-test/full-source-candidates', sourceSha256(f.task.id).slice(0, 24), saved.candidate.candidateId);
  const auditFile = (await readdir(directory)).find(n => n.endsWith('.stable-repair.json'));
  const audit = JSON.parse(await readFile(join(directory, auditFile), 'utf8'));
  assert.equal(audit.sourceSha256, sourceSha256(audit.sourceCode));
  assert.equal(audit.replacementSha256, saved.managedFile.sha256);
  assert.equal(audit.repairAttemptsUsed, 1);
  assert.equal(audit.repairAttemptLimit, 1);
  assert.match(audit.sourceCode, /void m1_ok\(\)/);
});
test('resuming interrupted Stable revalidates the retained source directly, including an empty candidate', async t => {
  const f = await setup(t, 1), execute = f.options.maven.execute, resume = f.options.agent.resumeFullSourceGenerationStream;
  let runs = 0, queues = 0;
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback) => {
    const turn = await resume(id, feedback);
    if (turn.kind === 'candidate_ready') {
      turn.candidate.testCode = turn.candidate.testCode.replace(/@org\.junit\.jupiter\.api\.Test void m(?:[2-9]|[12]\d|30)_ok\(\)\s*\{[^}]*\}/g,'');
      turn.candidate.generatedCodeSha256 = sourceSha256(turn.candidate.testCode);
      turn.candidate.ordinaryTestMethodCount = 1;
    }
    if (turn.kind === 'completed') turn.completion.stopReason = 'repair_exhausted';
    return turn;
  };
  f.options.maven.execute = async input => {
    const execution = await execute(input);
    if (++runs === 1) {
      execution.status = 'test_failed';
      execution.mavenExecutions.at(-1).exitCode = 1;
      execution.testReport.tests = execution.testReport.generatedTests = execution.testReport.errors = 1;
      execution.mavenExecutions.at(-1).surefireReports[0].content = `<testsuite name="${input.qualifiedTestClassName}" tests="1" failures="0" errors="1" skipped="0"><testcase name="m1_ok" classname="${input.qualifiedTestClassName}"><error type="java.lang.NullPointerException" message="fixture"/></testcase></testsuite>`;
      execution.testReport.failureDetails = Array.from({length:1}, (_,i) => ({
        suiteName:input.qualifiedTestClassName,testClassName:input.qualifiedTestClassName,
        testName:`m${i+1}_ok`,kind:'error',type:'java.lang.NullPointerException',message:'fixture'
      }));
      return execution;
    }
    if (runs === 2) throw new Error('interrupted after durable Stable replacement');
    assert.equal(input.scope, 'pruned_method_candidate');
    const saved = await f.checkpoints.fullSourceProgress(f.task.id);
    assert.equal(new JavaTestStructureService().findTestMethods(await readFile(saved.managedFile.path,'utf8')).length,0);
    return {status:'test_failed',mavenExecutions:execution.mavenExecutions.map(e=>({...e,scope:input.scope,surefireReports:[]}))};
  };
  const service = new FullSourceGenerationService(f.options);
  await assert.rejects(service.execute(f.task,f.task.methodOrder,f.cp,new AbortController().signal),/interrupted after durable/);
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.execution,null);
  assert.equal(saved.stableRepair.iteration,1);
  f.options.mavenReadyQueue = { enqueue:async () => { queues++; return {status:'unproven',mavenExecutions:[]}; } };
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task,f.task.methodOrder,saved,new AbortController().signal);
  assert.equal(queues,0);
  assert.equal(outcome.terminalStatus,'RETAINED_FAILURE');
  assert.equal(outcome.bundles.length,0);
  const final = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(final.stableRepair.annotatedMemberIds.length,1);
  assert.equal(final.repairAttemptsUsed,1);
  assert.equal(f.trace.starts,1);
  assert.equal(f.trace.corrections,1);
});

test('unattributed full-source Maven failure retains its exact command and source before stopping', async t => {
  const f=await setup(t);
  const evidence={scope:'method_candidate',phase:'test_compile',command:'mvn test-compile',exitCode:1,
    stdout:'[ERROR] /project/OtherTest.java:[9,1] external compile error',stderr:'',surefireReports:[]};
  f.options.mavenReadyQueue={enqueue:async submission=>{
    await submission.activate(); await submission.isolate();
    return {candidateId:submission.candidateId,status:'unproven',mavenExecutions:[evidence]};
  }};
  await assert.rejects(new FullSourceGenerationService(f.options).execute(f.task,f.task.methodOrder,f.cp,new AbortController().signal),/Maven 错误无法归属/);
  const saved=await f.checkpoints.fullSourceProgress(f.task.id);
  const directory=join(f.task.workspaceRoot,'.ai-unit-test/full-source-candidates',sourceSha256(f.task.id).slice(0,24),saved.candidate.candidateId);
  const file=(await readdir(directory)).find(n=>n.endsWith('.maven-unproven.json'));
  assert.ok(file,'exact unattributed failure must be retained');
  const audit=JSON.parse(await readFile(join(directory,file),'utf8'));
  assert.equal(audit.sourceSha256,sourceSha256(audit.sourceCode));
  assert.deepEqual(audit.result.mavenExecutions,[evidence]);
  assert.equal(f.trace.passFeedback,0);
});

test('unknown issued initial cannot be reissued even after executor reload', async t => {
  const f = await setup(t);
  const issued = await f.checkpoints.saveFullSourceProgress(f.task.id, { ...f.cp, initialCallState: 'ISSUED' });
  await assert.rejects(new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    issued, new AbortController().signal), /首次请求/);
  assert.equal(f.trace.starts, 0);
});

test('full-source preserves an assertionless test as a whole comment and revalidates before publication', async t => {
  const f = await setup(t, 1), resume = f.options.agent.resumeFullSourceGenerationStream, execute = f.options.maven.execute;
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback) => {
    const turn = await resume(id, feedback);
    if (turn.kind === 'candidate_ready') {
      turn.candidate.testCode = turn.candidate.testCode.replace('target.work0(); org.junit.jupiter.api.Assertions.assertNotNull(target);',
        'target.work0();\n// [断言失败已注释]\n// org.junit.jupiter.api.Assertions.assertNotNull(target);\n');
      turn.candidate.generatedCodeSha256 = sourceSha256(turn.candidate.testCode);
    }
    if (turn.kind === 'completed') turn.completion.stopReason = 'verified';
    return turn;
  };
  f.options.maven.execute = async input => {
    const execution = await execute(input), cp = await f.checkpoints.fullSourceProgress(f.task.id);
    const names = new JavaTestStructureService().findTestMethods(await readFile(cp.managedFile.path, 'utf8')).map(m => m.name);
    execution.mavenExecutions.at(-1).surefireReports[0].content = `<testsuite name="${input.qualifiedTestClassName}" tests="${names.length}" failures="0" errors="0" skipped="0">`
      + names.map(name => `<testcase name="${name}" classname="${input.qualifiedTestClassName}"/>`).join('') + '</testsuite>';
    return { ...execution, testReport: { ...execution.testReport, tests: names.length, generatedTests: names.length } };
  };
  const service = new FullSourceGenerationService(f.options);
  await service.execute(f.task, f.task.methodOrder, f.cp, new AbortController().signal);
  const prior = await f.checkpoints.fullSourceProgress(f.task.id);
  const prepared = await f.checkpoints.saveFullSourceProgress(f.task.id, { ...prior,
    completion: { ...prior.completion, stopReason: 'repair_exhausted' }, publication: {
      phase: 'PREPARED', candidateId: prior.candidate.candidateId, candidateSha256: prior.managedFile.sha256,
      formalPath: join(f.task.workspaceRoot,'src/test/java/example/Target1Test.java'),
      formalSha256: 'b'.repeat(64), startedAt: new Date().toISOString() } });
  const outcome = await service.execute(f.task, f.task.methodOrder, prepared, new AbortController().signal);
  assert.equal(outcome.bundles.reduce((n,b)=>n+b.ordinaryTestMethodCount,0),29);
  assert.equal(outcome.bundles.flatMap(b=>b.passedTestMethods).length,29);
  assert.equal(outcome.methodOutcomes[0].status,'RETAINED_FAILURE');
  assert.equal(outcome.methodOutcomes.reduce((n,m)=>n+m.passedTestNames.length,0),29);
  assert.equal(f.trace.starts,1);
  assert.equal(f.trace.maven,2);
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.repairAttemptsUsed,1);
  assert.equal(saved.publication,null);
  const directory = join(f.task.workspaceRoot,'.ai-unit-test/full-source-candidates',sourceSha256(f.task.id).slice(0,24),saved.candidate.candidateId);
  const audit = JSON.parse(await readFile(join(directory,(await readdir(directory)).find(n=>n.endsWith('.stable-repair.json'))),'utf8'));
  assert.equal(audit.reason,'NON_VALIDATING_TEST');
  assert.equal(audit.execution.status,'passed');
  assert.equal(audit.sourceSha256,sourceSha256(audit.sourceCode));
  assert.match(audit.sourceCode,/void m1_ok\(\)/);
  assert.equal(audit.replacementSha256,saved.managedFile.sha256);
});

test('exhausted invalid final output still stabilizes the last valid candidate without another model call', async t => {
  const f = await setup(t, 2), execute = f.options.maven.execute, resume = f.options.agent.resumeFullSourceGenerationStream;
  let failed = false, finalInvalid = false;
  f.options.maven.execute = async input => {
    const execution = await execute(input);
    if (!failed) {
      failed = true;
      const last = execution.mavenExecutions.at(-1);
      last.exitCode = 1;
      last.surefireReports[0].content = last.surefireReports[0].content.replace('errors="0"', 'errors="1"')
        .replace(/(<testcase name="m1_ok"[^>]+)\/>/, '$1><error type="java.lang.NullPointerException" message="fixture"/></testcase>');
      return { ...execution, status: 'test_failed', testReport: { ...execution.testReport, errors: 1,
        failureDetails: [{ suiteName: input.qualifiedTestClassName, testClassName: input.qualifiedTestClassName,
          testName: 'm1_ok', kind: 'error', type: 'java.lang.NullPointerException', message: 'fixture' }] } };
    }
    const cp = await f.checkpoints.fullSourceProgress(f.task.id);
    const names = new JavaTestStructureService().findTestMethods(await readFile(cp.managedFile.path, 'utf8')).map(m => m.name);
    const report = execution.mavenExecutions.at(-1).surefireReports[0];
    report.content = `<testsuite name="${input.qualifiedTestClassName}" tests="${names.length}" failures="0" errors="0" skipped="0">`
      + names.map(name => `<testcase name="${name}" classname="${input.qualifiedTestClassName}"/>`).join('') + '</testsuite>';
    return { ...execution, testReport: { ...execution.testReport, tests: names.length, generatedTests: names.length } };
  };
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback) => {
    const cp = await f.checkpoints.fullSourceProgress(f.task.id);
    if (feedback.feedbackKind === 'maven' && !finalInvalid) {
      finalInvalid = true;
      return { kind: 'output_invalid', sessionId: id, eventSequence: 3, outputInvalid: {
        generationMode: 'FULL_SOURCE', candidateId: cp.candidate.candidateId, candidateVersion: 3, repairAttempt: 2,
        invalidOutput: 'invalid final output', invalidOutputSha256: sourceSha256('invalid final output'),
        validationErrors: [{ code: 'GENERATED_TEST_INVALID', message: 'missing assertion' }] } };
    }
    const turn = await resume(id, feedback);
    if (finalInvalid) return { kind: 'completed', sessionId: id, eventSequence: 4,
      completion: { methodId: cp.batch.methodId, batchId: cp.batch.batchId, stopReason: 'repair_exhausted',
        bestCandidateId: cp.lastValidCandidate.candidateId, aggregateUsage: null, modelCallCount: 3, usageReportedCallCount: 0 } };
    return turn;
  };
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder, f.cp, new AbortController().signal);
  assert.equal(outcome.bundles.length, 29);
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  assert.equal(saved.stableRepair.phase, 'PASSED');
  assert.equal(saved.repairAttemptsUsed, 2);
  assert.equal(saved.candidate.candidateVersion, 2);
  assert.equal(f.trace.starts, 1);
  const dir = join(f.task.workspaceRoot, '.ai-unit-test/full-source-candidates', sourceSha256(f.task.id).slice(0,24),saved.candidate.candidateId);
  const finalOutput = JSON.parse(await readFile(join(dir, 'final-invalid-output-v3.json'), 'utf8'));
  assert.equal(finalOutput.outputFailure.invalidOutput, 'invalid final output');
  assert.equal(finalOutput.repairAttemptsUsed, 2);
});

test('repair survives a crash after source replacement without repeating initial generation', async t => {
  const f = await setup(t);
  const execute = f.options.maven.execute, resume = f.options.agent.resumeFullSourceGenerationStream;
  let firstMaven = true, repaired = false, crashed = false;
  f.options.maven.execute = async input => {
    const result = await execute(input);
    if (firstMaven) { firstMaven = false; return { status: 'compile_failed',
      mavenExecutions: [{ ...result.mavenExecutions[0], exitCode: 1, stdout: 'unknown symbol' }] }; }
    return result;
  };
  f.options.agent.resumeFullSourceGenerationStream = async (id, feedback) => {
    if (feedback.feedbackKind === 'maven' && feedback.execution.status === 'compile_failed') {
      const cp = await f.checkpoints.fullSourceProgress(f.task.id);
      const testCode = cp.candidate.testCode + '\n// repaired unknown symbol\n';
      repaired = true;
      return { kind: 'candidate_ready', sessionId: id, eventSequence: 3, candidate: { ...cp.candidate,
        candidateVersion: 3, repairAttempt: 2, testCode, generatedCodeSha256: sourceSha256(testCode) } };
    }
    const result = await resume(id, feedback);
    return repaired && result.kind === 'completed' ? { ...result, eventSequence: 4 } : result;
  };
  const replace = f.options.writer.replacePreparedGeneratedTest.bind(f.options.writer);
  f.options.writer.replacePreparedGeneratedTest = async input => {
    const result = await replace(input);
    if (!crashed) {
      crashed = true;
      const cp = await f.checkpoints.fullSourceProgress(f.task.id);
      await f.checkpoints.saveFullSourceProgress(f.task.id, { ...cp, publication: {
        phase: 'PREPARED', candidateId: cp.candidate.candidateId, candidateSha256: cp.managedFile.sha256,
        formalPath: join(f.task.workspaceRoot,'src/test/java/example/Target1Test.java'),
        formalSha256: 'b'.repeat(64), startedAt: new Date().toISOString() } });
      throw new Error('simulated crash after durable source write');
    }
    return result;
  };
  await assert.rejects(new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    f.cp, new AbortController().signal), /simulated crash/);
  const saved = await f.checkpoints.fullSourceProgress(f.task.id);
  const outcome = await new FullSourceGenerationService(f.options).execute(f.task, f.task.methodOrder,
    saved, new AbortController().signal);
  assert.equal(outcome.terminalStatus, 'PASSED');
  assert.equal(f.trace.starts, 1);
  assert.equal(f.trace.corrections, 1);
  assert.equal(f.trace.maven, 2);
  assert.equal((await f.checkpoints.fullSourceProgress(f.task.id)).pendingReplacement, null);
  assert.equal((await f.checkpoints.fullSourceProgress(f.task.id)).publication, null);
});

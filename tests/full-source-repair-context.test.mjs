import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullSourceFacts } from './fixtures/full-source.mjs';
import { sourceSha256, validateFullSourceFeedback } from '../src/main/services/full-source-generation-contract.ts';

const failed = { status: 'compile_failed', mavenExecutions: [{ scope:'method_candidate', phase:'test_compile',
  command:'mvn test-compile', exitCode:1, stdout:'', stderr:'', surefireReports:[] }] };
const feedback = source => ({ feedbackId:'00000000-0000-4000-8000-000000000001', expectedEventSequence:1,
  candidateId:'00000000-0000-4000-8000-000000000002', candidateVersion:1, repairAttempt:0,
  feedbackKind:'maven', effectiveTestCode:source, effectiveFileSha256:sourceSha256(source), execution:failed });

test('full-source repair context uses actual frozen source lines and the existing diagnostic contract', async t => {
  const { resolveFullSourceRepairContext } = await import('../src/main/services/full-source-repair-context.ts');
  const root = await mkdtemp(join(tmpdir(),'full-repair-context-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const facts = fullSourceFacts(2);
  const source = 'package example;\nclass Target {\n' + facts.methods.map(m=>m.completeMethodSource).join('\n') + '\n}\n';
  facts.sourceSha256 = sourceSha256(source);
  const file = join(root,'Target.java'); await writeFile(file,source);
  const context = await resolveFullSourceRepairContext({ facts, analysisSessionId:'id', sourceFilePath:file,
    generatedTestFilePath:join(root,'TargetTest.java'), generatedTestClassName:'example.TargetTest',
    effectiveTestCode:'class TargetTest {}', execution:failed, analyzer:{}, signal:new AbortController().signal });
  assert.equal(context.targetMethod.firstLine,3);
  assert.equal(context.stackMethods[0].firstLine,4);
  assert.equal(context.analyzerStatus,'fallback');
  const value = feedback('class TargetTest {}'); value.repairContext = context;
  assert.deepEqual(validateFullSourceFeedback(value).repairContext,context);
  const names=Array.from({length:23},(_,i)=>`m1_fail${i}`);
  const execution={status:'test_failed',mavenExecutions:[...failed.mavenExecutions.map(e=>({...e,exitCode:0})),
    {scope:'method_candidate',phase:'test',command:'mvn test',exitCode:1,stdout:'',stderr:'',surefireReports:[{
      fileName:'TEST-example.TargetTest.xml',content:'<testsuite>'+names.map(n=>`<testcase name="${n}" classname="example.TargetTest"><error type="java.lang.NullPointerException"/></testcase>`).join('')
        +'<testcase name="m2_pass" classname="example.TargetTest"/></testsuite>'}]}],
    testReport:{reportCount:1,tests:24,failures:0,errors:23,skipped:0,generatedTestClassName:'example.TargetTest',generatedTests:24,generatedSkipped:0,
      failureDetails:names.slice(0,20).map(n=>({suiteName:'example.TargetTest',testClassName:'example.TargetTest',testName:n,kind:'error',type:'java.lang.NullPointerException',message:'fixture'}))}};
  const bounded=await resolveFullSourceRepairContext({ facts, analysisSessionId:'id', sourceFilePath:file,
    generatedTestFilePath:join(root,'TargetTest.java'),generatedTestClassName:'example.TargetTest',
    effectiveTestCode:'class TargetTest {}',execution,analyzer:{},signal:new AbortController().signal });
  assert.deepEqual(bounded.affectedTestNames,names);
  assert.equal(bounded.truncated,true);
  assert.equal(bounded.droppedItemCount,3);
  value.execution = { status:'passed', mavenExecutions:[...failed.mavenExecutions.map(e=>({...e,exitCode:0})),
    {scope:'method_candidate',phase:'test',command:'mvn test',exitCode:0,stdout:'',stderr:'',surefireReports:[]}] };
  assert.throws(()=>validateFullSourceFeedback(value));
  await writeFile(file,source+'//changed');
  await assert.rejects(resolveFullSourceRepairContext({ facts, analysisSessionId:'id', sourceFilePath:file,
    generatedTestFilePath:'TargetTest.java', generatedTestClassName:'example.TargetTest',
    effectiveTestCode:'class TargetTest {}', execution:failed, analyzer:{}, signal:new AbortController().signal }),/源码/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fullSourceFacts } from './fixtures/full-source.mjs';
import { ClassTaskCheckpointService } from '../src/main/services/class-task-checkpoint.service.ts';
import { ClassTaskRunnerService } from '../src/main/services/class-task-runner.service.ts';

test('frozen full-source refuses an unsupported adapter without falling back to a Wave', async t => {
  const root = await mkdtemp(join(tmpdir(), 'full-source-runner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const facts = fullSourceFacts(2);
  let task = { id: randomUUID(), ragEnabled: false, state: 'RUNNING', repairAttemptLimit: 6, unlimitedRepair: false,
    currentAtomicStep: 'IDLE', currentMethodIndex: -1, methodOrder: facts.methods.map(m => m.methodId), generatedArtifacts: [] };
  const checkpoints = new ClassTaskCheckpointService({ storagePath: join(root, 'checkpoint.json'),
    taskState: { snapshot: () => structuredClone(task), save: async v => (task = structuredClone(v)) } });
  const identity = { analysisSessionId: randomUUID(), reportPairId: facts.reportPairId,
    methodIds: task.methodOrder, repairAttemptLimit: 6, unlimitedRepair: false };
  await checkpoints.prepareFullSourceRun(task.id, identity);
  let waveCalls = 0;
  const runner = new ClassTaskRunnerService({ checkpoints, methodExecution: {
    async execute() { waveCalls++; throw new Error('must not downgrade'); },
    async nextClassWave() { waveCalls++; throw new Error('must not downgrade'); },
    async executeWave() { waveCalls++; throw new Error('must not downgrade'); }
  } });
  await assert.rejects(runner.run(task, task.methodOrder, identity, new AbortController().signal), /不支持恢复完整源码协议/);
  assert.equal(waveCalls, 0);
});

test('the legacy runner freezes its actual mode before executing a method', async t => {
  const root=await mkdtemp(join(tmpdir(),'legacy-mode-runner-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const facts=fullSourceFacts(1);
  let task={id:randomUUID(),ragEnabled:true,state:'RUNNING',currentAtomicStep:'IDLE',currentMethodIndex:-1,
    methodOrder:facts.methods.map(m=>m.methodId),generatedArtifacts:[]};
  const checkpoints=new ClassTaskCheckpointService({storagePath:join(root,'checkpoint.json'),
    taskState:{snapshot:()=>structuredClone(task),save:async value=>(task=structuredClone(value))}});
  const runner=new ClassTaskRunnerService({checkpoints,methodExecution:{execute:async()=>{
    assert.equal((await checkpoints.taskProgress(task.id)).executionMode,'LEGACY_WAVE');return null;
  }}});
  await runner.run(task,task.methodOrder,{analysisSessionId:randomUUID(),reportPairId:facts.reportPairId},new AbortController().signal);
});

test('new false runner calls full-source once with all selected methods before Wave/group routing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'full-source-runner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const facts = fullSourceFacts();
  let task = { id: randomUUID(), ragEnabled: false, state: 'RUNNING', repairAttemptLimit: 6, unlimitedRepair: false,
    currentAtomicStep: 'IDLE', currentMethodIndex: -1, methodOrder: facts.methods.map(m => m.methodId), generatedArtifacts: [] };
  const checkpoints = new ClassTaskCheckpointService({ storagePath: join(root, 'checkpoint.json'),
    taskState: { snapshot: () => structuredClone(task), save: async v => (task = structuredClone(v)) } });
  const calls = [];
  const runner = new ClassTaskRunnerService({ checkpoints, methodExecution: {
    async executeFullSource(_task, ids) { calls.push([...ids]); return { candidateIds: [], bundles: [], terminalStatus: 'RETAINED_FAILURE',
      methodOutcomes: ids.map(methodId => ({ methodId, passedTestNames: [], retainedFailureMembers: [], deletedTests: [], status: 'NO_VALID_TEST' })) }; },
    async formalizeFullSource() {},
    async execute() { throw new Error('legacy'); }, async nextClassWave() { throw new Error('Wave'); },
    async executeWave() { throw new Error('Wave'); }, async executeGroup() { throw new Error('group'); }
  } });
  const result = await runner.run(task, task.methodOrder, { analysisSessionId: randomUUID(), reportPairId: facts.reportPairId }, new AbortController().signal);
  assert.equal(result, 'NO_FORMAL_TEST_FILE'); assert.deepEqual(calls, [task.methodOrder]);
});

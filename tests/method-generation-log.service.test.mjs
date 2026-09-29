import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MethodGenerationLogService
} from '../src/main/services/method-generation-log.service.ts';

function modelEvent({
  callId,
  phase,
  version,
  userPrompt = `user-v${version}`,
  toolExchanges,
  processingError = null,
  sessionId = '11111111-1111-4111-8111-111111111111',
  batchId = 'a'.repeat(64),
  batchIndex = 1
}) {
  return {
    sessionId,
    eventSequence: version,
    eventType: 'model_call',
    occurredAt: `2026-08-09T00:00:0${version}.000Z`,
    progress: null,
    candidate: null,
    completion: null,
    error: null,
    modelCall: {
      sessionId,
      callId,
      parentCallId: null,
      phase,
      callKind: version === 1 ? 'generation' : 'repair',
      methodId: 'b'.repeat(64),
      batchId,
      batchIndex,
      repairAttempt: version - 1,
      candidateVersion: version,
      modelName: 'fake-model',
      startedAt: '2026-08-09T00:00:00.000Z',
      occurredAt: `2026-08-09T00:00:0${version}.000Z`,
      systemPrompt: phase === 'started' ? 'system Authorization: Bearer top-secret' : null,
      userPrompt: phase === 'started' ? userPrompt : null,
      rawOutput: phase === 'completed' ? `raw-v${version}` : null,
      processedOutput: phase === 'completed' ? `code-v${version}` : null,
      processingValid: phase === 'completed' ? true : null,
      processingError,
      usage: null,
      errorCode: null,
      statusCode: null,
      errorType: null,
      providerCode: null,
      truncated: false,
      ...(toolExchanges === undefined ? {} : { toolExchanges })
    }
  };
}

function toolExchange(sequence, overrides = {}) {
  return {
    sequence,
    toolCallId: `source-call-${sequence}`,
    toolName: 'retrieve_java_source',
    modelRequestSequence: sequence,
    rawArguments: `{ "query" : "Type${sequence}" }`,
    validatedInput: { query: `Type${sequence}` },
    toolMessage: JSON.stringify({
      status: 'FOUND',
      results: [{
        ownerFqn: `demo.Type${sequence}`,
        methodKey: `demo.Type${sequence}#run()V`,
        sourceText: `SOURCE-CANARY-${sequence}`
      }],
      nextCursor: null,
      degradationCode: null
    }),
    includedInModelRequestSequence: sequence + 1,
    status: 'FOUND',
    startedAt: `2026-08-09T00:00:0${sequence}.000Z`,
    completedAt: `2026-08-09T00:00:0${sequence + 1}.000Z`,
    durationMs: 1_000,
    cacheHit: false,
    physicalAttempts: [{
      attempt: 1,
      status: 'FOUND',
      toolMessage: JSON.stringify({ status: 'FOUND', sequence }),
      retryScheduled: false,
      startedAt: `2026-08-09T00:00:0${sequence}.000Z`,
      completedAt: `2026-08-09T00:00:0${sequence + 1}.000Z`,
      durationMs: 1_000
    }],
    evidenceStatus: 'NEW_EVIDENCE',
    consecutiveNoNewEvidence: 0,
    forcedFinalOutput: false,
    ...overrides
  };
}

function logRecord(event, overrides = {}) {
  return {
    taskId: 'task-1',
    className: 'TaskService',
    qualifiedClassName: 'demo.TaskService',
    methodId: 'b'.repeat(64),
    methodName: 'getChildZipFile',
    descriptor: '(Ljava/lang/String;)V',
    displaySignature: 'public void getChildZipFile(java.lang.String)',
    modifiers: ['public'],
    batchId: 'a'.repeat(64),
    batchIndex: 1,
    event,
    ...overrides
  };
}

function probeLogRecord(overrides = {}) {
  return {
    taskId: 'task-1',
    className: 'TaskService',
    qualifiedClassName: 'demo.TaskService',
    modelName: 'tool-model',
    occurredAt: '2026-08-09T00:00:00.000Z',
    probe: {
      supported: true,
      cacheHit: false,
      cacheKeyDigest: 'd'.repeat(64),
      trace: {
        request: {
          systemPrompt: 'probe-system',
          userPrompt: 'probe-user',
          toolName: 'rag_tool_probe',
          toolChoice: 'auto'
        },
        toolExchange: {
          toolCallId: 'probe-call-1',
          toolName: 'rag_tool_probe',
          arguments: { token: 'nonce' },
          toolMessage: { toolCallId: 'probe-call-1', content: 'nonce' }
        },
        finalConfirmation: { content: 'nonce', matchesNonce: true },
        outcome: 'supported'
      }
    },
    ...overrides
  };
}

test('stores each method candidate version separately and redacts credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-'));
  try {
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    for (const version of [1, 2]) {
      const callId = `0000000${version}-0000-4000-8000-00000000000${version}`;
      await service.record(logRecord(
        modelEvent({ callId, phase: 'started', version })
      ));
      await service.record(logRecord(
        modelEvent({ callId, phase: 'completed', version })
      ));
    }
    assert.equal(await service.finish(), null);

    const dates = await readdir(directory);
    assert.equal(dates.length, 1);
    const callDirectories = (await readdir(join(directory, dates[0]))).sort();
    assert.equal(callDirectories.length, 2);
    assert.match(
      callDirectories[0],
      /^08-00-00\.000_TaskService_getChildZipFile_第1批生成_候选v1_00000001$/
    );
    assert.match(
      callDirectories[1],
      /^08-00-00\.000_TaskService_getChildZipFile_第1批第1次修复_候选v2_00000002$/
    );
    const firstDirectory = join(directory, dates[0], callDirectories[0]);
    const firstFiles = await readdir(firstDirectory);
    const systemPromptFile = firstFiles.find((name) => name.endsWith('_01-系统提示词.md'));
    const rawOutputFile = firstFiles.find((name) => name.endsWith('_03-模型原始输出.java'));
    const metadataFile = firstFiles.find((name) => name.endsWith('_调用信息.json'));
    assert.ok(systemPromptFile);
    assert.ok(rawOutputFile);
    assert.ok(metadataFile);
    const systemPrompt = await readFile(
      join(firstDirectory, systemPromptFile),
      'utf8'
    );
    assert.doesNotMatch(systemPrompt, /top-secret/);
    assert.match(systemPrompt, /\[REDACTED\]/);
    assert.equal(
      await readFile(join(firstDirectory, rawOutputFile), 'utf8'),
      'raw-v1'
    );
    const metadata = JSON.parse(await readFile(
      join(firstDirectory, metadataFile),
      'utf8'
    ));
    assert.equal(metadata.className, 'TaskService');
    assert.equal(metadata.qualifiedClassName, 'demo.TaskService');
    assert.equal(metadata.methodName, 'getChildZipFile');
    assert.equal(metadata.descriptor, '(Ljava/lang/String;)V');
    assert.equal(
      metadata.displaySignature,
      'public void getChildZipFile(java.lang.String)'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes the exact model-output validation reason into call metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-'));
  try {
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    const callId = '00000009-0000-4000-8000-000000000009';
    await service.record(logRecord(modelEvent({
      callId,
      phase: 'started',
      version: 1
    })));
    const completed = modelEvent({
      callId,
      phase: 'completed',
      version: 1,
      processingError: '模型返回的普通 @Test 数量与本批测试计划不一致。'
    });
    completed.modelCall.processedOutput = null;
    completed.modelCall.processingValid = false;
    await service.record(logRecord(completed));
    assert.equal(await service.finish(), null);

    const [date] = await readdir(directory);
    const [callDirectory] = await readdir(join(directory, date));
    const metadataName = (await readdir(join(directory, date, callDirectory)))
      .find((name) => name.endsWith('_调用信息.json'));
    assert.ok(metadataName);
    const metadata = JSON.parse(await readFile(
      join(directory, date, callDirectory, metadataName),
      'utf8'
    ));
    assert.equal(
      metadata.processingError,
      '模型返回的普通 @Test 数量与本批测试计划不一致。'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('labels unpublished generation retries separately from the initial candidate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-'));
  try {
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    const callIds = [
      '00000003-0000-4000-8000-000000000003',
      '00000004-0000-4000-8000-000000000004'
    ];
    for (const callId of callIds) {
      await service.record(logRecord(
        modelEvent({ callId, phase: 'started', version: 1 })
      ));
      await service.record(logRecord(
        modelEvent({ callId, phase: 'completed', version: 1 })
      ));
    }
    assert.equal(await service.finish(), null);

    const [date] = await readdir(directory);
    const callDirectories = (await readdir(join(directory, date))).sort();
    assert.deepEqual(callDirectories, [
      '08-00-00.000_TaskService_getChildZipFile_第1批生成_候选v1_00000003',
      '08-00-00.000_TaskService_getChildZipFile_第1批第1次生成重试_候选v1_00000004'
    ]);
    const retryFiles = await readdir(join(directory, date, callDirectories[1]));
    assert.ok(retryFiles.some((name) => (
      name.includes('_第1批第1次生成重试_公开方法_01-系统提示词.md')
    )));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wave part logs keep stable Wave and Part identity when parts finish out of order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-wave-log-'));
  try {
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    for (const partIndex of [2, 1]) {
      const batchId = String.fromCharCode(98 + partIndex).repeat(64);
      const sessionId = `0000000${partIndex}-1111-4111-8111-11111111111${partIndex}`;
      const callId = `0000000${partIndex}-2222-4222-8222-22222222222${partIndex}`;
      const identity = {
        waveIndex: 1,
        partIndex,
        partBatchId: batchId,
        scenarioIds: [`scenario-${partIndex}-1`, `scenario-${partIndex}-2`]
      };
      for (const phase of ['started', 'completed']) {
        await service.record(logRecord(modelEvent({
          callId,
          phase,
          version: 1,
          sessionId,
          batchId
        }), {
          batchId,
          ...identity
        }));
      }
    }
    await service.recordWaveSummary({
      taskId: 'task-1',
      className: 'TaskService',
      qualifiedClassName: 'demo.TaskService',
      methodId: 'b'.repeat(64),
      methodName: 'getBbq',
      descriptor: '()V',
      waveId: 'e'.repeat(64),
      waveIndex: 1,
      selectedScenarioIds: ['scenario-1-1', 'scenario-1-2', 'scenario-2-1', 'scenario-2-2'],
      skippedScenarioIds: ['scenario-2-1', 'scenario-2-2'],
      parts: [{
        partIndex: 1,
        partBatchId: 'c'.repeat(64),
        scenarioIds: ['scenario-1-1', 'scenario-1-2'],
        status: 'succeeded',
        candidateId: '00000001-3333-4333-8333-333333333331'
      }, {
        partIndex: 2,
        partBatchId: 'd'.repeat(64),
        scenarioIds: ['scenario-2-1', 'scenario-2-2'],
        status: 'failed',
        candidateId: null
      }],
      mergedCandidateId: '00000001-4444-4444-8444-444444444441',
      occurredAt: '2026-08-09T00:00:09.000Z'
    });
    assert.equal(await service.finish(), null);

    const [date] = await readdir(directory);
    const entries = (await readdir(join(directory, date))).sort();
    assert.ok(entries.some((name) => name.includes(
      'TaskService_getChildZipFile_Wave1_Part1_首次生成_候选v1'
    )));
    assert.ok(entries.some((name) => name.includes(
      'TaskService_getChildZipFile_Wave1_Part2_首次生成_候选v1'
    )));
    const partOneDirectory = entries.find((name) => name.includes('Wave1_Part1_'));
    assert.ok(partOneDirectory);
    const partOneMetadataName = (await readdir(
      join(directory, date, partOneDirectory)
    )).find((name) => name.endsWith('_调用信息.json'));
    assert.ok(partOneMetadataName);
    const metadata = JSON.parse(await readFile(
      join(directory, date, partOneDirectory, partOneMetadataName),
      'utf8'
    ));
    assert.equal(metadata.waveIndex, 1);
    assert.equal(metadata.partIndex, 1);
    assert.deepEqual(metadata.scenarioIds, ['scenario-1-1', 'scenario-1-2']);

    const summaryName = entries.find((name) => name.includes('getBbq_Wave1_汇总'));
    assert.ok(summaryName);
    const summary = JSON.parse(await readFile(
      join(directory, date, summaryName),
      'utf8'
    ));
    assert.equal(summary.waveId, 'e'.repeat(64));
    assert.deepEqual(summary.skippedScenarioIds, ['scenario-2-1', 'scenario-2-2']);
    assert.equal(summary.parts[0].partIndex, 1);
    assert.equal(summary.parts[1].status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('redacts quoted JSON credential keys from persisted prompts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-'));
  try {
    const service = new MethodGenerationLogService();
    const callId = '00000001-0000-4000-8000-000000000001';
    await service.begin({ enabled: true, directory });
    await service.record(logRecord(modelEvent({
        callId,
        phase: 'started',
        version: 1,
        userPrompt: '{"apiKey":"json-secret","access_token":"token-secret"}'
      })));
    assert.equal(await service.finish(), null);

    const [date] = await readdir(directory);
    const [callDirectory] = await readdir(join(directory, date));
    const files = await readdir(join(directory, date, callDirectory));
    const userPromptFile = files.find((name) => (
      name.endsWith('_02-完整方法与必要分析信息.md')
    ));
    assert.ok(userPromptFile);
    const persisted = await readFile(
      join(directory, date, callDirectory, userPromptFile),
      'utf8'
    );
    assert.doesNotMatch(persisted, /json-secret|token-secret/);
    assert.match(persisted, /\[REDACTED\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of ['failed', 'stopped']) {
  test(`RAG ${phase} call preserves exact requests and completed tool exchanges`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'rag-terminal-log-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    const event = modelEvent({
      callId: '00000002-0000-4000-8000-000000000002', phase, version: 2,
      toolExchanges: [toolExchange(1)]
    });
    event.modelCall.requestTraces = [JSON.stringify({ input: 'WIRE-EVIDENCE' })];
    await service.record(logRecord(event));
    assert.equal(await service.finish(), null);
    const [date] = await readdir(directory);
    const [call] = await readdir(join(directory, date));
    const callPath = join(directory, date, call);
    const files = await readdir(callPath);
    const request = files.find(name => name.endsWith('-模型请求-01.json'));
    const output = files.find(name => name.endsWith('-工具调用-01-输出.json'));
    assert.ok(request, 'actual request should survive a failed final model call');
    assert.ok(output, 'retrieved RAG evidence should survive a failed final model call');
    assert.match(await readFile(join(callPath, request), 'utf8'), /WIRE-EVIDENCE/);
    assert.match(await readFile(join(callPath, output), 'utf8'), /SOURCE-CANARY-1/);
    assert.equal(files.some(name => name.endsWith('-Maven候选代码.java')), false);
  });
}

test('method generation log writes ordered exact RAG tool exchange files before repair output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-'));
  try {
    const service = new MethodGenerationLogService();
    const callId = '00000002-0000-4000-8000-000000000002';
    await service.begin({ enabled: true, directory });
    await service.record(logRecord(modelEvent({
      callId,
      phase: 'started',
      version: 2,
      userPrompt: 'TEST-SOURCE-CANARY'
    })));
    await service.record(logRecord(modelEvent({
      callId,
      phase: 'completed',
      version: 2,
      toolExchanges: [
        toolExchange(1),
        toolExchange(2, {
          rawArguments: '{"query":"Secret","apiKey":"tool-secret","embeddingVector":[0.123456789,0.987654321]}',
          validatedInput: { query: 'Secret' },
          toolMessage: '{"status":"NOT_FOUND","Authorization":"Bearer tool-secret","results":[],"nextCursor":null,"degradationCode":null}',
          status: 'CACHE_HIT',
          cacheHit: true,
          physicalAttempts: [],
          evidenceStatus: 'NO_NEW_EVIDENCE',
          consecutiveNoNewEvidence: 2
        })
      ]
    })));
    assert.equal(await service.finish(), null);

    const [date] = await readdir(directory);
    const [callDirectory] = await readdir(join(directory, date));
    const callPath = join(directory, date, callDirectory);
    const files = (await readdir(callPath)).sort();
    assert.deepEqual(
      files.map((name) => name.replace(/^.*_((?:0[1-8]-)|调用信息)/, '$1')),
      [
        '01-系统提示词.md',
        '02-完整方法与必要分析信息.md',
        '03-工具调用-01-输入.json',
        '04-工具调用-01-输出.json',
        '05-工具调用-02-输入.json',
        '06-工具调用-02-输出.json',
        '07-模型原始输出.java',
        '08-Maven候选代码.java',
        '调用信息.json'
      ]
    );
    const firstInputName = files.find((name) => name.endsWith('_03-工具调用-01-输入.json'));
    const firstOutputName = files.find((name) => name.endsWith('_04-工具调用-01-输出.json'));
    const secondInputName = files.find((name) => name.endsWith('_05-工具调用-02-输入.json'));
    const secondOutputName = files.find((name) => name.endsWith('_06-工具调用-02-输出.json'));
    assert.ok(firstInputName && firstOutputName && secondInputName && secondOutputName);
    const firstInput = JSON.parse(await readFile(join(callPath, firstInputName), 'utf8'));
    const firstOutput = JSON.parse(await readFile(join(callPath, firstOutputName), 'utf8'));
    const secondInputText = await readFile(join(callPath, secondInputName), 'utf8');
    const secondOutputText = await readFile(join(callPath, secondOutputName), 'utf8');
    assert.equal(firstInput.classFqn, 'demo.TaskService');
    assert.equal(
      firstInput.methodKey,
      'demo.TaskService#getChildZipFile(Ljava/lang/String;)V'
    );
    assert.equal(firstInput.repairAttempt, 1);
    assert.equal(firstInput.sequence, 1);
    assert.equal(firstInput.toolCallId, 'source-call-1');
    assert.equal(firstInput.rawArguments, '{ "query" : "Type1" }');
    assert.equal(firstOutput.includedInModelRequestSequence, 2);
    assert.match(firstOutput.toolMessage, /SOURCE-CANARY-1/);
    assert.equal(firstOutput.durationMs, 1_000);
    assert.equal(firstOutput.cacheHit, false);
    assert.equal(firstOutput.physicalAttempts.length, 1);
    assert.equal(firstOutput.physicalAttempts[0].retryScheduled, false);
    assert.equal(firstOutput.evidenceStatus, 'NEW_EVIDENCE');
    assert.equal(firstOutput.consecutiveNoNewEvidence, 0);
    assert.equal(firstOutput.forcedFinalOutput, false);
    assert.doesNotMatch(secondInputText + secondOutputText, /tool-secret/);
    assert.doesNotMatch(
      secondInputText + secondOutputText,
      /0\.123456789|0\.987654321/
    );
    assert.match(secondInputText + secondOutputText, /\[REDACTED\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Maven batch log preserves command candidate attribution and fallback decisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-maven-log-'));
  try {
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    await service.recordMavenBatch({
      taskId: 'task-1',
      className: 'TaskService',
      qualifiedClassName: 'demo.TaskService',
      methodId: 'b'.repeat(64),
      methodName: 'getBbq',
      descriptor: '()V',
      waveIndex: 1,
      candidateId: '00000001-4444-4444-8444-444444444441',
      trace: {
        mavenBatchId: '11111111-1111-4111-8111-111111111111',
        moduleRoot: 'D:\\work\\manager-core',
        startedAt: '2026-08-09T00:00:10.000Z',
        completedAt: '2026-08-09T00:00:12.000Z',
        durationMs: 2_000,
        candidates: [{
          candidateId: '00000001-4444-4444-8444-444444444441',
          filePath: 'D:\\work\\manager-core\\src\\test\\java\\demo\\ATmp1Test.java',
          qualifiedTestClassName: 'demo.ATmp1Test'
        }, {
          candidateId: '00000002-4444-4444-8444-444444444442',
          filePath: 'D:\\work\\manager-core\\src\\test\\java\\demo\\BTmp1Test.java',
          qualifiedTestClassName: 'demo.BTmp1Test'
        }],
        steps: [{
          sequence: 1,
          candidateIds: [
            '00000001-4444-4444-8444-444444444441',
            '00000002-4444-4444-8444-444444444442'
          ],
          phase: 'test_compile',
          command: 'mvn -Dtest=ATmp1Test,BTmp1Test test-compile',
          exitCode: 1,
          stdout: '',
          stderr: '[ERROR] cannot find symbol\napiKey=maven-secret',
          surefireReports: [],
          attribution: {
            ambiguous: true,
            results: [{
              candidateId: '00000001-4444-4444-8444-444444444441',
              status: 'UNPROVEN',
              diagnostic: ''
            }, {
              candidateId: '00000002-4444-4444-8444-444444444442',
              status: 'UNPROVEN',
              diagnostic: ''
            }]
          },
          fallback: 'INDIVIDUAL'
        }],
        results: [{
          candidateId: '00000001-4444-4444-8444-444444444441',
          status: 'passed'
        }, {
          candidateId: '00000002-4444-4444-8444-444444444442',
          status: 'compile_failed'
        }]
      }
    });
    assert.equal(await service.finish(), null);

    const [date] = await readdir(directory);
    const [batchName] = (await readdir(join(directory, date))).filter((name) => (
      name.includes('TaskService_getBbq_Wave1_Maven批次_11111111')
    ));
    assert.ok(batchName);
    const persistedText = await readFile(join(directory, date, batchName), 'utf8');
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.trace.mavenBatchId, '11111111-1111-4111-8111-111111111111');
    assert.equal(
      persisted.trace.steps[0].command,
      'mvn -Dtest=ATmp1Test,BTmp1Test test-compile'
    );
    assert.equal(persisted.trace.steps[0].fallback, 'INDIVIDUAL');
    assert.equal(persisted.trace.steps[0].attribution.ambiguous, true);
    assert.equal(persisted.trace.steps[0].stderr.split('\n')[0], '[ERROR] cannot find symbol');
    assert.doesNotMatch(persistedText, /maven-secret/);
    assert.match(persistedText, /\[REDACTED\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('probe log writes request tool exchange and final confirmation but cache hits only write metadata', async () => {
  for (const cacheHit of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'method-generation-probe-log-'));
    try {
      const service = new MethodGenerationLogService();
      await service.begin({ enabled: true, directory });
      const record = probeLogRecord(cacheHit ? {
        probe: {
          supported: true,
          cacheHit: true,
          cacheKeyDigest: 'e'.repeat(64),
          trace: null
        }
      } : {});

      await service.recordRagToolCallingProbe(record);
      assert.equal(await service.finish(), null);

      const [date] = await readdir(directory);
      const [probeDirectory] = await readdir(join(directory, date));
      assert.match(probeDirectory, /TaskService_RAG工具能力检测_/);
      const files = (await readdir(join(directory, date, probeDirectory))).sort();
      assert.deepEqual(
        files,
        cacheHit
          ? ['调用信息.json']
          : [
              '01-探针请求.json',
              '02-工具调用-输入.json',
              '03-工具调用-输出.json',
              '04-最终确认.json',
              '调用信息.json'
            ]
      );
      const metadata = JSON.parse(await readFile(
        join(directory, date, probeDirectory, '调用信息.json'),
        'utf8'
      ));
      assert.equal(metadata.classFqn, 'demo.TaskService');
      assert.equal(metadata.modelName, 'tool-model');
      assert.equal(metadata.cacheHit, cacheHit);
      if (!cacheHit) {
        const toolInput = JSON.parse(await readFile(
          join(directory, date, probeDirectory, '02-工具调用-输入.json'),
          'utf8'
        ));
        assert.equal(toolInput.toolCallId, 'probe-call-1');
        assert.deepEqual(toolInput.arguments, { token: 'nonce' });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('model log write failures are nonfatal and surface through finish warning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-failure-'));
  const service = new MethodGenerationLogService();
  try {
    await service.begin({ enabled: true, directory });
    await rm(directory, { recursive: true, force: true });
    await writeFile(directory, 'blocks child directories', 'utf8');

    await assert.doesNotReject(service.recordRagToolCallingProbe(probeLogRecord()));
    assert.equal(await service.finish(), 'Method-generation log write failed.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists bounded repair telemetry without Maven output or user source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'method-generation-log-'));
  try {
    const service = new MethodGenerationLogService();
    await service.begin({ enabled: true, directory });
    await service.recordRepairTelemetry({
      taskId: 'task-1',
      className: 'TaskService',
      qualifiedClassName: 'demo.TaskService',
      methodId: 'b'.repeat(64),
      methodName: 'getChildZipFile',
      descriptor: '(Ljava/lang/String;)V',
      batchId: 'a'.repeat(64),
      batchIndex: 1,
      candidateId: '00000001-0000-4000-8000-000000000001',
      candidateVersion: 2,
      repairAttempt: 1,
      candidateSha256: 'c'.repeat(64),
      feedbackKind: 'candidate_rejected',
      executionStatus: 'compile_failed',
      compilerErrorCount: 4,
      compilerCategories: ['unreported_exception'],
      affectedTestCount: 0,
      exceptionCount: 0,
      generatedTestFrameCount: 0,
      productionFrameCount: 0,
      missingSymbolCount: 0,
      relatedTypeCount: 1,
      diagnosticTruncated: false,
      droppedItemCount: 0,
      analyzerStatus: 'available',
      analyzerWarningCount: 0,
      scopeRejectionCodes: ['UNRELATED_TEST_CHANGED'],
      mavenDurationMs: 1_234,
      analyzerDurationMs: null,
      occurredAt: '2026-08-13T12:00:00.000Z'
    });
    assert.equal(await service.finish(), null);

    const telemetry = JSON.parse(await readFile(
      join(directory, '2026-08-13', 'repair-telemetry.jsonl'),
      'utf8'
    ));
    assert.equal(telemetry.qualifiedClassName, 'demo.TaskService');
    assert.equal(telemetry.methodName, 'getChildZipFile');
    assert.equal(telemetry.compilerErrorCount, 4);
    assert.deepEqual(telemetry.scopeRejectionCodes, ['UNRELATED_TEST_CHANGED']);
    assert.equal(telemetry.candidateSha256, 'c'.repeat(64));
    assert.equal('source' in telemetry, false);
    assert.equal('testCode' in telemetry, false);
    assert.equal('mavenExecutions' in telemetry, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

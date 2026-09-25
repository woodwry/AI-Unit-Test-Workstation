import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MavenCandidateExecutorService
} from '../src/main/services/maven-candidate-executor.service.ts';

const settings = {
  mavenHome: 'D:\\tools\\maven',
  javaHome: 'D:\\tools\\jdk',
  settingsPath: 'D:\\tools\\maven\\conf\\settings.xml',
  localRepository: 'D:\\m2'
};

const report = {
  reportCount: 1,
  tests: 2,
  failures: 0,
  errors: 0,
  skipped: 0,
  generatedTestClassName: 'com.example.TaskServicePublicTmpTest',
  generatedTests: 2,
  generatedSkipped: 0,
  failureDetails: []
};

function input(overrides = {}) {
  return {
    moduleRoot: 'D:\\work\\manager-core',
    buildSettings: settings,
    attemptId: '11111111-1111-4111-8111-111111111111',
    qualifiedTestClassName: 'com.example.TaskServicePublicTmpTest',
    scope: 'method_candidate',
    excludedEnvironmentVariables: ['DEEPSEEK_API_KEY'],
    ...overrides
  };
}

function commandResult(phase, exitCode) {
  return {
    command: phase === 'compile'
      ? 'mvn -s settings.xml test-compile'
      : 'mvn -s settings.xml -Dtest=TaskServicePublicTmpTest surefire:test',
    cwd: 'D:\\work\\manager-core',
    exitCode,
    stdout: `${phase}-stdout-完整输出`,
    stderr: exitCode === 0 ? '' : `${phase}-stderr-完整错误`
  };
}

function harness({
  compile = commandResult('compile', 0),
  testResult = commandResult('test', 0),
  parsedReport = report,
  artifacts = [{
    fileName: 'TEST-com.example.TaskServicePublicTmpTest.xml',
    content: '<testsuite tests="2"></testsuite>'
  }],
  parseError
} = {}) {
  const calls = [];
  const shellService = {
    runMavenGeneratedTestCompile: async (...args) => {
      calls.push(['compile', ...args]);
      return compile;
    },
    runMavenGeneratedSurefireTest: async (...args) => {
      calls.push(['test', ...args]);
      return testResult;
    }
  };
  const surefireReportService = {
    prepareAttempt: async (...args) => {
      calls.push(['prepare-report', ...args]);
      return 'D:\\work\\manager-core\\target\\ai-unit-test\\surefire\\current\\attempt';
    },
    readAttemptArtifacts: async (...args) => {
      calls.push(['read-artifacts', ...args]);
      return artifacts;
    },
    parseAttempt: async (...args) => {
      calls.push(['parse-report', ...args]);
      if (parseError) throw parseError;
      return parsedReport;
    }
  };
  return {
    calls,
    executor: new MavenCandidateExecutorService(
      shellService,
      surefireReportService
    )
  };
}

test('test-compile 失败时立即返回完整编译证据且绝不执行测试', async () => {
  const fullError = '无法解析符号\n'.repeat(120_000);
  const compile = {
    ...commandResult('compile', 1),
    stderr: fullError
  };
  const { calls, executor } = harness({ compile });

  const feedback = await executor.execute(input());

  assert.equal(feedback.status, 'compile_failed');
  assert.equal(feedback.mavenExecutions.length, 1);
  assert.equal(feedback.mavenExecutions[0].phase, 'test_compile');
  assert.equal(feedback.mavenExecutions[0].stderr, fullError);
  assert.deepEqual(feedback.mavenExecutions[0].surefireReports, []);
  assert.deepEqual(calls.map((call) => call[0]), ['compile']);
});

test('编译成功后才执行定向 Surefire 并携带完整 XML 证据', async () => {
  const { calls, executor } = harness();

  const feedback = await executor.execute(input());

  assert.equal(feedback.status, 'passed');
  assert.deepEqual(
    feedback.mavenExecutions.map((execution) => execution.phase),
    ['test_compile', 'test']
  );
  assert.equal(
    feedback.mavenExecutions[1].surefireReports[0].content,
    '<testsuite tests="2"></testsuite>'
  );
  assert.deepEqual(feedback.testReport, report);
  assert.deepEqual(calls.map((call) => call[0]), [
    'compile',
    'prepare-report',
    'test',
    'read-artifacts',
    'parse-report'
  ]);
});

test('Surefire 自身失败且没有 XML 时仍返回完整 Maven 测试错误', async () => {
  const testResult = commandResult('test', 1);
  const { executor } = harness({
    testResult,
    artifacts: [],
    parseError: new Error('未找到本轮 Surefire XML 报告')
  });

  const feedback = await executor.execute(input());

  assert.equal(feedback.status, 'test_failed');
  assert.equal(feedback.mavenExecutions.length, 2);
  assert.equal(
    feedback.mavenExecutions[1].stderr,
    'test-stderr-完整错误'
  );
  assert.deepEqual(feedback.mavenExecutions[1].surefireReports, []);
  assert.equal('testReport' in feedback, false);
});

test('reports exact compile and test phase boundaries around Maven commands', async () => {
  const events = [];
  const { executor } = harness();

  await executor.execute(input({
    onPhaseStart: async (phase) => { events.push(`start:${phase}`); },
    onPhaseComplete: async (phase) => { events.push(`complete:${phase}`); }
  }));

  assert.deepEqual(events, [
    'start:test_compile',
    'complete:test_compile',
    'start:test',
    'complete:test'
  ]);
});

test('Surefire XML 报告失败时即使 Maven 退出码为零也不得判定通过', async () => {
  const failedReport = {
    ...report,
    failures: 1,
    failureDetails: [{
      suiteName: 'com.example.TaskServicePublicTmpTest',
      testClassName: 'com.example.TaskServicePublicTmpTest',
      testName: 'publicScenario',
      kind: 'failure'
    }]
  };
  const { executor } = harness({
    testResult: commandResult('test', 0),
    parsedReport: failedReport
  });

  const feedback = await executor.execute(input());

  assert.equal(feedback.status, 'test_failed');
  assert.equal(feedback.mavenExecutions.length, 2);
  assert.deepEqual(feedback.testReport, failedReport);
});

test('精确裁剪候选使用独立 Maven 证据作用域', async () => {
  const { executor } = harness();

  const feedback = await executor.execute(input({
    scope: 'pruned_method_candidate'
  }));

  assert.deepEqual(
    feedback.mavenExecutions.map((execution) => execution.scope),
    ['pruned_method_candidate', 'pruned_method_candidate']
  );
});

test('精确裁剪后 Maven 成功但零测试无 XML 时返回分类失败而不是中断会话', async () => {
  const { executor } = harness({
    testResult: {
      ...commandResult('test', 0),
      stdout: 'Tests run: 0\nBUILD SUCCESS'
    },
    artifacts: [],
    parseError: new Error('未找到本轮 Surefire XML 报告')
  });

  const feedback = await executor.execute(input({
    scope: 'pruned_method_candidate'
  }));

  assert.equal(feedback.status, 'test_failed');
  assert.equal(feedback.mavenExecutions.length, 2);
  assert.equal(
    feedback.mavenExecutions[1].scope,
    'pruned_method_candidate'
  );
  assert.equal(
    feedback.mavenExecutions[1].stdout,
    'Tests run: 0\nBUILD SUCCESS'
  );
  assert.deepEqual(feedback.mavenExecutions[1].surefireReports, []);
  assert.equal('testReport' in feedback, false);
});

for (const failureKind of ['failure', 'error']) {
test(`batch execution attributes Surefire ${failureKind} results without inventing failures`, async () => {
  const candidates = [{
    candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\ATmp1Test.java',
    qualifiedTestClassName: 'com.example.ATmp1Test'
  }, {
    candidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\BTmp1Test.java',
    qualifiedTestClassName: 'com.example.BTmp1Test'
  }];
  const artifacts = [{
    fileName: 'TEST-batch.xml',
    content: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuite name="batch" tests="2" failures="${failureKind === 'failure' ? 1 : 0}" errors="${failureKind === 'error' ? 1 : 0}" skipped="0">`,
      '  <testcase classname="com.example.ATmp1Test" name="passes"/>',
      '  <testcase classname="com.example.BTmp1Test" name="fails">',
      `    <${failureKind} type="java.lang.RuntimeException" message="failed">stack</${failureKind}>`,
      '  </testcase>',
      '</testsuite>'
    ].join('\n')
  }];
  const calls = [];
  const placements = [];
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile(...args) {
      calls.push(['compile', ...args]);
      return commandResult('compile', 0);
    },
    async runMavenGeneratedSurefireTest(...args) {
      calls.push(['test', ...args]);
      return commandResult('test', 1);
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\batch-attempt'; },
    async readAttemptArtifacts() { return artifacts; },
    async parseAttempt(_directory, qualifiedTestClassName) {
      const failed = qualifiedTestClassName === 'com.example.BTmp1Test';
      return {
        reportCount: 1,
        tests: 2,
        failures: failed && failureKind === 'failure' ? 1 : 0,
        errors: failed && failureKind === 'error' ? 1 : 0,
        skipped: 0,
        generatedTestClassName: qualifiedTestClassName,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: failed ? [{
          suiteName: 'batch',
          testClassName: qualifiedTestClassName,
          testName: 'fails',
          kind: failureKind,
          message: 'expected true',
          detail: 'stack'
        }] : []
      };
    }
  });

  const results = await executor.executeBatch({
    ...input(),
    candidates,
    placement: {
      async activate(items) {
        placements.push(['activate', items.map((item) => item.candidateId)]);
      },
      async isolate(items) {
        placements.push(['isolate', items.map((item) => item.candidateId)]);
      }
    }
  });

  assert.deepEqual(calls.map((call) => [call[0], call[3]]), [
    ['compile', ['com.example.ATmp1Test', 'com.example.BTmp1Test']],
    ['test', ['com.example.ATmp1Test', 'com.example.BTmp1Test']]
  ]);
  assert.equal(results.get(candidates[0].candidateId).status, 'passed');
  assert.equal(results.get(candidates[1].candidateId).status, 'test_failed');
  assert.equal(results.get(candidates[0].candidateId).testReport.failures, 0);
  assert.equal(results.get(candidates[1].candidateId).testReport.failures, failureKind === 'failure' ? 1 : 0);
  assert.equal(results.get(candidates[1].candidateId).testReport.errors, failureKind === 'error' ? 1 : 0);
  const trace = results.get(candidates[0].candidateId).trace;
  assert.strictEqual(trace, results.get(candidates[1].candidateId).trace);
  assert.equal(trace.mavenBatchId, input().attemptId);
  assert.equal(trace.moduleRoot, input().moduleRoot);
  assert.deepEqual(
    trace.candidates.map((candidate) => candidate.candidateId),
    candidates.map((candidate) => candidate.candidateId)
  );
  assert.deepEqual(trace.steps.map((step) => ({
    sequence: step.sequence,
    phase: step.phase,
    candidateIds: step.candidateIds,
    fallback: step.fallback
  })), [{
    sequence: 1,
    phase: 'test_compile',
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    fallback: 'NONE'
  }, {
    sequence: 2,
    phase: 'test',
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    fallback: 'NONE'
  }]);
  assert.equal(
    trace.steps[1].attribution.results[candidates[1].candidateId].status,
    'TEST_FAILED'
  );
  assert.deepEqual(trace.results, [{
    candidateId: candidates[0].candidateId,
    status: 'passed'
  }, {
    candidateId: candidates[1].candidateId,
    status: 'test_failed'
  }]);
  assert.deepEqual(placements, [
    ['activate', [candidates[0].candidateId, candidates[1].candidateId]],
    ['isolate', [candidates[1].candidateId]]
  ]);
});

}

test('an attributable compile blocker is isolated before the remaining candidates are reverified', async () => {
  const candidates = ['A', 'B', 'C'].map((name, index) => ({
    candidateId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
    filePath: `D:\\work\\manager-core\\src\\test\\java\\com\\example\\${name}Tmp1Test.java`,
    qualifiedTestClassName: `com.example.${name}Tmp1Test`
  }));
  const compileResults = [{
    ...commandResult('compile', 1),
    stderr: [
      '[ERROR] D:/work/manager-core/src/test/java/com/example/BTmp1Test.java:[17,9] cannot find symbol',
      '[ERROR]   symbol: method missing()'
    ].join('\n')
  }, commandResult('compile', 0)];
  const artifacts = [{
    fileName: 'TEST-remaining.xml',
    content: [
      '<testsuite name="remaining" tests="2" failures="0" errors="0" skipped="0">',
      '  <testcase classname="com.example.ATmp1Test" name="a"/>',
      '  <testcase classname="com.example.CTmp1Test" name="c"/>',
      '</testsuite>'
    ].join('\n')
  }];
  const calls = [];
  const placements = [];
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile(...args) {
      calls.push(['compile', ...args]);
      return compileResults.shift();
    },
    async runMavenGeneratedSurefireTest(...args) {
      calls.push(['test', ...args]);
      return commandResult('test', 0);
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\remaining'; },
    async readAttemptArtifacts() { return artifacts; },
    async parseAttempt(_directory, qualifiedTestClassName) {
      return {
        reportCount: 1,
        tests: 2,
        failures: 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName: qualifiedTestClassName,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: []
      };
    }
  });
  const placement = {
    async activate(items) {
      placements.push(['activate', items.map((item) => item.candidateId)]);
    },
    async isolate(items) {
      placements.push(['isolate', items.map((item) => item.candidateId)]);
    }
  };

  const results = await executor.executeBatch({
    ...input(),
    candidates,
    placement
  });

  assert.deepEqual(calls.map((call) => [call[0], call[3]]), [
    ['compile', candidates.map((candidate) => candidate.qualifiedTestClassName)],
    ['compile', [candidates[0].qualifiedTestClassName, candidates[2].qualifiedTestClassName]],
    ['test', [candidates[0].qualifiedTestClassName, candidates[2].qualifiedTestClassName]]
  ]);
  assert.equal(results.get(candidates[0].candidateId).status, 'passed');
  assert.equal(results.get(candidates[1].candidateId).status, 'compile_failed');
  assert.equal(results.get(candidates[2].candidateId).status, 'passed');
  assert.equal(results.get(candidates[0].candidateId).trace.steps[0].fallback,
    'ISOLATE_ATTRIBUTED_AND_RETRY');
  assert.deepEqual(placements, [
    ['activate', candidates.map((candidate) => candidate.candidateId)],
    ['isolate', [candidates[1].candidateId]]
  ]);
});

test('an ambiguous batch compile failure falls back to isolated candidates one by one', async () => {
  const candidates = [{
    candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\ATmp1Test.java',
    qualifiedTestClassName: 'com.example.ATmp1Test'
  }, {
    candidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\BTmp1Test.java',
    qualifiedTestClassName: 'com.example.BTmp1Test'
  }];
  const compileResults = [{
    ...commandResult('compile', 1),
    stderr: '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin'
  }, commandResult('compile', 0), {
    ...commandResult('compile', 1),
    stderr: '[ERROR] D:/work/manager-core/src/test/java/com/example/BTmp1Test.java:[9,5] incompatible types'
  }];
  const artifacts = [{
    fileName: 'TEST-a.xml',
    content: [
      '<testsuite name="a" tests="1" failures="0" errors="0" skipped="0">',
      '  <testcase classname="com.example.ATmp1Test" name="passes"/>',
      '</testsuite>'
    ].join('\n')
  }];
  const calls = [];
  const placements = [];
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile(...args) {
      calls.push(['compile', ...args]);
      return compileResults.shift();
    },
    async runMavenGeneratedSurefireTest(...args) {
      calls.push(['test', ...args]);
      return commandResult('test', 0);
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\fallback-a'; },
    async readAttemptArtifacts() { return artifacts; },
    async parseAttempt(_directory, qualifiedTestClassName) {
      return {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName: qualifiedTestClassName,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: []
      };
    }
  });
  const placement = {
    async activate(items) {
      placements.push(['activate', items.map((item) => item.candidateId)]);
    },
    async isolate(items) {
      placements.push(['isolate', items.map((item) => item.candidateId)]);
    }
  };

  const results = await executor.executeBatch({ ...input(), candidates, placement });

  assert.deepEqual(calls.map((call) => [call[0], call[3]]), [
    ['compile', candidates.map((candidate) => candidate.qualifiedTestClassName)],
    ['compile', [candidates[0].qualifiedTestClassName]],
    ['test', [candidates[0].qualifiedTestClassName]],
    ['compile', [candidates[1].qualifiedTestClassName]]
  ]);
  assert.equal(results.get(candidates[0].candidateId).status, 'passed');
  assert.equal(results.get(candidates[1].candidateId).status, 'compile_failed');
  const trace = results.get(candidates[0].candidateId).trace;
  assert.equal(trace.steps[0].fallback, 'INDIVIDUAL');
  assert.deepEqual(trace.steps.map((step) => step.candidateIds), [
    candidates.map((candidate) => candidate.candidateId),
    [candidates[0].candidateId],
    [candidates[0].candidateId],
    [candidates[1].candidateId]
  ]);
  assert.deepEqual(placements, [
    ['activate', candidates.map((candidate) => candidate.candidateId)],
    ['isolate', candidates.map((candidate) => candidate.candidateId)],
    ['activate', [candidates[0].candidateId]],
    ['activate', [candidates[1].candidateId]],
    ['isolate', [candidates[1].candidateId]]
  ]);
});

test('an explicitly named single-candidate fork crash is returned for model repair without XML', async () => {
  const candidate = {
    candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\ATmp1Test.java',
    qualifiedTestClassName: 'com.example.ATmp1Test'
  };
  const placements = [];
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile() {
      return commandResult('compile', 0);
    },
    async runMavenGeneratedSurefireTest() {
      return {
        ...commandResult('test', 1),
        stdout: [
          '[INFO] Running com.example.ATmp1Test',
          'java.lang.IllegalStateException: application terminated the test JVM',
          '\\tat com.example.ATmp1Test.startsApplication(ATmp1Test.java:23)',
          '[ERROR] The forked VM terminated without properly saying goodbye.',
          '[ERROR] Crashed tests:',
          '[ERROR] com.example.ATmp1Test'
        ].join('\n')
      };
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\fork-crash'; },
    async readAttemptArtifacts() { return []; },
    async parseAttempt() { throw new Error('no directed Surefire XML'); }
  });

  const results = await executor.executeBatch({
    ...input(),
    candidates: [candidate],
    placement: {
      async activate(items) {
        placements.push(['activate', items.map((item) => item.candidateId)]);
      },
      async isolate(items) {
        placements.push(['isolate', items.map((item) => item.candidateId)]);
      }
    }
  });

  const feedback = results.get(candidate.candidateId);
  assert.equal(feedback.status, 'test_failed');
  assert.equal(feedback.mavenExecutions.length, 2);
  assert.equal('testReport' in feedback, false);
  assert.equal(feedback.trace.steps[1].attribution.results[candidate.candidateId].status,
    'TEST_FAILED');
  assert.deepEqual(placements, [
    ['activate', [candidate.candidateId]],
    ['isolate', [candidate.candidateId]]
  ]);
});

test('an explicitly named generated-test timeout is returned for model repair without XML', async () => {
  const candidate = {
    candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\ATmp1Test.java',
    qualifiedTestClassName: 'com.example.ATmp1Test'
  };
  const placements = [];
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile() {
      return commandResult('compile', 0);
    },
    async runMavenGeneratedSurefireTest() {
      return {
        ...commandResult('test', 124),
        stderr: [
          '[ERROR] Generated test validation timed out after 120 seconds.',
          '[ERROR] Timed out tests:',
          '[ERROR] com.example.ATmp1Test'
        ].join('\n')
      };
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\timeout'; },
    async readAttemptArtifacts() { return []; },
    async parseAttempt() { throw new Error('no directed Surefire XML'); }
  });

  const results = await executor.executeBatch({
    ...input(),
    candidates: [candidate],
    placement: {
      async activate(items) {
        placements.push(['activate', items.map((item) => item.candidateId)]);
      },
      async isolate(items) {
        placements.push(['isolate', items.map((item) => item.candidateId)]);
      }
    }
  });

  const feedback = results.get(candidate.candidateId);
  assert.equal(feedback.status, 'test_failed');
  assert.equal(feedback.mavenExecutions[1].exitCode, 124);
  assert.equal(feedback.trace.steps[1].attribution.results[candidate.candidateId].status,
    'TEST_FAILED');
  assert.match(
    feedback.trace.steps[1].attribution.results[candidate.candidateId].diagnostic,
    /Timed out tests:/
  );
  assert.deepEqual(placements, [
    ['activate', [candidate.candidateId]],
    ['isolate', [candidate.candidateId]]
  ]);
});

test('a single-candidate Surefire OOM dump is returned for model repair without XML', async () => {
  const candidate = {
    candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\ATmp1Test.java',
    qualifiedTestClassName: 'com.example.ATmp1Test'
  };
  const placements = [];
  const dump = {
    fileName: '2026-09-18T11-03-20_195-jvmRun1.dump',
    content: [
      'java.lang.OutOfMemoryError: Java heap space',
      '\\tat com.example.TaskService.canWriteData(TaskService.java:1508)',
      '\\tat com.example.ATmp1Test.generatesUnboundedInput(ATmp1Test.java:789)'
    ].join('\n')
  };
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile() {
      return commandResult('compile', 0);
    },
    async runMavenGeneratedSurefireTest() {
      return {
        ...commandResult('test', 1),
        stdout: '[ERROR] Java heap space',
        stderr: ''
      };
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\oom-dump'; },
    async readAttemptArtifacts() { return [dump]; },
    async parseAttempt() { throw new Error('no directed Surefire XML'); }
  });

  const results = await executor.executeBatch({
    ...input(),
    candidates: [candidate],
    placement: {
      async activate(items) {
        placements.push(['activate', items.map((item) => item.candidateId)]);
      },
      async isolate(items) {
        placements.push(['isolate', items.map((item) => item.candidateId)]);
      }
    }
  });

  const feedback = results.get(candidate.candidateId);
  assert.equal(feedback.status, 'test_failed');
  assert.equal(feedback.testReport, undefined);
  assert.equal(feedback.mavenExecutions[1].surefireReports[0].fileName, dump.fileName);
  assert.equal(feedback.trace.steps[1].attribution.results[candidate.candidateId].status,
    'TEST_FAILED');
  assert.match(
    feedback.trace.steps[1].attribution.results[candidate.candidateId].diagnostic,
    /ATmp1Test\.generatesUnboundedInput/
  );
  assert.deepEqual(placements, [
    ['activate', [candidate.candidateId]],
    ['isolate', [candidate.candidateId]]
  ]);
});

test('an attributed fork crash is isolated before unproven batch siblings are reverified', async () => {
  const candidates = [{
    candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\ATmp1Test.java',
    qualifiedTestClassName: 'com.example.ATmp1Test'
  }, {
    candidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    filePath: 'D:\\work\\manager-core\\src\\test\\java\\com\\example\\BTmp1Test.java',
    qualifiedTestClassName: 'com.example.BTmp1Test'
  }];
  const testResults = [{
    ...commandResult('test', 1),
    stdout: [
      '[INFO] Running com.example.BTmp1Test',
      '\\tat com.example.BTmp1Test.startsApplication(BTmp1Test.java:23)',
      '[ERROR] Crashed tests:',
      '[ERROR] com.example.BTmp1Test'
    ].join('\n')
  }, commandResult('test', 0)];
  const artifactResults = [[], [{
    fileName: 'TEST-com.example.ATmp1Test.xml',
    content: [
      '<testsuite name="a" tests="1" failures="0" errors="0" skipped="0">',
      '  <testcase classname="com.example.ATmp1Test" name="passes"/>',
      '</testsuite>'
    ].join('\n')
  }]];
  const calls = [];
  const placements = [];
  const executor = new MavenCandidateExecutorService({
    async runMavenGeneratedTestCompile(...args) {
      calls.push(['compile', ...args]);
      return commandResult('compile', 0);
    },
    async runMavenGeneratedSurefireTest(...args) {
      calls.push(['test', ...args]);
      return testResults.shift();
    }
  }, {
    async prepareAttempt() { return 'D:\\work\\manager-core\\target\\fork-crash-batch'; },
    async readAttemptArtifacts() { return artifactResults.shift(); },
    async parseAttempt(_directory, qualifiedTestClassName) {
      if (qualifiedTestClassName === candidates[1].qualifiedTestClassName) {
        throw new Error('no directed Surefire XML for crashed candidate');
      }
      return {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName: qualifiedTestClassName,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: []
      };
    }
  });

  const results = await executor.executeBatch({
    ...input(),
    candidates,
    placement: {
      async activate(items) {
        placements.push(['activate', items.map((item) => item.candidateId)]);
      },
      async isolate(items) {
        placements.push(['isolate', items.map((item) => item.candidateId)]);
      }
    }
  });

  assert.deepEqual(calls.map((call) => [call[0], call[3]]), [
    ['compile', candidates.map((candidate) => candidate.qualifiedTestClassName)],
    ['test', candidates.map((candidate) => candidate.qualifiedTestClassName)],
    ['compile', [candidates[0].qualifiedTestClassName]],
    ['test', [candidates[0].qualifiedTestClassName]]
  ]);
  assert.equal(results.get(candidates[0].candidateId).status, 'passed');
  assert.equal(results.get(candidates[1].candidateId).status, 'test_failed');
  assert.equal(results.get(candidates[1].candidateId).testReport, undefined);
  assert.equal(results.get(candidates[0].candidateId).trace.steps[1].fallback,
    'ISOLATE_ATTRIBUTED_AND_RETRY');
  assert.deepEqual(placements, [
    ['activate', candidates.map((candidate) => candidate.candidateId)],
    ['isolate', [candidates[1].candidateId]]
  ]);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StableTestRepairService
} from '../src/main/services/stable-test-repair.service.ts';

function execution({
  status = 'test_failed',
  stdout = '',
  stderr = '',
  testClassName = 'com.example.TaskServiceTmp1Test',
  failures = []
} = {}) {
  const failed = failures.length;
  return {
    status,
    mavenExecutions: [{
      scope: 'pruned_method_candidate',
      phase: status === 'compile_failed' ? 'test_compile' : 'test',
      command: 'mvn.cmd -Dtest=com.example.TaskServiceTmp1Test test',
      exitCode: status === 'passed' ? 0 : 1,
      stdout,
      stderr,
      surefireReports: failures.filter(item => item.type === 'java.util.concurrent.TimeoutException')
        .map(item => ({ fileName: `TEST-${testClassName}.xml`,
          content: `<testsuite name="${testClassName}" tests="1" errors="1" failures="0" skipped="0">`
            + `<testcase classname="${item.testClassName ?? testClassName}" name="${item.testName}" time="120">`
            + `<error type="${item.type}" message="${item.message ?? ''}"/></testcase></testsuite>` }))
    }],
    ...(status === 'compile_failed' ? {} : {
      testReport: {
        reportCount: 1,
        tests: Math.max(1, failed),
        failures: failures.filter((item) => item.kind === 'failure').length,
        errors: failures.filter((item) => item.kind === 'error').length,
        skipped: 0,
        generatedTestClassName: testClassName,
        generatedTests: Math.max(1, failed),
        generatedSkipped: 0,
        failureDetails: failures
      }
    })
  };
}

function passed(testCount = 1) {
  return {
    ...execution({ status: 'passed' }),
    testReport: {
      reportCount: 1,
      tests: testCount,
      failures: 0,
      errors: 0,
      skipped: 0,
      generatedTestClassName: 'com.example.TaskServiceTmp1Test',
      generatedTests: testCount,
      generatedSkipped: 0,
      failureDetails: []
    }
  };
}

function compilableEmptyCandidate() {
  return {
    status: 'test_failed',
    mavenExecutions: [{
      scope: 'pruned_method_candidate',
      phase: 'test_compile',
      command: 'mvn.cmd test-compile',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }, {
      scope: 'pruned_method_candidate',
      phase: 'test',
      command: 'mvn.cmd -Dtest=com.example.TaskServiceTmp1Test surefire:test',
      exitCode: 0,
      stdout: '',
      stderr: '',
      surefireReports: []
    }]
  };
}

test('stable repair comments every currently failing test method in one pass and never calls a model', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test',
    '    void firstFails() { org.junit.jupiter.api.Assertions.assertTrue(false); }',
    '',
    '    @Test',
    '    void secondFails() { throw new IllegalStateException("failed"); }',
    '',
    '    @Test',
    '    void remainsActive() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const writes = [];
  const checkpoints = [];
  let mavenCalls = 0;
  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({
      failures: [{
        suiteName: 'TaskServiceTmp1Test',
        testClassName: 'com.example.TaskServiceTmp1Test',
        testName: 'firstFails',
        kind: 'error',
        message: 'expected true'
      }, {
        suiteName: 'TaskServiceTmp1Test',
        testClassName: 'com.example.TaskServiceTmp1Test',
        testName: 'secondFails',
        kind: 'error',
        type: 'java.lang.IllegalStateException',
        message: 'failed'
      }]
    }),
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { mavenCalls += 1; return passed(1); },
    async saveCheckpoint(state) { checkpoints.push(structuredClone(state)); }
  });

  assert.equal(result.status, 'passed');
  assert.equal(mavenCalls, 1);
  assert.equal(writes.length, 1);
  assert.equal(
    [...result.code.matchAll(/^\s*\/\/ TODO 当前测试方法需要修复\s*$/gm)].length,
    2
  );
  assert.match(result.code, /\/\/ TODO 当前测试方法需要修复\n\s*\/\/ @Test/);
  assert.match(result.code, /void remainsActive\(\)/);
  assert.equal(checkpoints.at(-1).phase, 'PASSED');
  assert.deepEqual(result.annotatedMemberIds.map((item) => item.split(':')[0]), [
    'test',
    'test'
  ]);
  assert.equal('model' in result, false);
});

for (const type of ['java.lang.OutOfMemoryError', 'java.lang.StackOverflowError', 'java.util.concurrent.TimeoutException']) {
test(`stable repair deletes only a proven timeout and preserves other fatal failures (${type})`, async () => {
  const code = 'package com.example;\nclass TaskServiceTmp1Test {\n'
    + '  @Test void unboundedPage() { while (true) {} }\n'
    + '  @Test void keepsWorking() { work(); }\n}\n';
  const writes = [];
  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: 'D:/work/TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({ failures: [{
      suiteName: 'com.example.TaskServiceTmp1Test',
      testClassName: 'com.example.TaskServiceTmp1Test',
      testName: 'unboundedPage', kind: 'error',
      type, message: type.endsWith('TimeoutException') ? 'unboundedPage() timed out after 120 seconds' : 'GC overhead limit exceeded'
    }] }),
    annotatedMemberIds: [],
    async replaceCandidate(next) { writes.push(next); },
    async executeMaven() { return passed(1); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'passed');
  assert.equal(writes.length, 1);
  if (type.endsWith('TimeoutException')) {
    assert.doesNotMatch(result.code, /unboundedPage|while \(true\)/);
  } else {
    assert.match(result.code, /\/\/ @Test void unboundedPage\(\) \{ while \(true\) \{\} \}/);
    assert.equal(result.annotatedMemberIds.length, 1);
  }
  assert.match(result.code, /@Test void keepsWorking\(\) \{ work\(\); \}/);
});
}

test('stable repair preserves source and execution evidence before deleting a newly timed-out method', async () => {
  const code = 'package com.example;\nclass TaskServiceTmp1Test {\n'
    + '  @Test void ordinaryFailure() { fail(); }\n'
    + '  @Test void laterTimeout() { while (true) {} }\n'
    + '  @Test void works() {}\n}\n';
  const events = [];
  const timeout = execution({ failures: [{ testClassName: 'com.example.TaskServiceTmp1Test',
    testName: 'laterTimeout', kind: 'error', type: 'java.util.concurrent.TimeoutException',
    message: 'laterTimeout() timed out after 120 seconds' }] });
  let executions = 0;
  const result = await new StableTestRepairService().repair({
    code, candidateFilePath: 'D:/work/TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({ failures: [{ testClassName: 'com.example.TaskServiceTmp1Test',
      testName: 'ordinaryFailure', kind: 'error', type: 'java.lang.IllegalStateException' }] }),
    annotatedMemberIds: [],
    async onDiscardAbnormalTests(methods, evidence) { events.push({ methods, evidence }); },
    async replaceCandidate(next) {
      if (!next.includes('void laterTimeout')) assert.equal(events.length, 1, 'audit precedes deletion');
    },
    async executeMaven() { return ++executions === 1 ? timeout : passed(1); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'passed');
  assert.equal(events.length, 1);
  assert.equal(events[0].methods[0].name, 'laterTimeout');
  assert.match(events[0].methods[0].code, /while \(true\)/);
  assert.equal(events[0].evidence, timeout);
  assert.doesNotMatch(result.code, /void laterTimeout/);
  assert.match(result.code, /@Test void works/);
});

test('stable repair audits each shared and test change with its current source and Maven failure before replacement', async () => {
  const code = 'package com.example;\nclass TaskServiceTmp1Test {\n'
    + '  private static final java.lang.reflect.Method UNUSED;\n'
    + '  @Test void failsLater() { fail(); }\n'
    + '  @Test void works() {}\n}\n';
  const path = 'D:/work/TaskServiceTmp1Test.java';
  const compileFailure = execution({ status: 'compile_failed',
    stdout: `[ERROR] ${path}:[3,49] variable UNUSED not initialized in the default constructor` });
  const testFailure = execution({ failures: [{ testClassName: 'com.example.TaskServiceTmp1Test',
    testName: 'failsLater', kind: 'error', type: 'java.lang.IllegalStateException', message: 'later failure' }] });
  const changes = [];
  const events = [];
  let calls = 0;
  const result = await new StableTestRepairService().repair({
    code, candidateFilePath: path, generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: compileFailure, annotatedMemberIds: [],
    async onBeforeRepairChange(change) { changes.push(change); events.push('audit'); },
    async replaceCandidate() {
      assert.equal(events.at(-1), 'audit', 'persist failure evidence before changing source');
      events.push('replace');
    },
    async executeMaven() { return ++calls === 1 ? testFailure : passed(1); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'passed');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map(change => change.phase), ['SHARED_MEMBERS', 'TEST_METHODS']);
  assert.deepEqual(changes.map(change => change.iteration), [1, 2]);
  assert.equal(changes[0].code, code);
  assert.equal(changes[0].execution, compileFailure);
  assert.equal(changes[1].code, changes[0].nextCode);
  assert.equal(changes[1].execution, testFailure, 'second prune must retain its fresh failure');
  assert.equal(changes[1].newMemberIds.length, 1);
  assert.match(changes[1].newMemberIds[0], /^test:failsLater:/);
  assert.equal(changes[1].annotatedMemberIds.length, 2);
});

test('stable repair keeps the original candidate when failure evidence cannot be saved', async () => {
  let replaced = false;
  let executed = false;
  await assert.rejects(new StableTestRepairService().repair({
    code: 'package com.example;\nclass TaskServiceTmp1Test {\n  @Test void broken() {}\n  @Test void works() {}\n}\n',
    candidateFilePath: 'D:/work/TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({ failures: [{ testClassName: 'com.example.TaskServiceTmp1Test',
      testName: 'broken', kind: 'error', type: 'java.lang.IllegalStateException' }] }),
    annotatedMemberIds: [],
    async onBeforeRepairChange() { throw new Error('failure audit could not be saved'); },
    async replaceCandidate() { replaced = true; },
    async executeMaven() { executed = true; return passed(1); },
    async saveCheckpoint() {}
  }), /failure audit could not be saved/);
  assert.equal(replaced, false);
  assert.equal(executed, false);
});

test('stable repair preserves callers when only their shared helper fails compilation', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test',
    '    void usesBrokenHelper() {',
    '        org.junit.jupiter.api.Assertions.assertEquals(1, brokenHelper());',
    '    }',
    '',
    '    @Test',
    '    void unrelated() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '',
    '    int brokenHelper() {',
    '        return missing;',
    '    }',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const compilerFailure = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[13,16] cannot find symbol\n[ERROR] symbol: variable missing`
  });
  const writes = [];
  const maven = [compilerFailure, passed(1)];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: compilerFailure,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return maven.shift(); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
  assert.deepEqual(result.annotatedMemberIds, []);
});

test('stable repair stops without commenting code when Maven evidence is external to the candidate', async () => {
  const code = [
    'package com.example;',
    'class TaskServiceTmp1Test {}',
    ''
  ].join('\n');
  let writes = 0;
  let mavenCalls = 0;

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({
      status: 'compile_failed',
      stderr: '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin'
    }),
    annotatedMemberIds: [],
    async replaceCandidate() { writes += 1; },
    async executeMaven() { mavenCalls += 1; return passed(0); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(result.code, code);
  assert.equal(writes, 0);
  assert.equal(mavenCalls, 0);
});

test('stable repair preserves tests when their shared field fails compilation', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    private MissingType brokenField;',
    '    @Test',
    '    void usesBrokenField() { org.junit.jupiter.api.Assertions.assertNull(brokenField); }',
    '    @Test',
    '    void unrelated() { org.junit.jupiter.api.Assertions.assertTrue(true); }',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const fieldFailure = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[4,13] cannot find symbol`
  });
  const writes = [];
  const maven = [fieldFailure, passed(1)];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: fieldFailure,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return maven.shift(); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
});

test('stable repair does not disable every test for a lifecycle compiler error', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.*;',
    'class TaskServiceTmp1Test {',
    '    private MissingType brokenField;',
    '    @BeforeEach',
    '    void brokenSetup() { missingSetup(); }',
    '    @Test',
    '    void first() {}',
    '    @Test',
    '    void second() {}',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const both = execution({
    status: 'compile_failed',
    stderr: [
      `[ERROR] ${filePath}:[4,13] cannot find symbol`,
      `[ERROR] ${filePath}:[6,26] cannot find symbol`
    ].join('\n')
  });
  const fieldOnly = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[4,13] cannot find symbol`
  });
  const writes = [];
  const maven = [both, fieldOnly, passed(0)];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: both,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return maven.shift(); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
});

test('stable repair does not disable every test for an initializer compiler error', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    {',
    '        missingSetup();',
    '    }',
    '    @Test void first() {}',
    '    @Test void second() {}',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const initializerFailure = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[5,9] cannot find symbol`
  });
  const writes = [];
  const maven = [initializerFailure, passed(0)];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: initializerFailure,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return maven.shift(); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
});

test('stable repair preserves tests when their nested fixture fails compilation', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test void usesFixture() { new Fixture(); }',
    '    @Test void unrelated() {}',
    '    static class Fixture {',
    '        MissingType value;',
    '    }',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const nestedTypeFailure = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[7,9] cannot find symbol`
  });
  const writes = [];
  const maven = [nestedTypeFailure, passed(1)];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: nestedTypeFailure,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return maven.shift(); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
});

test('candidate-local unmapped compiler evidence preserves tests and blocks instead of guessing', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test void first() {}',
    '    @Test void second() {}',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const unmapped = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[3,1] invalid generated class declaration`
  });
  const writes = [];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: unmapped,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return passed(0); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(result.blockedScope, 'candidate');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
});

test('mixed candidate and external compiler errors remain a project blocker', async () => {
  const filePath = 'D:/work/TaskServiceTmp1Test.java';
  const code = 'package com.example; class TaskServiceTmp1Test {}';
  const result = await new StableTestRepairService().repair({
    code, candidateFilePath: filePath, generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({ status: 'compile_failed', stderr:
      `[ERROR] ${filePath}:[1,1] invalid declaration\n[ERROR] D:/work/UserTest.java:[3,1] cannot find symbol` }),
    annotatedMemberIds: [],
    async replaceCandidate() { assert.fail('External errors must preserve the candidate'); },
    async executeMaven() { assert.fail('Cannot repair an external file'); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'external_project_blocked');
  assert.equal(result.blockedScope, 'project');
});

test('stable repair preserves a field used by setup instead of cascading to all tests', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.*;',
    'class TaskServiceTmp1Test {',
    '    private MissingType reportUnitDAO;',
    '    @BeforeEach void setup() { install(reportUnitDAO); }',
    '    @Test void first() {}',
    '    @Test void second() {}',
    '    void install(Object value) {}',
    '}'
  ].join('\n');
  const filePath = 'D:/work/TaskServiceTmp1Test.java';
  const writes = [];
  const result = await new StableTestRepairService().repair({
    code, candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({status: 'compile_failed',
      stderr: `[ERROR] ${filePath}:[4,13] cannot find symbol`}),
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return passed(2); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'external_project_blocked');
  assert.equal(result.code, code);
  assert.equal(writes.length, 0);
});

test('stable repair keeps the target call and only comments a located ordinary assertion', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test void verifiesExport() {',
    '        target();',
    '        org.junit.jupiter.api.Assertions.assertTrue(false);',
    '    }',
    '    void target() {}',
    '}',
    ''
  ].join('\n');
  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: 'D:/work/TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({failures: [{
      suiteName: 'TaskServiceTmp1Test', testClassName: 'com.example.TaskServiceTmp1Test',
      testName: 'verifiesExport', kind: 'failure', type: 'org.opentest4j.AssertionFailedError',
      detail: 'at com.example.TaskServiceTmp1Test.verifiesExport(TaskServiceTmp1Test.java:6)'
    }]}),
    annotatedMemberIds: [],
    async replaceCandidate() {},
    async executeMaven() { return passed(1); },
    async saveCheckpoint() {}
  });
  assert.match(result.code, /^    @Test void verifiesExport/m);
  assert.match(result.code, /^        target\(\);/m);
  assert.match(result.code, /\/\/ .*assertTrue\(false\)/);
  assert.doesNotMatch(result.code, /TODO 当前测试方法需要修复/);
});

test('stable repair retains a compilable empty class when Surefire emits no XML', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test void broken() { throw new IllegalStateException("failed"); }',
    '}',
    ''
  ].join('\n');
  const writes = [];
  const checkpoints = [];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({
      failures: [{
        suiteName: 'TaskServiceTmp1Test',
        testClassName: 'com.example.TaskServiceTmp1Test',
        testName: 'broken',
        kind: 'error',
        type: 'java.lang.IllegalStateException',
        message: 'failed'
      }]
    }),
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return compilableEmptyCandidate(); },
    async saveCheckpoint(value) { checkpoints.push(structuredClone(value)); }
  });

  assert.equal(result.status, 'retained_empty');
  assert.equal(writes.length, 1);
  assert.match(result.code, /\/\/ TODO 当前测试方法需要修复/);
  assert.equal(result.execution.status, 'test_failed');
  assert.equal(checkpoints.at(-1).phase, 'PASSED');
});

test('empty compiled candidates finish when Surefire emits only a nonfatal dumpstream warning', async () => {
  const feedback = compilableEmptyCandidate();
  feedback.mavenExecutions[1].surefireReports = [{
    fileName: '2026-10-01T18-34-32_951.dumpstream',
    content: "Boot Manifest-JAR contains absolute paths in classpath\n'other' has different root"
  }];
  const result = await new StableTestRepairService().repair({
    code: 'package com.example; class TaskServiceTmp1Test {}',
    candidateFilePath: 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: feedback,
    annotatedMemberIds: [],
    async replaceCandidate() { assert.fail('An empty compiled candidate needs no source edits.'); },
    async executeMaven() { assert.fail('Successful Maven evidence needs no retry.'); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'retained_empty');
  assert.equal(result.phase, 'PASSED');
  assert.equal(result.execution.mavenExecutions[1].surefireReports.length, 1);
});

test('empty candidates cannot hide a failed Maven process behind a dumpstream warning', async () => {
  const feedback = compilableEmptyCandidate();
  feedback.mavenExecutions[1].exitCode = 1;
  feedback.mavenExecutions[1].surefireReports = [{
    fileName: 'fork.dumpstream', content: 'Forked VM terminated unexpectedly.'
  }];
  const result = await new StableTestRepairService().repair({
    code: 'package com.example; class TaskServiceTmp1Test {}',
    candidateFilePath: 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: feedback, annotatedMemberIds: [],
    async replaceCandidate() { assert.fail('External failures must preserve source.'); },
    async executeMaven() { assert.fail('External failures must stop.'); },
    async saveCheckpoint() {}
  });
  assert.equal(result.status, 'external_project_blocked');
});

test('unmapped class residue does not justify commenting a test or replacing the whole class', async () => {
  const code = [
    'package com.example;',
    'class TaskServiceTmp1Test {',
    '    @org.junit.jupiter.api.Test',
    '    void broken() {}',
    '    <<< invalid generated residue >>>',
    '}',
    ''
  ].join('\n');
  const filePath = 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java';
  const candidateFailure = execution({
    status: 'compile_failed',
    stderr: `[ERROR] ${filePath}:[5,5] illegal start of type`
  });
  const writes = [];
  const maven = [candidateFailure, compilableEmptyCandidate()];

  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: filePath,
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: candidateFailure,
    annotatedMemberIds: [],
    async replaceCandidate(nextCode) { writes.push(nextCode); },
    async executeMaven() { return maven.shift(); },
    async saveCheckpoint() {}
  });

  assert.equal(result.status, 'external_project_blocked');
  assert.equal(writes.length, 0);
  assert.equal(result.code, code);
});

test('stable repair resumes its persisted iteration monotonically', async () => {
  const code = [
    'package com.example;',
    'import org.junit.jupiter.api.Test;',
    'class TaskServiceTmp1Test {',
    '    @Test void broken() {}',
    '}',
    ''
  ].join('\n');
  const checkpoints = [];
  const result = await new StableTestRepairService().repair({
    code,
    candidateFilePath: 'D:\\work\\module\\src\\test\\java\\com\\example\\TaskServiceTmp1Test.java',
    generatedTestClassName: 'com.example.TaskServiceTmp1Test',
    initialExecution: execution({
      failures: [{
        suiteName: 'TaskServiceTmp1Test',
        testClassName: 'com.example.TaskServiceTmp1Test',
        testName: 'broken',
        kind: 'failure',
        message: 'failed'
      }]
    }),
    annotatedMemberIds: ['test:already-commented:1'],
    initialIteration: 7,
    async replaceCandidate() {},
    async executeMaven() { return passed(0); },
    async saveCheckpoint(value) { checkpoints.push(value); }
  });

  assert.equal(result.iteration, 8);
  assert.equal(checkpoints[0].iteration, 8);
  assert.equal(checkpoints.at(-1).iteration, 8);
});

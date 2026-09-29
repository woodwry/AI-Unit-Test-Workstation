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
      surefireReports: []
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
        kind: 'failure',
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

test('stable repair comments dependent tests before a failing shared helper', async () => {
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

  assert.equal(result.status, 'passed');
  assert.equal(writes.length, 2);
  assert.match(writes[0], /\/\/ TODO 当前测试方法需要修复[\s\S]*\/\/ void usesBrokenHelper/);
  assert.match(writes[0], /int brokenHelper\(\)/);
  assert.match(writes[1], /\/\/\s+int brokenHelper\(\)/);
  assert.deepEqual(result.annotatedMemberIds.map((item) => item.split(':')[0]), [
    'test',
    'method'
  ]);
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

test('stable repair comments field-dependent tests before the failing field', async () => {
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

  assert.equal(result.status, 'passed');
  assert.equal(writes.length, 2);
  assert.match(writes[0], /TODO 当前测试方法需要修复[\s\S]*\/\/ void usesBrokenField/);
  assert.match(writes[0], /private MissingType brokenField;/);
  assert.match(writes[1], /\/\/\s+private MissingType brokenField;/);
});

test('stable repair processes lifecycle before fields even when Maven lists the field first', async () => {
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

  assert.equal(result.status, 'passed');
  assert.equal(writes.length, 3);
  assert.equal((writes[0].match(/TODO 当前测试方法需要修复/g) ?? []).length, 2);
  assert.match(writes[0], /void brokenSetup\(\)/);
  assert.match(writes[1], /\/\/\s+void brokenSetup\(\)/);
  assert.match(writes[1], /private MissingType brokenField;/);
  assert.match(writes[2], /\/\/\s+private MissingType brokenField;/);
});

test('stable repair comments dependent tests before a failing instance initializer', async () => {
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

  assert.equal(result.status, 'passed');
  assert.equal(writes.length, 2);
  assert.equal((writes[0].match(/TODO 当前测试方法需要修复/g) ?? []).length, 2);
  assert.match(writes[0], /^\s*\{\s*$/m);
  assert.match(writes[1], /^\s*\/\/ \{\s*$/m);
  assert.ok(result.annotatedMemberIds.some((id) => id.startsWith('initializer:')));
});

test('stable repair comments callers before a failing nested support type', async () => {
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

  assert.equal(result.status, 'passed');
  assert.equal(writes.length, 2);
  assert.match(writes[0], /TODO 当前测试方法需要修复[\s\S]*\/\/\s*@Test void usesFixture/);
  assert.match(writes[0], /^\s*@Test void unrelated\(\)/m);
  assert.match(writes[0], /^\s*static class Fixture/m);
  assert.match(writes[1], /^\s*\/\/ static class Fixture/m);
  assert.ok(result.annotatedMemberIds.some((id) => id.startsWith('nested_type:')));
});

test('candidate-local unmapped compiler evidence comments all remaining tests before blocking', async () => {
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

  assert.equal(result.status, 'passed');
  assert.equal((writes[0].match(/TODO 当前测试方法需要修复/g) ?? []).length, 2);
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

test('candidate-local unmapped residue is preserved as comments beside a compilable empty class', async () => {
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

  assert.equal(result.status, 'retained_empty');
  assert.equal(writes.length, 2);
  assert.match(result.code, /^\s*\/\/ <<< invalid generated residue >>>$/m);
  assert.match(result.code, /class TaskServiceTmp1Test \{\r?\n\}\s*$/);
  assert.ok(result.annotatedMemberIds.some((id) => id.startsWith('empty_class:')));
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

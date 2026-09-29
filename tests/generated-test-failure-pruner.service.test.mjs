import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GeneratedTestFailurePrunerService
} from '../src/main/services/generated-test-failure-pruner.service.ts';
import {
  JavaTestStructureService
} from '../src/main/services/java-test-structure.service.ts';

const candidatePath =
  'D:\\work\\manager-core\\src\\test\\java\\com\\example\\TaskServicePublicTmpTest.java';

const candidateCode = [
  'package com.example;',
  '',
  'import org.junit.jupiter.api.Test;',
  'import org.junit.jupiter.params.ParameterizedTest;',
  'import org.junit.jupiter.params.provider.ValueSource;',
  '',
  'public class TaskServicePublicTmpTest {',
  '    @Test',
  '    void passingScenario() {',
  '        String value = "} // not a brace";',
  '    }',
  '',
  '    @Test',
  '    void failingRuntimeScenario() {',
  '        throw new IllegalStateException("boom");',
  '    }',
  '',
  '    @ParameterizedTest',
  '    @ValueSource(strings = {"a", "b"})',
  '    void failingCompileScenario(String value) {',
  '        MissingType missing = null;',
  '    }',
  '',
  '    private String helper() {',
  '        return """',
  '            { "value": "}" }',
  '            """;',
  '    }',
  '}',
  ''
].join('\n');

function mavenExecution(phase, exitCode, output = '') {
  return {
    scope: 'method_candidate',
    phase,
    command: phase === 'test_compile'
      ? 'mvn test-compile'
      : 'mvn -Dtest=TaskServicePublicTmpTest surefire:test',
    exitCode,
    stdout: output,
    stderr: '',
    surefireReports: []
  };
}

test('同时依据 Surefire 唯一测试名和 javac 精确行号注释失败方法', () => {
  const pruner = new GeneratedTestFailurePrunerService();
  const compilerOutput = [
    '[ERROR] COMPILATION ERROR :',
    `[ERROR] ${candidatePath}:[21,9] cannot find symbol`
  ].join('\n');

  const result = pruner.prune({
    code: candidateCode,
    candidateFilePath: candidatePath,
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 3,
        failures: 1,
        errors: 0,
        skipped: 0,
        generatedTestClassName:
          'com.example.TaskServicePublicTmpTest',
        generatedTests: 3,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'com.example.TaskServicePublicTmpTest',
          testClassName: 'com.example.TaskServicePublicTmpTest',
          testName: 'failingRuntimeScenario',
          kind: 'error'
        }]
      }
    },
    additionalMavenOutput: compilerOutput
  });

  assert.deepEqual(result.commentedMethods, [
    'failingRuntimeScenario',
    'failingCompileScenario'
  ]);
  assert.deepEqual(activeTestNames(result.code), ['passingScenario']);
  assert.match(result.code, /void passingScenario\(\)/);
  assert.match(result.code, /private String helper\(\)/);
  assert.equal(countRepairTodos(result.code), 2);
  assert.match(result.code, /\/\/ @Test\r?\n\s*\/\/ void failingRuntimeScenario\(\) \{/);
  assert.match(result.code, /\/\/ @ParameterizedTest\r?\n\s*\/\/ @ValueSource\(strings = \{"a", "b"\}\)\r?\n\s*\/\/ void failingCompileScenario\(String value\) \{/);
  assert.match(result.code, /public class TaskServicePublicTmpTest/);
});

test('Windows Maven 的 /D:/ 路径能够归属到 D:\\ 候选文件并注释对应测试方法', () => {
  const compilerOutput = [
    '[ERROR] COMPILATION ERROR :',
    '[ERROR] /D:/work/manager-core/src/test/java/com/example/TaskServicePublicTmpTest.java:[21,9] cannot find symbol'
  ].join('\n');

  const result = new GeneratedTestFailurePrunerService().prune({
    code: candidateCode,
    candidateFilePath: candidatePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution('test_compile', 1, compilerOutput)]
    }
  });

  assert.deepEqual(result.commentedMethods, ['failingCompileScenario']);
  assert.deepEqual(activeTestNames(result.code), [
    'passingScenario',
    'failingRuntimeScenario'
  ]);
  assert.equal(countRepairTodos(result.code), 1);
});

test('最后一轮编译错误命中无效 import 时注释使用它的测试并保留 import 原文', () => {
  const filePath =
    'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp22Test.java';
  const lines = [
    'package demo;',
    '',
    'import wrong.package.ReportUnit;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp22Test {',
    '    @Test',
    '    void failingScenario() {',
    '        ReportUnit reportUnit = new ReportUnit();',
    '    }',
    '',
    '    @Test',
    '    void passingScenario() {',
    '        String value = "ok";',
    '    }',
    '}',
    ''
  ];
  const code = lines.join('\n');
  const importLine = lines.findIndex((line) => (
    line === 'import wrong.package.ReportUnit;'
  )) + 1;

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution(
        'test_compile',
        1,
        `[ERROR] /D:/work/module/src/test/java/demo/TaskServiceTmp22Test.java:[${importLine},33] cannot find symbol`
      )]
    }
  });

  assert.deepEqual(result.commentedMethods, ['failingScenario']);
  assert.deepEqual(activeTestNames(result.code), ['passingScenario']);
  assert.equal(countRepairTodos(result.code), 1);
  assert.match(result.code, /^\/\/ import wrong\.package\.ReportUnit;$/m);
  assert.match(result.code, /^import org\.junit\.jupiter\.api\.Test;$/m);
  assert.match(result.code, /\/\/ void failingScenario\(\) \{/);
  assert.match(result.code, /^\s*void passingScenario\(\) \{/m);
});

test('参数化 Surefire 展示名只能删除唯一匹配的测试方法', () => {
  const pruner = new GeneratedTestFailurePrunerService();

  const result = pruner.prune({
    code: candidateCode,
    candidateFilePath: candidatePath,
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 2,
        failures: 1,
        errors: 0,
        skipped: 0,
        generatedTestClassName:
          'com.example.TaskServicePublicTmpTest',
        generatedTests: 2,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'com.example.TaskServicePublicTmpTest',
          testClassName: 'com.example.TaskServicePublicTmpTest',
          testName: 'failingCompileScenario(String)[2]',
          kind: 'error'
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, ['failingCompileScenario']);
  assert.deepEqual(activeTestNames(result.code), [
    'passingScenario',
    'failingRuntimeScenario'
  ]);
  assert.equal(countRepairTodos(result.code), 1);
  assert.match(result.code, /\/\/ void failingCompileScenario\(String value\) \{/);
  assert.match(result.code, /failingRuntimeScenario/);
});

test('无法唯一映射到候选文件和测试方法时完整代码保持不变', () => {
  const pruner = new GeneratedTestFailurePrunerService();
  const unrelatedPath =
    'D:\\work\\manager-core\\src\\test\\java\\com\\example\\OtherTest.java';

  const result = pruner.prune({
    code: candidateCode,
    candidateFilePath: candidatePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [
        mavenExecution(
          'test_compile',
          1,
          `[ERROR] ${unrelatedPath}:[21,9] cannot find symbol`
        )
      ]
    }
  });

  assert.deepEqual(result.commentedMethods, []);
  assert.equal(result.code, candidateCode);
});

test('最后一轮无法归因时不猜测失败方法并保持完整源码不变', () => {
  const result = new GeneratedTestFailurePrunerService().prune({
    code: candidateCode,
    candidateFilePath: candidatePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution(
        'test_compile',
        1,
        '[ERROR] compilation failed without a candidate source location'
      )]
    },
    commentAllWhenUnattributable: true
  });

  assert.deepEqual(result.commentedMethods, []);
  assert.deepEqual(activeTestNames(result.code), [
    'passingScenario',
    'failingRuntimeScenario',
    'failingCompileScenario'
  ]);
  assert.equal(countRepairTodos(result.code), 0);
  assert.equal(result.code, candidateCode);
});

test('最后一轮注释未修复测试方法时完整保留原有 import 及顺序', () => {
  const code = [
    'package demo;',
    '',
    'import demo.FailureOnlyType;',
    'import static org.junit.jupiter.api.Assertions.assertNotNull;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Test',
    '    void unresolvedRuntimeFailure() {',
    '        FailureOnlyType value = null;',
    '        assertNotNull(value);',
    '    }',
    '}',
    ''
  ].join('\n');

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath:
      'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java',
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        generatedTestClassName: 'demo.TaskServiceTmp1Test',
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'demo.TaskServiceTmp1Test',
          testClassName: 'demo.TaskServiceTmp1Test',
          testName: 'unresolvedRuntimeFailure',
          kind: 'error',
          type: 'java.lang.IllegalStateException'
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, ['unresolvedRuntimeFailure']);
  assert.equal(importBlock(result.code), importBlock(code));
  assert.equal(countRepairTodos(result.code), 1);
  assert.match(result.code, /\/\/ void unresolvedRuntimeFailure\(\) \{/);
});

test('最后一轮只有断言失败时仅注释断言且不添加 TODO', () => {
  const lines = [
    'package demo;',
    '',
    'import static org.junit.jupiter.api.Assertions.assertEquals;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Test',
    '    void assertionFailure() {',
    '        int actual = 1;',
    '        assertEquals(',
    '            2,',
    '            actual',
    '        );',
    '    }',
    '}',
    ''
  ];
  const code = lines.join('\n');
  const assertionLine = lines.findIndex((line) => line.includes('assertEquals(')) + 1;
  const detail = [
    'org.opentest4j.AssertionFailedError: expected: <2> but was: <1>',
    `    at demo.TaskServiceTmp1Test.assertionFailure(TaskServiceTmp1Test.java:${assertionLine})`
  ].join('\n');

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath:
      'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java',
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 1,
        errors: 0,
        skipped: 0,
        generatedTestClassName: 'demo.TaskServiceTmp1Test',
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'demo.TaskServiceTmp1Test',
          testClassName: 'demo.TaskServiceTmp1Test',
          testName: 'assertionFailure',
          kind: 'failure',
          type: 'org.opentest4j.AssertionFailedError',
          message: 'expected: <2> but was: <1>',
          detail
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, []);
  assert.deepEqual(activeTestNames(result.code), ['assertionFailure']);
  assert.equal(countRepairTodos(result.code), 0);
  assert.equal(importBlock(result.code), importBlock(code));
  assert.match(result.code, /^\s*\/\/ assertEquals\($/m);
  assert.match(result.code, /^\s*\/\/ 2,$/m);
  assert.match(result.code, /^\s*\/\/ actual$/m);
  assert.match(result.code, /^\s*\/\/ \);$/m);
  assert.doesNotMatch(result.code, /^\s*assertEquals\($/m);
});

test('即使所有测试方法都被精确定位，仍保留分类文件的类与辅助结构', () => {
  const code = [
    'package com.example;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class OneTest {',
    '    @Test',
    '    void onlyFailure() {',
    '        throw new RuntimeException();',
    '    }',
    '',
    '    private Object helper = new Object();',
    '}',
    ''
  ].join('\n');
  const pruner = new GeneratedTestFailurePrunerService();

  const result = pruner.prune({
    code,
    candidateFilePath:
      'D:\\work\\manager-core\\src\\test\\java\\com\\example\\OneTest.java',
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 1,
        errors: 0,
        skipped: 0,
        generatedTestClassName: 'com.example.OneTest',
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'com.example.OneTest',
          testClassName: 'com.example.OneTest',
          testName: 'onlyFailure',
          kind: 'error'
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, ['onlyFailure']);
  assert.deepEqual(activeTestNames(result.code), []);
  assert.equal(countRepairTodos(result.code), 1);
  assert.match(result.code, /public class OneTest/);
  assert.match(result.code, /private Object helper/);
  assert.match(result.code, /\/\/ void onlyFailure\(\) \{/);
  assert.notEqual(result.code.trim(), '');
});

test('compiler failure in a helper comments only its calling test and preserves all support members', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const code = [
    'package demo;',
    '',
    'import demo.MissingType;',
    'import demo.SharedType;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private MissingType failureOnlyField;',
    '',
    '    @Test',
    '    void passingScenario() {',
    '        sharedHelper();',
    '    }',
    '',
    '    @Test',
    '    void failingScenario() {',
    '        brokenHelper();',
    '    }',
    '',
    '    private void brokenHelper() {',
    '        MissingType value = failureOnlyField;',
    '    }',
    '',
    '    private void sharedHelper() {',
    '        SharedType value = null;',
    '    }',
    '}',
    ''
  ].join('\n');
  const brokenLine = code.split('\n').findIndex((line) => (
    line.includes('MissingType value = failureOnlyField')
  )) + 1;

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution(
        'test_compile',
        1,
        `[ERROR] ${filePath}:[${brokenLine},9] cannot find symbol`
      )]
    }
  });

  assert.deepEqual(result.commentedMethods, ['failingScenario']);
  assert.deepEqual(activeTestNames(result.code), ['passingScenario']);
  assert.equal(countRepairTodos(result.code), 1);
  assert.match(result.code, /void passingScenario\(\)/);
  assert.match(result.code, /void sharedHelper\(\)/);
  assert.match(result.code, /import demo\.SharedType;/);
  assert.match(result.code, /\/\/ void failingScenario\(\) \{/);
  assert.match(result.code, /private void brokenHelper/);
  assert.match(result.code, /private MissingType failureOnlyField/);
  assert.match(result.code, /import demo\.MissingType;/);
});

test('Mockito unnecessary stubbing comments only the reported statement and keeps the test active', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const lines = [
    'package demo;',
    '',
    'import static org.mockito.Mockito.when;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private Dependency dependency;',
    '',
    '    @Test',
    '    void getChildZipFile_P01() {',
    '        Task task = newTask();',
    '        when(dependency.load()).thenReturn("unused");',
    '        task.run();',
    '    }',
    '',
    '    private Task newTask() {',
    '        return new Task();',
    '    }',
    '}',
    ''
  ];
  const code = lines.join('\n');
  const stubbingLine = lines.findIndex((line) => line.includes('when(dependency')) + 1;
  const detail = [
    'org.mockito.exceptions.misusing.UnnecessaryStubbingException:',
    'Following stubbings are unnecessary:',
    `  1. -> at demo.TaskServiceTmp1Test.getChildZipFile_P01(TaskServiceTmp1Test.java:${stubbingLine})`
  ].join('\n');

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        generatedTestClassName: 'demo.TaskServiceTmp1Test',
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'demo.TaskServiceTmp1Test',
          testClassName: 'demo.TaskServiceTmp1Test',
          testName: 'getChildZipFile_P01',
          kind: 'error',
          type: 'org.mockito.exceptions.misusing.UnnecessaryStubbingException',
          detail
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, []);
  assert.deepEqual(activeTestNames(result.code), ['getChildZipFile_P01']);
  assert.equal(countRepairTodos(result.code), 0);
  assert.equal(importBlock(result.code), importBlock(code));
  assert.match(result.code, /^\s*\/\/ when\(dependency\.load\(\)\)\.thenReturn\("unused"\);$/m);
  assert.match(result.code, /private Task newTask\(\)/);
  assert.match(result.code, /^\s*task\.run\(\);$/m);
});

test('Mockito unnecessary stubbing comments every reported statement in one prune pass', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const lines = [
    'package demo;',
    '',
    'import static org.mockito.Mockito.when;',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    private Dependency dependency;',
    '',
    '    @Test',
    '    void getChildZipFile_P01() {',
    '        when(dependency.load()).thenReturn("unused");',
    '        when(dependency.size()).thenReturn(2);',
    '        dependency.run();',
    '    }',
    '}',
    ''
  ];
  const code = lines.join('\n');
  const firstLine = lines.findIndex((line) => line.includes('dependency.load')) + 1;
  const secondLine = lines.findIndex((line) => line.includes('dependency.size')) + 1;
  const detail = [
    'org.mockito.exceptions.misusing.UnnecessaryStubbingException:',
    'Following stubbings are unnecessary:',
    `  1. -> at demo.TaskServiceTmp1Test.getChildZipFile_P01(TaskServiceTmp1Test.java:${firstLine})`,
    `  2. -> at demo.TaskServiceTmp1Test.getChildZipFile_P01(TaskServiceTmp1Test.java:${secondLine})`
  ].join('\n');

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        generatedTestClassName: 'demo.TaskServiceTmp1Test',
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'demo.TaskServiceTmp1Test',
          testClassName: 'demo.TaskServiceTmp1Test',
          testName: 'getChildZipFile_P01',
          kind: 'error',
          type: 'org.mockito.exceptions.misusing.UnnecessaryStubbingException',
          detail
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, []);
  assert.deepEqual(activeTestNames(result.code), ['getChildZipFile_P01']);
  assert.match(result.code, /^\s*\/\/ when\(dependency\.load\(\)\)\.thenReturn\("unused"\);$/m);
  assert.match(result.code, /^\s*\/\/ when\(dependency\.size\(\)\)\.thenReturn\(2\);$/m);
  assert.match(result.code, /^\s*dependency\.run\(\);$/m);
});

test('compiler failure in support shared by two tests comments every caller but preserves support source', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const code = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '    @Test void firstScenario() { sharedBrokenHelper(); }',
    '    @Test void secondScenario() { sharedBrokenHelper(); }',
    '    private void sharedBrokenHelper() {',
    '        MissingType value = null;',
    '    }',
    '}',
    ''
  ].join('\n');
  const helperLine = code.split('\n').findIndex((line) => (
    line.includes('MissingType value')
  )) + 1;

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution(
        'test_compile',
        1,
        `[ERROR] ${filePath}:[${helperLine},48] cannot find symbol`
      )]
    }
  });

  assert.deepEqual(result.commentedMethods, ['firstScenario', 'secondScenario']);
  assert.deepEqual(activeTestNames(result.code), []);
  assert.equal(countRepairTodos(result.code), 2);
  assert.match(result.code, /private void sharedBrokenHelper\(\)/);
  assert.match(result.code, /^\s*MissingType value = null;$/m);
  assert.doesNotMatch(result.code, /^\s*\/\/ MissingType value = null;$/m);
});

test('compiler failure reached through nested helpers comments only the failed test method', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const code = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '    @Test void failingScenario() throws Exception { injectMock(); }',
    '    private void injectMock() throws Exception { findField(); }',
    '    private void findField() throws java.lang.reflect.NoSuchFieldException {}',
    '}',
    ''
  ].join('\n');
  const helperLine = code.split('\n').findIndex((line) => (
    line.includes('java.lang.reflect.NoSuchFieldException')
  )) + 1;

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution(
        'test_compile',
        1,
        `[ERROR] ${filePath}:[${helperLine},41] cannot find symbol`
      )]
    }
  });

  assert.deepEqual(result.commentedMethods, ['failingScenario']);
  assert.deepEqual(activeTestNames(result.code), []);
  assert.match(result.code, /\/\/ @Test void failingScenario\(\) throws Exception/);
  assert.match(result.code, /^\s*private void injectMock\(\) throws Exception \{ findField\(\); \}$/m);
  assert.match(
    result.code,
    /^\s*private void findField\(\) throws java\.lang\.reflect\.NoSuchFieldException \{\}$/m
  );
  assert.doesNotMatch(result.code, /\/\/ private void (?:injectMock|findField)/);
});

test('keeps a multi-variable field declaration when a surviving test still uses one variable', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const code = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '    private Object sharedValue, failureOnlyValue;',
    '    @Test void passingScenario() { sharedValue.toString(); }',
    '    @Test void failingScenario() { failureOnlyValue.toString(); }',
    '}',
    ''
  ].join('\n');

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'test_failed',
      mavenExecutions: [
        mavenExecution('test_compile', 0),
        mavenExecution('test', 1)
      ],
      testReport: {
        reportCount: 1,
        tests: 2,
        failures: 1,
        errors: 0,
        skipped: 0,
        generatedTestClassName: 'demo.TaskServiceTmp1Test',
        generatedTests: 2,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: 'demo.TaskServiceTmp1Test',
          testClassName: 'demo.TaskServiceTmp1Test',
          testName: 'failingScenario',
          kind: 'error'
        }]
      }
    }
  });

  assert.deepEqual(result.commentedMethods, ['failingScenario']);
  assert.deepEqual(activeTestNames(result.code), ['passingScenario']);
  assert.equal(countRepairTodos(result.code), 1);
  assert.match(result.code, /private Object sharedValue, failureOnlyValue;/);
  assert.match(result.code, /void passingScenario\(\)/);
});

test('does not attribute an overloaded helper compiler error from name-only calls', () => {
  const filePath = 'D:\\work\\module\\src\\test\\java\\demo\\TaskServiceTmp1Test.java';
  const code = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '    @Test void stringScenario() { helper("value"); }',
    '    @Test void unrelatedScenario() {}',
    '    private void helper(String value) {}',
    '    private void helper(int value) { MissingType broken = null; }',
    '}',
    ''
  ].join('\n');
  const brokenLine = code.split('\n').findIndex((line) => (
    line.includes('helper(int value)')
  )) + 1;

  const result = new GeneratedTestFailurePrunerService().prune({
    code,
    candidateFilePath: filePath,
    execution: {
      status: 'compile_failed',
      mavenExecutions: [mavenExecution(
        'test_compile',
        1,
        `[ERROR] ${filePath}:[${brokenLine},38] cannot find symbol`
      )]
    }
  });

  assert.deepEqual(result.commentedMethods, []);
  assert.equal(result.code, code);
});

function activeTestNames(code) {
  return new JavaTestStructureService()
    .findTestMethods(code)
    .map((method) => method.name);
}

function countRepairTodos(code) {
  return [...code.matchAll(/^\s*\/\/ TODO 当前测试方法需要修复\s*$/gm)].length;
}

function importBlock(code) {
  return code.split(/\r?\n/)
    .filter((line) => line.startsWith('import '))
    .join('\n');
}

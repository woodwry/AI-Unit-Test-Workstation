import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MavenRepairDiagnosticService
} from '../src/main/services/maven-repair-diagnostic.service.ts';

const TEST_PATH =
  'D:\\work\\collection-core\\src\\test\\java\\com\\dtsz\\collection\\model\\service\\TaskServiceTmp1Test.java';
const TEST_FQN =
  'com.dtsz.collection.model.service.TaskServiceTmp1Test';
const TARGET_FQN =
  'com.dtsz.collection.model.service.TaskService';

function execution(phase, stdout, stderr = '') {
  return {
    scope: 'method_candidate',
    phase,
    command: 'mvn.cmd test',
    exitCode: 1,
    stdout,
    stderr,
    surefireReports: []
  };
}

test('complete Surefire failures exclude exceptions logged by passing tests', () => {
  const failed = `java.lang.IllegalStateException: broken\n\tat ${TARGET_FQN}.run(TaskService.java:80)\n\tat ${TEST_FQN}.failedTest(TaskServiceTmp1Test.java:20)`;
  const caught = `java.lang.NullPointerException: caught\n\tat ${TARGET_FQN}.logged(TaskService.java:90)\n\tat ${TEST_FQN}.passingTest(TaskServiceTmp1Test.java:30)`;
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed', mavenExecutions: [execution('test', caught + '\n' + failed)],
      testReport: {tests: 2, failures: 0, errors: 1, skipped: 0, failureDetails: [{
        testName: 'failedTest', kind: 'error', type: 'java.lang.IllegalStateException', message: 'broken', detail: failed
      }]}
    },
    generatedTestFilePath: TEST_PATH, generatedTestClassName: TEST_FQN, targetProductionClassName: TARGET_FQN
  });
  assert.deepEqual(diagnostic.exceptions.map(value => value.testName), ['failedTest']);
  assert.deepEqual(diagnostic.generatedTestFrames.map(value => value.methodName), ['failedTest']);
  assert.equal(diagnostic.productionFrames.some(value => value.methodName === 'logged'), false);
});

test('fork crash without Surefire XML still exposes the generated test location and root exception', () => {
  const output = [
    'java.lang.IllegalStateException: application startup failed',
    '\tat org.springframework.boot.SpringApplication.run(SpringApplication.java:330)',
    `\tat ${TARGET_FQN}.main(TaskService.java:43)`,
    `\tat ${TEST_FQN}.startsApplication(TaskServiceTmp1Test.java:23)`,
    '[ERROR] The forked VM terminated without properly saying goodbye.',
    '[ERROR] Crashed tests:',
    `[ERROR] ${TEST_FQN}`
  ].join('\n');

  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test', output)]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(diagnostic.status, 'test_failed');
  assert.equal(diagnostic.exceptions[0]?.type, 'java.lang.IllegalStateException');
  assert.equal(diagnostic.exceptions[0]?.testName, 'startsApplication');
  assert.deepEqual(diagnostic.exceptions[0]?.testLocation, {
    ownerFqn: TEST_FQN,
    methodName: 'startsApplication',
    sourceFile: 'TaskServiceTmp1Test.java',
    sourceLine: 23
  });
  assert.ok(diagnostic.productionFrames.some((frame) => frame.methodName === 'main'));
  assert.ok(diagnostic.generatedTestFrames.some((frame) => (
    frame.methodName === 'startsApplication' && frame.sourceLine === 23
  )));
});

test('Surefire OOM dump supplies the failed generated test and production frames to repair context', () => {
  const testExecution = execution('test', '[ERROR] Java heap space');
  testExecution.surefireReports = [{
    fileName: '2026-09-18T11-03-20_195-jvmRun1.dump',
    content: [
      'java.lang.OutOfMemoryError: Java heap space',
      `\tat ${TARGET_FQN}.canWriteData(TaskService.java:1508)`,
      `\tat ${TARGET_FQN}.getLockFlag(TaskService.java:1421)`,
      `\tat ${TEST_FQN}.unboundedParents(TaskServiceTmp1Test.java:789)`
    ].join('\n')
  }];

  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test_compile', ''), testExecution]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(diagnostic.exceptions[0]?.type, 'java.lang.OutOfMemoryError');
  assert.equal(diagnostic.exceptions[0]?.message, 'Java heap space');
  assert.equal(diagnostic.exceptions[0]?.testName, 'unboundedParents');
  assert.deepEqual(diagnostic.generatedTestFrames.map(({ methodName, sourceLine }) => [
    methodName,
    sourceLine
  ]), [['unboundedParents', 789]]);
  assert.deepEqual(diagnostic.productionFrames.map(({ methodName, sourceLine }) => [
    methodName,
    sourceLine
  ]), [['canWriteData', 1508], ['getLockFlag', 1421]]);
});

test('Maven repair diagnostic keeps four distinct compiler errors and deduplicates repeated output', () => {
  const errors = [
    `[ERROR] ${TEST_PATH}:[618,49] cannot find symbol: method getReportUnitType()`,
    `[ERROR] ${TEST_PATH}:[620,48] unreported exception com.dtsz.collection.exception.ReportException; must be caught or declared to be thrown`,
    `[ERROR] ${TEST_PATH}:[625,37] unreported exception com.dtsz.collection.exception.ReportException; must be caught or declared to be thrown`,
    `[ERROR] ${TEST_PATH}:[660,32] unreported exception com.dtsz.collection.exception.ReportException; must be caught or declared to be thrown`
  ];
  const output = [...errors, errors[1], 'symbol: method getReportUnitType()']
    .join('\n');

  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'compile_failed',
      mavenExecutions: [
        execution('test_compile', output, output)
      ]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(diagnostic.status, 'compile_failed');
  assert.deepEqual(
    diagnostic.compilerErrors.map(({ line, column }) => [line, column]),
    [[618, 49], [620, 48], [625, 37], [660, 32]]
  );
  assert.deepEqual(diagnostic.missingSymbols, ['getReportUnitType']);
  assert.ok(diagnostic.relatedTypeFqns.includes(
    'com.dtsz.collection.exception.ReportException'
  ));
  assert.equal(diagnostic.truncated, false);
  assert.equal(diagnostic.droppedItemCount, 0);
});

test('Maven repair diagnostic matches Maven Windows paths with a leading slash', () => {
  const mavenPath = TEST_PATH.replaceAll('\\', '/').replace(/^([A-Za-z]:)/, '/$1');
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'compile_failed',
      mavenExecutions: [execution(
        'test_compile',
        `[ERROR] ${mavenPath}:[618,39] unreported exception com.dtsz.report.exception.ReportException; must be caught or declared to be thrown`
      )]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.deepEqual(
    diagnostic.compilerErrors.map(({ line, column, category }) =>
      [line, column, category]),
    [[618, 39, 'unreported_exception']]
  );
});

test('Maven repair diagnostic classifies localized unreported exceptions', () => {
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'compile_failed',
      mavenExecutions: [execution(
        'test_compile',
        `[ERROR] /D:/work/collection-core/src/test/java/com/dtsz/collection/model/service/TaskServiceTmp1Test.java:[618,39] 未报告的异常错误com.dtsz.report.exception.ReportException; 必须对其进行捕获或声明以便抛出`
      )]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(diagnostic.compilerErrors[0]?.category, 'unreported_exception');
});

test('Maven repair diagnostic preserves localized symbol and ambiguous-call details', () => {
  const output = [
    `[ERROR] /D:/work/collection-core/src/test/java/com/dtsz/collection/model/service/TaskServiceTmp1Test.java:[265,43] 对cal的引用不明确`,
    '  com.dtsz.collection.model.service.func.FuncService 中的方法 cal(com.dtsz.model.entity.report.Task,com.dtsz.model.entity.report.Sheet,com.dtsz.report.model.entity.report.Formula,com.dtsz.report.view.vo.authenticator.UserVO) 和 com.dtsz.collection.model.service.func.FuncService 中的方法 cal(com.dtsz.model.entity.report.Task,com.dtsz.model.entity.report.Sheet,java.lang.String,com.dtsz.report.view.vo.authenticator.UserVO) 都匹配',
    `[ERROR] /D:/work/collection-core/src/test/java/com/dtsz/collection/model/service/TaskServiceTmp1Test.java:[355,64] 找不到符号`,
    '  符号:   类 Executable',
    '  位置: 程序包 org.junit.jupiter.api'
  ].join('\n');

  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'compile_failed',
      mavenExecutions: [execution('test_compile', output)]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.deepEqual(diagnostic.compilerErrors, [{
    filePath: '/D:/work/collection-core/src/test/java/com/dtsz/collection/model/service/TaskServiceTmp1Test.java',
    line: 265,
    column: 43,
    category: 'ambiguous_reference',
    message: '对cal的引用不明确; com.dtsz.collection.model.service.func.FuncService 中的方法 cal(com.dtsz.model.entity.report.Task,com.dtsz.model.entity.report.Sheet,com.dtsz.report.model.entity.report.Formula,com.dtsz.report.view.vo.authenticator.UserVO) 和 com.dtsz.collection.model.service.func.FuncService 中的方法 cal(com.dtsz.model.entity.report.Task,com.dtsz.model.entity.report.Sheet,java.lang.String,com.dtsz.report.view.vo.authenticator.UserVO) 都匹配'
  }, {
    filePath: '/D:/work/collection-core/src/test/java/com/dtsz/collection/model/service/TaskServiceTmp1Test.java',
    line: 355,
    column: 64,
    category: 'cannot_find_symbol',
    message: '找不到符号; 符号: 类 Executable; 位置: 程序包 org.junit.jupiter.api'
  }]);
  assert.deepEqual(diagnostic.missingSymbols, ['Executable']);
});

test('Maven repair diagnostic merges equivalent Surefire and console exceptions', () => {
  const detail = [
    'java.lang.NullPointerException: com.dtsz.collection.model.ReportUnit was null',
    `\tat ${TARGET_FQN}.updateUserOfReportUnitInfo(TaskService.java:965)`,
    `\tat ${TEST_FQN}.updatesReportUnit(TaskServiceTmp1Test.java:712)`
  ].join('\n');
  const consoleOutput = [
    '[ERROR] updatesReportUnit  Time elapsed: 0.01 s  <<< ERROR!',
    detail,
    'Caused by: java.lang.NullPointerException: com.dtsz.collection.model.ReportUnit was null',
    `\tat ${TARGET_FQN}.updateUserOfReportUnitInfo(TaskService.java:965)`,
    `\tat ${TEST_FQN}.updatesReportUnit(TaskServiceTmp1Test.java:712)`
  ].join('\n');

  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test', consoleOutput)],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        generatedTestClassName: TEST_FQN,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: TEST_FQN,
          testClassName: TEST_FQN,
          testName: 'updatesReportUnit',
          kind: 'error',
          type: 'java.lang.NullPointerException',
          message: 'com.dtsz.collection.model.ReportUnit was null',
          detail
        }]
      }
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.deepEqual(diagnostic.affectedTestNames, ['updatesReportUnit']);
  assert.equal(diagnostic.exceptions.length, 1);
  assert.equal(diagnostic.exceptions[0].type, 'java.lang.NullPointerException');
  assert.deepEqual(
    diagnostic.productionFrames.map(({ ownerFqn, methodName, sourceLine }) =>
      [ownerFqn, methodName, sourceLine]),
    [[TARGET_FQN, 'updateUserOfReportUnitInfo', 965]]
  );
  assert.deepEqual(
    diagnostic.generatedTestFrames.map(({ methodName, sourceLine }) =>
      [methodName, sourceLine]),
    [['updatesReportUnit', 712]]
  );
  assert.ok(diagnostic.relatedTypeFqns.includes(
    'com.dtsz.collection.model.ReportUnit'
  ));
});

test('Maven repair diagnostic reserves a bounded stack frame for the failing test', () => {
  const detail = [
    'java.lang.IllegalStateException: deep application stack',
    `\tat ${TARGET_FQN}.run(TaskService.java:20)`,
    ...Array.from({ length: 11 }, (_, index) => (
      `\tat com.dtsz.collection.layer.Layer${index}.call(Layer${index}.java:${30 + index})`
    )),
    `\tat ${TEST_FQN}.deepFailure(TaskServiceTmp1Test.java:77)`
  ].join('\n');
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test', detail)],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        generatedTestClassName: TEST_FQN,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: TEST_FQN,
          testClassName: TEST_FQN,
          testName: 'deepFailure',
          kind: 'error',
          type: 'java.lang.IllegalStateException',
          message: 'deep application stack',
          detail
        }]
      }
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(diagnostic.exceptions[0].stackFrames.length, 12);
  assert.equal(diagnostic.exceptions[0].testLocation?.methodName, 'deepFailure');
  assert.equal(diagnostic.exceptions[0].testLocation?.sourceLine, 77);
});

test('Maven repair diagnostic keeps the root cause, target frame, helper and concrete test under frame bounds', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-unit-test-repair-diagnostic-'));
  try {
    const sourceRoot = join(root, 'collection-core', 'src', 'main', 'java');
    const targetPath = join(sourceRoot, 'com', 'example', 'CalculateService.java');
    mkdirSync(join(targetPath, '..'), { recursive: true });
    const targetLines = Array.from({ length: 130 }, () => '');
    targetLines[0] = 'package com.example;';
    targetLines[1] = 'class CalculateService {';
    targetLines[122] = '        dataCellService.getCellDataBySheet(task, reportSheet, unit, bbq, user, dataCellMap);';
    targetLines[129] = '}';
    writeFileSync(targetPath, targetLines.join('\n'), 'utf8');

    const detail = [
      'java.lang.reflect.InvocationTargetException',
      '\tat java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)',
      `\tat ${TEST_FQN}.invokePrivate(TaskServiceTmp1Test.java:93)`,
      `\tat ${TEST_FQN}.setData_reportsRootCause(TaskServiceTmp1Test.java:211)`,
      `\tat ${TEST_FQN}.parameterizedDispatch(TaskServiceTmp1Test.java:220)`,
      'Caused by: java.lang.NullPointerException: task data was null',
      '\tat com.example.Task.getSheets(Task.java:1643)',
      ...Array.from({ length: 14 }, (_, index) => (
        `\tat com.example.pipeline.Layer${index}.call(Layer${index}.java:${40 + index})`
      )),
      '\tat com.example.CalculateService.setData(CalculateService.java:123)'
    ].join('\n');
    const diagnostic = new MavenRepairDiagnosticService().normalize({
      execution: {
        status: 'test_failed',
        mavenExecutions: [execution('test', '')],
        testReport: {
          reportCount: 1,
          tests: 1,
          failures: 0,
          errors: 1,
          skipped: 0,
          generatedTestClassName: TEST_FQN,
          generatedTests: 1,
          generatedSkipped: 0,
          failureDetails: [{
            suiteName: TEST_FQN,
            testClassName: TEST_FQN,
            testName: 'setData_reportsRootCause[2]',
            kind: 'error',
            type: 'java.lang.reflect.InvocationTargetException',
            message: '',
            detail
          }]
        }
      },
      generatedTestFilePath: TEST_PATH,
      generatedTestClassName: TEST_FQN,
      targetProductionClassName: 'com.example.CalculateService',
      targetProductionFilePath: targetPath
    });

    const failure = diagnostic.exceptions[0];
    assert.equal(failure.type, 'java.lang.NullPointerException');
    assert.equal(failure.message, 'task data was null');
    assert.deepEqual(failure.failingLocation, {
      ownerFqn: 'com.example.Task',
      methodName: 'getSheets',
      sourceFile: 'Task.java',
      sourceLine: 1643
    });
    assert.deepEqual(failure.testLocation, {
      ownerFqn: TEST_FQN,
      methodName: 'setData_reportsRootCause',
      sourceFile: 'TaskServiceTmp1Test.java',
      sourceLine: 211
    });
    assert.deepEqual(
      failure.stackFrames
        .filter(({ ownerFqn }) => ownerFqn === 'com.example.Task'
          || ownerFqn === 'com.example.CalculateService'
          || ownerFqn === TEST_FQN)
        .map(({ ownerFqn, methodName, sourceLine }) => [ownerFqn, methodName, sourceLine]),
      [
        ['com.example.Task', 'getSheets', 1643],
        ['com.example.CalculateService', 'setData', 123],
        [TEST_FQN, 'invokePrivate', 93],
        [TEST_FQN, 'setData_reportsRootCause', 211],
        [TEST_FQN, 'parameterizedDispatch', 220]
      ]
    );
    assert.deepEqual(
      diagnostic.productionFrames.map(({ ownerFqn, methodName, sourceLine }) => [
        ownerFqn,
        methodName,
        sourceLine
      ]),
      [['com.example.CalculateService', 'setData', 123]]
    );
    assert.equal(
      failure.failingStatement,
      'dataCellService.getCellDataBySheet(task, reportSheet, unit, bbq, user, dataCellMap);'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Maven repair diagnostic does not attribute a dependency statement to the target method', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-unit-test-repair-diagnostic-'));
  try {
    const sourceRoot = join(root, 'collection-core', 'src', 'main', 'java');
    const targetPath = join(sourceRoot, 'com', 'example', 'CalculateService.java');
    const dependencyPath = join(sourceRoot, 'com', 'example', 'Task.java');
    mkdirSync(join(targetPath, '..'), { recursive: true });
    writeFileSync(
      targetPath,
      'package com.example;\nclass CalculateService { void setData() {} }\n',
      'utf8'
    );
    writeFileSync(
      dependencyPath,
      'package com.example;\nclass Task {\n  Set<Sheet> getSheets() { return sheets; }\n}\n',
      'utf8'
    );
    const detail = [
      'java.lang.NullPointerException',
      '\tat com.example.Task.getSheets(Task.java:3)',
      `\tat ${TEST_FQN}.scenarioOne(TaskServiceTmp1Test.java:20)`
    ].join('\n');

    const diagnostic = new MavenRepairDiagnosticService().normalize({
      execution: {
        status: 'test_failed',
        mavenExecutions: [execution('test', '')],
        testReport: {
          tests: 1,
          failures: 0,
          errors: 1,
          skipped: 0,
          failureDetails: [{
            testName: 'scenarioOne',
            kind: 'error',
            type: 'java.lang.NullPointerException',
            message: '',
            detail
          }]
        }
      },
      generatedTestFilePath: TEST_PATH,
      generatedTestClassName: TEST_FQN,
      targetProductionClassName: 'com.example.CalculateService',
      targetProductionFilePath: targetPath
    });

    assert.equal(diagnostic.exceptions[0].failingStatement, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Maven repair diagnostic preserves assertion type and message when it has a nested cause', () => {
  const detail = [
    'org.opentest4j.AssertionFailedError: expected: <1> but was: <0>',
    `\tat ${TEST_FQN}.scenarioOne(TaskServiceTmp1Test.java:20)`,
    'Caused by: java.lang.NullPointerException: nested fixture detail',
    `\tat ${TARGET_FQN}.run(TaskService.java:80)`
  ].join('\n');
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test', '')],
      testReport: {
        tests: 1,
        failures: 1,
        errors: 0,
        skipped: 0,
        failureDetails: [{
          testName: 'scenarioOne',
          kind: 'failure',
          type: 'org.opentest4j.AssertionFailedError',
          message: 'expected: <1> but was: <0>',
          detail
        }]
      }
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(
    diagnostic.exceptions[0].type,
    'org.opentest4j.AssertionFailedError'
  );
  assert.equal(
    diagnostic.exceptions[0].message,
    'expected: <1> but was: <0>'
  );
});

test('Maven repair diagnostic keeps Apache library frames but drops Surefire infrastructure', () => {
  const detail = [
    'java.lang.IllegalStateException: workbook export failed',
    '\tat org.apache.poi.xssf.usermodel.XSSFWorkbook.write(XSSFWorkbook.java:420)',
    '\tat org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.invoke(JUnitPlatformProvider.java:120)',
    `\tat ${TARGET_FQN}.export(TaskService.java:88)`,
    `\tat ${TEST_FQN}.exportsWorkbook(TaskServiceTmp1Test.java:101)`
  ].join('\n');
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test', detail)],
      testReport: {
        reportCount: 1,
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        generatedTestClassName: TEST_FQN,
        generatedTests: 1,
        generatedSkipped: 0,
        failureDetails: [{
          suiteName: TEST_FQN,
          testClassName: TEST_FQN,
          testName: 'exportsWorkbook',
          kind: 'error',
          type: 'java.lang.IllegalStateException',
          message: 'workbook export failed',
          detail
        }]
      }
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  const owners = diagnostic.exceptions[0].stackFrames.map(({ ownerFqn }) => ownerFqn);
  assert.ok(owners.includes('org.apache.poi.xssf.usermodel.XSSFWorkbook'));
  assert.ok(!owners.includes(
    'org.apache.maven.surefire.junitplatform.JUnitPlatformProvider'
  ));
});

test('Maven repair diagnostic reports when complete diagnostic items are dropped by bounds', () => {
  const output = Array.from({ length: 40 }, (_, index) =>
    `[ERROR] ${TEST_PATH}:[${100 + index},1] cannot find symbol: class Missing${index}`
  ).join('\n');

  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'compile_failed',
      mavenExecutions: [execution('test_compile', output)]
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  assert.equal(diagnostic.compilerErrors.length, 32);
  assert.equal(diagnostic.truncated, true);
  assert.equal(diagnostic.droppedItemCount, 8);
  assert.equal(diagnostic.compilerErrors.at(-1).line, 131);
});

test('Maven repair diagnostic preserves identical failures per test and uses the target production statement', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-unit-test-repair-diagnostic-'));
  try {
    const sourceRoot = join(root, 'collection-core', 'src', 'main', 'java');
    const targetPath = join(
      sourceRoot,
      'com', 'example', 'service', 'TaskService.java'
    );
    const dependencyPath = join(
      sourceRoot,
      'com', 'example', 'export', 'ExportCollection.java'
    );
    mkdirSync(join(targetPath, '..'), { recursive: true });
    mkdirSync(join(dependencyPath, '..'), { recursive: true });
    writeFileSync(targetPath, [
      'package com.example.service;',
      'class TaskService {',
      '    void run() {}',
      '}'
    ].join('\n'), 'utf8');
    writeFileSync(dependencyPath, [
      'package com.example.export;',
      'class ExportCollection {',
      '    this.container.init(map, writeBuffer);',
      '}'
    ].join('\n'), 'utf8');

    const failure = (testName, testLine) => ({
      suiteName: 'com.example.service.TaskServiceTmp1Test',
      testClassName: 'com.example.service.TaskServiceTmp1Test',
      testName,
      kind: 'error',
      type: 'java.lang.NullPointerException',
      message: '',
      detail: [
        'java.lang.NullPointerException',
        '\tat com.example.export.ExportCollection$Excel.init(ExportCollection.java:3)',
        '\tat com.example.service.TaskService.run(TaskService.java:3)',
        `\tat com.example.service.TaskServiceTmp1Test.${testName}(TaskServiceTmp1Test.java:${testLine})`
      ].join('\n')
    });
    const diagnostic = new MavenRepairDiagnosticService().normalize({
      execution: {
        status: 'test_failed',
        mavenExecutions: [execution('test', '')],
        testReport: {
          reportCount: 1,
          tests: 2,
          failures: 0,
          errors: 2,
          skipped: 0,
          generatedTestClassName: 'com.example.service.TaskServiceTmp1Test',
          generatedTests: 2,
          generatedSkipped: 0,
          failureDetails: [failure('scenarioOne', 20), failure('scenarioTwo', 40)]
        }
      },
      generatedTestFilePath: join(
        root,
        'collection-core', 'src', 'test', 'java',
        'com', 'example', 'service', 'TaskServiceTmp1Test.java'
      ),
      generatedTestClassName: 'com.example.service.TaskServiceTmp1Test',
      targetProductionClassName: 'com.example.service.TaskService',
      targetProductionFilePath: targetPath
    });

    assert.equal(diagnostic.exceptions.length, 2);
    assert.deepEqual(
      diagnostic.exceptions.map(({ testName, testLocation }) => [
        testName,
        testLocation?.methodName,
        testLocation?.sourceLine
      ]),
      [
        ['scenarioOne', 'scenarioOne', 20],
        ['scenarioTwo', 'scenarioTwo', 40]
      ]
    );
    assert.deepEqual(
      diagnostic.exceptions.map(({ failingStatement }) => failingStatement),
      [
        'void run() {}',
        'void run() {}'
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Maven repair diagnostic keeps Mockito problem-stub arrows without replacing the failing test call', () => {
  const detail = [
    'org.mockito.exceptions.misusing.PotentialStubbingProblem: Strict stubbing argument mismatch. Please check:',
    " - this invocation of 'getByCode' method:",
    '    reportUnitService.getByCode(null, null);',
    '    -> at ' + TARGET_FQN + '.calculate(TaskService.java:141)',
    ' - has following stubbing(s) with different arguments:',
    '    1. reportUnitService.getByCode("", "");',
    '      -> at ' + TEST_FQN + '.calculate_handlesNullCodes(TaskServiceTmp1Test.java:234)',
    '\tat ' + TARGET_FQN + '.calculate(TaskService.java:141)',
    '\tat ' + TEST_FQN + '.calculate_handlesNullCodes(TaskServiceTmp1Test.java:252)'
  ].join('\n');
  const diagnostic = new MavenRepairDiagnosticService().normalize({
    execution: {
      status: 'test_failed',
      mavenExecutions: [execution('test', '')],
      testReport: {
        tests: 1,
        failures: 0,
        errors: 1,
        skipped: 0,
        failureDetails: [{
          testName: 'calculate_handlesNullCodes',
          kind: 'error',
          type: 'org.mockito.exceptions.misusing.PotentialStubbingProblem',
          message: 'Strict stubbing argument mismatch',
          detail
        }]
      }
    },
    generatedTestFilePath: TEST_PATH,
    generatedTestClassName: TEST_FQN,
    targetProductionClassName: TARGET_FQN
  });

  const failure = diagnostic.exceptions[0];
  assert.deepEqual(failure.testLocation, {
    ownerFqn: TEST_FQN,
    methodName: 'calculate_handlesNullCodes',
    sourceFile: 'TaskServiceTmp1Test.java',
    sourceLine: 252
  });
  assert.deepEqual(
    diagnostic.generatedTestFrames.map(({ methodName, sourceLine }) => [
      methodName,
      sourceLine
    ]),
    [
      ['calculate_handlesNullCodes', 252],
      ['calculate_handlesNullCodes', 234]
    ]
  );
  assert.ok(failure.stackFrames.some((frame) => (
    frame.ownerFqn === TEST_FQN && frame.sourceLine === 234
  )));
});

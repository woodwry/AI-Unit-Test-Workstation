import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SurefireReportService } from '../src/main/services/surefire-report.service.ts';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const GENERATED_TEST_CLASS = 'com.example.TargetTest';

async function createHarness(t, attemptId = ATTEMPT_ID) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-unit-test-surefire-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleRoot = join(root, 'module');
  await fs.mkdir(moduleRoot, { recursive: true });
  const service = new SurefireReportService();
  const reportDirectory = await service.prepareAttempt(moduleRoot, attemptId);
  return { root, moduleRoot, reportDirectory, service };
}

async function writeReport(directory, name, source) {
  await fs.writeFile(join(directory, name), source, 'utf8');
}

test('聚合本轮独立目录中的 Surefire 成功报告并确认生成测试实际执行', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.TargetTest" tests="2" failures="0" errors="0" skipped="0">
  <testcase classname="com.example.TargetTest" name="coversFirstBranch"/>
  <testcase classname="com.example.TargetTest" name="coversSecondBranch"/>
</testsuite>`);
  await writeReport(reportDirectory, 'TEST-com.example.ExistingTest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.ExistingTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase classname="com.example.ExistingTest" name="keepsExistingCoverage"/>
</testsuite>`);

  const report = await service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS);

  assert.deepEqual(report, {
    reportCount: 2,
    tests: 3,
    failures: 0,
    errors: 0,
    skipped: 0,
    generatedTestClassName: GENERATED_TEST_CLASS,
    generatedTests: 2,
    generatedSkipped: 0,
    failureDetails: []
  });
});

test('解析失败与错误用例并对 XML 实体和公开文本做有界处理', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.TargetTest" tests="2" failures="1" errors="1" skipped="0">
  <testcase classname="com.example.TargetTest" name="failsWithValue">
    <failure type="org.opentest4j.AssertionFailedError" message="expected &lt;A&gt; but was &lt;B&gt;">C:\\Users\\name\\project\\TargetTest.java:18
failure detail</failure>
  </testcase>
  <testcase classname="com.example.TargetTest" name="throwsUnexpectedly">
    <error type="java.lang.IllegalStateException" message="状态错误">/home/name/project/TargetTest.java:29
error detail</error>
  </testcase>
</testsuite>`);

  const report = await service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS);

  assert.equal(report.tests, 2);
  assert.equal(report.failures, 1);
  assert.equal(report.errors, 1);
  assert.equal(report.failureDetails.length, 2);
  assert.deepEqual(
    report.failureDetails.map(({ testClassName, testName, kind, type, message }) => ({
      testClassName,
      testName,
      kind,
      type,
      message
    })),
    [
      {
        testClassName: GENERATED_TEST_CLASS,
        testName: 'failsWithValue',
        kind: 'failure',
        type: 'org.opentest4j.AssertionFailedError',
        message: 'expected <A> but was <B>'
      },
      {
        testClassName: GENERATED_TEST_CLASS,
        testName: 'throwsUnexpectedly',
        kind: 'error',
        type: 'java.lang.IllegalStateException',
        message: '状态错误'
      }
    ]
  );
  assert.ok(report.failureDetails.every((item) => !item.detail?.includes('C:\\Users')));
  assert.ok(report.failureDetails.every((item) => !item.detail?.includes('/home/name')));
});

test('long reflection stack keeps the trailing cause and key application and test frames', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  const reflectionFrames = Array.from({ length: 80 }, (_, index) => (
    `\tat java.base/jdk.internal.reflect.GeneratedMethodAccessor${index}.invoke(Unknown Source)`
  ));
  const detail = [
    'java.lang.reflect.InvocationTargetException',
    ...reflectionFrames,
    '\tat com.example.TargetTest.invokePrivate(TargetTest.java:93)',
    'Caused by: java.lang.NullPointerException: task data was null',
    '\tat com.example.Task.getSheets(Task.java:1643)',
    '\tat com.example.CalculateService.setData(CalculateService.java:123)',
    '\tat com.example.TargetTest.setData_reportsRootCause(TargetTest.java:211)'
  ].join('\n');
  await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="1" skipped="0">
  <testcase classname="com.example.TargetTest" name="setData_reportsRootCause">
    <error type="java.lang.reflect.InvocationTargetException">${detail}</error>
  </testcase>
</testsuite>`);

  const report = await service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS);
  const retained = report.failureDetails[0]?.detail ?? '';

  assert.ok(retained.length <= 2_000);
  assert.match(retained, /^java\.lang\.reflect\.InvocationTargetException/m);
  assert.match(retained, /Caused by: java\.lang\.NullPointerException: task data was null/);
  assert.match(retained, /com\.example\.Task\.getSheets\(Task\.java:1643\)/);
  assert.match(retained, /com\.example\.CalculateService\.setData\(CalculateService\.java:123\)/);
  assert.match(retained, /com\.example\.TargetTest\.invokePrivate\(TargetTest\.java:93\)/);
  assert.match(retained, /com\.example\.TargetTest\.setData_reportsRootCause\(TargetTest\.java:211\)/);
});

test('没有本轮 TEST XML 时失败关闭而不是返回零覆盖假象', async (t) => {
  const { reportDirectory, service } = await createHarness(t);

  await assert.rejects(
    service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
    /未找到本轮 Surefire XML 报告/
  );
});

test('项目忽略自定义报告目录时读取本轮更新的默认 Surefire 报告', async (t) => {
  const { moduleRoot, reportDirectory, service } = await createHarness(t);
  const defaultDirectory = join(moduleRoot, 'target', 'surefire-reports');
  await fs.mkdir(defaultDirectory, { recursive: true });
  await writeReport(defaultDirectory, 'TEST-com.example.TargetTest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase classname="com.example.TargetTest" name="runs"/>
</testsuite>`);

  const report = await service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS);

  assert.equal(report.reportCount, 1);
  assert.equal(report.generatedTests, 1);
});

test('同时收集默认目录中的本轮 Surefire 崩溃诊断且 XML 聚合不受影响', async (t) => {
  const { moduleRoot, reportDirectory, service } = await createHarness(t);
  await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml',
    '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.TargetTest" name="runs"/></testsuite>');
  const defaultDirectory = join(moduleRoot, 'target', 'surefire-reports');
  await fs.mkdir(defaultDirectory, { recursive: true });
  await writeReport(
    defaultDirectory,
    '2026-09-18T11-03-20_195-jvmRun1.dump',
    [
      'java.lang.OutOfMemoryError: Java heap space',
      '\\tat com.example.TaskService.run(TaskService.java:88)',
      '\\tat com.example.TargetTest.runs(TargetTest.java:21)'
    ].join('\n')
  );

  const artifacts = await service.readAttemptArtifacts(reportDirectory);
  const report = await service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS);

  assert.deepEqual(artifacts.map((artifact) => artifact.fileName).sort(), [
    '2026-09-18T11-03-20_195-jvmRun1.dump',
    'TEST-com.example.TargetTest.xml'
  ]);
  assert.equal(report.reportCount, 1);
  assert.equal(report.generatedTests, 1);
});

test('默认 Surefire 目录中的历史报告不能冒充本轮执行结果', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-unit-test-surefire-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleRoot = join(root, 'module');
  const defaultDirectory = join(moduleRoot, 'target', 'surefire-reports');
  await fs.mkdir(defaultDirectory, { recursive: true });
  const staleReport = join(defaultDirectory, 'TEST-com.example.TargetTest.xml');
  await fs.writeFile(staleReport, `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase classname="com.example.TargetTest" name="stale"/>
</testsuite>`, 'utf8');
  const staleTime = new Date(Date.now() - 60_000);
  await fs.utimes(staleReport, staleTime, staleTime);
  const service = new SurefireReportService();
  const reportDirectory = await service.prepareAttempt(moduleRoot, ATTEMPT_ID);

  await assert.rejects(
    service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
    /未找到本轮 Surefire XML 报告/
  );
});

test('默认 Surefire 目录中的历史崩溃诊断不会归入本轮证据', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-unit-test-surefire-stale-dump-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleRoot = join(root, 'module');
  const defaultDirectory = join(moduleRoot, 'target', 'surefire-reports');
  await fs.mkdir(defaultDirectory, { recursive: true });
  const staleDump = join(defaultDirectory, '2026-09-18T10-00-00_000-jvmRun1.dump');
  await fs.writeFile(staleDump, 'java.lang.OutOfMemoryError\n\\tat com.example.TargetTest.runs(TargetTest.java:21)', 'utf8');
  const staleTime = new Date(Date.now() - 60_000);
  await fs.utimes(staleDump, staleTime, staleTime);
  const service = new SurefireReportService();
  const reportDirectory = await service.prepareAttempt(moduleRoot, ATTEMPT_ID);

  assert.deepEqual(await service.readAttemptArtifacts(reportDirectory), []);
});

for (const scenario of [
  {
    name: '缺少计数字段',
    xml: '<testsuite name="com.example.TargetTest" failures="0" errors="0" skipped="0"></testsuite>',
    expected: /计数字段无效/
  },
  {
    name: '计数为负数',
    xml: '<testsuite name="com.example.TargetTest" tests="-1" failures="0" errors="0" skipped="0"></testsuite>',
    expected: /计数字段无效/
  },
  {
    name: '计数不是整数',
    xml: '<testsuite name="com.example.TargetTest" tests="1.5" failures="0" errors="0" skipped="0"></testsuite>',
    expected: /计数字段无效/
  },
  {
    name: '失败错误跳过数超过测试总数',
    xml: '<testsuite name="com.example.TargetTest" tests="1" failures="1" errors="1" skipped="0"></testsuite>',
    expected: /计数不一致/
  },
  {
    name: '声明执行测试但缺少 testcase',
    xml: '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    expected: /测试用例与计数字段不一致/
  },
  {
    name: 'failure 元素与计数字段矛盾',
    xml: '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.TargetTest" name="fails"><failure message="失败"/></testcase></testsuite>',
    expected: /测试用例与计数字段不一致/
  },
  {
    name: 'skipped 元素与计数字段矛盾',
    xml: '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.TargetTest" name="skipped"><skipped/></testcase></testsuite>',
    expected: /测试用例与计数字段不一致/
  },
  {
    name: 'XML 结构损坏',
    xml: '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><testcase>',
    expected: /无法解析本轮 Surefire XML/
  },
  {
    name: '包含 DTD',
    xml: '<!DOCTYPE testsuite SYSTEM "file:///secret"><testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    expected: /禁止包含 DTD 或实体声明/
  },
  {
    name: '包含实体声明',
    xml: '<!ENTITY secret SYSTEM "file:///secret"><testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"></testsuite>',
    expected: /禁止包含 DTD 或实体声明/
  }
]) {
  test(`拒绝 ${scenario.name} 的 Surefire 报告`, async (t) => {
    const { reportDirectory, service } = await createHarness(t);
    await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml', scenario.xml);

    await assert.rejects(
      service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
      scenario.expected
    );
  });
}

test('生成测试套件不存在时拒绝继续生成覆盖率', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  await writeReport(reportDirectory, 'TEST-com.example.OtherTest.xml',
    '<testsuite name="com.example.OtherTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.OtherTest" name="runs"/></testsuite>');

  await assert.rejects(
    service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
    /没有执行本轮生成的测试类/
  );
});

test('生成测试全部跳过时拒绝继续生成覆盖率', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml',
    '<testsuite name="com.example.TargetTest" tests="2" failures="0" errors="0" skipped="2"><testcase classname="com.example.TargetTest" name="first"><skipped/></testcase><testcase classname="com.example.TargetTest" name="second"><skipped/></testcase></testsuite>');

  await assert.rejects(
    service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
    /本轮生成的测试全部被跳过/
  );
});

test('拒绝超过单文件体积上限的 Surefire XML', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  const padding = 'x'.repeat(5 * 1024 * 1024);
  await writeReport(
    reportDirectory,
    'TEST-com.example.TargetTest.xml',
    `<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><system-out>${padding}</system-out></testsuite>`
  );

  await assert.rejects(
    service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
    /超过体积上限/
  );
});

test('拒绝超过文件数量上限的 Surefire 报告目录', async (t) => {
  const { reportDirectory, service } = await createHarness(t);
  const xml = '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.TargetTest" name="runs"/></testsuite>';
  await Promise.all(Array.from({ length: 201 }, (_, index) =>
    writeReport(reportDirectory, `TEST-${String(index).padStart(3, '0')}.xml`, xml)));

  await assert.rejects(
    service.parseAttempt(reportDirectory, GENERATED_TEST_CLASS),
    /文件数量超过上限/
  );
});

test('拒绝解析不属于本轮 target 安全目录的路径', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-unit-test-surefire-outside-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new SurefireReportService();

  await assert.rejects(
    service.parseAttempt(root, GENERATED_TEST_CLASS),
    /Surefire 报告目录无效/
  );
});

test('清理只删除本会话 Surefire current 目录且不删除模块源码', async (t) => {
  const { moduleRoot, reportDirectory, service } = await createHarness(t);
  const sourceFile = join(moduleRoot, 'src', 'main', 'java', 'Target.java');
  await fs.mkdir(join(moduleRoot, 'src', 'main', 'java'), { recursive: true });
  await fs.writeFile(sourceFile, 'class Target {}', 'utf8');
  await writeReport(reportDirectory, 'TEST-com.example.TargetTest.xml',
    '<testsuite name="com.example.TargetTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.example.TargetTest" name="runs"/></testsuite>');

  await service.cleanupSession(moduleRoot);

  await assert.rejects(fs.access(reportDirectory));
  assert.equal(await fs.readFile(sourceFile, 'utf8'), 'class Target {}');
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import { MavenAnalysisContextService } from '../src/main/services/maven-analysis-context.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import { WorkstationBuildSettingsService } from '../src/main/services/workstation-build-settings.service.ts';

const RUN_REAL_TEST = process.env.RUN_REAL_TASK_SERVICE_REPAIR_CONTEXT === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const MODULE_ROOT = `${WORKSPACE_ROOT}\\collection-core`;
const SOURCE_FILE_PATH = `${MODULE_ROOT}\\src\\main\\java\\com\\dtsz\\collection\\model\\service\\TaskService.java`;
const PLACEHOLDER_TEST_PATH = `${MODULE_ROOT}\\src\\test\\java\\com\\dtsz\\collection\\model\\service\\TaskServiceRepairContextPlaceholderTest.java`;
const TARGET_FQN = 'com.dtsz.collection.model.service.TaskService';
const REPORT_UNIT_FQN = 'com.dtsz.model.entity.report.ReportUnit';
const REPORT_UNIT_TYPE_FQN =
  'com.dtsz.report.model.entity.report.common.ReportUnitType';
const REPORT_UNIT_REPOSITORY_FQN =
  'com.dtsz.collection.model.repository.report.ReportUnitRepository';
const METHOD_ID = '3a0612e55cbe809b102be166a7994d6ecfb5cac3fc5785d682d429d415f28442';
const BUILD_SETTINGS_PATH = 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation\\workstation-build-settings.json';
const ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const REPORT_PATH = `${MODULE_ROOT}\\target\\ai-unit-test\\jacoco\\preload\\34d6957bf4516a1494153d2f36d516974108bb8c2b9b8c3bd24413d8774d28bf\\classes\\81d91af73919fb343ddb3c08061507e73c7643e0c34e6463e9ac8e58afb4d693.xml`;
const BRANCH_PATH = REPORT_PATH.replace(/\.xml$/, '.branches.json');
const REPORT_PAIR_ID = 'b409de51e5abb2acb7e93de0b8d52e3258dc81d27e7b3433ede64b13c95b59ef';
const EXPECTED_SOURCE_SHA256 = '306e06cb17524082445ece1e447edc39808beb524029cc231b966cce119f4459';
const RESULT_ROOT = resolve('test-results', 'real-task-service-repair-context');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('real TaskService repair context exposes exact API facts and bounded failure-line source', {
  skip: !RUN_REAL_TEST,
  timeout: 30 * 60_000
}, async () => {
  const resultDirectory = resolve(
    RESULT_ROOT,
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`
  );
  await mkdir(resultDirectory, { recursive: true });
  const sourceBefore = await readFile(SOURCE_FILE_PATH);
  assert.equal(sha256(sourceBefore), EXPECTED_SOURCE_SHA256);

  const shell = new ShellService();
  const buildSettings = await new WorkstationBuildSettingsService(
    BUILD_SETTINGS_PATH,
    'win32',
    'C:\\Users\\wry'
  ).get();
  assert.ok(buildSettings);
  const validation = await shell.validateBuildSettings(
    buildSettings,
    MODULE_ROOT,
    { excludedEnvironmentVariables: ['DEEPSEEK_API_KEY'] }
  );
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.ok(validation.javaVersion && validation.mavenVersion);

  const analysisInput = await new MavenAnalysisContextService(shell).collect({
    workspaceRoot: WORKSPACE_ROOT,
    moduleRoot: MODULE_ROOT,
    targetSourcePath: SOURCE_FILE_PATH,
    targetClass: TARGET_FQN,
    plannedTestClassName: 'TaskServiceRepairContextPlaceholderTest',
    plannedRelativeTestPath: relative(
      WORKSPACE_ROOT,
      PLACEHOLDER_TEST_PATH
    ).replaceAll('\\', '/'),
    reportPath: REPORT_PATH,
    branchSnapshotPath: BRANCH_PATH,
    reportPairId: REPORT_PAIR_ID,
    buildSettings,
    buildToolchain: {
      javaVersion: validation.javaVersion,
      mavenVersion: validation.mavenVersion
    },
    customModelEnvironmentVariable: 'DEEPSEEK_API_KEY'
  });
  const client = new AiClient();
  client.setBackendSettings({
    agentServiceUrl: 'http://127.0.0.1:9',
    javaAnalyzerUrl: ANALYZER_URL
  });
  const sessionId = randomUUID();
  const session = await client.createMethodAnalysisSession({
    ...analysisInput,
    analysisSessionId: sessionId
  });
  const context = await client.getMethodRepairContext(sessionId, {
    reportPairId: session.reportPairId,
    methodId: METHOD_ID,
    currentClassFrames: [{
      ownerFqn: TARGET_FQN,
      methodName: 'updateUserOfReportUnitInfo',
      descriptor: null,
      sourceLine: 965
    }, {
      ownerFqn: TARGET_FQN,
      methodName: 'exportTaskGetData',
      descriptor: null,
      sourceLine: 9429
    }, {
      ownerFqn: TARGET_FQN,
      methodName: 'getWorkbook',
      descriptor: null,
      sourceLine: 9726
    }],
    relatedTypeFqns: [
      REPORT_UNIT_FQN,
      REPORT_UNIT_TYPE_FQN,
      REPORT_UNIT_REPOSITORY_FQN
    ],
    missingSymbols: ['getReportUnitType', 'setReportUnitType', 'getId', 'get']
  });
  const sourceAfter = await readFile(SOURCE_FILE_PATH);
  const reportUnit = context.referencedTypes.find(
    (type) => type.qualifiedName === REPORT_UNIT_FQN
  );
  const reportUnitType = context.referencedTypes.find(
    (type) => type.qualifiedName === REPORT_UNIT_TYPE_FQN
  );
  const reportUnitRepository = context.referencedTypes.find(
    (type) => type.qualifiedName === REPORT_UNIT_REPOSITORY_FQN
  );
  const result = {
    sourceSha256Before: sha256(sourceBefore),
    sourceSha256After: sha256(sourceAfter),
    targetMethod: {
      methodName: context.targetMethod.methodName,
      descriptor: context.targetMethod.descriptor,
      firstLine: context.targetMethod.firstLine,
      lastLine: context.targetMethod.lastLine,
      sourceFirstLine: context.targetMethod.sourceFirstLine,
      sourceLastLine: context.targetMethod.sourceLastLine,
      sourceComplete: context.targetMethod.sourceComplete
    },
    stackMethods: context.stackMethods.map((method) => ({
      methodName: method.methodName,
      descriptor: method.descriptor,
      firstLine: method.firstLine,
      lastLine: method.lastLine,
      sourceFirstLine: method.sourceFirstLine,
      sourceLastLine: method.sourceLastLine,
      sourceComplete: method.sourceComplete,
      containsFailureStatement: method.sourceText.includes(
        'fis = new ByteArrayInputStream(bytes);'
      )
    })),
    referencedTypes: context.referencedTypes.map((type) => ({
      qualifiedName: type.qualifiedName,
      methods: type.methods,
      enumConstants: type.enumConstants
    })),
    warnings: context.warnings,
    truncated: context.truncated
  };
  const resultPath = resolve(resultDirectory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`REAL_TASK_SERVICE_REPAIR_CONTEXT_RESULT=${resultPath}\n`);

  assert.equal(sha256(sourceAfter), EXPECTED_SOURCE_SHA256);
  assert.equal(context.targetMethod.methodName, 'getChildZipFile');
  assert.ok(
    context.targetMethod.sourceLastLine - context.targetMethod.sourceFirstLine + 1 <= 300,
    JSON.stringify(result.targetMethod)
  );
  assert.equal(
    context.stackMethods.some(
      (method) => method.methodName === 'updateUserOfReportUnitInfo'
        && method.firstLine <= 965
        && method.lastLine >= 965
    ),
    true
  );
  const getWorkbook = context.stackMethods.find(
    (method) => method.methodName === 'getWorkbook'
      && method.firstLine <= 9726
      && method.lastLine >= 9726
  );
  assert.ok(getWorkbook, 'Analyzer omitted getWorkbook at TaskService.java:9726.');
  assert.equal(getWorkbook.sourceComplete, false);
  assert.ok(
    getWorkbook.sourceLastLine - getWorkbook.sourceFirstLine + 1 <= 300,
    JSON.stringify(getWorkbook)
  );
  assert.ok(
    getWorkbook.sourceFirstLine <= 9726 && getWorkbook.sourceLastLine >= 9726,
    JSON.stringify(getWorkbook)
  );
  assert.match(getWorkbook.sourceText, /fis\s*=\s*new ByteArrayInputStream\(bytes\);/);
  assert.ok(reportUnit, 'Analyzer omitted ReportUnit API facts.');
  assert.equal(
    reportUnit.methods.some((method) => method.includes('getReportUnitType()')),
    true,
    JSON.stringify(reportUnit)
  );
  assert.equal(
    reportUnit.methods.some((method) => method.includes('setReportUnitType(')),
    true,
    JSON.stringify(reportUnit)
  );
  assert.ok(reportUnitType, 'Analyzer omitted ReportUnitType API facts.');
  assert.equal(
    reportUnitType.methods.some((method) => method.includes('getId()')),
    true,
    JSON.stringify(reportUnitType)
  );
  assert.ok(
    reportUnitRepository,
    'Analyzer omitted the exact ReportUnitRepository type.'
  );
  assert.equal(
    reportUnitRepository.methods.some((method) => /\bget\s*\(/.test(method)),
    true,
    JSON.stringify(reportUnitRepository)
  );
});

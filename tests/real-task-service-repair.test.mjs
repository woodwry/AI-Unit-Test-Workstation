import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  MavenCandidateExecutorService
} from '../src/main/services/maven-candidate-executor.service.ts';
import {
  MavenRepairDiagnosticService
} from '../src/main/services/maven-repair-diagnostic.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import {
  SurefireReportService
} from '../src/main/services/surefire-report.service.ts';
import {
  WorkstationBuildSettingsService
} from '../src/main/services/workstation-build-settings.service.ts';

const RUN_REAL_TEST = process.env.RUN_REAL_TASK_SERVICE_REPAIR === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const MODULE_ROOT = join(WORKSPACE_ROOT, 'collection-core');
const SOURCE_FILE_PATH = join(
  MODULE_ROOT,
  'src',
  'main',
  'java',
  'com',
  'dtsz',
  'collection',
  'model',
  'service',
  'TaskService.java'
);
const TEST_FILE_PATH = join(
  MODULE_ROOT,
  'src',
  'test',
  'java',
  'com',
  'dtsz',
  'collection',
  'model',
  'service',
  'TaskServiceTmp1Test.java'
);
const QUALIFIED_CLASS_NAME = 'com.dtsz.collection.model.service.TaskService';
const QUALIFIED_TEST_CLASS_NAME =
  'com.dtsz.collection.model.service.TaskServiceTmp1Test';
const USER_DATA_DIRECTORY = process.env.WORKSTATION_USER_DATA_DIRECTORY
  ?? 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation';
const RESULT_ROOT = resolve('test-results', 'real-task-service-repair');
const EXPECTED_BUILD_SETTINGS = Object.freeze({
  mavenHome: 'D:\\java\\apache-maven-3.5.4',
  javaHome: 'D:\\java\\jdk1.8',
  settingsPath: 'D:\\java\\apache-maven-3.5.4\\conf\\settings.xml',
  localRepository: 'D:\\java\\apache-maven-3.5.4\\repository'
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compactDiagnostic(diagnostic) {
  return {
    status: diagnostic.status,
    compilerErrors: diagnostic.compilerErrors.map((item) => ({
      filePath: item.filePath,
      line: item.line,
      column: item.column,
      category: item.category,
      message: item.message
    })),
    affectedTestNames: diagnostic.affectedTestNames,
    exceptions: diagnostic.exceptions.map((item) => ({
      type: item.type,
      message: item.message,
      failingLocation: item.failingLocation
    })),
    missingSymbols: diagnostic.missingSymbols,
    relatedTypeFqns: diagnostic.relatedTypeFqns,
    truncated: diagnostic.truncated,
    droppedItemCount: diagnostic.droppedItemCount
  };
}

function relevantMavenOutput(feedback) {
  const relevantLine = /(TaskServiceTmp1Test\.java|ReportException|\[ERROR\])/i;
  const maximumLines = 160;
  let droppedLineCount = 0;
  const executions = feedback.mavenExecutions.map((execution) => {
    const output = [execution.stdout, execution.stderr]
      .flatMap((value) => String(value ?? '').split(/\r?\n/))
      .filter((line) => relevantLine.test(line));
    if (output.length > maximumLines) {
      droppedLineCount += output.length - maximumLines;
    }
    return {
      phase: execution.phase,
      lines: output.slice(0, maximumLines)
    };
  });
  return { executions, droppedLineCount };
}

test('real TaskServiceTmp1Test passes through the production Workstation Maven executor', {
  skip: !RUN_REAL_TEST,
  timeout: 30 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const resultDirectory = join(RESULT_ROOT, runId);
  await mkdir(resultDirectory, { recursive: true });

  const sourceBefore = await readFile(SOURCE_FILE_PATH);
  const testBefore = await readFile(TEST_FILE_PATH);
  const settingsService = new WorkstationBuildSettingsService(
    join(USER_DATA_DIRECTORY, 'workstation-build-settings.json'),
    'win32',
    'C:\\Users\\wry'
  );
  const buildSettings = await settingsService.get();
  assert.ok(buildSettings, 'Workstation build settings are missing.');
  assert.deepEqual({
    mavenHome: buildSettings.mavenHome,
    javaHome: buildSettings.javaHome,
    settingsPath: buildSettings.settingsPath,
    localRepository: buildSettings.localRepository
  }, EXPECTED_BUILD_SETTINGS);

  const executor = new MavenCandidateExecutorService(
    new ShellService(),
    new SurefireReportService()
  );
  const startedAt = Date.now();
  const feedback = await executor.execute({
    moduleRoot: MODULE_ROOT,
    buildSettings,
    attemptId: randomUUID(),
    qualifiedTestClassName: QUALIFIED_TEST_CLASS_NAME,
    scope: 'method_candidate',
    excludedEnvironmentVariables: ['DEEPSEEK_API_KEY']
  });
  const diagnostic = feedback.status === 'passed'
    ? null
    : new MavenRepairDiagnosticService().normalize({
        execution: feedback,
        generatedTestFilePath: TEST_FILE_PATH,
        generatedTestClassName: QUALIFIED_TEST_CLASS_NAME,
        targetProductionClassName: QUALIFIED_CLASS_NAME
      });
  const sourceAfter = await readFile(SOURCE_FILE_PATH);
  const testAfter = await readFile(TEST_FILE_PATH);
  const result = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sourceSha256Before: sha256(sourceBefore),
    sourceSha256After: sha256(sourceAfter),
    testSha256Before: sha256(testBefore),
    testSha256After: sha256(testAfter),
    status: feedback.status,
    mavenPhases: feedback.mavenExecutions.map((execution) => ({
      phase: execution.phase,
      exitCode: execution.exitCode
    })),
    relevantMavenOutput: relevantMavenOutput(feedback),
    testReport: feedback.testReport ?? null,
    diagnostic: diagnostic ? compactDiagnostic(diagnostic) : null
  };
  const resultPath = join(resultDirectory, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`REAL_TASK_SERVICE_REPAIR_RESULT=${resultPath}\n`);

  assert.equal(sha256(sourceAfter), sha256(sourceBefore), 'TaskService.java changed.');
  assert.equal(sha256(testAfter), sha256(testBefore), 'Maven validation changed the test.');
  assert.equal(feedback.status, 'passed', JSON.stringify(result.diagnostic));
  assert.ok(feedback.testReport, 'Passing Maven feedback has no Surefire report.');
  assert.equal(feedback.testReport.failures, 0);
  assert.equal(feedback.testReport.errors, 0);
  assert.ok(feedback.testReport.generatedTests > feedback.testReport.generatedSkipped);
});

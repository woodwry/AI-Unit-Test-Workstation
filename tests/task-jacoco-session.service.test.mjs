import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ClassCoverageLedgerService
} from '../src/main/services/class-coverage-ledger.service.ts';
import {
  JacocoArtifactsService
} from '../src/main/services/jacoco-artifacts.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import {
  TaskJacocoSessionService
} from '../src/main/services/task-jacoco-session.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_IDS = [
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555'
];

const buildSettings = {
  mavenHome: 'C:/tools/maven',
  javaHome: 'C:/tools/java',
  settingsPath: null,
  localRepository: null
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactCounts(coveredLines, coveredBranches) {
  return {
    lineCovered: coveredLines.length,
    lineMissed: 3 - coveredLines.length,
    lineTotal: 3,
    branchCovered: coveredBranches.length,
    branchMissed: 2 - coveredBranches.length,
    branchTotal: 2
  };
}

function branchSnapshot(
  pairId,
  report,
  executionData,
  coveredLines,
  coveredBranches
) {
  const lineTargets = [10, 11, 12].map((line) => ({
    targetId: `method@line:${line}`,
    methodId: 'method',
    decisionId: '',
    instructionIndex: line - 10,
    sourceLine: line,
    kind: 'LINE_EXECUTE',
    direction: 'EXECUTE',
    covered: coveredLines.includes(line),
    mappingStatus: 'EXACT',
    requiredEdgeIds: []
  }));
  const branchTargets = ['B_FALSE', 'B_TRUE'].map((targetId, index) => ({
    targetId,
    methodId: 'method',
    decisionId: 'decision',
    instructionIndex: 3,
    sourceLine: 13,
    kind: 'BRANCH',
    direction: index === 0 ? 'IF_FALSE' : 'IF_TRUE',
    covered: coveredBranches.includes(targetId),
    mappingStatus: 'EXACT',
    requiredEdgeIds: [`edge-${index}`]
  }));
  return {
    schemaVersion: 1,
    pairId,
    targetClass: 'com.example.TaskService',
    targetSourceSha256: sha256('source'),
    targetClassSha256: sha256('class'),
    executionDataSha256: sha256(executionData),
    reportSha256: sha256(report),
    methods: [{
      methodId: 'method',
      methodName: 'execute',
      descriptor: '()V',
      firstLine: 10,
      lastLine: 13,
      mappingStatus: 'EXACT',
      instructions: [],
      decisions: [],
      targets: [...lineTargets, ...branchTargets]
    }]
  };
}

async function writePair(
  paths,
  label,
  coveredLines,
  coveredBranches,
  executionData = 'exec'
) {
  await mkdir(dirname(paths.reportPath), { recursive: true });
  const report = Buffer.from(`<report name="${label}"/>`, 'utf8');
  const pairId = sha256(`pair:${label}`);
  await writeFile(paths.reportPath, report);
  await writeFile(
    paths.branchSnapshotPath,
    JSON.stringify(branchSnapshot(
      pairId,
      report,
      executionData,
      coveredLines,
      coveredBranches
    )),
    'utf8'
  );
  return { ...paths, pairId };
}

function artifact(index) {
  return {
    id: `artifact-${index}`,
    filePath: `C:/tests/TaskService${index}Test.java`,
    testClassName: `TaskService${index}Test`,
    ordinaryTestMethodCount: 3,
    methodIds: [`method-${index}`],
    sha256: String(index).repeat(64),
    sealed: false,
    accepted: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z'
  };
}

async function harness(t, overrides = {}) {
  const moduleRoot = await mkdtemp(join(tmpdir(), 'task-jacoco-session-'));
  t.after(() => rm(moduleRoot, { recursive: true, force: true }));
  const artifacts = overrides.artifactsFactory?.(moduleRoot)
    ?? new JacocoArtifactsService();
  const targetDirectory = artifacts.paths(moduleRoot).targetDirectory;
  const preloadExecutionDataPath = join(
    targetDirectory,
    'ai-unit-test',
    'jacoco',
    'preload',
    'baseline.exec'
  );
  await mkdir(dirname(preloadExecutionDataPath), { recursive: true });
  await writeFile(preloadExecutionDataPath, 'baseline-exec', 'utf8');
  const preloadPairPaths = {
    reportPath: join(targetDirectory, 'preload-class.xml'),
    branchSnapshotPath: join(targetDirectory, 'preload-class.branches.json')
  };
  const baselinePair = await writePair(
    preloadPairPaths,
    'baseline',
    [10],
    ['B_FALSE'],
    'baseline-exec'
  );
  const baselineCoverage = exactCounts([10], ['B_FALSE']);
  const events = [];
  const ledger = new ClassCoverageLedgerService();
  let generatedPair = null;
  let versionIndex = 0;
  const moduleLock = {
    async runExclusive(moduleKey, operation, signal) {
      assert.equal(moduleKey, 'module-key');
      assert.equal(signal?.aborted ?? false, false);
      events.push('lock:start');
      try {
        return await operation();
      } finally {
        events.push('lock:end');
      }
    }
  };
  const maven = overrides.maven ?? {
    async runMavenDirectTestsWithJacocoAppend(
      actualRoot,
      actualSettings,
      testClassNames,
      executionDataPath,
      surefireDirectory,
      options
    ) {
      events.push('maven');
      assert.equal(actualRoot, moduleRoot);
      assert.deepEqual(actualSettings, buildSettings);
      assert.deepEqual(testClassNames, ['com.example.TaskService1Test']);
      assert.notEqual(executionDataPath, preloadExecutionDataPath);
      assert.match(surefireDirectory, /33333333-3333-4333-8333-333333333333/);
      assert.equal(options.signal.aborted, false);
      await appendFile(executionDataPath, '|generated', 'utf8');
      return {
        command: 'mvn test', cwd: moduleRoot, exitCode: 0,
        stdout: '', stderr: ''
      };
    }
  };
  const targetReport = overrides.targetReport ?? {
    async generateTargetJacocoReport(request, signal) {
      events.push('target-report');
      assert.equal(signal.aborted, false);
      assert.equal(request.projectPath, moduleRoot);
      assert.equal(request.targetClass, 'com.example.TaskService');
      generatedPair = await writePair(
        {
          reportPath: request.outputPath,
          branchSnapshotPath: request.branchSnapshotOutputPath
        },
        'after-1',
        [10, 11],
        ['B_FALSE', 'B_TRUE'],
        await readFile(request.executionDataPath)
      );
      return {
        generated: true,
        reportPath: generatedPair.reportPath,
        branchSnapshotPath: generatedPair.branchSnapshotPath,
        pairId: generatedPair.pairId,
        targetClass: request.targetClass,
        generatedAt: '2026-08-09T00:00:01.000Z',
        message: 'generated'
      };
    }
  };
  const analyzer = overrides.analyzer ?? {
    async refreshMethodAnalysisCoverage(analysisSessionId, request, signal) {
      events.push('analyzer-refresh');
      assert.equal(analysisSessionId, SESSION_ID);
      assert.equal(request.reportPairId, generatedPair.pairId);
      assert.equal(signal?.aborted ?? false, false);
      return {
        reportPairId: request.reportPairId,
        coverage: exactCounts([10, 11], ['B_FALSE', 'B_TRUE']),
        catalog: {
          analysisSessionId,
          reportPairId: request.reportPairId,
          methods: [],
          warnings: []
        }
      };
    }
  };
  const service = new TaskJacocoSessionService({
    artifacts,
    ledger,
    moduleLock,
    maven,
    targetReport,
    analyzer,
    idFactory: () => VERSION_IDS[versionIndex++]
  });
  const context = {
    taskId: TASK_ID,
    moduleKey: 'module-key',
    moduleRoot,
    targetFilePath: join(
      moduleRoot,
      'src',
      'main',
      'java',
      'com',
      'example',
      'TaskService.java'
    ),
    qualifiedClassName: 'com.example.TaskService',
    analysisSessionId: SESSION_ID,
    buildSettings,
    baselineExecutionDataPath: preloadExecutionDataPath,
    baselinePair,
    baselineCoverage
  };
  return {
    service,
    artifacts,
    ledger,
    context,
    events,
    moduleRoot,
    preloadExecutionDataPath,
    baselinePair
  };
}

test('copies preload exec into a task version and promotes exact coverage after success', async (t) => {
  const {
    service,
    artifacts,
    ledger,
    context,
    events,
    preloadExecutionDataPath
  } = await harness(t);
  await service.initialize(context);

  const result = await service.refreshArtifact(
    context,
    artifact(1),
    new AbortController().signal
  );

  assert.deepEqual(events, [
    'lock:start', 'lock:end',
    'lock:start', 'maven', 'target-report', 'analyzer-refresh', 'lock:end'
  ]);
  assert.equal(await readFile(preloadExecutionDataPath, 'utf8'), 'baseline-exec');
  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);
  assert.equal(
    ledger.baseline(TASK_ID).pair.reportPath,
    taskPaths.baseline.reportPath
  );
  assert.equal(
    await readFile(taskPaths.currentExecutionDataPath, 'utf8'),
    'baseline-exec|generated'
  );
  assert.equal(result.coverage.counts.lineCovered, 2);
  assert.deepEqual(result.coverage.coveredLineIds, ['L10', 'L11']);
  assert.deepEqual(result.coverage.coveredBranchIds, ['B_FALSE', 'B_TRUE']);
  assert.equal(ledger.contributions(TASK_ID)[0].addedLineCount, 1);
  assert.equal(service.currentPair(TASK_ID).pairId, result.pair.pairId);
  assert.equal(service.terminate(TASK_ID).pairId, result.pair.pairId);
});

test('accepted coverage becomes the durable baseline for later files and revoke', async (t) => {
  const { service, artifacts, ledger, context } = await harness(t);
  await service.initialize(context);
  const refreshed = await service.refreshArtifact(
    context,
    artifact(1),
    new AbortController().signal
  );

  const accepted = await service.checkpointAcceptedBaseline(
    context,
    new AbortController().signal
  );

  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);
  assert.equal(
    await readFile(taskPaths.baselineExecutionDataPath, 'utf8'),
    'baseline-exec|generated'
  );
  assert.equal(accepted.context.baselinePair.pairId, refreshed.pair.pairId);
  assert.deepEqual(accepted.coverage.counts, refreshed.coverage.counts);
  assert.deepEqual(ledger.baseline(TASK_ID).counts, refreshed.coverage.counts);
  assert.deepEqual(ledger.artifacts(TASK_ID), []);
  assert.deepEqual(ledger.contributions(TASK_ID), []);

  const revokedNextFiles = await service.recalculate(
    accepted.context,
    [],
    new AbortController().signal
  );
  assert.deepEqual(revokedNextFiles.coverage.counts, refreshed.coverage.counts);
  assert.equal(
    await readFile(taskPaths.currentExecutionDataPath, 'utf8'),
    'baseline-exec|generated'
  );
});

test('rebinds an initialized task JaCoCo session to a replacement Analyzer session', async (t) => {
  const replacementSessionId = '99999999-9999-4999-8999-999999999999';
  const analyzerSessionIds = [];
  const { service, context } = await harness(t, {
    analyzer: {
      async refreshMethodAnalysisCoverage(analysisSessionId, request) {
        analyzerSessionIds.push(analysisSessionId);
        return {
          reportPairId: request.reportPairId,
          coverage: exactCounts([10], ['B_FALSE']),
          catalog: {
            analysisSessionId,
            reportPairId: request.reportPairId,
            methods: [],
            warnings: []
          }
        };
      }
    }
  });
  await service.initialize(context);

  service.rebindAnalysisSession(TASK_ID, replacementSessionId);
  await service.recalculate(
    { ...context, analysisSessionId: replacementSessionId },
    [],
    new AbortController().signal
  );

  assert.deepEqual(analyzerSessionIds, [replacementSessionId]);
});

test('recalculating with no formal files restores the task baseline and refreshes Analyzer', async (t) => {
  const analyzerRequests = [];
  const analyzer = {
    async refreshMethodAnalysisCoverage(analysisSessionId, request) {
      analyzerRequests.push({ analysisSessionId, request });
      return {
        reportPairId: request.reportPairId,
        coverage: exactCounts([10], ['B_FALSE']),
        catalog: {
          analysisSessionId,
          reportPairId: request.reportPairId,
          methods: [],
          warnings: []
        }
      };
    }
  };
  const { service, artifacts, ledger, context } = await harness(t, { analyzer });
  await service.initialize(context);

  const result = await service.recalculate(
    context,
    [],
    new AbortController().signal
  );

  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);
  assert.equal(analyzerRequests.length, 1);
  assert.equal(
    analyzerRequests[0].request.reportPath,
    taskPaths.baseline.reportPath
  );
  assert.equal(result.pair.pairId, context.baselinePair.pairId);
  assert.deepEqual(ledger.artifacts(TASK_ID), []);
  assert.equal(await readFile(taskPaths.currentExecutionDataPath, 'utf8'), 'baseline-exec');
});

test('cancellation arriving after atomic promotion keeps the newly committed state', async (t) => {
  const controller = new AbortController();
  const { service, artifacts, ledger, context } = await harness(t);
  await service.initialize(context);
  const originalPromote = artifacts.promoteTaskVersion.bind(artifacts);
  artifacts.promoteTaskVersion = async (...args) => {
    const pair = await originalPromote(...args);
    controller.abort(new Error('late cancellation'));
    return pair;
  };

  const result = await service.refreshArtifact(
    context,
    artifact(1),
    controller.signal
  );

  assert.equal(result.coverage.counts.lineCovered, 2);
  assert.equal(ledger.artifacts(TASK_ID).length, 1);
  assert.equal(service.currentPair(TASK_ID).pairId, result.pair.pairId);
});

test('failed Maven coverage refresh preserves the previous pair, exec, and ledger', async (t) => {
  let targetCalls = 0;
  const failingMaven = {
    async runMavenDirectTestsWithJacocoAppend(
      moduleRoot,
      settings,
      testNames,
      executionDataPath
    ) {
      await appendFile(executionDataPath, '|failed-run', 'utf8');
      return {
        command: 'mvn test', cwd: moduleRoot, exitCode: 1,
        stdout: '', stderr: 'failed'
      };
    }
  };
  const harnessValue = await harness(t, {
    maven: failingMaven,
    targetReport: {
      async generateTargetJacocoReport() {
        targetCalls++;
        throw new Error('must not run');
      }
    }
  });
  const { service, artifacts, ledger, context } = harnessValue;
  await service.initialize(context);
  const beforePair = service.currentPair(TASK_ID);
  const beforeLedger = ledger.snapshot(TASK_ID);
  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);
  const beforeExec = await readFile(taskPaths.currentExecutionDataPath, 'utf8');

  await assert.rejects(
    service.refreshArtifact(
      context,
      artifact(1),
      new AbortController().signal
    ),
    /Maven.*failed|exit.*1/i
  );

  assert.equal(targetCalls, 0);
  assert.deepEqual(service.currentPair(TASK_ID), beforePair);
  assert.deepEqual(ledger.snapshot(TASK_ID), beforeLedger);
  assert.equal(await readFile(taskPaths.currentExecutionDataPath, 'utf8'), beforeExec);
});

test('recalculates multiple formal files in order from a private baseline exec copy', async (t) => {
  const executionInputs = [];
  const generatedCoverage = new Map();
  let reportIndex = 0;
  const maven = {
    async runMavenDirectTestsWithJacocoAppend(
      moduleRoot,
      settings,
      testNames,
      executionDataPath
    ) {
      executionInputs.push({
        testName: testNames[0],
        before: await readFile(executionDataPath, 'utf8')
      });
      await appendFile(executionDataPath, `|${testNames[0]}`, 'utf8');
      return {
        command: 'mvn test', cwd: moduleRoot, exitCode: 0,
        stdout: '', stderr: ''
      };
    }
  };
  const targetReport = {
    async generateTargetJacocoReport(request) {
      reportIndex++;
      const coveredLines = reportIndex === 1 ? [10, 11] : [10, 11, 12];
      const coveredBranches = ['B_FALSE', 'B_TRUE'];
      const pair = await writePair(
        {
          reportPath: request.outputPath,
          branchSnapshotPath: request.branchSnapshotOutputPath
        },
        `recalculated-${reportIndex}`,
        coveredLines,
        coveredBranches,
        await readFile(request.executionDataPath)
      );
      generatedCoverage.set(pair.pairId, exactCounts(coveredLines, coveredBranches));
      return {
        generated: true,
        ...pair,
        targetClass: request.targetClass,
        generatedAt: `2026-08-09T00:00:0${reportIndex}.000Z`,
        message: 'generated'
      };
    }
  };
  const analyzer = {
    async refreshMethodAnalysisCoverage(analysisSessionId, request) {
      return {
        reportPairId: request.reportPairId,
        coverage: generatedCoverage.get(request.reportPairId),
        catalog: {
          analysisSessionId,
          reportPairId: request.reportPairId,
          methods: [],
          warnings: []
        }
      };
    }
  };
  const { service, artifacts, ledger, context } = await harness(t, {
    maven,
    targetReport,
    analyzer
  });
  await service.initialize(context);

  const result = await service.recalculate(
    context,
    [artifact(1), artifact(2)],
    new AbortController().signal
  );

  assert.deepEqual(executionInputs, [
    {
      testName: 'com.example.TaskService1Test',
      before: 'baseline-exec'
    },
    {
      testName: 'com.example.TaskService2Test',
      before: 'baseline-exec|com.example.TaskService1Test'
    }
  ]);
  assert.deepEqual(
    result.contributions.map((item) => ({
      artifactId: item.artifactId,
      addedLineCount: item.addedLineCount,
      addedBranchCount: item.addedBranchCount
    })),
    [
      { artifactId: 'artifact-1', addedLineCount: 1, addedBranchCount: 1 },
      { artifactId: 'artifact-2', addedLineCount: 1, addedBranchCount: 0 }
    ]
  );
  assert.deepEqual(ledger.artifacts(TASK_ID), [
    { id: 'artifact-1', filePath: 'C:/tests/TaskService1Test.java' },
    { id: 'artifact-2', filePath: 'C:/tests/TaskService2Test.java' }
  ]);
  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);
  assert.equal(
    await readFile(taskPaths.currentExecutionDataPath, 'utf8'),
    'baseline-exec|com.example.TaskService1Test|com.example.TaskService2Test'
  );
  assert.equal(result.coverage.counts.lineCovered, 3);
  assert.equal(service.currentPair(TASK_ID).pairId, result.pair.pairId);
});

test('restores Analyzer when exact snapshot validation fails after refresh', async (t) => {
  const analyzerRequests = [];
  const analyzer = {
    async refreshMethodAnalysisCoverage(analysisSessionId, request) {
      analyzerRequests.push(request);
      const restoringBaseline = analyzerRequests.length > 1;
      return {
        reportPairId: request.reportPairId,
        coverage: restoringBaseline
          ? exactCounts([10], ['B_FALSE'])
          : exactCounts([10, 11, 12], ['B_FALSE', 'B_TRUE']),
        catalog: {
          analysisSessionId,
          reportPairId: request.reportPairId,
          methods: [],
          warnings: []
        }
      };
    }
  };
  const { service, artifacts, ledger, context } = await harness(t, { analyzer });
  await service.initialize(context);
  const beforePair = service.currentPair(TASK_ID);
  const beforeLedger = ledger.snapshot(TASK_ID);
  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);
  const beforeExec = await readFile(taskPaths.currentExecutionDataPath, 'utf8');

  await assert.rejects(
    service.refreshArtifact(
      context,
      artifact(1),
      new AbortController().signal
    ),
    /exact counters do not match/i
  );

  assert.equal(analyzerRequests.length, 2);
  assert.notEqual(analyzerRequests[0].reportPairId, beforePair.pairId);
  assert.equal(analyzerRequests[1].reportPairId, beforePair.pairId);
  assert.deepEqual(service.currentPair(TASK_ID), beforePair);
  assert.deepEqual(ledger.snapshot(TASK_ID), beforeLedger);
  assert.equal(await readFile(taskPaths.currentExecutionDataPath, 'utf8'), beforeExec);
});

test('a failed three-file task promotion restores the previous exec and pair', async (t) => {
  let failPromotion = false;
  let taskPaths;
  const artifactsFactory = (moduleRoot) => {
    taskPaths = new JacocoArtifactsService().taskSessionPaths(moduleRoot, TASK_ID);
    return new JacocoArtifactsService({
      ...fs,
      rename: async (source, destination) => {
        if (
          failPromotion
          && destination === taskPaths.current.branchSnapshotPath
          && String(source).includes('.snapshot.tmp')
        ) {
          throw new Error('injected task snapshot commit failure');
        }
        return fs.rename(source, destination);
      }
    });
  };
  const { service, context } = await harness(t, { artifactsFactory });
  await service.initialize(context);
  const beforePair = service.currentPair(TASK_ID);
  const beforeFiles = await Promise.all([
    readFile(taskPaths.currentExecutionDataPath),
    readFile(taskPaths.current.reportPath),
    readFile(taskPaths.current.branchSnapshotPath)
  ]);
  failPromotion = true;

  await assert.rejects(
    service.refreshArtifact(
      context,
      artifact(1),
      new AbortController().signal
    ),
    /injected task snapshot commit failure/
  );

  assert.deepEqual(service.currentPair(TASK_ID), beforePair);
  assert.deepEqual(
    await Promise.all([
      readFile(taskPaths.currentExecutionDataPath),
      readFile(taskPaths.current.reportPath),
      readFile(taskPaths.current.branchSnapshotPath)
    ]),
    beforeFiles
  );
  assert.deepEqual(
    (await readdir(taskPaths.taskDirectory)).filter((name) =>
      name.endsWith('.tmp') || name.endsWith('.bak')
    ),
    []
  );
});

test('keeps task backups when a failed promotion cannot fully roll back', async (t) => {
  let injectFailures = false;
  let taskPaths;
  const artifactsFactory = (moduleRoot) => {
    taskPaths = new JacocoArtifactsService().taskSessionPaths(moduleRoot, TASK_ID);
    return new JacocoArtifactsService({
      ...fs,
      rename: async (source, destination) => {
        if (
          injectFailures
          && destination === taskPaths.current.branchSnapshotPath
          && String(source).includes('.snapshot.tmp')
        ) {
          throw new Error('injected task snapshot commit failure');
        }
        if (
          injectFailures
          && destination === taskPaths.current.reportPath
          && String(source).includes('.report.bak')
        ) {
          throw new Error('injected task report rollback failure');
        }
        return fs.rename(source, destination);
      }
    });
  };
  const { service, context } = await harness(t, { artifactsFactory });
  await service.initialize(context);
  injectFailures = true;

  await assert.rejects(
    service.refreshArtifact(
      context,
      artifact(1),
      new AbortController().signal
    ),
    (error) => error instanceof AggregateError
      && /rollback was incomplete/i.test(error.message)
  );

  const reportBackup = (await readdir(taskPaths.taskDirectory))
    .find((name) => name.endsWith('.report.bak'));
  assert.ok(reportBackup, 'the recoverable previous report backup must remain');
  assert.equal(
    await readFile(join(taskPaths.taskDirectory, reportBackup), 'utf8'),
    '<report name="baseline"/>'
  );
});

test('backup cleanup failure cannot turn a committed task promotion into failure', async (t) => {
  let failBackupCleanup = false;
  const artifactsFactory = () => new JacocoArtifactsService({
    ...fs,
    rm: async (path, options) => {
      if (failBackupCleanup && String(path).endsWith('.bak')) {
        throw Object.assign(new Error('injected backup cleanup lock'), {
          code: 'EBUSY'
        });
      }
      return fs.rm(path, options);
    }
  });
  const { service, ledger, context } = await harness(t, { artifactsFactory });
  await service.initialize(context);
  const beforePair = service.currentPair(TASK_ID);
  failBackupCleanup = true;

  const result = await service.refreshArtifact(
    context,
    artifact(1),
    new AbortController().signal
  );

  assert.notEqual(result.pair.pairId, beforePair.pairId);
  assert.equal(service.currentPair(TASK_ID).pairId, result.pair.pairId);
  assert.equal(ledger.current(TASK_ID).counts.lineCovered, 2);
});

test('removing a task session deletes its private artifacts and in-memory state', async (t) => {
  const { service, artifacts, ledger, context } = await harness(t);
  await service.initialize(context);
  const taskPaths = artifacts.taskSessionPaths(context.moduleRoot, TASK_ID);

  await service.remove(context);

  await assert.rejects(access(taskPaths.taskDirectory));
  assert.throws(() => service.currentPair(TASK_ID), /not initialized/i);
  assert.throws(() => ledger.current(TASK_ID), /not initialized/i);
});

test('removing a task session bypasses the module queue used by sibling refreshes', async (t) => {
  const { service, context, events } = await harness(t);
  await service.initialize(context);
  events.length = 0;

  await service.remove(context);

  assert.deepEqual(events, []);
});

test('ShellService has a dedicated append-mode JaCoCo command for task-owned exec data', async () => {
  const service = new ShellService();
  let capturedArgs = null;
  service.runMaven = async (workspaceRoot, settings, args) => {
    capturedArgs = args;
    return {
      command: 'mvn test', cwd: workspaceRoot, exitCode: 0,
      stdout: '', stderr: ''
    };
  };

  await service.runMavenDirectTestsWithJacocoAppend(
    'C:/workspace/module',
    buildSettings,
    ['com.example.TaskService1Test'],
    'C:/workspace/module/target/task.exec',
    'C:/workspace/module/target/task-reports'
  );

  assert.ok(capturedArgs.includes('-Djacoco.append=true'));
  assert.ok(capturedArgs.includes('-Djacoco.destFile=C:/workspace/module/target/task.exec'));
  assert.equal(capturedArgs.some((argument) => /(?:^|:)clean$/.test(argument)), false);
});

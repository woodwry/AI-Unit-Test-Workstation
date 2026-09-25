import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { JacocoArtifactsService } from '../src/main/services/jacoco-artifacts.service.ts';
import { ModuleOperationLock } from '../src/main/services/module-operation-lock.service.ts';
import { ModulePreloadCacheStore } from '../src/main/services/module-preload-cache.store.ts';
import { ModulePreloadCoordinator } from '../src/main/services/module-preload-coordinator.service.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function commandResult(overrides = {}) {
  return {
    command: 'mvn.cmd -s public-settings.xml test-compile jacoco:prepare-agent surefire:test',
    cwd: 'D:\\work\\orders',
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides
  };
}

function makeAbortError(message = 'Maven 执行已停止。') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

async function createHarness(t, options = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'module-preload-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const moduleRoot = join(workspaceRoot, 'orders');
  const sourceRoot = join(moduleRoot, 'src', 'main', 'java', 'com', 'example');
  const compiledClassRoot = join(moduleRoot, 'target', 'classes', 'com', 'example');
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>');
  await writeFile(join(sourceRoot, 'Order.java'), 'class Order {}');
  await writeFile(join(sourceRoot, 'Customer.java'), 'class Customer {}');
  const orderTestPath = join(
    moduleRoot,
    'src',
    'test',
    'java',
    'com',
    'example',
    'OrderTest.java'
  );
  await mkdir(dirname(orderTestPath), { recursive: true });
  await writeFile(orderTestPath, 'package com.example; class OrderTest { Order target; }');

  let fingerprint = options.fingerprint ?? SHA_A;
  let mode = options.mavenMode ?? 'success';
  let releaseMaven;
  let mavenStarted;
  const mavenStartedPromise = new Promise((resolve) => { mavenStarted = resolve; });
  let releaseFingerprint;
  let fingerprintCallCount = 0;
  let fingerprintStarted;
  const fingerprintStartedPromise = new Promise((resolve) => { fingerprintStarted = resolve; });
  let fingerprintCompleted;
  const fingerprintCompletedPromise = new Promise((resolve) => { fingerprintCompleted = resolve; });
  const mavenCalls = [];
  const compileMavenCalls = [];
  const directMavenCalls = [];
  const targetReportCalls = [];
  const targetReportSignals = [];
  const identityService = {
    async resolve(root, sourceFilePath) {
      return {
        moduleKey: moduleRoot.toLowerCase().replaceAll('\\', '/'),
        moduleDisplayPath: moduleRoot,
        pomPath: join(moduleRoot, 'pom.xml'),
        workspaceRoot: root,
        sourceFilePath
      };
    }
  };
  const fingerprintService = {
    async calculate() {
      fingerprintCallCount += 1;
      fingerprintStarted();
      if (
        options.fingerprintMode === 'blocked'
        && (!options.blockFirstFingerprintOnly || fingerprintCallCount === 1)
      ) {
        await new Promise((resolve) => { releaseFingerprint = resolve; });
      }
      fingerprintCompleted();
      return {
        sha256: fingerprint,
        watcherVersion: 1,
        fileCount: 3,
        calculatedAt: '2026-08-09T01:00:00.000Z'
      };
    },
    async calculateClass(input) {
      return {
        sha256: input.qualifiedClassName.endsWith('.Customer') ? SHA_D : SHA_C,
        watcherVersion: 1,
        fileCount: 2,
        calculatedAt: '2026-08-09T01:00:00.000Z'
      };
    }
  };
  const shellService = {
    async runMavenCompile(root, settings, runOptions) {
      compileMavenCalls.push({ root, settings, runOptions });
      productionCompiled = true;
      await mkdir(compiledClassRoot, { recursive: true });
      await Promise.all([
        writeFile(join(compiledClassRoot, 'Order.class'), 'compiled-order'),
        writeFile(join(compiledClassRoot, 'Customer.class'), 'compiled-customer')
      ]);
      return commandResult({ command: 'mvn.cmd compile' });
    },
    async runMavenModuleTestsWithJacoco(root, settings, executionDataPath, surefireDirectory, runOptions) {
      mavenCalls.push({ root, settings, executionDataPath, surefireDirectory, runOptions });
      mavenStarted();
      if (mode === 'blocked') {
        await new Promise((resolve, reject) => {
          releaseMaven = resolve;
          runOptions.signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        });
      }
      if (mode === 'failure') {
        await mkdir(dirname(executionDataPath), { recursive: true });
        await writeFile(executionDataPath, 'candidate must be removed');
        return commandResult({ exitCode: 1, stderr: '  [ERROR] compilation failed\nBearer top-secret-token\n' });
      }
      if (mode === 'missing-exec') return commandResult();
      await mkdir(dirname(executionDataPath), { recursive: true });
      await writeFile(executionDataPath, `exec:${fingerprint}`);
      return commandResult();
    },
    async runMavenDirectTestsWithJacoco(
      root,
      settings,
      testClassNames,
      executionDataPath,
      surefireDirectory,
      runOptions
    ) {
      directMavenCalls.push({
        root,
        settings,
        testClassNames,
        executionDataPath,
        surefireDirectory,
        runOptions
      });
      await mkdir(compiledClassRoot, { recursive: true });
      await writeFile(join(compiledClassRoot, 'Order.class'), 'compiled-order');
      await mkdir(dirname(executionDataPath), { recursive: true });
      await writeFile(executionDataPath, `direct-exec:${fingerprint}`);
      return commandResult({ command: `mvn.cmd -Dtest=${testClassNames.join(',')} surefire:test` });
    }
  };
  let productionCompiled = false;
  const directTestLocator = {
    async find(_root, _targetFilePath, targetClassName) {
      if (targetClassName !== 'Order') return [];
      return [{
        className: 'OrderTest',
        qualifiedName: 'com.example.OrderTest',
        filePath: orderTestPath
      }];
    }
  };
  const targetReport = {
    async generateTargetJacocoReport(request, signal) {
      if (options.requireProductionCompile && !productionCompiled) {
        throw new Error('target report received stale production classes');
      }
      targetReportCalls.push(request);
      targetReportSignals.push(signal);
      if (options.failTargetClass === request.targetClass) {
        throw new Error('java-analyzer report failed');
      }
      await mkdir(dirname(request.outputPath), { recursive: true });
      const report = Buffer.from(`<report name="${request.targetClass}"/>`);
      const pairId = sha256(`${request.targetClass}:${fingerprint}`);
      await writeFile(request.outputPath, report);
      await writeFile(request.branchSnapshotOutputPath, JSON.stringify({
        schemaVersion: 1,
        pairId,
        reportSha256: sha256(report)
      }));
      return {
        generated: true,
        reportPath: request.outputPath,
        branchSnapshotPath: request.branchSnapshotOutputPath,
        pairId,
        targetClass: request.targetClass,
        generatedAt: '2026-08-09T01:02:03.000Z',
        message: ''
      };
    }
  };
  const cache = new ModulePreloadCacheStore(join(workspaceRoot, 'preload-cache.json'));
  const lock = new ModuleOperationLock();
  const coordinator = new ModulePreloadCoordinator({
    identityService,
    fingerprintService,
    cache,
    lock,
    shellService,
    directTestLocator,
    jacocoArtifactsService: new JacocoArtifactsService(),
    targetReport,
    clock: () => new Date('2026-08-09T01:02:03.000Z')
  });
  const requestFor = (fileName = 'Order.java') => ({
    workspaceRoot,
    sourceFilePath: join(sourceRoot, fileName),
    buildSettings: {
      mavenHome: 'D:\\maven',
      javaHome: 'D:\\jdk'
    },
    toolchain: { mavenVersion: '3.9.9', javaVersion: '21.0.7' },
    watcherVersion: 1
  });
  const classRequest = (fileName, qualifiedClassName) => ({
    ...requestFor(fileName),
    qualifiedClassName,
    targetFilePath: join(sourceRoot, fileName)
  });
  return {
    cache,
    classRequest,
    customerClassPath: join(compiledClassRoot, 'Customer.class'),
    coordinator,
    compileMavenCalls,
    getFingerprint: () => fingerprint,
    identityService,
    lock,
    directMavenCalls,
    mavenCalls,
    mavenStartedPromise,
    moduleKey: moduleRoot.toLowerCase().replaceAll('\\', '/'),
    moduleRoot,
    orderTestPath,
    releaseMaven: () => releaseMaven?.(),
    releaseFingerprint: () => releaseFingerprint?.(),
    requestFor,
    setFingerprint: (value) => { fingerprint = value; },
    setMavenMode: (value) => { mode = value; },
    fingerprintStartedPromise,
    fingerprintCompletedPromise,
    targetReportCalls,
    targetReportSignals
  };
}

async function waitFor(condition, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

test('class report fingerprint probe never executes Maven or creates a JaCoCo report', async (t) => {
  const harness = await createHarness(t);

  const fingerprint = await harness.coordinator.calculateClassReportFingerprint(
    harness.classRequest('Order.java', 'com.example.Order')
  );

  assert.equal(fingerprint.sha256, SHA_C);
  assert.equal(harness.mavenCalls.length, 0);
  assert.equal(harness.directMavenCalls.length, 0);
  assert.equal(harness.targetReportCalls.length, 0);
});

test('class report preparation runs only target-class tests and never the full module suite', async (t) => {
  // Mutation caught: delegating class preparation back to ensureReady() would execute the module suite.
  const harness = await createHarness(t);

  const first = await harness.coordinator.prepareClassReport(
    harness.classRequest('Order.java', 'com.example.Order')
  );
  const reused = await harness.coordinator.prepareClassReport(
    harness.classRequest('Order.java', 'com.example.Order')
  );

  assert.equal(harness.mavenCalls.length, 0);
  assert.equal(harness.directMavenCalls.length, 1);
  assert.deepEqual(
    harness.directMavenCalls[0].testClassNames,
    ['com.example.OrderTest']
  );
  assert.equal(first.executionDataPath, harness.directMavenCalls[0].executionDataPath);
  assert.equal(reused.reportPairId, first.reportPairId);
});

test('class report refresh omits exact pending files from Maven but includes an externally edited file', async (t) => {
  const pending = await createHarness(t);
  const pendingContent = await readFile(pending.orderTestPath);
  await pending.coordinator.prepareClassReport({
    ...pending.classRequest('Order.java', 'com.example.Order'),
    excludedDirectTestArtifacts: [{
      path: pending.orderTestPath,
      sha256: sha256(pendingContent)
    }]
  });

  assert.equal(pending.directMavenCalls.length, 0);
  assert.equal(pending.compileMavenCalls.length, 1);

  await pending.coordinator.prepareClassReport(
    pending.classRequest('Order.java', 'com.example.Order')
  );
  assert.deepEqual(
    pending.directMavenCalls.map((call) => call.testClassNames),
    [['com.example.OrderTest']]
  );
  assert.equal(pending.compileMavenCalls.length, 1);

  const edited = await createHarness(t);
  const originalContent = await readFile(edited.orderTestPath);
  await writeFile(
    edited.orderTestPath,
    'package com.example; class OrderTest { Order target; void userEdit() {} }'
  );
  await edited.coordinator.prepareClassReport({
    ...edited.classRequest('Order.java', 'com.example.Order'),
    excludedDirectTestArtifacts: [{
      path: edited.orderTestPath,
      sha256: sha256(originalContent)
    }]
  });

  assert.deepEqual(
    edited.directMavenCalls.map((call) => call.testClassNames),
    [['com.example.OrderTest']]
  );
  assert.equal(edited.compileMavenCalls.length, 0);
});

test('forced class report refresh bypasses a valid-looking cached pair and reruns only that class', async (t) => {
  const harness = await createHarness(t);
  const request = harness.classRequest('Order.java', 'com.example.Order');

  const cached = await harness.coordinator.prepareClassReport(request);
  const refreshed = await harness.coordinator.refreshClassReport(request);

  assert.equal(harness.mavenCalls.length, 0);
  assert.equal(harness.directMavenCalls.length, 2);
  assert.equal(harness.targetReportCalls.length, 2);
  assert.equal(refreshed.qualifiedClassName, cached.qualifiedClassName);
  assert.equal(refreshed.fingerprint, cached.fingerprint);
});

test('forced class report refresh preserves cached reports for sibling classes', async (t) => {
  const harness = await createHarness(t);
  const orderRequest = harness.classRequest('Order.java', 'com.example.Order');
  const customerRequest = harness.classRequest('Customer.java', 'com.example.Customer');

  await harness.coordinator.prepareClassReport(orderRequest);
  const sibling = await harness.coordinator.prepareClassReport(customerRequest);
  const siblingReport = await readFile(sibling.reportPath, 'utf8');

  await harness.coordinator.refreshClassReport(orderRequest);

  const snapshot = await harness.cache.get(harness.moduleKey);
  assert.equal(
    snapshot.classReportPairs['com.example.Customer'].reportPairId,
    sibling.reportPairId
  );
  assert.equal(await readFile(sibling.reportPath, 'utf8'), siblingReport);
});

test('class report without direct tests compiles production sources before reading class files', async (t) => {
  const harness = await createHarness(t, { requireProductionCompile: true });

  const pair = await harness.coordinator.prepareClassReport(
    harness.classRequest('Customer.java', 'com.example.Customer')
  );

  assert.equal(pair.qualifiedClassName, 'com.example.Customer');
  assert.equal(harness.compileMavenCalls.length, 1);
  assert.equal(harness.directMavenCalls.length, 0);
  assert.equal(harness.targetReportCalls.length, 1);
});

test('missing compiled target invalidates the cached class report and recompiles only that class', async (t) => {
  const harness = await createHarness(t, { requireProductionCompile: true });
  const request = harness.classRequest('Customer.java', 'com.example.Customer');

  const cached = await harness.coordinator.prepareClassReport(request);
  await rm(harness.customerClassPath, { force: true });
  const rebuilt = await harness.coordinator.prepareClassReport(request);

  assert.equal(harness.mavenCalls.length, 0);
  assert.equal(harness.directMavenCalls.length, 0);
  assert.equal(harness.compileMavenCalls.length, 2);
  assert.equal(harness.targetReportCalls.length, 2);
  assert.equal(rebuilt.qualifiedClassName, cached.qualifiedClassName);
});

test('two classes share one running preload and create distinct class report pairs', async (t) => {
  const harness = await createHarness(t);
  const [first, second] = await Promise.all([
    harness.coordinator.ensureReady(harness.requestFor('Order.java')),
    harness.coordinator.ensureReady(harness.requestFor('Customer.java'))
  ]);

  assert.equal(harness.mavenCalls.length, 1);
  assert.equal(first.fingerprint, second.fingerprint);
  const [pairA, pairB] = await Promise.all([
    harness.coordinator.prepareClassReport(harness.classRequest('Order.java', 'com.example.Order')),
    harness.coordinator.prepareClassReport(harness.classRequest('Customer.java', 'com.example.Customer'))
  ]);
  assert.equal(harness.targetReportCalls.length, 2);
  assert.notEqual(pairA.reportPairId, pairB.reportPairId);
  assert.equal(await readFile(first.executionDataPath, 'utf8'), `exec:${SHA_A}`);
});

test('class report generation receives the task cancellation signal', async (t) => {
  const harness = await createHarness(t);
  const controller = new AbortController();

  await harness.coordinator.prepareClassReport(
    harness.classRequest('Order.java', 'com.example.Order'),
    controller.signal
  );

  assert.equal(harness.targetReportSignals[0], controller.signal);
});

test('ready cache is reused, but a changed fingerprint runs one replacement preload', async (t) => {
  const harness = await createHarness(t);
  await harness.coordinator.ensureReady(harness.requestFor());
  await harness.coordinator.ensureReady(harness.requestFor());
  assert.equal(harness.mavenCalls.length, 1);

  harness.setFingerprint(SHA_B);
  const [first, second] = await Promise.all([
    harness.coordinator.ensureReady(harness.requestFor('Order.java')),
    harness.coordinator.ensureReady(harness.requestFor('Customer.java'))
  ]);

  assert.equal(harness.mavenCalls.length, 2);
  assert.equal(first.fingerprint, SHA_B);
  assert.equal(second.fingerprint, SHA_B);
});

test('a changed fingerprint waits for the current owner and starts at most one replacement', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'blocked' });
  const first = harness.coordinator.ensureReady(harness.requestFor('Order.java'));
  await harness.mavenStartedPromise;
  harness.setFingerprint(SHA_B);
  harness.setMavenMode('success');
  const second = harness.coordinator.ensureReady(harness.requestFor('Customer.java'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.mavenCalls.length, 1);

  harness.releaseMaven();
  await Promise.all([first, second]);
  assert.equal(harness.mavenCalls.length, 2);
});

test('aborting one waiter releases it without stopping the shared Maven preload', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'blocked' });
  const owner = harness.coordinator.ensureReady(harness.requestFor('Order.java'));
  await harness.mavenStartedPromise;

  const controller = new AbortController();
  const removal = new Error('Class task was removed.');
  const waiter = harness.coordinator.ensureReady(
    harness.requestFor('Customer.java'),
    controller.signal
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(removal);

  const earlyOutcome = await Promise.race([
    waiter.then(
      () => ({ status: 'fulfilled' }),
      (reason) => ({ status: 'rejected', reason })
    ),
    new Promise((resolve) => setImmediate(() => resolve({ status: 'pending' })))
  ]);
  harness.releaseMaven();
  const [ownerOutcome, waiterOutcome] = await Promise.allSettled([owner, waiter]);

  assert.equal(earlyOutcome.status, 'rejected');
  assert.equal(earlyOutcome.reason, removal);
  assert.equal(ownerOutcome.status, 'fulfilled');
  assert.equal(ownerOutcome.value.state, 'READY');
  assert.equal(waiterOutcome.status, 'rejected');
  assert.equal(waiterOutcome.reason, removal);
  assert.equal(harness.mavenCalls.length, 1);
});

test('aborting during fingerprint calculation never starts an unowned Maven preload', async (t) => {
  const harness = await createHarness(t, { fingerprintMode: 'blocked' });
  const controller = new AbortController();
  const removal = new Error('Class task was removed.');
  const pending = harness.coordinator.ensureReady(
    harness.requestFor('Order.java'),
    controller.signal
  );
  await harness.fingerprintStartedPromise;

  controller.abort(removal);
  await assert.rejects(pending, (error) => error === removal);
  harness.releaseFingerprint();
  await harness.fingerprintCompletedPromise;
  for (let attempt = 0; attempt < 5_000 && harness.mavenCalls.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(harness.mavenCalls.length, 0);
});

test('failed unchanged fingerprint waits for manual retry and never returns stale reports', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'failure' });
  await assert.rejects(
    harness.coordinator.ensureReady(harness.requestFor()),
    /orders[\s\S]*请修复该模块后重新检测。/
  );
  await assert.rejects(
    harness.coordinator.ensureReady(harness.requestFor()),
    /请修复该模块后重新检测。/
  );

  assert.equal(harness.mavenCalls.length, 1);
  const failed = await harness.cache.get(harness.moduleKey);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.executionDataPath, null);
  assert.deepEqual(failed.classReportPairs, {});
  assert.doesNotMatch(failed.diagnostic.summary, /top-secret-token/);

  harness.setMavenMode('success');
  await harness.coordinator.retry(harness.moduleKey);
  const retried = await harness.coordinator.ensureReady(harness.requestFor());
  assert.equal(retried.state, 'READY');
  assert.equal(harness.mavenCalls.length, 2);
});

test('a failed module automatically retries when its fingerprint changes', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'failure' });
  await assert.rejects(harness.coordinator.ensureReady(harness.requestFor()));
  harness.setFingerprint(SHA_B);
  harness.setMavenMode('success');

  const ready = await harness.coordinator.ensureReady(harness.requestFor());
  assert.equal(ready.fingerprint, SHA_B);
  assert.equal(harness.mavenCalls.length, 2);
});

test('a successful Maven exit without a valid exec reports the real artifact failure', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'missing-exec' });

  await assert.rejects(
    harness.coordinator.ensureReady(harness.requestFor()),
    /命令：[\s\S]*mvn\.cmd[\s\S]*(?:JaCoCo exec|ENOENT)/
  );

  const failed = await harness.cache.get(harness.moduleKey);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.executionDataPath, null);
  assert.match(failed.diagnostic.summary, /JaCoCo exec|ENOENT/);
});

test('stopping without an active preload preserves a READY cache for the next launch', async (t) => {
  const harness = await createHarness(t);
  const ready = await harness.coordinator.ensureReady(harness.requestFor());

  await harness.coordinator.stop(harness.moduleKey);

  const retained = await harness.cache.get(harness.moduleKey);
  assert.equal(retained.state, 'READY');
  assert.equal(retained.fingerprint, ready.fingerprint);
  assert.equal(retained.executionDataPath, ready.executionDataPath);
});

test('stopping without an active preload preserves a FAILED cache until manual retry', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'failure' });
  await assert.rejects(harness.coordinator.ensureReady(harness.requestFor()));
  const failed = await harness.cache.get(harness.moduleKey);

  await harness.coordinator.stop(harness.moduleKey);

  const retained = await harness.cache.get(harness.moduleKey);
  assert.equal(retained.state, 'FAILED');
  assert.equal(retained.fingerprint, failed.fingerprint);
  assert.deepEqual(retained.diagnostic, failed.diagnostic);
});

test('stopping a shared preload retains its fingerprint and waits for manual retry while unchanged', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'blocked' });
  const first = harness.coordinator.ensureReady(harness.requestFor('Order.java'));
  const second = harness.coordinator.ensureReady(harness.requestFor('Customer.java'));
  const firstStopped = assert.rejects(first, /已停止/);
  const secondStopped = assert.rejects(second, /已停止/);
  await harness.mavenStartedPromise;

  await harness.coordinator.stop(harness.moduleKey);
  await Promise.all([firstStopped, secondStopped]);
  const stopped = await harness.cache.get(harness.moduleKey);
  assert.equal(stopped.state, 'IDLE');
  assert.equal(stopped.fingerprint, SHA_A);

  harness.setMavenMode('success');
  await assert.rejects(harness.coordinator.ensureReady(harness.requestFor()), /stopped|\u5df2\u505c\u6b62/i);
  assert.equal(harness.mavenCalls.length, 1);

  await harness.coordinator.retry(harness.moduleKey);
  const retried = await harness.coordinator.ensureReady(harness.requestFor());
  assert.equal(retried.state, 'READY');
  assert.equal(harness.mavenCalls.length, 2);
});

test('a manually stopped preload automatically retries when its fingerprint changes', async (t) => {
  const harness = await createHarness(t, { mavenMode: 'blocked' });
  const pending = harness.coordinator.ensureReady(harness.requestFor());
  const stopped = assert.rejects(pending, /\u5df2\u505c\u6b62/);
  await harness.mavenStartedPromise;
  await harness.coordinator.stop(harness.moduleKey);
  await stopped;

  harness.setFingerprint(SHA_B);
  harness.setMavenMode('success');
  const ready = await harness.coordinator.ensureReady(harness.requestFor());

  assert.equal(ready.state, 'READY');
  assert.equal(ready.fingerprint, SHA_B);
  assert.equal(harness.mavenCalls.length, 2);
});

test('stopping a preload queued behind the module owner never starts Maven and persists IDLE', async (t) => {
  const harness = await createHarness(t);
  let releaseOwner;
  const owner = harness.lock.runExclusive(harness.moduleKey, async () => {
    await new Promise((resolve) => { releaseOwner = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = harness.coordinator.ensureReady(harness.requestFor());
  const stopped = assert.rejects(pending, /已停止/);
  await waitFor(
    () => harness.coordinator.inFlight.has(harness.moduleKey),
    'preload never entered the module queue'
  );

  const stopping = harness.coordinator.stop(harness.moduleKey);
  await stopped;
  const snapshot = await harness.cache.get(harness.moduleKey);
  releaseOwner();
  await Promise.all([owner, stopping]);
  assert.equal(snapshot?.state, 'IDLE');
  assert.equal(harness.mavenCalls.length, 0);
});

test('stop cancels a waiter that is still calculating its module fingerprint', async (t) => {
  const harness = await createHarness(t, { fingerprintMode: 'blocked' });
  const pending = harness.coordinator.ensureReady(harness.requestFor());
  const stopped = assert.rejects(pending, /已停止/);
  await harness.fingerprintStartedPromise;

  await harness.coordinator.stop(harness.moduleKey);
  harness.releaseFingerprint();
  await stopped;

  assert.equal((await harness.cache.get(harness.moduleKey))?.state, 'IDLE');
  assert.equal(harness.mavenCalls.length, 0);
});

test('an obsolete fingerprint waiter cannot erase a newer READY preload after stop', async (t) => {
  const harness = await createHarness(t, {
    fingerprintMode: 'blocked',
    blockFirstFingerprintOnly: true
  });
  const obsolete = harness.coordinator.ensureReady(harness.requestFor());
  const obsoleteStopped = assert.rejects(obsolete, {
    name: 'ModulePreloadStoppedError'
  });
  await harness.fingerprintStartedPromise;

  await harness.coordinator.stop(harness.moduleKey);
  harness.setFingerprint(SHA_B);
  const newer = await harness.coordinator.ensureReady(harness.requestFor());
  assert.equal(newer.state, 'READY');
  assert.equal(newer.fingerprint, SHA_B);

  harness.releaseFingerprint();
  await obsoleteStopped;

  const retained = await harness.cache.get(harness.moduleKey);
  assert.equal(retained.state, 'READY');
  assert.equal(retained.fingerprint, SHA_B);
  assert.equal(retained.executionDataPath, newer.executionDataPath);
  assert.equal(harness.mavenCalls.length, 1);
});

test('one class report failure preserves the sibling class report and its execution data', async (t) => {
  const harness = await createHarness(t, { failTargetClass: 'com.example.Customer' });
  const sibling = await harness.coordinator.prepareClassReport(
    harness.classRequest('Order.java', 'com.example.Order')
  );
  await assert.rejects(
    harness.coordinator.prepareClassReport(
      harness.classRequest('Customer.java', 'com.example.Customer')
    ),
    /java-analyzer report failed/
  );

  const snapshot = await harness.cache.get(harness.moduleKey);
  assert.equal(snapshot.state, 'READY');
  assert.equal(snapshot.classReportPairs['com.example.Order'].reportPairId, sibling.reportPairId);
  assert.equal(snapshot.classPreloadFailures['com.example.Customer'], undefined);
  assert.equal(snapshot.executionDataPath, sibling.executionDataPath);
  assert.equal(await readFile(sibling.executionDataPath, 'utf8'), `direct-exec:${SHA_A}`);
});

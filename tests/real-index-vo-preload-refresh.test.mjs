import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { AiClient } from '../src/main/services/ai-client.ts';
import { createProductionClassTaskRuntime } from '../src/main/services/class-task-runtime.service.ts';
import { JacocoArtifactsService } from '../src/main/services/jacoco-artifacts.service.ts';
import { MavenAnalysisContextService } from '../src/main/services/maven-analysis-context.service.ts';
import { ModelCallLogSettingsService } from '../src/main/services/model-call-log-settings.service.ts';
import { ShellService } from '../src/main/services/shell.service.ts';
import { SurefireReportService } from '../src/main/services/surefire-report.service.ts';
import { TestWriterService } from '../src/main/services/test-writer.service.ts';
import { WorkstationBuildSettingsService } from '../src/main/services/workstation-build-settings.service.ts';
import { WorkstationModelInterfaceCredentialsStore } from '../src/main/services/workstation-model-interface-credentials.store.ts';
import { WorkstationModelInterfacesService } from '../src/main/services/workstation-model-interfaces.service.ts';
import { WorkstationModelInterfacesStore } from '../src/main/services/workstation-model-interfaces.store.ts';

const RUN_REAL_TEST = process.env.RUN_REAL_INDEX_VO_PRELOAD_REFRESH === '1';
const WORKSPACE_ROOT = 'D:\\DTSZTMP\\collection';
const INDEX_VO_FQN = 'com.dtsz.collection.view.vo.IndexVO';
const INDEX_VO_TASK_ID = 'c7087da0-504e-478c-8c92-87522cd90fe3';
const USER_DATA_DIRECTORY = process.env.WORKSTATION_USER_DATA_DIRECTORY
  ?? 'C:\\Users\\wry\\AppData\\Roaming\\ai-unit-test-workstation';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:18000';
const JAVA_ANALYZER_URL = process.env.JAVA_ANALYZER_URL ?? 'http://127.0.0.1:18080';
const RESULT_ROOT = resolve('test-results', 'real-index-vo-preload-refresh');

test('refreshes the persisted IndexVO task through the production preload runtime', {
  skip: !RUN_REAL_TEST,
  timeout: 30 * 60_000
}, async () => {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const resultDirectory = join(RESULT_ROOT, runId);
  await mkdir(resultDirectory, { recursive: true });

  for (const healthUrl of [
    new URL('/api/health', AGENT_SERVICE_URL),
    new URL('/api/health', JAVA_ANALYZER_URL)
  ]) {
    const response = await fetch(healthUrl, { redirect: 'error' });
    assert.equal(response.ok, true, `${healthUrl.origin} health returned ${response.status}`);
  }

  const client = new AiClient();
  client.setBackendSettings({
    agentServiceUrl: AGENT_SERVICE_URL,
    javaAnalyzerUrl: JAVA_ANALYZER_URL
  });
  const shell = new ShellService();
  const buildSettings = new WorkstationBuildSettingsService(
    join(USER_DATA_DIRECTORY, 'workstation-build-settings.json'),
    'win32',
    'C:\\Users\\wry'
  );
  const unavailableCipher = {
    isEncryptionAvailable: () => false,
    encryptString() { throw new Error('Credential encryption is not used by preload refresh.'); },
    decryptString() { throw new Error('Credential decryption is not used by preload refresh.'); }
  };
  const modelInterfaces = new WorkstationModelInterfacesService(
    new WorkstationModelInterfacesStore(
      join(USER_DATA_DIRECTORY, 'workstation-model-interfaces.json')
    ),
    new WorkstationModelInterfaceCredentialsStore(
      join(USER_DATA_DIRECTORY, 'workstation-model-interface-credentials.json')
    ),
    unavailableCipher
  );
  const snapshots = [];
  const runtime = createProductionClassTaskRuntime({
    storageDirectory: USER_DATA_DIRECTORY,
    aiClient: client,
    shellService: shell,
    mavenAnalysisContextService: new MavenAnalysisContextService(shell),
    testWriterService: new TestWriterService(),
    jacocoArtifactsService: new JacocoArtifactsService(),
    surefireReportService: new SurefireReportService(),
    buildSettingsService: buildSettings,
    modelInterfacesService: modelInterfaces,
    modelCallLogSettingsService: new ModelCallLogSettingsService(
      join(USER_DATA_DIRECTORY, 'model-call-log-settings.json')
    ),
    broadcast(snapshot) {
      if (snapshot.id !== INDEX_VO_TASK_ID) return;
      snapshots.push({
        state: snapshot.state,
        preloadState: snapshot.preloadState,
        coverageCurrent: snapshot.coverageCurrent,
        lastError: snapshot.lastError,
        at: new Date().toISOString()
      });
    }
  });

  let finalSnapshot = null;
  let runError = null;
  try {
    await runtime.startup();
    await runtime.flush();
    const tasks = await runtime.listClassTasks({ workspaceRoot: WORKSPACE_ROOT });
    finalSnapshot = tasks.find((task) => task.id === INDEX_VO_TASK_ID);
    assert.ok(finalSnapshot, 'The persisted IndexVO task is missing.');
    assert.equal(finalSnapshot.qualifiedClassName, INDEX_VO_FQN);
    assert.equal(finalSnapshot.state, 'READY', JSON.stringify(finalSnapshot.lastError));
    assert.equal(finalSnapshot.preloadState, 'READY');
    assert.ok(finalSnapshot.coverageCurrent, 'IndexVO coverage was not refreshed.');
    assert.ok(
      finalSnapshot.coverageCurrent.lineCovered > 0,
      `Expected IndexVO covered lines, got ${JSON.stringify(finalSnapshot.coverageCurrent)}`
    );
  } catch (error) {
    runError = {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    };
    throw error;
  } finally {
    await runtime.beforeQuit();
    await writeFile(
      join(resultDirectory, 'result.json'),
      `${JSON.stringify({
        runId,
        indexVoTaskId: INDEX_VO_TASK_ID,
        finalSnapshot,
        snapshots,
        runError
      }, null, 2)}\n`
    );
  }
});

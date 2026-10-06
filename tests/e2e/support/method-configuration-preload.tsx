import { createRoot } from 'react-dom/client';
import { App } from '../../../src/renderer/src/App';
import type {
  ClassMethodCatalog, ClassTaskResultSnapshot, ClassTaskSnapshot, GetClassTaskMethodsRequest
} from '../../../src/shared/class-task-contracts';
import type { MonacoEditorSession } from '../../../src/renderer/src/monaco-editor-session';

const settings = (window as any).methodConfigurationFixtureSettings ?? {};
let taskPresent = !settings.deletedTask;
let finishTaskList: (() => void) | null = null;
let finishViewState: (() => void) | null = null;
const taskListGate = settings.holdTaskList
  ? new Promise<void>(resolve => { finishTaskList = resolve; }) : Promise.resolve();
const viewStateGate = settings.holdViewState
  ? new Promise<void>(resolve => { finishViewState = resolve; }) : Promise.resolve();
const savedViewStates: any[] = [];
let viewStateCalls = 0;
let freshnessCalls = 0;
let coverageRestored = false;

let task: ClassTaskSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceRoot: 'D:/fixture',
  sourceFilePath: 'D:/fixture/src/TaskService.java',
  qualifiedClassName: 'example.TaskService',
  moduleKey: 'core',
  moduleDisplayPath: 'collection-core',
  state: 'PRELOADING',
  preloadState: 'RUNNING',
  ragEnabled: false,
  repairAttemptLimit: 6,
  unlimitedRepair: false,
  selectionMode: 'ALL_BY_DEFAULT',
  selectedMethodIds: [],
  methodOrder: [],
  coveredMethodIds: [],
  currentMethodIndex: -1,
  currentAtomicStep: null,
  activeGenerationBatch: null,
  tokenUsage: null,
  modelCallCount: null,
  usageReportedCallCount: null,
  generatedArtifacts: [],
  coverageBaseline: null,
  coverageCurrent: null,
  coverageContributions: [],
  completionAttentionPending: false,
  startedAt: null,
  pausedAt: null,
  finishedAt: null,
  lastError: null,
  updatedAt: new Date().toISOString()
};
if (settings.readyInitially) task = { ...task, state: 'READY', preloadState: 'READY' };
const listeners = new Set<(snapshot: ClassTaskSnapshot) => void>();
const catalogListeners = new Set<(event: { workspaceRoot: string; catalog: ClassMethodCatalog }) => void>();
const catalog: ClassMethodCatalog = {
  taskId: task.id, analysisSessionId: 'fixture', reportPairId: 'fixture',
  methods: [{
    methodId: 'method-id', methodName: 'run', descriptor: '()V', displaySignature: 'run()',
    firstLine: 1, lastLine: 1, jacocoOrder: 0, lineCovered: 0, lineMissed: 1,
    branchCovered: 0, branchMissed: 0, instructionCovered: 0, instructionMissed: 1,
    complexityCovered: 0, complexityMissed: 1, coverageGap: true, generatable: true,
    unavailableReason: null, modifiers: ['public']
  }], warnings: [], refreshedAt: new Date().toISOString(),
  reportCoverageTotals: {
    instructionCovered: 0, instructionMissed: 0, branchCovered: 0, branchMissed: 0,
    lineCovered: 0, lineMissed: 0, complexityCovered: 0, complexityMissed: 0
  }
};
const persistedViewState = {
  expandedPaths: [], openFilePaths: [],
  workbenchTabs: [{ kind: 'method_configuration', taskId: task.id,
    sourceFilePath: task.sourceFilePath, qualifiedClassName: task.qualifiedClassName,
    ...(settings.savedCatalog ? { catalog: { ...catalog, fingerprint: 'a'.repeat(64) } } : {}) }],
  activeWorkbenchTabId: `methods:${task.id}`
};
let catalogCalls = 0;
const catalogRequests: GetClassTaskMethodsRequest[] = [];
let runCalls = 0;
let racing = false;
let rejectForcedRead: ((error: Error) => void) | null = null;
let finishSharedRead: ((catalog: ClassMethodCatalog) => void) | null = null;
let rejectSharedRead: ((error: Error) => void) | null = null;
let pendingRevoke: Promise<void> | null = null;
let finishRevoke: (() => void) | null = null;
let rejectRevoke: ((error: Error) => void) | null = null;
let holdNextCatalog = false;
let finishHeldCatalog: (() => void) | null = null;
function update(patch: Partial<ClassTaskSnapshot>) {
  task = { ...task, ...patch, updatedAt: new Date().toISOString() };
  for (const listener of listeners) listener(task);
}
function result(): ClassTaskResultSnapshot {
  return {
    taskId: task.id, state: task.state, artifacts: task.generatedArtifacts, generatedMethods: [],
    tokenUsage: null, modelCallCount: null, usageReportedCallCount: null,
    coverageBaseline: task.coverageBaseline, coverageCurrent: task.coverageCurrent,
    coverageContributions: [], canAccept: task.generatedArtifacts.length > 0,
    canRevoke: task.generatedArtifacts.length > 0,
    ...(coverageRestored ? { restoredMethodCatalog: structuredClone(catalog) } : {})
  };
}
const api = {
  onClassTaskSnapshotChanged(callback: (snapshot: ClassTaskSnapshot) => void) {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  },
  onClassTaskMethodCatalogChanged(callback: (event: { workspaceRoot: string; catalog: ClassMethodCatalog }) => void) {
    catalogListeners.add(callback);
    return () => { catalogListeners.delete(callback); };
  },
  getAuthState: async () => ({ status: 'disabled', user: null }),
  getManagedBackendRuntimeStatus: async () => null,
  getLastWorkspace: async () => ({ state: 'ready', workspaceRoot: task.workspaceRoot }),
  listChildren: async () => [],
  listClassTasks: async () => { await taskListGate; return taskPresent ? [task] : []; },
  scanJavaProject: async () => ({ files: [] }),
  async getWorkspaceViewState() {
    viewStateCalls += 1;
    await viewStateGate;
    return persistedViewState;
  },
  async saveWorkspaceViewState(viewState: any) { savedViewStates.push(viewState); },
  async checkClassTaskMethods() {
    freshnessCalls += 1;
    if (!taskPresent) throw new Error(`Unknown class task: ${task.id}`);
    return { current: true, catalog };
  },
  async getClassTaskMethods(request: GetClassTaskMethodsRequest) {
    catalogCalls += 1;
    catalogRequests.push(request);
    if (!taskPresent) throw new Error(`Unknown class task: ${task.id}`);
    if (task.state === 'PRELOADING') throw new Error('当前类正在预加载，请稍后再打开方法列表。');
    if (holdNextCatalog) {
      holdNextCatalog = false;
      const staleCatalog = structuredClone(catalog);
      return new Promise<ClassMethodCatalog>(resolve => { finishHeldCatalog = () => resolve(staleCatalog); });
    }
    if (racing) {
      if (request.forceReload) {
        return new Promise<ClassMethodCatalog>((_resolve, reject) => { rejectForcedRead = reject; });
      }
      return new Promise<ClassMethodCatalog>((resolve, reject) => {
        finishSharedRead = resolve;
        rejectSharedRead = reject;
      });
    }
    return catalog;
  },
  getClassTaskResult: async () => result(),
  async removeClassTask() { taskPresent = false; },
  async revokeClassTask() {
    if (pendingRevoke) await pendingRevoke;
    update({ generatedArtifacts: [], coverageCurrent: task.coverageBaseline });
    coverageRestored = Boolean(settings.restoreOnRevoke);
    return result();
  },
  async runClassTask() {
    runCalls += 1;
    if (task.generatedArtifacts.length > 0) throw Error('请先接受或撤回本次生成结果，再重新执行。');
    update({ state: 'RUNNING', currentAtomicStep: 'ANALYZE_METHOD', finishedAt: null });
    return task;
  }
};
Object.assign(window, {
  workstation: new Proxy(api, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      if (String(property).startsWith('on')) return () => () => {};
      return async () => null;
    }
  }),
  preloadFixture: {
    catalogCalls: () => catalogCalls,
    catalogRequests: () => catalogRequests,
    runCalls: () => runCalls,
    freshnessCalls: () => freshnessCalls,
    viewStateCalls: () => viewStateCalls,
    savedViewStates: () => savedViewStates,
    finishTaskList() { if (!finishTaskList) throw Error('No held task list'); finishTaskList(); },
    finishViewState() { if (!finishViewState) throw Error('No held view state'); finishViewState(); },
    update,
    holdNextCatalog() { holdNextCatalog = true; },
    finishHeldCatalog() { if (!finishHeldCatalog) throw Error('No held catalog'); finishHeldCatalog(); },
    publishCoverage(covered: number, total = 2, workspaceRoot = task.workspaceRoot) {
      const refreshed = structuredClone(catalog);
      refreshed.reportPairId = `report-${covered}-${total}`;
      refreshed.methods[0] = { ...refreshed.methods[0], instructionCovered: covered,
        instructionMissed: total - covered, lineCovered: covered, lineMissed: total - covered,
        complexityCovered: covered, complexityMissed: total - covered, coverageGap: covered < total };
      for (const listener of catalogListeners) listener({ workspaceRoot, catalog: refreshed });
    },
    complete() {
      update({ state: 'COMPLETED', preloadState: 'READY', selectionMode: 'EXPLICIT',
        selectedMethodIds: ['method-id'], methodOrder: ['method-id'],
        generatedArtifacts: [{ id: 'artifact', filePath: 'D:/fixture/src/TaskServiceTest.java',
          testClassName: 'TaskServiceTest', ordinaryTestMethodCount: 1, methodIds: ['method-id'],
          sha256: 'a'.repeat(64), sealed: true, accepted: false,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
      });
    },
    armRace() { racing = true; },
    holdRevoke() {
      pendingRevoke = new Promise<void>((resolve, reject) => { finishRevoke = resolve; rejectRevoke = reject; });
    },
    finishRevoke(message?: string) {
      if (!finishRevoke || !rejectRevoke) throw Error('No pending revocation');
      if (message) rejectRevoke(new Error(message));
      else finishRevoke();
    },
    rejectForce(message: string) {
      if (!rejectForcedRead) throw new Error('No pending force reload');
      rejectForcedRead(new Error(message));
    },
    finishShared(message?: string) {
      if (!finishSharedRead || !rejectSharedRead) throw new Error('No shared catalog waiter');
      if (message) rejectSharedRead(new Error(message));
      else finishSharedRead(catalog);
    }
  }
});
const editorSession = {
  updateDesiredState() {}, getModelByCanonicalKey() { return null; }
} as unknown as MonacoEditorSession;
createRoot(document.getElementById('root')!).render(<App editorSession={editorSession} />);

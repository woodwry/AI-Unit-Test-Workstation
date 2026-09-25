import type { ModelTokenUsage } from './model-token-usage.ts';

export const MODULE_PRELOAD_STATES = ['IDLE', 'RUNNING', 'READY', 'FAILED'] as const;
export type ModulePreloadState = (typeof MODULE_PRELOAD_STATES)[number];

export const CLASS_TASK_STATES = [
  'PRELOADING',
  'PRELOAD_FAILED',
  'READY',
  'RUNNING',
  'PAUSE_REQUESTED',
  'PAUSED',
  'STOPPING',
  'TERMINATED',
  'COMPLETED',
  'INTERRUPTED',
  'FAILED'
] as const;
export type ClassTaskState = (typeof CLASS_TASK_STATES)[number];

export const METHOD_SELECTION_MODES = ['ALL_BY_DEFAULT', 'EXPLICIT'] as const;
export type MethodSelectionMode = (typeof METHOD_SELECTION_MODES)[number];

export const CLASS_TASK_ATOMIC_STEPS = [
  'IDLE',
  'ANALYZE_METHOD',
  'MODEL_GENERATION',
  'MODEL_REPAIR',
  'CONFIRM_RESULT',
  'WRITE_CANDIDATE',
  'MAVEN_COMPILE',
  'MAVEN_TEST',
  'PRUNE_FAILED_TESTS',
  'MERGE_METHOD_BATCHES',
  'PACK_FORMAL_FILE',
  'JACOCO_REFRESH'
] as const;
export type ClassTaskAtomicStep = (typeof CLASS_TASK_ATOMIC_STEPS)[number];

export type ClassTaskActiveGenerationBatch = {
  methodCount: number;
  scenarioCount: number;
};

export const CLASS_TASK_CHANNELS = {
  add: 'class-task:add',
  remove: 'class-task:remove',
  reorder: 'class-task:reorder',
  list: 'class-task:list',
  getMethods: 'class-task:methods:get',
  checkMethods: 'class-task:methods:check',
  saveSelection: 'class-task:selection:save',
  run: 'class-task:run',
  pause: 'class-task:pause',
  resume: 'class-task:resume',
  terminate: 'class-task:terminate',
  runAll: 'class-task:run-all',
  terminateAll: 'class-task:terminate-all',
  getResult: 'class-task:result:get',
  accept: 'class-task:accept',
  revoke: 'class-task:revoke',
  retryModulePreload: 'module-preload:retry',
  stopModulePreload: 'module-preload:stop',
  snapshotChanged: 'class-task:snapshot-changed'
} as const;

export type ExactCoverageCounts = {
  lineCovered: number;
  lineMissed: number;
  lineTotal: number;
  branchCovered: number;
  branchMissed: number;
  branchTotal: number;
};

export type ClassMethodSummary = {
  methodId: string;
  methodName: string;
  descriptor: string;
  displaySignature: string;
  firstLine: number;
  lastLine: number;
  jacocoOrder: number;
  lineCovered: number;
  lineMissed: number;
  branchCovered: number;
  branchMissed: number;
  instructionCovered: number;
  instructionMissed: number;
  complexityCovered: number;
  complexityMissed: number;
  coverageGap: boolean;
  generatable: boolean;
  unavailableReason: string | null;
  modifiers: string[];
};

export type CoverageTotals = {
  instructionCovered: number;
  instructionMissed: number;
  branchCovered: number;
  branchMissed: number;
  complexityCovered: number;
  complexityMissed: number;
  lineCovered: number;
  lineMissed: number;
};

export type ClassMethodCatalog = {
  taskId: string;
  analysisSessionId: string;
  reportPairId: string;
  /** Class-local source/report fingerprint used to reuse a persisted catalog. */
  fingerprint?: string;
  reportCoverageTotals: CoverageTotals;
  methods: ClassMethodSummary[];
  warnings: PublicTaskNotice[];
  refreshedAt: string;
};

export type GeneratedClassTaskArtifact = {
  id: string;
  filePath: string;
  testClassName: string;
  ordinaryTestMethodCount: number;
  methodIds: string[];
  methodResults?: GeneratedSourceMethodResult[];
  sha256: string;
  sealed: boolean;
  accepted: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedSourceMethodResult = {
  methodId: string;
  methodName: string;
  displaySignature: string;
  jacocoOrder: number;
  ordinaryTestMethodCount: number;
};

export type ClassTaskResultMethod = GeneratedSourceMethodResult & {
  artifactId: string;
  filePath: string;
  testClassName: string;
};

export type CoverageContribution = {
  artifactId: string;
  filePath: string;
  addedLineCount: number;
  lineTotal: number;
  addedBranchCount: number;
  branchTotal: number;
};

export type PublicTaskNotice = {
  code: string;
  message: string;
};

export type PublicTaskError = PublicTaskNotice & {
  moduleName: string | null;
  modulePath: string | null;
  command: string | null;
  occurredAt: string;
};

export type ClassTaskModelUsageIncrement = {
  tokenUsage: ModelTokenUsage | null;
  modelCallCount: number;
  usageReportedCallCount: number;
};

export type ClassTaskSnapshot = {
  id: string;
  workspaceRoot: string;
  sourceFilePath: string;
  qualifiedClassName: string;
  moduleKey: string;
  moduleDisplayPath: string;
  state: ClassTaskState;
  preloadState: ModulePreloadState;
  ragEnabled: boolean;
  repairAttemptLimit: number | null;
  unlimitedRepair: boolean;
  selectionMode: MethodSelectionMode;
  selectedMethodIds: string[];
  methodOrder: string[];
  /** Latest JaCoCo catalog methods that currently have no uncovered target. */
  coveredMethodIds: string[];
  currentMethodIndex: number;
  currentAtomicStep: ClassTaskAtomicStep;
  activeGenerationBatch: ClassTaskActiveGenerationBatch | null;
  tokenUsage: ModelTokenUsage | null;
  modelCallCount: number | null;
  usageReportedCallCount: number | null;
  generatedArtifacts: GeneratedClassTaskArtifact[];
  coverageBaseline: ExactCoverageCounts | null;
  coverageCurrent: ExactCoverageCounts | null;
  coverageContributions: CoverageContribution[];
  completionAttentionPending: boolean;
  startedAt: string | null;
  pausedAt: string | null;
  finishedAt: string | null;
  lastError: PublicTaskError | null;
  updatedAt: string;
};

export function hasPendingClassTaskResult(
  task: Pick<ClassTaskSnapshot, 'state' | 'generatedArtifacts'>
): boolean {
  return (task.state === 'COMPLETED' || task.state === 'TERMINATED')
    && task.generatedArtifacts.some((artifact) => !artifact.accepted);
}

export type ClassTaskResultSnapshot = {
  taskId: string;
  state: ClassTaskState;
  artifacts: GeneratedClassTaskArtifact[];
  generatedMethods: ClassTaskResultMethod[];
  allScenariosSkipped?: boolean;
  tokenUsage: ModelTokenUsage | null;
  modelCallCount: number | null;
  usageReportedCallCount: number | null;
  coverageBaseline: ExactCoverageCounts;
  coverageCurrent: ExactCoverageCounts;
  coverageContributions: CoverageContribution[];
  canAccept: boolean;
  canRevoke: boolean;
};

export type WorkspaceRequest = { workspaceRoot: string };

export type TaskIdentityRequest = WorkspaceRequest & { taskId: string };

export type AddClassTasksRequest = WorkspaceRequest & { classFilePaths: string[] };
export type AddClassTasksResult = ClassTaskSnapshot[];

export type SaveMethodSelectionRequest = TaskIdentityRequest & {
  selectionMode: MethodSelectionMode;
  selectedMethodIds: string[];
  methodOrder: string[];
  ragEnabled: boolean;
  repairAttemptLimit: number | null;
  unlimitedRepair: boolean;
};

export type RemoveClassTaskRequest = TaskIdentityRequest;
export type ReorderClassTasksRequest = WorkspaceRequest & { taskIds: string[] };
export type ListClassTasksRequest = WorkspaceRequest;
export type GetClassTaskMethodsRequest = TaskIdentityRequest & {
  forceReload?: boolean;
};
export type CheckClassTaskMethodsRequest = TaskIdentityRequest & {
  fingerprint: string;
};
export type ClassTaskMethodsFreshness = {
  current: boolean;
  /** Latest in-memory catalog, when this Workstation process has already prepared the task. */
  catalog?: ClassMethodCatalog;
};
export type RunClassTaskRequest = TaskIdentityRequest;
export type PauseClassTaskRequest = TaskIdentityRequest;
export type ResumeClassTaskRequest = TaskIdentityRequest;
export type TerminateClassTaskRequest = TaskIdentityRequest;
export type RunAllClassTasksRequest = WorkspaceRequest;
export type TerminateAllClassTasksRequest = WorkspaceRequest;
export type GetClassTaskResultRequest = TaskIdentityRequest;
export type AcceptClassTaskRequest = TaskIdentityRequest;
export type RevokeClassTaskRequest = TaskIdentityRequest;
// Channel names remain stable, but preload control is scoped to one class task.
export type RetryModulePreloadRequest = TaskIdentityRequest;
export type StopModulePreloadRequest = TaskIdentityRequest;

/** Named context-bridge wrappers only; no raw Electron or internal cancellation values. */
export type ClassTaskAppApi = {
  addClassTasks: (request: AddClassTasksRequest) => Promise<AddClassTasksResult>;
  removeClassTask: (request: RemoveClassTaskRequest) => Promise<void>;
  reorderClassTasks: (request: ReorderClassTasksRequest) => Promise<ClassTaskSnapshot[]>;
  listClassTasks: (request: ListClassTasksRequest) => Promise<ClassTaskSnapshot[]>;
  getClassTaskMethods: (request: GetClassTaskMethodsRequest) => Promise<ClassMethodCatalog>;
  checkClassTaskMethods: (
    request: CheckClassTaskMethodsRequest
  ) => Promise<ClassTaskMethodsFreshness>;
  saveClassTaskMethodSelection: (request: SaveMethodSelectionRequest) => Promise<ClassTaskSnapshot>;
  runClassTask: (request: RunClassTaskRequest) => Promise<ClassTaskSnapshot>;
  pauseClassTask: (request: PauseClassTaskRequest) => Promise<ClassTaskSnapshot>;
  resumeClassTask: (request: ResumeClassTaskRequest) => Promise<ClassTaskSnapshot>;
  terminateClassTask: (request: TerminateClassTaskRequest) => Promise<ClassTaskSnapshot>;
  runAllClassTasks: (request: RunAllClassTasksRequest) => Promise<ClassTaskSnapshot[]>;
  terminateAllClassTasks: (request: TerminateAllClassTasksRequest) => Promise<ClassTaskSnapshot[]>;
  getClassTaskResult: (request: GetClassTaskResultRequest) => Promise<ClassTaskResultSnapshot | null>;
  acceptClassTask: (request: AcceptClassTaskRequest) => Promise<ClassTaskResultSnapshot>;
  revokeClassTask: (request: RevokeClassTaskRequest) => Promise<ClassTaskResultSnapshot>;
  retryModulePreload: (request: RetryModulePreloadRequest) => Promise<void>;
  stopModulePreload: (request: StopModulePreloadRequest) => Promise<void>;
  onClassTaskSnapshotChanged: (callback: (snapshot: ClassTaskSnapshot) => void) => () => void;
  getPathForFile: (file: File) => string;
};

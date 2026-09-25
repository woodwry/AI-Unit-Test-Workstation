import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CLASS_TASK_CHANNELS } from '../shared/class-task-contracts';
import { RAG_KNOWLEDGE_CHANNELS } from '../shared/rag-knowledge-contracts';
import type { RagKnowledgeMethodRequest } from '../shared/rag-knowledge-contracts';
import {
  AUTH_CHANNELS,
  type CreateUserRequest,
  type DeleteUserRequest,
  type LoginRequest,
  type UpdateUserRequest
} from '../shared/auth-contracts';
import type { RagKnowledgeChangedEvent } from '../shared/rag-knowledge-contracts';
import type {
  AcceptClassTaskRequest,
  AddClassTasksRequest,
  AppApi,
  BackendSettings,
  BuildSettingsPathKind,
  CheckClassTaskMethodsRequest,
  ClassTaskSnapshot,
  GetClassTaskMethodsRequest,
  GetClassTaskResultRequest,
  ListClassTasksRequest,
  ManagedBackendRuntimeStatus,
  MavenHomeDefaults,
  PauseClassTaskRequest,
  CreateRagEmbeddingInterfaceRequest,
  UpdateRagEmbeddingInterfaceRequest,
  DeleteRagEmbeddingInterfaceRequest,
  SelectRagEmbeddingInterfaceRequest,
  RagEmbeddingInterfaceConnectionTestRequest,
  RemoveClassTaskRequest,
  ReorderClassTasksRequest,
  ResumeClassTaskRequest,
  RetryModulePreloadRequest,
  RevokeClassTaskRequest,
  RunAllClassTasksRequest,
  RunClassTaskRequest,
  SaveModelCallLogSettingsRequest,
  SaveMethodSelectionRequest,
  SaveWorkstationBuildSettingsRequest,
  StopModulePreloadRequest,
  TerminateAllClassTasksRequest,
  TerminateClassTaskRequest,
  WorkspaceViewState,
  CreateModelInterfaceRequest,
  UpdateModelInterfaceRequest,
  DeleteModelInterfaceRequest,
  SelectModelInterfaceRequest,
  ModelInterfaceConnectionTestRequest
} from '../shared/types';

const api: AppApi = {
  getAuthState: () => ipcRenderer.invoke(AUTH_CHANNELS.state),
  login: (request: LoginRequest) => ipcRenderer.invoke(AUTH_CHANNELS.login, request),
  logout: () => ipcRenderer.invoke(AUTH_CHANNELS.logout),
  forgetAuthentication: () => ipcRenderer.invoke(AUTH_CHANNELS.forget),
  retryAuthentication: () => ipcRenderer.invoke(AUTH_CHANNELS.retry),
  onAuthStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]): void => {
      callback(state);
    };
    ipcRenderer.on(AUTH_CHANNELS.changed, listener);
    return () => ipcRenderer.removeListener(AUTH_CHANNELS.changed, listener);
  },
  listUsers: () => ipcRenderer.invoke(AUTH_CHANNELS.listUsers),
  createUser: (request: CreateUserRequest) => ipcRenderer.invoke(AUTH_CHANNELS.createUser, request),
  updateUser: (request: UpdateUserRequest) => ipcRenderer.invoke(AUTH_CHANNELS.updateUser, request),
  deleteUser: (request: DeleteUserRequest) => ipcRenderer.invoke(AUTH_CHANNELS.deleteUser, request),
  addClassTasks: (request: AddClassTasksRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.add, request),
  removeClassTask: (request: RemoveClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.remove, request),
  reorderClassTasks: (request: ReorderClassTasksRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.reorder, request),
  listClassTasks: (request: ListClassTasksRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.list, request),
  getClassTaskMethods: (request: GetClassTaskMethodsRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.getMethods, request),
  checkClassTaskMethods: (request: CheckClassTaskMethodsRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.checkMethods, request),
  saveClassTaskMethodSelection: (request: SaveMethodSelectionRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.saveSelection, request),
  runClassTask: (request: RunClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.run, request),
  pauseClassTask: (request: PauseClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.pause, request),
  resumeClassTask: (request: ResumeClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.resume, request),
  terminateClassTask: (request: TerminateClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.terminate, request),
  runAllClassTasks: (request: RunAllClassTasksRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.runAll, request),
  terminateAllClassTasks: (request: TerminateAllClassTasksRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.terminateAll, request),
  getClassTaskResult: (request: GetClassTaskResultRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.getResult, request),
  acceptClassTask: (request: AcceptClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.accept, request),
  revokeClassTask: (request: RevokeClassTaskRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.revoke, request),
  retryModulePreload: (request: RetryModulePreloadRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.retryModulePreload, request),
  stopModulePreload: (request: StopModulePreloadRequest) =>
    ipcRenderer.invoke(CLASS_TASK_CHANNELS.stopModulePreload, request),
  onClassTaskSnapshotChanged: (callback: (snapshot: ClassTaskSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ClassTaskSnapshot): void => {
      callback(snapshot);
    };
    ipcRenderer.on(CLASS_TASK_CHANNELS.snapshotChanged, listener);
    return () => {
      ipcRenderer.removeListener(CLASS_TASK_CHANNELS.snapshotChanged, listener);
    };
  },
  getRagKnowledgeMethodSource: (request: RagKnowledgeMethodRequest) =>
    ipcRenderer.invoke('rag-global:request', { action: 'source', entryId: request.entryId, methodId: request.methodId }),
  onRagKnowledgeChanged: (callback: (event: RagKnowledgeChangedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, changed: RagKnowledgeChangedEvent): void => {
      callback(changed);
    };
    ipcRenderer.on(RAG_KNOWLEDGE_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.removeListener(RAG_KNOWLEDGE_CHANNELS.changed, listener);
    };
  },
  globalKnowledge: (request) => ipcRenderer.invoke('rag-global:request', request),
  cancelGlobalKnowledgeImport: () => ipcRenderer.invoke('rag-global:cancel-import'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getWorkstationModelInterfaces: () => ipcRenderer.invoke('model-interfaces:get'),
  createModelInterface: (request: CreateModelInterfaceRequest) => ipcRenderer.invoke('model-interfaces:create', request),
  updateModelInterface: (request: UpdateModelInterfaceRequest) => ipcRenderer.invoke('model-interfaces:update', request),
  deleteModelInterface: (request: DeleteModelInterfaceRequest) => ipcRenderer.invoke('model-interfaces:delete', request),
  selectModelInterface: (request: SelectModelInterfaceRequest) => ipcRenderer.invoke('model-interfaces:select', request),
  testModelInterfaceConnection: (request: ModelInterfaceConnectionTestRequest) => ipcRenderer.invoke('model-interfaces:test-connection', request),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  getLastWorkspace: () => ipcRenderer.invoke('workspace:get-last'),
  getWorkspaceViewState: (workspaceRoot) => ipcRenderer.invoke('workspace:get-view-state', workspaceRoot),
  saveWorkspaceViewState: (state: WorkspaceViewState) => ipcRenderer.invoke('workspace:save-view-state', state),
  getWorkstationBuildSettings: () => ipcRenderer.invoke('workstation-build-settings:get'),
  saveWorkstationBuildSettings: (settings: SaveWorkstationBuildSettingsRequest) =>
    ipcRenderer.invoke('workstation-build-settings:save', settings),
  validateWorkstationBuildSettings: (settings: SaveWorkstationBuildSettingsRequest) =>
    ipcRenderer.invoke('workstation-build-settings:validate', settings),
  selectWorkstationBuildSettingsPath: (kind: BuildSettingsPathKind) =>
    ipcRenderer.invoke('workstation-build-settings:select-path', kind),
  resolveWorkstationMavenHomeDefaults: (mavenHome: string) =>
    ipcRenderer.invoke('workstation-build-settings:maven-defaults', mavenHome) as Promise<MavenHomeDefaults>,
  getModelCallLogSettings: () =>
    ipcRenderer.invoke('model-call-log-settings:get'),
  saveModelCallLogSettings: (request: SaveModelCallLogSettingsRequest) =>
    ipcRenderer.invoke('model-call-log-settings:save', request),
  selectModelCallLogDirectory: () =>
    ipcRenderer.invoke('model-call-log-settings:select-directory'),
  getRagEmbeddingInterfaces: () =>
    ipcRenderer.invoke('rag-embedding-interfaces:get'),
  createRagEmbeddingInterface: (request: CreateRagEmbeddingInterfaceRequest) =>
    ipcRenderer.invoke('rag-embedding-interfaces:create', request),
  updateRagEmbeddingInterface: (request: UpdateRagEmbeddingInterfaceRequest) =>
    ipcRenderer.invoke('rag-embedding-interfaces:update', request),
  deleteRagEmbeddingInterface: (request: DeleteRagEmbeddingInterfaceRequest) =>
    ipcRenderer.invoke('rag-embedding-interfaces:delete', request),
  selectRagEmbeddingInterface: (request: SelectRagEmbeddingInterfaceRequest) =>
    ipcRenderer.invoke('rag-embedding-interfaces:select', request),
  testRagEmbeddingInterfaceConnection: (request: RagEmbeddingInterfaceConnectionTestRequest) =>
    ipcRenderer.invoke('rag-embedding-interfaces:test-connection', request),
  playAttentionSound: () => ipcRenderer.invoke('ui:attention-sound'),
  setWindowModalBlocked: (blocked: boolean) => ipcRenderer.invoke('ui:set-window-modal-blocked', blocked),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text),
  listFiles: (workspaceRoot) => ipcRenderer.invoke('file:list', workspaceRoot),
  listChildren: (workspaceRoot, directoryPath) => ipcRenderer.invoke('file:list-children', workspaceRoot, directoryPath),
  listSearchFiles: (workspaceRoot) => ipcRenderer.invoke('file:list-search', workspaceRoot),
  readFile: (workspaceRoot, filePath) => ipcRenderer.invoke('file:read', workspaceRoot, filePath),
  writeFile: (workspaceRoot, filePath, content) => ipcRenderer.invoke('file:write', workspaceRoot, filePath, content),
  scanJavaProject: (workspaceRoot) => ipcRenderer.invoke('java:scan-project', workspaceRoot),
  runMavenTest: (workspaceRoot, testName) => ipcRenderer.invoke('shell:mvn-test', workspaceRoot, testName),
  getManagedBackendRuntimeStatus: () => ipcRenderer.invoke('backend-runtime:status'),
  retryManagedBackendRuntime: () => ipcRenderer.invoke('backend-runtime:retry'),
  probeBackendAvailability: () => ipcRenderer.invoke('backend-runtime:probe'),
  onManagedBackendRuntimeStatusChanged: (callback: (status: ManagedBackendRuntimeStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ManagedBackendRuntimeStatus): void => {
      callback(status);
    };
    ipcRenderer.on('backend-runtime:status-changed', listener);

    return () => {
      ipcRenderer.removeListener('backend-runtime:status-changed', listener);
    };
  },
  getBackendSettings: () => ipcRenderer.invoke('backend-settings:get'),
  saveBackendSettings: (settings: BackendSettings) => ipcRenderer.invoke('backend-settings:save', settings),
  checkBackendHealth: () => ipcRenderer.invoke('backend:health')
};

contextBridge.exposeInMainWorld('workstation', api);

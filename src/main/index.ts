import { readClipboardFilePaths } from './services/clipboard-file-paths';
import { browseKnowledgeFiles } from './services/global-knowledge-files';
import {
  ensureGlobalSnapshotPage,
  cancelGlobalKnowledgeImport,
  ensureGlobalTaskKnowledge,
  executeGlobalKnowledge
} from './services/global-knowledge.service';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net } from 'electron';
import { safeStorage } from 'electron';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { shell as electronShell } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { FileSystemService } from './services/file-system.service';
import { ShellService } from './services/shell.service';
import { AiClient, DEFAULT_BACKEND_SETTINGS } from './services/ai-client';
import { JavaProjectAnalyzer } from './services/java-project-analyzer';
import { TestWriterService } from './services/test-writer.service';
import { JacocoConfigService } from './services/jacoco-config.service';
import { WorkspaceBuildSettingsService } from './services/workspace-build-settings.service';
import { WorkstationBuildSettingsService } from './services/workstation-build-settings.service';
import { ModelCallLogSettingsService } from './services/model-call-log-settings.service';
import { ModelCallLogAccessService } from './services/model-call-log-access.service';
import { RagIndexCoordinator } from './services/rag-index-coordinator.service';
import {
  resolveRagEmbeddingModelFingerprint,
  validateRagActiveIndexIdentity
} from './services/rag-index-contract';
import { DirectTestLocatorService } from './services/direct-test-locator.service';
import { JacocoArtifactsService } from './services/jacoco-artifacts.service';
import { SurefireReportService } from './services/surefire-report.service';
import type { CredentialCipher } from './services/credential-cipher';
import { WorkstationModelInterfacesStore } from './services/workstation-model-interfaces.store';
import { WorkstationModelInterfaceCredentialsStore } from './services/workstation-model-interface-credentials.store';
import { WorkstationModelInterfacesService } from './services/workstation-model-interfaces.service';
import { ModelInterfaceConnectionTestService } from './services/model-interface-connection-test.service';
import { RagEmbeddingInterfacesStore } from './services/rag-embedding-interfaces.store';
import { RagEmbeddingInterfaceCredentialsStore } from './services/rag-embedding-interface-credentials.store';
import { RagEmbeddingInterfacesService } from './services/rag-embedding-interfaces.service';
import { RagEmbeddingInterfaceConnectionTestService } from './services/rag-embedding-interface-connection-test.service';
import { WorkstationModelInterfaceUpgradeService } from './services/workstation-model-interface-upgrade.service';
import { WorkstationConfigurationMigrationService } from './services/workstation-configuration-migration.service';
import { WorkspaceStateService, getWorkspaceStateKey } from './services/workspace-state.service';
import { MavenAnalysisContextService } from './services/maven-analysis-context.service';
import { registerClassTaskIpc } from './ipc/class-task.ipc';
import {
  createProductionClassTaskRuntime,
  type ClassTaskRuntimeService
} from './services/class-task-runtime.service';
import { checkBackendHealth } from './services/backend-health.service';
import {
  probeExternalBackendAvailability,
  probeManagedBackendAvailability,
  probeRemoteAgentServiceAvailability
} from './services/backend-availability.service';
import { AuthSessionService } from './services/auth-session.service';
import { PackagedBackendRuntime } from './backend-runtime/packaged-backend-runtime';
import {
  E2E_BACKEND_RUNTIME_ENABLED_ENV,
  createE2eBackendRuntime,
  type ManagedBackendRuntime
} from './backend-runtime/e2e-backend-runtime';
import {
  isExternalBackendClientDeployment,
  isRemoteBackendDeployment,
  readExternalBackendClientConfiguration,
  type ExternalBackendClientConfiguration
} from './deployment-mode';
import type { BackendProcessManagerStatus } from './backend-runtime/backend-process-manager';
import { configureApplicationUserData } from './user-data-location';
import {
  isTrustedWorkspaceModelIpcSender,
  isTrustedWorkspaceNavigation,
  denyNewWorkspaceWindow,
  runTrustedBackendSettingsAction,
  resolvePersistedBackendSettings,
  validateBackendSettingsSaveRequest,
  validateSaveModelCallLogSettingsRequest,
  validateSaveWorkstationBuildSettingsRequest,
  validateCreateModelInterfaceRequest,
  validateUpdateModelInterfaceRequest,
  validateDeleteModelInterfaceRequest,
  validateSelectModelInterfaceRequest,
  validateModelInterfaceConnectionTestRequest,
  validateCreateRagEmbeddingInterfaceRequest,
  validateUpdateRagEmbeddingInterfaceRequest,
  validateDeleteRagEmbeddingInterfaceRequest,
  validateSelectRagEmbeddingInterfaceRequest,
  validateRagEmbeddingInterfaceConnectionTestRequest,
  validateWorkstationBuildSettingsPathKind,
  validateWorkstationMavenHome,
  validateWorkspaceRoot
} from './services/workspace-model-ipc-validation';
import type {
  BackendSettings,
  ManagedBackendRuntimeStatus,
  WorkspaceViewState
} from '../shared/types';
import {
  AUTH_CHANNELS,
  type CreateUserRequest,
  type LoginRequest,
  type UpdateUserRequest
} from '../shared/auth-contracts';
import {
  CLASS_TASK_CHANNELS,
  type ClassTaskSnapshot
} from '../shared/class-task-contracts';
import {
  RAG_KNOWLEDGE_CHANNELS,
  type RagKnowledgeChangedEvent
} from '../shared/rag-knowledge-contracts';

if (
  !app.isPackaged
  && process.env[E2E_BACKEND_RUNTIME_ENABLED_ENV] === 'enabled'
) {
  // Some Windows CI hosts cannot initialize the GPU subprocess. This affects
  // only the explicit unpackaged E2E launch and leaves production rendering unchanged.
  app.disableHardwareAcceleration();
}
configureApplicationUserData(app);

const fileSystemService = new FileSystemService();
const shellService = new ShellService();
const mavenAnalysisContextService = new MavenAnalysisContextService(shellService);
const aiClient = new AiClient((input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init)
);
const javaProjectAnalyzer = new JavaProjectAnalyzer();
const testWriterService = new TestWriterService();
const jacocoConfigService = new JacocoConfigService();
const directTestLocatorService = new DirectTestLocatorService();
const jacocoArtifactsService = new JacocoArtifactsService();
const surefireReportService = new SurefireReportService();
const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let workstationBuildSettingsService: WorkstationBuildSettingsService;
let modelCallLogSettingsService: ModelCallLogSettingsService;
let modelCallLogAccessService: ModelCallLogAccessService;
let workstationModelInterfacesService: WorkstationModelInterfacesService;
let authSessionService: AuthSessionService;
let modelInterfaceConnectionTestService: ModelInterfaceConnectionTestService;
let ragEmbeddingInterfacesService: RagEmbeddingInterfacesService;
let ragEmbeddingInterfaceConnectionTestService: RagEmbeddingInterfaceConnectionTestService;
let workspaceStateService: WorkspaceStateService | undefined;
let managedBackendRuntime: ManagedBackendRuntime | null = null;
let externalBackendClientConfiguration: ExternalBackendClientConfiguration | null | undefined;
let classTaskRuntime: ClassTaskRuntimeService | null = null;
let disposeClassTaskIpc: (() => void) | null = null;
// 仅由用户通过原生目录选择器确认的工作区可发起类任务，renderer 传参不能切换授权目录。
let activeWorkspaceRoot: string | null = null;

function publishClassTaskSnapshot(snapshot: ClassTaskSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(CLASS_TASK_CHANNELS.snapshotChanged, snapshot);
    }
  }
}

function publishRagKnowledgeChanged(event: RagKnowledgeChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(RAG_KNOWLEDGE_CHANNELS.changed, event);
    }
  }
}

function publishRagConfigurationChanged(): void {
  publishRagKnowledgeChanged({
    workspaceId: 'global',
    indexGeneration: Date.now(),
    reason: 'configuration-changed'
  });
}

type WindowState = {
  bounds?: {
    x?: number;
    y?: number;
    width: number;
    height: number;
  };
  isMaximized?: boolean;
  isFullScreen?: boolean;
};

type RendererDiagnosticLevel = 'info' | 'warn' | 'error';
type RendererDiagnosticRecord = Readonly<{
  event: string;
  level: RendererDiagnosticLevel;
  errorType?: string;
  fingerprint?: string;
  errorCode?: number;
  reason?: string;
  line?: number;
}>;

const RENDERER_DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
const SAFE_RENDERER_ERROR_TYPES = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError'
]);
const SAFE_RENDERER_ERROR_FINGERPRINTS = new Set([
  'DUPLICATE_REGISTRATION',
  'INVALID_URL',
  'BROWSER_EXTERNAL',
  'CHUNK_LOAD',
  'CSP',
  'UNKNOWN'
]);
let rendererDiagnosticQueue: Promise<void> = Promise.resolve();

function getRendererDiagnosticPath(): string {
  return join(app.getPath('userData'), 'logs', 'renderer', 'renderer.log');
}

function getSafeErrorType(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return 'Error';
  const name = typeof error.name === 'string' ? error.name : 'Error';
  return SAFE_RENDERER_ERROR_TYPES.has(name) ? name : 'Error';
}

function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function appendRendererDiagnostic(record: RendererDiagnosticRecord): Promise<void> {
  const logPath = getRendererDiagnosticPath();
  const backupPath = `${logPath}.1`;
  const entry = `[${new Date().toISOString()}] ${JSON.stringify(record)}\n`;
  await fs.mkdir(dirname(logPath), { recursive: true });

  let currentSize = 0;
  try {
    currentSize = (await fs.stat(logPath)).size;
  } catch (error) {
    if (errorCodeOf(error) !== 'ENOENT') throw error;
  }
  if (currentSize > 0 && currentSize + Buffer.byteLength(entry, 'utf8') > RENDERER_DIAGNOSTIC_MAX_BYTES) {
    await fs.rm(backupPath, { force: true });
    try {
      await fs.rename(logPath, backupPath);
    } catch (error) {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    }
  }
  await fs.appendFile(logPath, entry, 'utf8');
}

function writeRendererDiagnostic(record: RendererDiagnosticRecord): void {
  const pending = rendererDiagnosticQueue.then(() => appendRendererDiagnostic(record));
  rendererDiagnosticQueue = pending.catch(() => {
    console.error('[main] renderer diagnostic log write failed');
  });
}

function parseSafeRendererConsoleMessage(
  message: string
): Pick<RendererDiagnosticRecord, 'event' | 'errorType' | 'fingerprint'> | null {
  const match = /^\[renderer\] ([A-Z][A-Z0-9_]{2,80})(?: (\w+))?(?: ([A-Z_]{3,40}))?$/.exec(message.trim());
  if (!match) return null;
  const candidateType = match[2];
  const candidateFingerprint = match[3];
  return {
    event: match[1].toLowerCase().replaceAll('_', '-'),
    errorType: candidateType && SAFE_RENDERER_ERROR_TYPES.has(candidateType) ? candidateType : undefined,
    fingerprint: candidateFingerprint && SAFE_RENDERER_ERROR_FINGERPRINTS.has(candidateFingerprint)
      ? candidateFingerprint
      : undefined
  };
}

function attachRendererDiagnostics(mainWindow: BrowserWindow): void {
  let unclassifiedConsoleErrorLogged = false;
  mainWindow.webContents.on('preload-error', (_event, _preloadPath, error) => {
    writeRendererDiagnostic({
      event: 'preload-error',
      level: 'error',
      errorType: getSafeErrorType(error)
    });
  });
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      writeRendererDiagnostic({
        event: 'renderer-page-load-failed',
        level: 'error',
        errorCode,
        reason: /^ERR_[A-Z0-9_]+$/.test(errorDescription) ? errorDescription : undefined
      });
    }
  );
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeRendererDiagnostic({
      event: 'renderer-process-gone',
      level: details.reason === 'clean-exit' ? 'info' : 'error',
      errorCode: details.exitCode,
      reason: details.reason
    });
    if (details.reason !== 'clean-exit' && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '工作站界面异常退出',
        message: '工作站界面进程已意外停止。',
        detail: '请重启应用；如果问题持续，请重新安装并提供 renderer.log。',
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true
      }).catch(() => {
        console.error('[main] renderer 异常退出提示失败');
      });
    }
  });
  mainWindow.webContents.on('console-message', (details) => {
    const safeMessage = parseSafeRendererConsoleMessage(details.message);
    const line = details.lineNumber;
    if (safeMessage) {
      const level = details.level === 'warning' || details.level === 'error' ? 'error' : 'info';
      writeRendererDiagnostic({ ...safeMessage, level, line });
      return;
    }
    // 第三方控制台文本可能含工作区内容或凭证，只记一次不含正文的错误事件。
    if (details.level === 'error' && !unclassifiedConsoleErrorLogged) {
      unclassifiedConsoleErrorLogged = true;
      writeRendererDiagnostic({ event: 'renderer-console-error', level: 'error', line });
    }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    writeRendererDiagnostic({ event: 'renderer-page-loaded', level: 'info' });
  });
}

// 后端端口与运行时注册表只能由一个工作站实例持有，第二次启动只激活已有窗口。
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException', getSafeErrorType(error));
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection', getSafeErrorType(reason));
});

async function createWindow(): Promise<BrowserWindow> {
  const windowState = await readWindowState();
  const mainWindow = new BrowserWindow({
    width: windowState.bounds?.width ?? 1280,
    height: windowState.bounds?.height ?? 840,
    x: windowState.bounds?.x,
    y: windowState.bounds?.y,
    minWidth: 980,
    minHeight: 680,
    title: 'AI Unit Test Workstation',
    icon: resolveWorkstationIconPath(),
    backgroundColor: '#161819',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  attachRendererDiagnostics(mainWindow);
  bindWindowStatePersistence(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => denyNewWorkspaceWindow());
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedWorkspaceNavigation({
      senderUrl: navigationUrl,
      isPackaged: app.isPackaged,
      developmentRendererUrl: process.env.ELECTRON_RENDERER_URL,
      packagedRendererFile: join(currentDirectory, '../renderer/index.html')
    })) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (windowState.isFullScreen) {
      mainWindow.setFullScreen(true);
    } else if (windowState.isMaximized) {
      mainWindow.maximize();
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(currentDirectory, '../renderer/index.html'));
  }

  return mainWindow;
}

function resolveWorkstationIconPath(): string | undefined {
  const iconFileName = process.platform === 'win32'
    ? 'ai-unit-test-workstation.ico'
    : 'ai-unit-test-workstation-256.png';
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'branding', iconFileName)
    : resolve(currentDirectory, '../../assets/branding', iconFileName);
  if (!existsSync(iconPath)) {
    console.warn('[main] 品牌图标资源不可用，使用 Electron 默认窗口图标');
    return undefined;
  }
  return iconPath;
}

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function getBackendSettingsPath(): string {
  return join(app.getPath('userData'), 'backend-settings.json');
}

async function readWindowState(): Promise<WindowState> {
  try {
    const rawState = await fs.readFile(getWindowStatePath(), 'utf8');
    const state = JSON.parse(rawState) as WindowState;
    return normalizeWindowState(state);
  } catch {
    return {};
  }
}

function normalizeWindowState(state: WindowState): WindowState {
  const bounds = state.bounds;
  const hasUsableBounds =
    bounds &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 980 &&
    bounds.height >= 680;

  return {
    ...(hasUsableBounds ? { bounds } : {}),
    isMaximized: Boolean(state.isMaximized),
    isFullScreen: Boolean(state.isFullScreen)
  };
}

function bindWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(() => {
      writeWindowState(window);
    }, 250);
  };

  window.on('move', scheduleSave);
  window.on('resize', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  window.on('enter-full-screen', scheduleSave);
  window.on('leave-full-screen', scheduleSave);
  window.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    writeWindowState(window);
  });
}

function writeWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }

  const state: WindowState = {
    bounds: window.getNormalBounds(),
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen()
  };

  writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

async function readBackendSettings(): Promise<BackendSettings> {
  try {
    const rawSettings = await fs.readFile(getBackendSettingsPath(), 'utf8');
    // 落盘文件可能来自旧版本或被外部修改，不能绕过保存接口的 URL 安全规则。
    return resolvePersistedBackendSettings(JSON.parse(rawSettings) as unknown, DEFAULT_BACKEND_SETTINGS);
  } catch {
    return { ...DEFAULT_BACKEND_SETTINGS };
  }
}

async function writeBackendSettings(settings: BackendSettings): Promise<BackendSettings> {
  const normalized = normalizeBackendSettings(settings);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getBackendSettingsPath(), JSON.stringify(normalized, null, 2), 'utf8');
  aiClient.setBackendSettings(normalized);
  return normalized;
}

function normalizeBackendSettings(settings: Partial<BackendSettings>): BackendSettings {
  return {
    agentServiceUrl: settings.agentServiceUrl?.trim() || DEFAULT_BACKEND_SETTINGS.agentServiceUrl,
    javaAnalyzerUrl: settings.javaAnalyzerUrl?.trim() || DEFAULT_BACKEND_SETTINGS.javaAnalyzerUrl
  };
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedIpcSender(event)) throw new Error('请求来源无效');
}

function getWorkspaceStateService(): WorkspaceStateService {
  if (!workspaceStateService) {
    throw new Error('工作区状态服务尚未就绪，请稍后重试。');
  }
  return workspaceStateService;
}

/**
 * 视图状态只能属于当前由原生目录选择器确认、或可信恢复记录恢复的工作区。
 * 不接受 renderer 借由任意绝对路径读取或覆盖其他工作区的保存状态。
 */
function validateActiveWorkspaceViewStateRoot(value: unknown): string {
  const workspaceRoot = validateWorkspaceRoot(value);
  if (
    !activeWorkspaceRoot ||
    getWorkspaceStateKey(workspaceRoot) !== getWorkspaceStateKey(activeWorkspaceRoot)
  ) {
    throw new Error('工作区状态请求与当前活动工作区不一致');
  }
  return workspaceRoot;
}

/**
 * 构建设置同样只能读写当前已确认的工作区，避免 renderer 指定其他目录的持久化配置。
 */
/** 仅接受 WorkspaceViewState 的公开字段，拒绝将生成会话数据混入持久化视图。 */
function validateWorkspaceViewState(value: unknown): WorkspaceViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('工作区视图状态无效');
  }

  const viewState = value as Record<string, unknown>;
  const expandedPaths = viewState.expandedPaths;
  const openFilePaths = viewState.openFilePaths;
  const activeFilePath = viewState.activeFilePath;
  const activityView = viewState.activityView;
  const workbenchTabs = viewState.workbenchTabs;
  const activeWorkbenchTabId = viewState.activeWorkbenchTabId;
  const allowedKeys = new Set([
    'workspaceRoot',
    'expandedPaths',
    'openFilePaths',
    'activeFilePath',
    'activityView',
    'workbenchTabs',
    'activeWorkbenchTabId'
  ]);
  if (Object.keys(viewState).some((key) => !allowedKeys.has(key))) {
    throw new Error('工作区视图状态包含不允许的字段');
  }

  if (!isWorkspacePathArray(expandedPaths) || !isWorkspacePathArray(openFilePaths)) {
    throw new Error('工作区视图状态无效');
  }
  if (activeFilePath !== undefined && (typeof activeFilePath !== 'string' || !activeFilePath.trim())) {
    throw new Error('工作区视图状态无效');
  }
  if (activityView !== undefined && !isWorkspaceActivityView(activityView)) {
    throw new Error('工作区视图状态无效');
  }
  if (workbenchTabs !== undefined && (!Array.isArray(workbenchTabs) || workbenchTabs.length > 64)) {
    throw new Error('工作区视图状态无效');
  }
  if (
    activeWorkbenchTabId !== undefined &&
    (typeof activeWorkbenchTabId !== 'string' || !activeWorkbenchTabId.trim())
  ) {
    throw new Error('工作区视图状态无效');
  }

  return {
    workspaceRoot: validateWorkspaceRoot(viewState.workspaceRoot),
    expandedPaths: [...expandedPaths],
    openFilePaths: [...openFilePaths],
    ...(activeFilePath !== undefined ? { activeFilePath } : {}),
    ...(activityView !== undefined ? { activityView } : {}),
    ...(workbenchTabs !== undefined
      ? { workbenchTabs: workbenchTabs as NonNullable<WorkspaceViewState['workbenchTabs']> }
      : {}),
    ...(activeWorkbenchTabId !== undefined ? { activeWorkbenchTabId } : {})
  };
}

function isWorkspacePathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isWorkspaceActivityView(
  value: unknown
): value is NonNullable<WorkspaceViewState['activityView']> {
  return value === 'explorer'
    || value === 'search'
    || value === 'rag-knowledge'
    || value === 'user-management';
}

function isTrustedIpcSender(event: Electron.IpcMainInvokeEvent): boolean {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  return Boolean(senderWindow && !senderWindow.isDestroyed() && senderFrame && isTrustedWorkspaceModelIpcSender({
    senderUrl: senderFrame.url,
    isTopFrame: senderFrame === event.sender.mainFrame,
    isPackaged: app.isPackaged,
    developmentRendererUrl: process.env.ELECTRON_RENDERER_URL,
    packagedRendererFile: join(currentDirectory, '../renderer/index.html')
  }));
}

const BACKEND_INITIALIZATION_FAILED: ManagedBackendRuntimeStatus = Object.freeze({
  state: 'failed',
  message: '本地服务初始化失败，请重启工作站。',
  retryable: false
});

function toManagedBackendRuntimeStatus(status: BackendProcessManagerStatus): ManagedBackendRuntimeStatus {
  return Object.freeze({
    state: status.state,
    message: status.message,
    retryable: status.retryable
  });
}

function getManagedBackendRuntimeStatus(): ManagedBackendRuntimeStatus | null {
  if (managedBackendRuntime) {
    return toManagedBackendRuntimeStatus(managedBackendRuntime.getStatus());
  }
  if (isRemoteBackendMode() || isExternalBackendClientMode()) return null;
  return app.isPackaged ? BACKEND_INITIALIZATION_FAILED : null;
}

function publishManagedBackendRuntimeStatus(status: BackendProcessManagerStatus): void {
  const publicStatus = toManagedBackendRuntimeStatus(status);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('backend-runtime:status-changed', publicStatus);
  }
}

function initializeManagedBackendRuntime(): void {
  try {
    if (isRemoteBackendMode() || isExternalBackendClientMode()) {
      managedBackendRuntime = null;
      return;
    }
    const e2eRuntime = createE2eBackendRuntime({
      isPackaged: app.isPackaged,
      environment: process.env
    });
    // 开发态直接连接设置页或环境变量中配置的 IDE 服务，不能静默启动可能过期的 staging 产物。
    if (!app.isPackaged && !e2eRuntime) {
      managedBackendRuntime = null;
      return;
    }
    const runtime = e2eRuntime ?? new PackagedBackendRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData')
    });
    managedBackendRuntime = runtime;
    // 安装版和 E2E 使用受管动态地址与令牌；普通开发态没有 provider，AiClient 才会读取 18000/18080 配置。
    aiClient.setManagedBackendAccessProvider(() => runtime.getManagedAccess());
    runtime.subscribe(publishManagedBackendRuntimeStatus);
    // 窗口无需等待哈希校验和服务启动，renderer 会通过安全状态 IPC 展示进度。
    void runtime.start().catch(() => {
      console.error('[main] 本地服务启动失败');
    });
  } catch {
    console.error('[main] 本地服务初始化失败');
  }
}

function assertManagedBackendRuntimeReady(): void {
  const runtime = managedBackendRuntime;
  const status = getManagedBackendRuntimeStatus();
  if (!runtime || status?.state !== 'ready') {
    throw new Error(status?.message ?? '本地服务尚未就绪，请稍候重试。');
  }
  try {
    // 状态之外再核对当前注册表快照，防止子进程刚退出时继续进入生成流程。
    runtime.getManagedAccess();
  } catch {
    throw new Error('本地服务连接已失效，请稍候重试。');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('账号请求格式无效。');
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string, minimum = 1): string {
  if (typeof value !== 'string') throw new TypeError(`${field}格式无效。`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > 1024) {
    throw new TypeError(`${field}格式无效。`);
  }
  return normalized;
}

function requireAuthString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new TypeError(`${field}格式无效。`);
  }
  return value;
}

function requireUuid(value: unknown): string {
  const id = requireText(value, '用户标识');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new TypeError('用户标识格式无效。');
  }
  return id;
}

function validateLoginRequest(value: unknown): LoginRequest {
  const record = requireRecord(value);
  return {
    loginName: requireAuthString(record.loginName, '登录名', 255),
    password: requireAuthString(record.password, '密码', 1024),
    rememberMe: record.rememberMe === true
  };
}

function validateCreateUserRequest(value: unknown): CreateUserRequest {
  const record = requireRecord(value);
  const role = record.role;
  const isAvailable = record.isAvailable;
  if (role !== 'ADMIN' && role !== 'USER') throw new TypeError('用户角色无效。');
  if (isAvailable !== 0 && isAvailable !== 1) throw new TypeError('账号状态无效。');
  return {
    loginName: requireAuthString(record.loginName, '登录名', 255),
    password: requireAuthString(record.password, '密码', 1024),
    role,
    isAvailable
  };
}

function validateUpdateUserRequest(value: unknown): UpdateUserRequest {
  const record = requireRecord(value);
  const request: {
    id: string;
    loginName?: string;
    password?: string;
    role?: 'ADMIN' | 'USER';
    isAvailable?: 0 | 1;
  } = { id: requireUuid(record.id) };
  if (record.loginName !== undefined) {
    request.loginName = requireAuthString(record.loginName, '登录名', 255);
  }
  if (record.password !== undefined) {
    request.password = requireAuthString(record.password, '密码', 1024);
  }
  if (record.role !== undefined) {
    if (record.role !== 'ADMIN' && record.role !== 'USER') throw new TypeError('用户角色无效。');
    request.role = record.role;
  }
  if (record.isAvailable !== undefined) {
    if (record.isAvailable !== 0 && record.isAvailable !== 1) throw new TypeError('账号状态无效。');
    request.isAvailable = record.isAvailable;
  }
  if (Object.keys(request).length === 1) throw new TypeError('至少修改一项用户信息。');
  return request;
}

async function probeBackendAvailability(): Promise<boolean> {
  if (isExternalBackendClientMode()) {
    const settings = aiClient.getBackendSettings();
    return probeExternalBackendAvailability(
      {
        agentServiceUrl: process.env.AI_BACKEND_URL || settings.agentServiceUrl,
        javaAnalyzerUrl: process.env.JAVA_ANALYZER_URL
          ?? process.env.AI_JAVA_ANALYZER_URL
          ?? settings.javaAnalyzerUrl
      },
      (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
    );
  }

  const runtime = managedBackendRuntime;
  if (runtime) {
    if (runtime.getStatus().state !== 'ready') return false;
    // 显式 E2E runtime 没有安装包内部 ready 端点；它的受控状态就是测试契约。
    if (!app.isPackaged) return true;
    try {
      const access = runtime.getManagedAccess();
      return probeManagedBackendAvailability(
        access,
        (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
      );
    } catch {
      return false;
    }
  }

  if (isRemoteBackendMode()) {
    return probeRemoteAgentServiceAvailability(
      aiClient.getUserAuthenticationEndpoint(),
      (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
    );
  }


  // 普通开发态由设置页连接用户显式启动的 IDE 服务；发布版才启用全局状态门。
  return !app.isPackaged;
}

function getExternalBackendClientConfiguration(): ExternalBackendClientConfiguration | null {
  if (externalBackendClientConfiguration !== undefined) {
    return externalBackendClientConfiguration;
  }
  const deployment = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  };
  externalBackendClientConfiguration = isExternalBackendClientDeployment(deployment)
    ? readExternalBackendClientConfiguration(deployment)
    : null;
  return externalBackendClientConfiguration;
}

function isRemoteBackendMode(): boolean {
  return !isExternalBackendClientMode() && isRemoteBackendDeployment(process.env);
}

function isExternalBackendClientMode(): boolean {
  return getExternalBackendClientConfiguration() !== null;
}

function assertDevelopmentBackendSettingsAllowed(): void {
  if (app.isPackaged) throw new Error('安装版的本地服务地址由工作站自动管理。');
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.aiunittest.workstation');
  workspaceStateService = new WorkspaceStateService(
    join(app.getPath('userData'), 'workspace-state.json'),
    app.getPath('documents'),
    app.getPath('home')
  );
  workstationBuildSettingsService = new WorkstationBuildSettingsService(
    join(app.getPath('userData'), 'workstation-build-settings.json')
  );
  modelCallLogSettingsService = new ModelCallLogSettingsService(
    join(app.getPath('userData'), 'model-call-log-settings.json')
  );
  const credentialCipher: CredentialCipher = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value)
  };
  authSessionService = new AuthSessionService({
    client: aiClient,
    storagePath: join(app.getPath('userData'), 'auth-session-v1.json'),
    cipher: credentialCipher,
    authenticationEnabled: () => isRemoteBackendMode() || isExternalBackendClientMode()
  });
  modelCallLogAccessService = new ModelCallLogAccessService(
    modelCallLogSettingsService,
    authSessionService
  );
  workstationModelInterfacesService = new WorkstationModelInterfacesService(
    new WorkstationModelInterfacesStore(join(app.getPath('userData'), 'workstation-model-interfaces.json')),
    new WorkstationModelInterfaceCredentialsStore(join(app.getPath('userData'), 'workstation-model-interface-credentials.json')),
    credentialCipher
  );
  modelInterfaceConnectionTestService = new ModelInterfaceConnectionTestService();
  ragEmbeddingInterfacesService = new RagEmbeddingInterfacesService(
    new RagEmbeddingInterfacesStore(
      join(app.getPath('userData'), 'rag-embedding-interfaces-v1.json')
    ),
    new RagEmbeddingInterfaceCredentialsStore(
      join(app.getPath('userData'), 'rag-embedding-interface-credentials-v1.json')
    ),
    credentialCipher
  );
  ragEmbeddingInterfaceConnectionTestService = new RagEmbeddingInterfaceConnectionTestService();

  if (app.isPackaged) {
    const legacyBuildSettingsService = new WorkspaceBuildSettingsService(
      join(app.getPath('userData'), 'workspace-build-settings.json')
    );
    await new WorkstationConfigurationMigrationService({
      isPackaged: app.isPackaged,
      userDataDirectory: app.getPath('userData'),
      paths: {
        buildSettings: join(app.getPath('userData'), 'workstation-build-settings.json'),
        completionMarker: join(app.getPath('userData'), 'workstation-configuration-migration.json')
      },
      workspaceStateService,
      legacyBuildSettingsService,
      reportFailure: (message) => console.error(`[main] ${message}`)
    }).migrateIfNeeded();
    await new WorkstationModelInterfaceUpgradeService({
      legacySettings: join(app.getPath('userData'), 'workstation-model-settings.json'),
      legacyCredentials: join(app.getPath('userData'), 'workstation-model-credentials.json'),
      legacyWorkspaceSettings: join(app.getPath('userData'), 'workspace-model-settings.json'),
      legacyWorkspaceCredentials: join(app.getPath('userData'), 'workspace-model-credentials.json')
    }).clearLegacyModelConfiguration();
  }
  const externalClientConfiguration = getExternalBackendClientConfiguration();
  const persistedBackendSettings = externalClientConfiguration
    ? {
        agentServiceUrl: externalClientConfiguration.agentServiceUrl,
        javaAnalyzerUrl: externalClientConfiguration.javaAnalyzerUrl
      }
    : await readBackendSettings();
  aiClient.setBackendSettings(persistedBackendSettings);
  initializeManagedBackendRuntime();
  authSessionService.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(AUTH_CHANNELS.changed, state);
    }
  });
  void authSessionService.initialize().catch(() => {
    console.error('[main] 登录状态恢复失败');
  });
  const ragTelemetry = (
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null>>
  ): void => {
    console.info(`[rag] ${event}`, fields);
  };
  const ragIndexCoordinator = new RagIndexCoordinator({
    globalKnowledge: async (context, embeddingContext, signal) => {
      const modulePom = await fs.readFile(join(context.scope.moduleRoot, 'pom.xml'), 'utf8').catch(() => undefined);
      return validateRagActiveIndexIdentity(await aiClient.globalKnowledge({
        action: 'prepare', scope: context.scope, modulePom,
        embeddingModelFingerprint: resolveRagEmbeddingModelFingerprint(
          embeddingContext.embeddingConfig
        )
      }, undefined, signal));
    },
    globalKnowledgeRefresh: async ({ context, page, embeddingContext, signal }) => {
      const result = await ensureGlobalSnapshotPage({
        moduleRoot: context.scope.moduleRoot,
        page,
        embeddingConfig: embeddingContext.embeddingConfig,
        ...(signal ? { signal } : {})
      }, aiClient);
      if (result.status === 'published') {
        publishRagKnowledgeChanged({
          workspaceId: 'global', indexGeneration: Date.now(), reason: 'imported'
        });
      }
      return result;
    },
    analyzer: aiClient,
    telemetry: ragTelemetry
  });
  classTaskRuntime = createProductionClassTaskRuntime({
    storageDirectory: app.getPath('userData'),
    aiClient,
    shellService,
    mavenAnalysisContextService,
    testWriterService,
    jacocoArtifactsService,
    surefireReportService,
    buildSettingsService: workstationBuildSettingsService,
    modelInterfacesService: workstationModelInterfacesService,
    modelCallLogSettingsService: modelCallLogAccessService,
    ragEmbeddingInterfacesService,
    ragIndexCoordinator,
    ensureRagTaskKnowledge: async (input) => {
      const result = await ensureGlobalTaskKnowledge(input, aiClient);
      if (result.status === 'published') {
        publishRagKnowledgeChanged({
          workspaceId: 'global',
          indexGeneration: result.indexGeneration,
          reason: 'imported',
          deletedEntryId: result.entryId
        });
      }
      return result;
    },
    ragTelemetry,
    broadcast: publishClassTaskSnapshot,
    recordTaskExecution: () => authSessionService.recordTaskExecution(),
    assertBackendReady: app.isPackaged && !isRemoteBackendMode() && !isExternalBackendClientMode()
      ? assertManagedBackendRuntimeReady
      : undefined
  });
  await classTaskRuntime.startup();
  disposeClassTaskIpc?.();
  disposeClassTaskIpc = registerClassTaskIpc({
    ipcMain,
    runtime: classTaskRuntime,
    isTrustedSender: (event) => isTrustedIpcSender(
      event as Electron.IpcMainInvokeEvent
    ),
    getActiveWorkspaceRoot: () => activeWorkspaceRoot,
    isShuttingDown: () => shutdownPending || shutdownReadyToQuit
  });
  const registerModelHandler = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    // 开发热重载时先移除旧 handler，避免重复注册。
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };
  registerModelHandler(AUTH_CHANNELS.state, (event) => {
    assertTrustedIpcSender(event);
    return authSessionService.getState();
  });
  registerModelHandler(AUTH_CHANNELS.login, async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event);
    return authSessionService.login(validateLoginRequest(rawRequest));
  });
  registerModelHandler(AUTH_CHANNELS.logout, async (event) => {
    assertTrustedIpcSender(event);
    await authSessionService.logout();
  });
  registerModelHandler(AUTH_CHANNELS.forget, async (event) => {
    assertTrustedIpcSender(event);
    await authSessionService.forget();
  });
  registerModelHandler(AUTH_CHANNELS.retry, async (event) => {
    assertTrustedIpcSender(event);
    return authSessionService.retry();
  });
  registerModelHandler(AUTH_CHANNELS.listUsers, async (event) => {
    assertTrustedIpcSender(event);
    return authSessionService.listUsers();
  });
  registerModelHandler(AUTH_CHANNELS.createUser, async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event);
    return authSessionService.createUser(validateCreateUserRequest(rawRequest));
  });
  registerModelHandler(AUTH_CHANNELS.updateUser, async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event);
    return authSessionService.updateUser(validateUpdateUserRequest(rawRequest));
  });
  registerModelHandler(AUTH_CHANNELS.deleteUser, async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event);
    const record = requireRecord(rawRequest);
    return authSessionService.deleteUser(requireUuid(record.id));
  });
  const activeGlobalKnowledgeImports = new Map<number, {
    operationId: string;
    controller: AbortController;
  }>();
  registerModelHandler('rag-global:cancel-import', async (event) => {
    assertTrustedIpcSender(event);
    const senderId = event.sender.id;
    const active = activeGlobalKnowledgeImports.get(senderId);
    if (!active) return false;
    try {
      await cancelGlobalKnowledgeImport(active.operationId, {
        aiClient
      });
      return true;
    } finally {
      active.controller.abort(new DOMException('已停止本次知识构建。', 'AbortError'));
      if (activeGlobalKnowledgeImports.get(senderId) === active) {
        activeGlobalKnowledgeImports.delete(senderId);
      }
    }
  });
  registerModelHandler('rag-global:request', async (event, request) => {
    assertTrustedIpcSender(event);
    if (request?.action === 'pick-files') {
      const kind:unknown=request.fileKind;
      if(kind!=='pom' && kind!=='class')throw new TypeError('文件类型不支持');
      const statePath=join(app.getPath('userData'),'knowledge-native-picker-positions.json');
      let positions:Partial<Record<'pom'|'class',string>>={};
      try{positions=JSON.parse(await fs.readFile(statePath,'utf8'));}catch{}
      const options:Electron.OpenDialogOptions={
        title:kind==='pom'?'选择 pom.xml 文件':'选择 Java / Class 文件',
        properties:['openFile','multiSelections'],
        filters:kind==='pom'?[{name:'POM 文件 (pom.xml)',extensions:['xml']}]:[{name:'Java / Class 文件',extensions:['java','class']}],
        ...(typeof positions[kind]==='string'?{defaultPath:positions[kind]}:{})
      };
      const owner=BrowserWindow.fromWebContents(event.sender);
      const result=owner?await dialog.showOpenDialog(owner,options):await dialog.showOpenDialog(options);
      if(result.canceled || !result.filePaths.length)return [];
      positions[kind]=dirname(result.filePaths[0]);
      await fs.writeFile(statePath,JSON.stringify(positions),'utf8');
      return result.filePaths;
    }
    if (request?.action === 'browse-files') return browseKnowledgeFiles(request, join(app.getPath('userData'), 'knowledge-browser-positions.json'));
    if (request?.action === 'clipboard-paths') return readClipboardFilePaths();
    const senderId = event.sender.id;
    const activeImport = request?.action === 'import'
      ? { operationId: randomUUID(), controller: new AbortController() }
      : null;
    if (activeImport) {
      if (activeGlobalKnowledgeImports.has(senderId)) throw new Error('已有知识构建正在进行。');
      activeGlobalKnowledgeImports.set(senderId, activeImport);
    }
    let result: unknown;
    try {
      result = await executeGlobalKnowledge(request, {
        aiClient,
        embeddings: ragEmbeddingInterfacesService,
        ...(activeImport ? {
          operationId: activeImport.operationId,
          signal: activeImport.controller.signal
        } : {})
      });
    } finally {
      if (activeImport && activeGlobalKnowledgeImports.get(senderId) === activeImport) {
        activeGlobalKnowledgeImports.delete(senderId);
      }
    }
    if (request.action === 'import' && result && typeof result === 'object' && 'items' in result) {
      for (const item of (result as { items: Array<{ entryId?: string }> }).items) if (item.entryId) publishRagKnowledgeChanged({ workspaceId: 'global', indexGeneration: Date.now(), reason: 'imported', deletedEntryId: item.entryId });
    }
    if (request.action === 'delete') {
      for (const entryId of request.entryIds ?? []) publishRagKnowledgeChanged({ workspaceId: 'global', indexGeneration: Date.now(), reason: 'deleted', deletedEntryId: entryId });
      for (const methodId of request.methodIds ?? []) publishRagKnowledgeChanged({ workspaceId: 'global', indexGeneration: Date.now(), reason: 'deleted', deletedEntryId: request.entryId, deletedMethodId: methodId });
    }
    if (['import','delete'].includes(request.action)) {
      publishRagKnowledgeChanged({ workspaceId: 'global', indexGeneration: Date.now(), reason: request.action === 'delete' ? 'deleted' : 'imported',
        ...(request.entryId && !request.methodIds?.length ? { deletedEntryId: request.entryId } : {}) });
    }
    return result;
  });
  registerModelHandler('backend-runtime:status', async (event) => {
    assertTrustedIpcSender(event);
    return getManagedBackendRuntimeStatus();
  });
  registerModelHandler('backend-runtime:retry', async (event) => {
    assertTrustedIpcSender(event);
    const runtime = managedBackendRuntime;
    const currentStatus = runtime?.getStatus();
    if (
      !runtime
      || !currentStatus
      || (currentStatus.state !== 'ready' && !currentStatus.retryable)
    ) {
      return getManagedBackendRuntimeStatus();
    }
    try {
      await runtime.retry();
    } catch {
      // 最终产品状态由 runtime 自己发布；IPC 不回传内部异常、端口或路径。
    }
    return getManagedBackendRuntimeStatus();
  });
  registerModelHandler('backend-runtime:probe', async (event) => {
    assertTrustedIpcSender(event);
    return probeBackendAvailability();
  });
  registerModelHandler('clipboard:read-text', async (event) => {
    assertTrustedIpcSender(event);
    return clipboard.readText();
  });
  registerModelHandler('clipboard:write-text', async (event, value: unknown) => {
    assertTrustedIpcSender(event);
    if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) {
      throw new Error('剪贴板文本无效');
    }
    clipboard.writeText(value);
  });
  registerModelHandler('model-interfaces:get', async (event) => {
    assertTrustedIpcSender(event);
    return workstationModelInterfacesService.getView();
  });
  registerModelHandler('model-interfaces:create', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return workstationModelInterfacesService.create(validateCreateModelInterfaceRequest(request));
  });
  registerModelHandler('model-interfaces:update', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return workstationModelInterfacesService.update(validateUpdateModelInterfaceRequest(request));
  });
  registerModelHandler('model-interfaces:delete', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const validated = validateDeleteModelInterfaceRequest(request);
    return workstationModelInterfacesService.delete(validated);
  });
  registerModelHandler('model-interfaces:select', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    return workstationModelInterfacesService.select(validateSelectModelInterfaceRequest(request));
  });
  registerModelHandler('model-interfaces:test-connection', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const validated = validateModelInterfaceConnectionTestRequest(request);
    if (validated.credentialMode === 'direct' && !validated.apiKey && validated.interfaceId) {
      const storedApiKey = await workstationModelInterfacesService.resolveStoredApiKey(validated.interfaceId);
      if (storedApiKey) return modelInterfaceConnectionTestService.test({ ...validated, apiKey: storedApiKey });
    }
    return modelInterfaceConnectionTestService.test(validated);
  });
  registerModelHandler('rag-embedding-interfaces:get', async (event) => {
    assertTrustedIpcSender(event);
    return ragEmbeddingInterfacesService.getView();
  });
  registerModelHandler('rag-embedding-interfaces:create', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const result = await ragEmbeddingInterfacesService.create(
      validateCreateRagEmbeddingInterfaceRequest(request)
    );
    publishRagConfigurationChanged();
    return result;
  });
  registerModelHandler('rag-embedding-interfaces:update', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const result = await ragEmbeddingInterfacesService.update(
      validateUpdateRagEmbeddingInterfaceRequest(request)
    );
    publishRagConfigurationChanged();
    return result;
  });
  registerModelHandler('rag-embedding-interfaces:delete', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const validated = validateDeleteRagEmbeddingInterfaceRequest(request);
    const options = {
      type: 'warning' as const,
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '删除 Embedding 接口',
      message: '确定删除这个 Embedding 接口吗？',
      detail: '删除后不会自动选择其他接口，RAG 将使用服务端知识库进行检索。'
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const confirmation = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return ragEmbeddingInterfacesService.getView();
    const result = await ragEmbeddingInterfacesService.delete(validated);
    publishRagConfigurationChanged();
    return result;
  });
  registerModelHandler('rag-embedding-interfaces:select', async (event, request: unknown) => {
    assertTrustedIpcSender(event);
    const result = await ragEmbeddingInterfacesService.select(
      validateSelectRagEmbeddingInterfaceRequest(request)
    );
    publishRagConfigurationChanged();
    return result;
  });
  registerModelHandler(
    'rag-embedding-interfaces:test-connection',
    async (event, request: unknown) => {
      assertTrustedIpcSender(event);
      const validated = validateRagEmbeddingInterfaceConnectionTestRequest(request);
      if (validated.credentialMode === 'direct' && !validated.apiKey && validated.interfaceId) {
        const storedApiKey = await ragEmbeddingInterfacesService.resolveStoredApiKeyForConnectionTest(
          validated
        );
        if (storedApiKey) {
          return ragEmbeddingInterfaceConnectionTestService.test({
            ...validated,
            apiKey: storedApiKey
          });
        }
      }
      return ragEmbeddingInterfaceConnectionTestService.test(validated);
    }
  );
  ipcMain.handle('workspace:select', async (event) => {
    assertTrustedIpcSender(event);
    let defaultPath: string;
    try {
      defaultPath = await getWorkspaceStateService().getPickerDefaultPath();
    } catch {
      throw new Error('无法读取工作区选择目录');
    }
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择 Java Maven 工作区',
      defaultPath
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const workspaceRoot = validateWorkspaceRoot(result.filePaths[0]);
    try {
      await getWorkspaceStateService().rememberWorkspaceSelection(workspaceRoot);
    } catch {
      throw new Error('无法保存工作区选择记录');
    }
    activeWorkspaceRoot = workspaceRoot;
    return workspaceRoot;
  });

  ipcMain.handle('workspace:get-last', async (event) => {
    assertTrustedIpcSender(event);
    try {
      const candidate = await getWorkspaceStateService().getLastWorkspace();
      if (candidate.state === 'ready') {
        // 仅可信且存在的恢复记录可以重新建立生成工作区授权。
        activeWorkspaceRoot = candidate.workspaceRoot;
      }
      return candidate;
    } catch {
      throw new Error('无法读取上次打开的工作区记录');
    }
  });

  ipcMain.handle('workspace:get-view-state', async (event, workspaceRoot: unknown) => {
    assertTrustedIpcSender(event);
    const activeWorkspaceRoot = validateActiveWorkspaceViewStateRoot(workspaceRoot);
    try {
      return await getWorkspaceStateService().getViewState(activeWorkspaceRoot);
    } catch {
      throw new Error('无法读取当前工作区的视图状态');
    }
  });

  ipcMain.handle('workspace:save-view-state', async (event, value: unknown) => {
    assertTrustedIpcSender(event);
    const viewState = validateWorkspaceViewState(value);
    validateActiveWorkspaceViewStateRoot(viewState.workspaceRoot);
    try {
      await getWorkspaceStateService().saveViewState(viewState);
    } catch {
      throw new Error('无法保存当前工作区的视图状态');
    }
  });

  ipcMain.handle('workstation-build-settings:get', async (event) => {
    assertTrustedIpcSender(event);
    return workstationBuildSettingsService.get();
  });

  ipcMain.handle('workstation-build-settings:validate', async (event, settings: unknown) => {
    assertTrustedIpcSender(event);
    const validated = validateSaveWorkstationBuildSettingsRequest(settings);
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    return shellService.validateBuildSettings(validated, app.getPath('userData'));
  });

  ipcMain.handle('workstation-build-settings:save', async (event, settings: unknown) => {
    assertTrustedIpcSender(event);
    const validated = validateSaveWorkstationBuildSettingsRequest(settings);
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    const validation = await shellService.validateBuildSettings(validated, app.getPath('userData'));
    if (!validation.valid) {
      throw new Error(validation.error || '构建环境校验失败');
    }
    const saved = await workstationBuildSettingsService.save(validated, validation);
    return saved;
  });

  ipcMain.handle('workstation-build-settings:select-path', async (event, rawKind: unknown) => {
    assertTrustedIpcSender(event);
    const kind = validateWorkstationBuildSettingsPathKind(rawKind);
    const isSettingsFile = kind === 'settingsPath';
    const result = await dialog.showOpenDialog({
      title: isSettingsFile ? '选择 Maven settings.xml' : '选择构建环境目录',
      properties: [isSettingsFile ? 'openFile' : 'openDirectory'],
      ...(isSettingsFile
        ? { filters: [{ name: 'Maven settings', extensions: ['xml'] }] }
        : {})
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('workstation-build-settings:maven-defaults', async (event, rawMavenHome: unknown) => {
    assertTrustedIpcSender(event);
    return workstationBuildSettingsService.resolveMavenHomeDefaults(validateWorkstationMavenHome(rawMavenHome));
  });

  ipcMain.handle('model-call-log-settings:get', async (event) => {
    assertTrustedIpcSender(event);
    try {
      return await modelCallLogAccessService.getForManagement();
    } catch {
      throw new Error('无法读取模型调用记录设置。');
    }
  });

  ipcMain.handle('model-call-log-settings:save', async (event, rawRequest: unknown) => {
    assertTrustedIpcSender(event);
    const request = validateSaveModelCallLogSettingsRequest(rawRequest);
    try {
      return await modelCallLogAccessService.saveForManagement(request);
    } catch (error) {
      if (error instanceof Error && /目录|路径/.test(error.message)) {
        throw error;
      }
      throw new Error('无法保存模型调用记录设置。');
    }
  });

  ipcMain.handle('model-call-log-settings:select-directory', async (event) => {
    assertTrustedIpcSender(event);
    const current = await modelCallLogAccessService.getForManagement();
    const result = await dialog.showOpenDialog({
      title: '选择模型调用记录存储目录',
      properties: ['openDirectory', 'createDirectory'],
      ...(current.directory ? { defaultPath: current.directory } : {})
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('ui:attention-sound', () => {
    electronShell.beep();
  });

  ipcMain.handle('ui:set-window-modal-blocked', (event, blocked: boolean) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.setMinimizable(!blocked);
    mainWindow.setMaximizable(!blocked);
    mainWindow.setClosable(!blocked);
  });

  ipcMain.handle('file:list', async (event, workspaceRoot: string) => {
    assertTrustedIpcSender(event);
    return fileSystemService.listWorkspaceFiles(workspaceRoot);
  });

  ipcMain.handle('file:list-children', async (event, workspaceRoot: string, directoryPath?: string) => {
    assertTrustedIpcSender(event);
    return fileSystemService.listWorkspaceChildren(workspaceRoot, directoryPath);
  });

  ipcMain.handle('file:list-search', async (event, workspaceRoot: string) => {
    assertTrustedIpcSender(event);
    return fileSystemService.listWorkspaceSearchFiles(workspaceRoot);
  });

  ipcMain.handle('file:read', async (event, workspaceRoot: string, filePath: string) => {
    assertTrustedIpcSender(event);
    return fileSystemService.readTextFile(workspaceRoot, filePath);
  });

  ipcMain.handle('file:write', async (event, workspaceRoot: string, filePath: string, content: string) => {
    assertTrustedIpcSender(event);
    return fileSystemService.writeTextFile(workspaceRoot, filePath, content);
  });

  ipcMain.handle('java:scan-project', async (event, workspaceRoot: string) => {
    assertTrustedIpcSender(event);
    return javaProjectAnalyzer.scanProject(workspaceRoot);
  });

  ipcMain.handle('shell:mvn-test', async (event, workspaceRoot: string, testName?: string) => {
    assertTrustedIpcSender(event);
    const activeWorkspaceRoot = validateActiveWorkspaceViewStateRoot(workspaceRoot);
    const buildSettings = await workstationBuildSettingsService.get();
    if (!buildSettings) {
      throw new Error('请先在设置中完成工作站全局构建环境配置');
    }
    const validation = await shellService.validateBuildSettings(buildSettings, activeWorkspaceRoot);
    if (!validation.valid) {
      throw new Error(validation.error || '构建环境校验失败');
    }
    return shellService.runMavenTest(activeWorkspaceRoot, buildSettings, testName);
  });

  ipcMain.handle('backend-settings:get', async (event) => {
    return runTrustedBackendSettingsAction({
      senderTrusted: isTrustedIpcSender(event),
      run: async () => {
        assertDevelopmentBackendSettingsAllowed();
        const settings = await readBackendSettings();
        aiClient.setBackendSettings(settings);
        return settings;
      }
    });
  });

  ipcMain.handle('backend-settings:save', async (event, rawSettings: unknown) => {
    return runTrustedBackendSettingsAction({
      senderTrusted: isTrustedIpcSender(event),
      run: async () => {
        assertDevelopmentBackendSettingsAllowed();
        return writeBackendSettings(validateBackendSettingsSaveRequest(rawSettings));
      }
    });
  });

  ipcMain.handle('backend:health', async (event) => {
    return runTrustedBackendSettingsAction({
      senderTrusted: isTrustedIpcSender(event),
      run: () => {
        assertDevelopmentBackendSettingsAllowed();
        return checkBackendHealth(aiClient.getBackendSettings());
      }
    });
  });

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(() => {
        console.error('[main] 工作站窗口重新创建失败');
        dialog.showErrorBox('工作站窗口启动失败', '工作站界面无法加载，请退出应用后重试。');
      });
    }
  });
  }).catch(async () => {
    console.error('[main] 工作站启动链失败');
    try {
      await classTaskRuntime?.beforeQuit();
    } catch {
      console.error('[main] 启动失败后的类任务清理未完成');
    }
    disposeClassTaskIpc?.();
    disposeClassTaskIpc = null;
    try {
      await managedBackendRuntime?.stop();
    } catch {
      console.error('[main] 启动失败后的本地服务清理未完成');
    }
    dialog.showErrorBox('工作站启动失败', '工作站初始化失败，请重启应用；如果问题持续，请重新安装。');
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let shutdownReadyToQuit = false;
let shutdownPending = false;

async function shutdownApplication(): Promise<void> {
  disposeClassTaskIpc?.();
  disposeClassTaskIpc = null;
  try {
    await classTaskRuntime?.beforeQuit();
  } catch {
    console.error('[main] 类任务退出状态未能完整落盘');
  }
  authSessionService?.dispose();

  const shutdownTasks: Promise<unknown>[] = [rendererDiagnosticQueue];
  if (workspaceStateService) shutdownTasks.push(workspaceStateService.flush());
  if (workstationBuildSettingsService) shutdownTasks.push(workstationBuildSettingsService.flush());
  if (ragEmbeddingInterfacesService) {
    shutdownTasks.push(ragEmbeddingInterfacesService.flush());
  }
  if (workstationModelInterfacesService) shutdownTasks.push(workstationModelInterfacesService.flush());
  await Promise.allSettled(shutdownTasks);
  try {
    await managedBackendRuntime?.stop();
  } catch {
    console.error('[main] 本地服务关闭未完成');
  }
}

app.on('before-quit', (event) => {
  if (shutdownReadyToQuit) {
    return;
  }

  event.preventDefault();
  if (shutdownPending) {
    return;
  }

  shutdownPending = true;
  void shutdownApplication().finally(() => {
    shutdownReadyToQuit = true;
    app.quit();
  });
});

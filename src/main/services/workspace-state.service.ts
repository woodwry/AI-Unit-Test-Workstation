import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { AtomicJsonStore } from './atomic-json-store.ts';
import { validateClassMethodCatalog } from './class-task-ipc-validation.ts';
import type {
  WorkspaceRestoreCandidate,
  WorkspaceViewState,
  WorkspaceWorkbenchTabState
} from '../../shared/types.ts';

const MAX_WORKBENCH_TABS = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUALIFIED_CLASS_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

export type StoredWorkspaceState = {
  version: 1;
  lastWorkspaceRoot?: string;
  pickerParentDirectory?: string;
  viewStates: Record<string, Omit<WorkspaceViewState, 'workspaceRoot'>>;
};

/** 工作区状态的唯一写入者；生成目标属于一次性流程，绝不写入此服务。 */
export class WorkspaceStateService {
  private readonly store: AtomicJsonStore<StoredWorkspaceState>;
  private readonly documentsDirectory: string;
  private readonly homeDirectory: string;
  private readonly directoryExists: (path: string) => Promise<boolean>;

  constructor(
    storagePath: string,
    documentsDirectory: string,
    homeDirectory: string,
    directoryExists: (path: string) => Promise<boolean> = defaultDirectoryExists
  ) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateStoredWorkspaceState,
      () => ({ version: 1, viewStates: {} })
    );
    this.documentsDirectory = documentsDirectory;
    this.homeDirectory = homeDirectory;
    this.directoryExists = directoryExists;
  }

  async getLastWorkspace(): Promise<WorkspaceRestoreCandidate> {
    const state = await this.store.read();
    const workspaceRoot = state.lastWorkspaceRoot;
    if (!workspaceRoot) return { state: 'none' };
    if (await this.directoryExists(workspaceRoot)) return { state: 'ready', workspaceRoot };

    await this.store.update((current) => {
      if (current.lastWorkspaceRoot !== workspaceRoot) return current;
      const { lastWorkspaceRoot: _discarded, ...rest } = current;
      return rest as StoredWorkspaceState;
    });
    return { state: 'missing' };
  }

  /** 迁移只读访问器：不检查目录是否仍存在，也不改变正常启动恢复记录。 */
  async getPersistedLastWorkspaceRoot(): Promise<string | null> {
    return (await this.store.read()).lastWorkspaceRoot ?? null;
  }

  /** 选择成功后记录启动恢复根目录和下一次 picker 的父目录。 */
  async rememberWorkspaceSelection(workspaceRoot: string): Promise<void> {
    if (!isNonEmptyString(workspaceRoot)) throw invalidWorkspaceStateError();
    await this.store.update((state) => ({
      ...state,
      lastWorkspaceRoot: workspaceRoot,
      pickerParentDirectory: dirname(workspaceRoot)
    }));
  }

  async getPickerDefaultPath(): Promise<string> {
    const state = await this.store.read();
    for (const candidate of [state.pickerParentDirectory, this.documentsDirectory, this.homeDirectory]) {
      if (candidate && await this.directoryExists(candidate)) return candidate;
    }
    return this.homeDirectory;
  }

  async getViewState(workspaceRoot: string): Promise<WorkspaceViewState | null> {
    if (!isNonEmptyString(workspaceRoot)) throw invalidWorkspaceStateError();
    const state = await this.store.read();
    const view = state.viewStates[getWorkspaceStateKey(workspaceRoot)];
    return view
      ? {
          workspaceRoot,
          expandedPaths: [...view.expandedPaths],
          openFilePaths: [...view.openFilePaths],
          ...(view.activeFilePath !== undefined ? { activeFilePath: view.activeFilePath } : {}),
          ...(view.activityView !== undefined ? { activityView: view.activityView } : {}),
          ...(view.workbenchTabs !== undefined
            ? { workbenchTabs: structuredClone(view.workbenchTabs) }
            : {}),
          ...(view.activeWorkbenchTabId !== undefined
            ? { activeWorkbenchTabId: view.activeWorkbenchTabId }
            : {})
        }
      : null;
  }

  /** 只复制允许的视图字段，避免生成目标等临时字段进入持久化文件。 */
  async saveViewState(viewState: WorkspaceViewState): Promise<void> {
    const normalized = normalizeViewState(viewState);
    await this.store.update((state) => ({
      ...state,
      viewStates: {
        ...state.viewStates,
        [getWorkspaceStateKey(normalized.workspaceRoot)]: {
          expandedPaths: [...normalized.expandedPaths],
          openFilePaths: [...normalized.openFilePaths],
          ...(normalized.activeFilePath !== undefined ? { activeFilePath: normalized.activeFilePath } : {}),
          ...(normalized.activityView !== undefined ? { activityView: normalized.activityView } : {}),
          ...(normalized.workbenchTabs !== undefined
            ? { workbenchTabs: structuredClone(normalized.workbenchTabs) }
            : {}),
          ...(normalized.activeWorkbenchTabId !== undefined
            ? { activeWorkbenchTabId: normalized.activeWorkbenchTabId }
            : {})
        }
      }
    }));
  }

  async flush(): Promise<void> {
    // read() 会等待 AtomicJsonStore 内部队列，退出前借此排空写入。
    await this.store.read();
  }
}

export function getWorkspaceStateKey(workspaceRoot: string): string {
  return workspaceRoot.replace(/\\/g, '/').toLowerCase();
}

export function validateStoredWorkspaceState(value: unknown): StoredWorkspaceState {
  const fail = (): never => { throw invalidWorkspaceStateError(); };
  if (!isPlainRecord(value)) return fail();
  requireExactKeys(value, ['version', 'lastWorkspaceRoot', 'pickerParentDirectory', 'viewStates'], fail);
  if (value.version !== undefined && value.version !== 1) return fail();

  for (const field of ['lastWorkspaceRoot', 'pickerParentDirectory'] as const) {
    const item = value[field];
    if (item !== undefined && !isNonEmptyString(item)) return fail();
  }

  const rawViews = value.viewStates ?? {};
  if (!isPlainRecord(rawViews)) return fail();
  const viewStates: StoredWorkspaceState['viewStates'] = {};
  for (const [key, rawView] of Object.entries(rawViews)) {
    if (!key || !isPlainRecord(rawView)) return fail();
    requireExactKeys(rawView, [
      'expandedPaths', 'openFilePaths', 'activeFilePath', 'activityView',
      'workbenchTabs', 'activeWorkbenchTabId',
      // 旧开发版文件可能包含该字段；读取时接受，但绝不回写。
      'generationTargetFilePath'
    ], fail);
    if (!isStringArray(rawView.expandedPaths) || !isStringArray(rawView.openFilePaths)) return fail();
    if (rawView.activeFilePath !== undefined && !isNonEmptyString(rawView.activeFilePath)) return fail();
    const activityView = rawView.activityView === undefined
      ? undefined
      : rawView.activityView === 'extensions'
        ? 'explorer'
        : rawView.activityView === 'explorer'
          || rawView.activityView === 'search'
          || rawView.activityView === 'rag-knowledge'
          ? rawView.activityView
          : fail();
    const workbenchTabs = rawView.workbenchTabs === undefined
      ? undefined
      : validateWorkbenchTabs(rawView.workbenchTabs, fail, true);
    if (rawView.activeWorkbenchTabId !== undefined && !isNonEmptyString(rawView.activeWorkbenchTabId)) return fail();
    if (
      rawView.activeWorkbenchTabId !== undefined &&
      workbenchTabs !== undefined &&
      !workbenchTabs.some((tab) => workbenchTabId(tab) === rawView.activeWorkbenchTabId)
    ) return fail();
    if (rawView.generationTargetFilePath !== undefined && typeof rawView.generationTargetFilePath !== 'string') return fail();

    viewStates[key] = {
      expandedPaths: [...rawView.expandedPaths],
      openFilePaths: [...rawView.openFilePaths],
      ...(rawView.activeFilePath !== undefined ? { activeFilePath: rawView.activeFilePath } : {}),
      ...(activityView !== undefined ? { activityView } : {}),
      ...(workbenchTabs !== undefined ? { workbenchTabs } : {}),
      ...(rawView.activeWorkbenchTabId !== undefined
        ? { activeWorkbenchTabId: rawView.activeWorkbenchTabId }
        : {})
    };
  }

  return {
    version: 1,
    ...(typeof value.lastWorkspaceRoot === 'string' ? { lastWorkspaceRoot: value.lastWorkspaceRoot } : {}),
    ...(typeof value.pickerParentDirectory === 'string' ? { pickerParentDirectory: value.pickerParentDirectory } : {}),
    viewStates
  };
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

function normalizeViewState(viewState: WorkspaceViewState): WorkspaceViewState {
  if (!isPlainRecord(viewState) || !isNonEmptyString(viewState.workspaceRoot) ||
      !isStringArray(viewState.expandedPaths) || !isStringArray(viewState.openFilePaths) ||
      (viewState.activeFilePath !== undefined && !isNonEmptyString(viewState.activeFilePath)) ||
      (viewState.activityView !== undefined
        && !['explorer', 'search', 'rag-knowledge'].includes(viewState.activityView)) ||
      (viewState.activeWorkbenchTabId !== undefined && !isNonEmptyString(viewState.activeWorkbenchTabId))) {
    throw invalidWorkspaceStateError();
  }
  const workbenchTabs = viewState.workbenchTabs === undefined
    ? undefined
    : validateWorkbenchTabs(viewState.workbenchTabs, () => { throw invalidWorkspaceStateError(); });
  if (
    viewState.activeWorkbenchTabId !== undefined &&
    workbenchTabs !== undefined &&
    !workbenchTabs.some((tab) => workbenchTabId(tab) === viewState.activeWorkbenchTabId)
  ) {
    throw invalidWorkspaceStateError();
  }
  return {
    workspaceRoot: viewState.workspaceRoot,
    expandedPaths: [...viewState.expandedPaths],
    openFilePaths: [...viewState.openFilePaths],
    ...(viewState.activeFilePath !== undefined ? { activeFilePath: viewState.activeFilePath } : {}),
    ...(viewState.activityView !== undefined ? { activityView: viewState.activityView } : {}),
    ...(workbenchTabs !== undefined ? { workbenchTabs } : {}),
    ...(viewState.activeWorkbenchTabId !== undefined
      ? { activeWorkbenchTabId: viewState.activeWorkbenchTabId }
      : {})
  };
}

function validateWorkbenchTabs(
  value: unknown,
  fail: () => never,
  discardLegacyCatalogWithoutTotals = false
): WorkspaceWorkbenchTabState[] {
  if (!Array.isArray(value) || value.length > MAX_WORKBENCH_TABS) return fail();
  const tabs: WorkspaceWorkbenchTabState[] = [];
  const ids = new Set<string>();
  for (const rawTab of value) {
    if (!isPlainRecord(rawTab)) return fail();
    let tab: WorkspaceWorkbenchTabState;
    if (rawTab.kind === 'source') {
      requireExactKeys(rawTab, ['kind', 'filePath'], fail);
      if (!isNonEmptyString(rawTab.filePath)) return fail();
      tab = { kind: 'source', filePath: rawTab.filePath };
    } else if (rawTab.kind === 'method_configuration') {
      requireExactKeys(rawTab, [
        'kind', 'taskId', 'sourceFilePath', 'qualifiedClassName', 'catalog'
      ], fail);
      if (!isNonEmptyString(rawTab.taskId) || !UUID_PATTERN.test(rawTab.taskId) ||
          !isNonEmptyString(rawTab.sourceFilePath) ||
          !isNonEmptyString(rawTab.qualifiedClassName) ||
          !QUALIFIED_CLASS_PATTERN.test(rawTab.qualifiedClassName)) return fail();
      const legacyCatalogWithoutTotals = discardLegacyCatalogWithoutTotals
        && isPlainRecord(rawTab.catalog)
        && !Object.prototype.hasOwnProperty.call(rawTab.catalog, 'reportCoverageTotals');
      const catalog = rawTab.catalog === undefined || legacyCatalogWithoutTotals
        ? undefined
        : validateCatalogForTab(rawTab.catalog, rawTab.taskId, fail);
      tab = {
        kind: 'method_configuration',
        taskId: rawTab.taskId,
        sourceFilePath: rawTab.sourceFilePath,
        qualifiedClassName: rawTab.qualifiedClassName,
        ...(catalog ? { catalog } : {})
      };
    } else {
      return fail();
    }
    const id = workbenchTabId(tab);
    if (ids.has(id)) return fail();
    ids.add(id);
    tabs.push(tab);
  }
  return tabs;
}

function validateCatalogForTab(
  value: unknown,
  taskId: string,
  fail: () => never
) {
  try {
    const catalog = validateClassMethodCatalog(value);
    if (catalog.taskId !== taskId) return fail();
    return catalog;
  } catch {
    return fail();
  }
}

function workbenchTabId(tab: WorkspaceWorkbenchTabState): string {
  return tab.kind === 'source' ? `source:${tab.filePath}` : `methods:${tab.taskId}`;
}

function invalidWorkspaceStateError(): TypeError {
  // 错误正文不包含用户路径，避免路径通过 IPC 或日志泄露。
  return new TypeError('工作区状态文件格式无效');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], fail: () => never): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail();
}

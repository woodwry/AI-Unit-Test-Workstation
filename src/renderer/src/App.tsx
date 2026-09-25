import {
  MonacoDecorationIdStore,
  updateOpenFileContentByPath
} from './monaco-editor-document-state';
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Crosshair,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search,
  Settings,
  Users,
  LogOut,
  User,
  Check,
  X
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type UIEvent,
  type WheelEvent as ReactWheelEvent
} from 'react';
import type {
  BackendHealthSummary,
  BackendSettings,
  BuildSettingsPathKind,
  BuildSettingsValidationResult,
  ClassMethodCatalog,
  ClassTaskResultSnapshot,
  ClassTaskSnapshot,
  JavaProjectScanResult,
  ManagedBackendRuntimeStatus,
  MavenHomeDefaults,
  WorkstationBuildSettings,
  WorkspaceFile,
  WorkspaceWorkbenchTabState
} from '../../shared/types';
import type { AuthUser } from '../../shared/auth-contracts';
import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog';
import { RagKnowledgeIcon } from './rag-knowledge/RagKnowledgeIcon';
import { GlobalKnowledgePanel as RagKnowledgePanel } from './rag-knowledge/GlobalKnowledgePanel';
import { RagMethodSourcePanel } from './rag-knowledge/RagMethodSourcePanel';
import type { RagKnowledgeEntryView, RagKnowledgeMethodSource, RagKnowledgeMethodView } from '../../shared/rag-knowledge-contracts';
import { openRagMethodTab, closeRagMethodTabs } from './class-tasks/workbench-tab-state';
import './rag-knowledge/rag-knowledge.css';
import { UserManagementPanel } from './UserManagementPanel';
import './user-management.css';
import {
  CLASS_TASK_FILE_PATH_MIME,
  ClassTaskPanel,
  type ClassTaskFocusRequest
} from './class-tasks/ClassTaskPanel';
import {
  classTaskTotalRunEligibleIds,
  releaseClassTaskCommandDispatch,
  type ClassTaskCardIntent
} from './class-tasks/class-task-card-view';
import {
  describeClassTaskRunAllOutcome,
  reconcileClassTaskCommandStart
} from './class-tasks/class-task-command-reconciliation';
import {
  MethodConfigurationTab,
  type MethodSelectionDraft
} from './class-tasks/MethodConfigurationTab';
import {
  activateWorkbenchTab,
  closeWorkbenchTab,
  createEmptyWorkbenchTabs,
  openMethodConfigurationTab,
  openSourceTab,
  restorePersistedWorkbenchTabs,
  type WorkbenchTab,
  type WorkbenchTabs
} from './class-tasks/workbench-tab-state';
import { canCloseModelSettings } from './model-settings-request-state';
import { applyJavaLocalSemanticDecorations } from './java-local-semantic-decorations';
import { LocalMonacoEditor } from './LocalMonacoEditor';
import { DEFAULT_EDITOR_THEME } from './monaco-editor-appearance';
import { getMonacoFailureCause, runMonacoStage } from './monaco-initialization-diagnostics';
import type {
  MonacoApi,
  MonacoEditor,
  MonacoEditorDesiredState,
  MonacoEditorFacade,
  MonacoEditorOptions,
  MonacoEditorSession,
  MonacoSessionModelBinding,
  MonacoSessionModelEvent
} from './monaco-editor-session';
import { getSafeRendererErrorFingerprint, getSafeRendererErrorType } from './renderer-safe-error';

type ActivityView = 'explorer' | 'search' | 'rag-knowledge' | 'user-management';

type ChatMessage = {
  role: 'assistant' | 'user';
  content: string;
};

type SelectedFile = {
  path: string;
  relativePath: string;
  content: string;
  savedContent: string;
};

const MAX_RESTORED_EXPANDED_PATHS = 120;
const MAX_RESTORED_OPEN_FILES = 12;

const MAX_WORKSPACE_SEARCH_MATCHES = 500;
const MAX_WORKSPACE_SEARCH_MATCHES_PER_FILE = 80;
const MAX_QUICK_FILE_SEARCH_RESULTS = 60;
const METHOD_SELECTION_SAVE_ERROR_VISIBLE_MS = 6_000;
const ACTIVITY_BAR_WIDTH = 48;
const RESIZE_HANDLE_WIDTH = 8;
const MIN_EDITOR_COLUMN_WIDTH = 220;
const MIN_LEFT_PANEL_WIDTH = 220;
const MAX_LEFT_PANEL_WIDTH = 520;
const MIN_RIGHT_PANEL_WIDTH = 320;
const MAX_RIGHT_PANEL_WIDTH = 640;

function scrollEditorTabsWithWheel(event: ReactWheelEvent<HTMLDivElement>): void {
  const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (
    horizontalDelta === 0
    || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth
  ) return;
  event.preventDefault();
  event.currentTarget.scrollLeft += horizontalDelta;
}

const MONACO_EDITOR_OPTIONS: MonacoEditorOptions = {
  minimap: { enabled: true },
  renderLineHighlight: 'none',
  readOnly: true,
  domReadOnly: true,
  cursorBlinking: 'blink',
  cursorStyle: 'line',
  cursorWidth: 2,
  overviewRulerBorder: false,
  scrollbar: {
    verticalScrollbarSize: 9,
    horizontalScrollbarSize: 9,
    useShadows: false
  },
  fontSize: 13,
  fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
  lineHeight: 21,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  wordWrap: 'off',
  automaticLayout: true,
  padding: { top: 14, bottom: 14 }
};
const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  agentServiceUrl: 'http://127.0.0.1:18000',
  javaAnalyzerUrl: 'http://127.0.0.1:18080'
};

type SemanticTokenStyle = {
  foreground?: string;
  fontStyle?: string;
};

type LanguageChoice = {
  id: string;
  label: string;
  aliases?: string;
};

type WorkspaceSearchMatch = {
  line: number;
  column: number;
  preview: string;
};

type WorkspaceSearchFileResult = {
  file: WorkspaceFile;
  matches: WorkspaceSearchMatch[];
};

type WorkspaceSearchOptions = {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
};

type WorkspaceSearchMatcher = {
  expression: RegExp;
};

type QuickFileSearchCache = {
  workspaceRoot: string;
  files: WorkspaceFile[];
};

type PendingEditorReveal = {
  path: string;
  line: number;
  column: number;
};

type TreeFileRevealRequest = {
  path: string;
  sequence: number;
};

type TabContextMenuState = {
  tabId: WorkbenchTab['id'];
  x: number;
  y: number;
};

type ClassTaskMethodCatalogLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string };

type RagSourceLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string };

type AppProps = {
  editorSession: MonacoEditorSession;
};

export function App({ editorSession }: AppProps): JSX.Element {
  const [activityView, setActivityView] = useState<ActivityView>('explorer');
  const [authenticatedUser, setAuthenticatedUser] = useState<AuthUser | null>(null);
  const [ragSettingsOpenRequestId, setRagSettingsOpenRequestId] = useState(0);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(372);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(420);
  const [workspaceRoot, setWorkspaceRoot] = useState<string>('');
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [javaProject, setJavaProject] = useState<JavaProjectScanResult | null>(null);
  const [openFiles, setOpenFiles] = useState<SelectedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [workbenchTabs, setWorkbenchTabs] = useState<WorkbenchTabs>(createEmptyWorkbenchTabs);
  const [ragSources, setRagSources] = useState<Record<string, RagKnowledgeMethodSource>>({});
  const [ragSourceLoadStates, setRagSourceLoadStates] = useState<Record<string, RagSourceLoadState>>({});
  const [ragConfigurationVersion, setRagConfigurationVersion] = useState(0);
  const ragSourceRequestEpoch = useRef(0);
  const ragSourceRequestTokens = useRef(new Map<string, symbol>());

  useEffect(() => {
    let disposed = false;
    const apply = (state: Awaited<ReturnType<typeof window.workstation.getAuthState>>): void => {
      if (!disposed) setAuthenticatedUser(state.status === 'authenticated' ? state.user : null);
    };
    void window.workstation.getAuthState().then(apply).catch(() => undefined);
    const unsubscribe = window.workstation.onAuthStateChanged(apply);
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (activityView === 'user-management' && authenticatedUser?.role !== 'ADMIN') {
      setActivityView('explorer');
    }
  }, [activityView, authenticatedUser]);

  useEffect(() => {
    ragSourceRequestEpoch.current++;
    ragSourceRequestTokens.current.clear();
    setRagSources({});
    setRagSourceLoadStates({});
  }, [workspaceRoot]);

  useEffect(() => window.workstation.onRagKnowledgeChanged(event => {
    if (event.reason === 'configuration-changed') {
      ragSourceRequestEpoch.current++;
      ragSourceRequestTokens.current.clear();
      setRagSources({});
      setRagSourceLoadStates({});
      setWorkbenchTabs(tabs => {
        for (const tab of tabs.items) if (tab.kind === 'rag_method') tabs = closeWorkbenchTab(tabs, tab.id);
        return tabs;
      });
      setRagConfigurationVersion(value => value + 1);
    } else if (event.deletedEntryId) {
      const deletedPrefix = `rag:${event.deletedEntryId}:`;
      const deletedId = event.deletedMethodId ? `${deletedPrefix}${event.deletedMethodId}` : null;
      for (const id of ragSourceRequestTokens.current.keys()) {
        if (deletedId ? id === deletedId : id.startsWith(deletedPrefix)) ragSourceRequestTokens.current.delete(id);
      }
      setWorkbenchTabs(tabs => closeRagMethodTabs(tabs, { entryId: event.deletedEntryId!, methodId: event.deletedMethodId }));
      setRagSources(sources => Object.fromEntries(Object.entries(sources).filter(([, source]) =>
        source.entryId !== event.deletedEntryId || (event.deletedMethodId && source.method.methodId !== event.deletedMethodId))));
      setRagSourceLoadStates(states => Object.fromEntries(Object.entries(states).filter(([id]) =>
        deletedId ? id !== deletedId : !id.startsWith(deletedPrefix))));
    }
  }), []);

  useEffect(() => {
    const ids = new Set(workbenchTabs.items.filter(tab => tab.kind === 'rag_method').map(tab => tab.id));
    for (const id of ragSourceRequestTokens.current.keys()) {
      if (!ids.has(id as `rag:${string}`)) ragSourceRequestTokens.current.delete(id);
    }
    setRagSources(previous => Object.keys(previous).some(id => !ids.has(id as `rag:${string}`))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id as `rag:${string}`))) : previous);
    setRagSourceLoadStates(previous => Object.keys(previous).some(id => !ids.has(id as `rag:${string}`))
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id as `rag:${string}`))) : previous);
  }, [workbenchTabs.items]);

  async function openRagSource(entry: RagKnowledgeEntryView, method: RagKnowledgeMethodView, indexGeneration: number, configurationId: string): Promise<void> {
    const id = `rag:${entry.entryId}:${method.methodId}` as const;
    setWorkbenchTabs(tabs => openRagMethodTab(tabs, { entryId: entry.entryId, methodId: method.methodId,
      ownerFqn: method.ownerFqn, methodName: method.methodName, canonicalSignature: method.canonicalSignature }));
    if (ragSources[id] || ragSourceRequestTokens.current.has(id)) return;

    const token = Symbol(id);
    ragSourceRequestTokens.current.set(id, token);
    setRagSourceLoadStates(states => ({ ...states, [id]: { status: 'loading' } }));
    const epoch = ragSourceRequestEpoch.current;
    try {
      const source = await window.workstation.getRagKnowledgeMethodSource({ workspaceRoot,
        entryId: entry.entryId, methodId: method.methodId, indexGeneration, configurationId });
      if (epoch !== ragSourceRequestEpoch.current || ragSourceRequestTokens.current.get(id) !== token) return;
      setRagSources(sources => ({ ...sources, [id]: source }));
      setRagSourceLoadStates(states => omitRecordKey(states, id));
    } catch (failure) {
      if (epoch === ragSourceRequestEpoch.current && ragSourceRequestTokens.current.get(id) === token) {
        setRagSourceLoadStates(states => ({
          ...states,
          [id]: { status: 'error', message: failure instanceof Error ? failure.message : String(failure) }
        }));
      }
    } finally {
      if (ragSourceRequestTokens.current.get(id) === token) ragSourceRequestTokens.current.delete(id);
    }
  }
  const [classTaskCatalogs, setClassTaskCatalogs] = useState<Record<string, ClassMethodCatalog>>({});
  const [classTaskMethodCatalogLoadStates, setClassTaskMethodCatalogLoadStates] =
    useState<Record<string, ClassTaskMethodCatalogLoadState>>({});
  const [classTaskSnapshots, setClassTaskSnapshots] = useState<Record<string, ClassTaskSnapshot>>({});
  const [classTaskOrder, setClassTaskOrder] = useState<string[]>([]);
  const [busyClassTaskIds, setBusyClassTaskIds] = useState<Set<string>>(new Set());
  const [classTaskFocusRequest, setClassTaskFocusRequest] = useState<ClassTaskFocusRequest | null>(null);
  const [isClassTaskTotalCommandBusy, setIsClassTaskTotalCommandBusy] = useState(false);
  const [savingMethodSelectionTaskId, setSavingMethodSelectionTaskId] = useState<string | null>(null);
  const [methodSelectionSaveErrors, setMethodSelectionSaveErrors] = useState<Record<string, string>>({});
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState<string>('');
  const [workspaceSearchCaseSensitive, setWorkspaceSearchCaseSensitive] = useState<boolean>(false);
  const [workspaceSearchWholeWord, setWorkspaceSearchWholeWord] = useState<boolean>(false);
  const [workspaceSearchRegex, setWorkspaceSearchRegex] = useState<boolean>(false);
  const [workspaceSearchTreeView, setWorkspaceSearchTreeView] = useState<boolean>(true);
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<WorkspaceSearchFileResult[]>([]);
  const [isSearchingWorkspace, setIsSearchingWorkspace] = useState<boolean>(false);
  const [workspaceSearchError, setWorkspaceSearchError] = useState<string>('');
  const [isQuickFileSearchOpen, setIsQuickFileSearchOpen] = useState<boolean>(false);
  const [quickFileSearchQuery, setQuickFileSearchQuery] = useState<string>('');
  const [quickFileSearchFiles, setQuickFileSearchFiles] = useState<WorkspaceFile[]>([]);
  const [quickFileSearchSelectedIndex, setQuickFileSearchSelectedIndex] = useState<number>(0);
  const [isQuickFileSearchLoading, setIsQuickFileSearchLoading] = useState<boolean>(false);
  const [quickFileSearchError, setQuickFileSearchError] = useState<string>('');
  const [chatInput, setChatInput] = useState<string>('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: '打开一个 Maven 项目，选择 Java 类后，我可以把 JUnit 测试生成到 src/test/java。'
    }
  ]);
  const [backendSettings, setBackendSettings] = useState<BackendSettings>(DEFAULT_BACKEND_SETTINGS);
  const [backendHealth, setBackendHealth] = useState<BackendHealthSummary | null>(null);
  const [managedBackendStatus, setManagedBackendStatus] = useState<ManagedBackendRuntimeStatus | null>();
  const [workspaceBuildSettings, setWorkspaceBuildSettings] = useState<WorkstationBuildSettings | null>(null);
  const [buildSettingsValidation, setBuildSettingsValidation] = useState<BuildSettingsValidationResult | null>(null);
  const [isBuildSettingsBusy, setIsBuildSettingsBusy] = useState<boolean>(false);
  const [isWorkspaceSelectionPending, setIsWorkspaceSelectionPending] = useState<boolean>(false);
  const [languageOverrides, setLanguageOverrides] = useState<Record<string, string>>({});
  const [languageMenuOpen, setLanguageMenuOpen] = useState<boolean>(false);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const [treeFileRevealRequest, setTreeFileRevealRequest] = useState<TreeFileRevealRequest | null>(null);
  const [status, setStatus] = useState<string>('就绪');
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const presentationMonacoRef = useRef<MonacoEditorFacade | null>(null);
  const decorationStoreRef = useRef(new MonacoDecorationIdStore());
  const workspaceSearchRequestRef = useRef<number>(0);
  const pendingEditorRevealRef = useRef<PendingEditorReveal | null>(null);
  const quickFileSearchRequestRef = useRef<number>(0);
  const quickFileSearchCacheRef = useRef<QuickFileSearchCache | null>(null);
  const treeFileRevealSequenceRef = useRef<number>(0);
  const classTaskFocusSequenceRef = useRef<number>(0);
  const classTaskTotalCommandSequenceRef = useRef<number>(0);
  const classTaskTotalPendingTaskIdsRef = useRef<Set<string>>(new Set());
  const deletedClassTaskIdsRef = useRef<Set<string>>(new Set());
  const classTaskMethodCatalogRequestSequenceRef = useRef<number>(0);
  const classTaskMethodCatalogRequestIdsRef = useRef<Map<string, number>>(new Map());
  const isRestoringViewStateRef = useRef<boolean>(false);
  const workspaceLoadRequestRef = useRef<number>(0);
  const workspaceSelectionRequestRef = useRef<number>(0);
  const workspaceSelectionPendingRef = useRef(false);
  const activeWorkspaceRootRef = useRef<string>('');
  const workspaceViewStateSaveTimerRef = useRef<number | null>(null);
  const methodSelectionSaveErrorTimersRef = useRef<Map<string, number>>(new Map());
  // StrictMode 会重放挂载 effect；请求序列同时让用户显式导入时的旧恢复结果失效。
  const startupWorkspaceRestoreStartedRef = useRef(false);
  const startupRestoreRequestRef = useRef(0);
  // 一旦用户主动打开工作区，即使启动 effect 尚未执行也绝不能再恢复旧视图。
  const manualWorkspaceImportStartedRef = useRef(false);

  useLayoutEffect(() => {
    editorRef.current?.layout();
  }, [leftPanelWidth, rightPanelWidth]);

  const selectedFile = useMemo(
    () => openFiles.find((file) => file.path === activeFilePath) ?? null,
    [activeFilePath, openFiles]
  );
  const activeWorkbenchTab = useMemo(
    () => workbenchTabs.items.find((tab) => tab.id === workbenchTabs.activeId) ?? null,
    [workbenchTabs]
  );
  const activeRagSourceLoadState = activeWorkbenchTab?.kind === 'rag_method'
    ? ragSourceLoadStates[activeWorkbenchTab.id]
    : undefined;
  const activeMethodConfigurationTask = activeWorkbenchTab?.kind === 'method_configuration'
    ? classTaskSnapshots[activeWorkbenchTab.taskId] ?? null
    : null;
  const activeMethodConfigurationCatalog = activeWorkbenchTab?.kind === 'method_configuration'
    ? classTaskCatalogs[activeWorkbenchTab.taskId] ?? null
    : null;
  const activeMethodConfigurationLoadState = activeWorkbenchTab?.kind === 'method_configuration'
    ? classTaskMethodCatalogLoadStates[activeWorkbenchTab.taskId] ?? null
    : null;
  const classTasks = useMemo(
    () => classTaskOrder.flatMap((taskId) => {
      const task = classTaskSnapshots[taskId];
      return task ? [task] : [];
    }),
    [classTaskOrder, classTaskSnapshots]
  );
  const openFilePathsKey = useMemo(() => openFiles.map((file) => file.path).join('\n'), [openFiles]);
  const quickFileSearchResults = useMemo(
    () => rankQuickFileSearchResults(
      quickFileSearchFiles,
      quickFileSearchQuery,
      openFiles,
      activeFilePath
    ),
    [activeFilePath, openFiles, quickFileSearchFiles, quickFileSearchQuery]
  );
  const editorLanguage = useMemo(
    () => (selectedFile ? languageOverrides[selectedFile.path] ?? getEditorLanguage(selectedFile.path) : 'plaintext'),
    [languageOverrides, selectedFile?.path]
  );
  const editorLanguageLabel = useMemo(() => getLanguageLabel(editorLanguage), [editorLanguage]);
  const isDirty = Boolean(selectedFile && selectedFile.content !== selectedFile.savedContent);

  function clearWorkspacePresentationState(): void {
    deletedClassTaskIdsRef.current.clear();
    const releasedDecorations = decorationStoreRef.current.clear();
    for (const { canonicalKey, ids } of releasedDecorations) {
      const model = editorSession.getModelByCanonicalKey(canonicalKey);
      if (!model || model.isDisposed()) {
        continue;
      }

      model.deltaDecorations(ids, []);
    }
  }

  const handleEditorError = useCallback((error: unknown): void => {
    const cause = getMonacoFailureCause(error);
    console.error(
      '[renderer] MONACO_EDITOR_FAILURE',
      getSafeRendererErrorType(cause),
      getSafeRendererErrorFingerprint(cause)
    );
    setStatus('编辑器运行失败，请重启工作站');
  }, []);

  const handleDidAttach = useCallback((editor: MonacoEditor, monaco: MonacoEditorFacade): void => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    presentationMonacoRef.current = monaco;
    monaco.editor.setTheme(DEFAULT_EDITOR_THEME);
  }, []);

  const handleWillChangeModel = useCallback((
    previous: MonacoSessionModelBinding | null,
    _nextPath: string | null
  ): void => {
    if (!previous || previous.model.isDisposed()) {
      return;
    }

    previous.model.deltaDecorations(decorationStoreRef.current.release(previous.key), []);
  }, []);

  const handleDidDetach = useCallback((editor: MonacoEditor, _monaco: MonacoEditorFacade): void => {
    const model = editor.getModel();
    if (model && !model.isDisposed()) {
      const canonicalKey = editorSession.getCanonicalKeyForDocumentUri(model.uri.toString());
      if (canonicalKey) {
        model.deltaDecorations(decorationStoreRef.current.release(canonicalKey), []);
      }
    }

    editorRef.current = null;
    monacoRef.current = null;
  }, [editorSession]);

  const handleDidChangeModel = useCallback((
    event: MonacoSessionModelEvent,
    callbackMonaco: MonacoEditorFacade
  ): void => {
    if (event.kind === 'release') {
      const released = decorationStoreRef.current.release(event.model.key);
      if (!event.model.model.isDisposed()) {
        event.model.model.deltaDecorations(released, []);
      }
      return;
    }

    const current = event.current;
    if (!current || current.model.isDisposed()) {
      return;
    }

    const file = openFiles.find((candidate) => candidate.path === current.path);
    const language = file
      ? languageOverrides[file.path] ?? getEditorLanguage(file.path)
      : 'plaintext';
    const previousLocalIds = decorationStoreRef.current.replace(current.key, []);
    const localIds = file && language === 'java'
      ? runMonacoStage('local-decoration', () => applyJavaLocalSemanticDecorations(
          current.model,
          callbackMonaco,
          file.content,
          previousLocalIds
        ))
      : current.model.deltaDecorations(previousLocalIds, []);
    decorationStoreRef.current.replace(current.key, localIds);
  }, [languageOverrides, openFiles]);

  const editorDesiredState = useMemo<MonacoEditorDesiredState>(() => ({
    activeDocument: selectedFile
      ? {
          path: selectedFile.path,
          value: selectedFile.content,
          language: editorLanguage
        }
      : null,
    openFilePaths: openFiles.map((file) => file.path),
    options: MONACO_EDITOR_OPTIONS,
    theme: DEFAULT_EDITOR_THEME,
    onError: handleEditorError,
    onDidChangeContent: (change) => {
      setOpenFiles((files) =>
        updateOpenFileContentByPath(files, change.path, change.value) as SelectedFile[]
      );
    },
    onDidAttach: handleDidAttach,
    onWillChangeModel: handleWillChangeModel,
    onDidDetach: handleDidDetach,
    onDidChangeModel: handleDidChangeModel
  }), [
    editorLanguage,
    handleDidAttach,
    handleDidChangeModel,
    handleDidDetach,
    handleEditorError,
    handleWillChangeModel,
    openFiles,
    selectedFile
  ]);

  useEffect(() => {
    try {
      editorSession.updateDesiredState(editorDesiredState);
    } catch (error) {
      handleEditorError(error);
    }
  }, [editorDesiredState, editorSession, handleEditorError]);

  useEffect(() => () => {
    for (const timer of methodSelectionSaveErrorTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    methodSelectionSaveErrorTimersRef.current.clear();
  }, []);

  useEffect(() => {
    updateSemanticTokenStyles(DEFAULT_SEMANTIC_TOKEN_STYLES);
    if (!startupWorkspaceRestoreStartedRef.current && !manualWorkspaceImportStartedRef.current) {
      startupWorkspaceRestoreStartedRef.current = true;
      const requestId = startupRestoreRequestRef.current + 1;
      startupRestoreRequestRef.current = requestId;
      void restoreLastWorkspace(requestId);
    }
    loadWorkstationBuildSettings();
  }, []);

  useEffect(() => {
    let disposed = false;
    let receivedStatusEvent = false;
    // 先订阅再查询初始快照，避免本地服务在两步之间完成启动而丢失状态变化。
    const unsubscribe = window.workstation.onManagedBackendRuntimeStatusChanged((nextStatus) => {
      if (disposed) return;
      receivedStatusEvent = true;
      setManagedBackendStatus(nextStatus);
    });

    void window.workstation.getManagedBackendRuntimeStatus()
      .then((initialStatus) => {
        if (disposed || receivedStatusEvent) return;
        setManagedBackendStatus(initialStatus);
      })
      .catch(() => {
        if (disposed || receivedStatusEvent) return;
        setManagedBackendStatus({
          state: 'failed',
          message: '无法读取本地服务状态，请重启工作站。',
          retryable: false
        });
        setStatus('本地服务状态读取失败，请重启工作站');
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // 普通界面只提示用户可执行的动作，不展示本地服务的内部状态细节。
  useEffect(() => {
    if (!managedBackendStatus) return;

    if (
      managedBackendStatus.state === 'idle' ||
      managedBackendStatus.state === 'starting-analyzer' ||
      managedBackendStatus.state === 'starting-agent'
    ) {
      setStatus('正在准备本地功能，请稍候…');
      return;
    }

    if (managedBackendStatus.state === 'ready') {
      setStatus('就绪');
      return;
    }

    if (managedBackendStatus.state === 'failed') {
      setStatus(
        managedBackendStatus.retryable
          ? '本地功能暂时不可用，请重启工作站后重试。'
          : '本地组件无法使用，请重新安装工作站。'
      );
      return;
    }

    setStatus(
      managedBackendStatus.state === 'stopping'
        ? '正在关闭工作站…'
        : '本地功能已停止，请重启工作站后重试。'
    );
  }, [managedBackendStatus]);

  useEffect(() => window.workstation.onClassTaskSnapshotChanged((snapshot) => {
    applyClassTaskSnapshot(snapshot);
  }), []);

  useEffect(() => {
    const handleQuickFileSearchShortcut = (event: KeyboardEvent): void => {
      if (
        !event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'n'
      ) {
        return;
      }
      // 原生设置对话框打开时保持模态边界，不在其上方叠加第二个窗口。
      if (document.querySelector('dialog[open]')) {
        return;
      }
      event.preventDefault();
      void openQuickFileSearch();
    };

    window.addEventListener('keydown', handleQuickFileSearchShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleQuickFileSearchShortcut, true);
    };
  }, [workspaceRoot]);

  useEffect(() => {
    setQuickFileSearchSelectedIndex(0);
  }, [quickFileSearchFiles, quickFileSearchQuery]);


  useEffect(() => {
    if (activityView !== 'search') {
      return;
    }

    if (!workspaceSearchQuery.trim()) {
      workspaceSearchRequestRef.current += 1;
      setWorkspaceSearchError('');
      setWorkspaceSearchResults([]);
      setIsSearchingWorkspace(false);
      return;
    }

    const timer = window.setTimeout(() => {
      void searchWorkspace();
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activityView,
    workspaceRoot,
    workspaceSearchCaseSensitive,
    workspaceSearchQuery,
    workspaceSearchRegex,
    workspaceSearchWholeWord
  ]);

  useEffect(() => {
    if (!tabContextMenu) {
      return;
    }

    const closeMenu = (): void => setTabContextMenu(null);
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('blur', closeMenu);

    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('blur', closeMenu);
    };
  }, [tabContextMenu]);


  useEffect(() => {
    setLanguageMenuOpen(false);
  }, [selectedFile?.path]);

  useEffect(() => {
    if (activityView !== 'explorer' || !treeFileRevealRequest) {
      return;
    }

    let cancelled = false;
    let highlightTimer: number | undefined;
    const request = treeFileRevealRequest;

    scheduleAfterFirstPaint(() => {
      if (cancelled) {
        return;
      }

      const target = Array.from(
        document.querySelectorAll<HTMLElement>('[data-workspace-file-path]')
      ).find((element) => element.dataset.workspaceFilePath === request.path);

      if (!target) {
        const fileName = request.path.split(/[\\/]/).pop() ?? request.path;
        setStatus(`文件已打开，但无法在资源管理器中定位：${fileName}`);
        setTreeFileRevealRequest((current) =>
          current?.sequence === request.sequence ? null : current
        );
        return;
      }

      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      highlightTimer = window.setTimeout(() => {
        setTreeFileRevealRequest((current) =>
          current?.sequence === request.sequence ? null : current
        );
      }, 1400);
    });

    return () => {
      cancelled = true;
      if (highlightTimer !== undefined) {
        window.clearTimeout(highlightTimer);
      }
    };
  }, [activityView, treeFileRevealRequest]);

  useEffect(() => {
    const reveal = pendingEditorRevealRef.current;
    const editor = editorRef.current;

    if (!reveal || !editor || selectedFile?.path !== reveal.path) {
      return;
    }

    scheduleAfterFirstPaint(() => {
      const pendingReveal = pendingEditorRevealRef.current;
      const currentEditor = editorRef.current;
      const presentationMonaco = presentationMonacoRef.current;
      if (!pendingReveal || pendingReveal.path !== reveal.path || !currentEditor || !presentationMonaco) {
        return;
      }

      const pendingUri = presentationMonaco.Uri.file(pendingReveal.path).toString();
      const canonicalKey = editorSession.getCanonicalKeyForDocumentUri(pendingUri);
      const currentModel = canonicalKey ? editorSession.getModelByCanonicalKey(canonicalKey) : null;
      if (!currentModel || currentModel !== currentEditor.getModel()) {
        return;
      }

      currentEditor.setPosition({ lineNumber: pendingReveal.line, column: pendingReveal.column });
      currentEditor.revealLineInCenter(pendingReveal.line);
      currentEditor.focus();
      pendingEditorRevealRef.current = null;
    });
  }, [editorSession, selectedFile?.path]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();

    if (!editor || !monaco || !model || model.isDisposed()) {
      return;
    }

    const canonicalKey = editorSession.getCanonicalKeyForDocumentUri(model.uri.toString());
    if (!canonicalKey) {
      return;
    }

    const previousIds = decorationStoreRef.current.replace(canonicalKey, []);
    const nextIds = selectedFile && editorLanguage === 'java'
      ? runMonacoStage('local-decoration', () =>
          applyJavaLocalSemanticDecorations(model, monaco, selectedFile.content, previousIds)
        )
      : model.deltaDecorations(previousIds, []);
    decorationStoreRef.current.replace(canonicalKey, nextIds);
  }, [editorLanguage, editorSession, selectedFile?.content, selectedFile?.path]);


  useEffect(() => {
    if (!workspaceRoot || isRestoringViewStateRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      workspaceViewStateSaveTimerRef.current = null;
      window.workstation
        .saveWorkspaceViewState({
          workspaceRoot,
          expandedPaths: [...expandedPaths],
          openFilePaths: openFiles.map((file) => file.path),
          activeFilePath: activeFilePath ?? undefined,
          activityView,
          workbenchTabs: workbenchTabs.items.filter(tab => tab.kind !== 'rag_method').map((tab): WorkspaceWorkbenchTabState => (
            tab.kind === 'source'
              ? { kind: 'source', filePath: tab.filePath }
              : {
                  kind: 'method_configuration',
                  taskId: tab.taskId,
                  sourceFilePath: tab.sourceFilePath,
                  qualifiedClassName: tab.qualifiedClassName,
                  ...(classTaskCatalogs[tab.taskId]
                    ? { catalog: classTaskCatalogs[tab.taskId] }
                    : {})
                }
          )),
          activeWorkbenchTabId: workbenchTabs.activeId ?? undefined
        })
        .catch((error: unknown) => {
          setStatus(`工作区状态保存失败：${toErrorMessage(error)}`);
        });
    }, 250);
    workspaceViewStateSaveTimerRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (workspaceViewStateSaveTimerRef.current === timer) {
        workspaceViewStateSaveTimerRef.current = null;
      }
    };
  }, [
    activeFilePath,
    activityView,
    classTaskCatalogs,
    expandedPaths,
    openFilePathsKey,
    workbenchTabs,
    workspaceRoot
  ]);

  function selectLanguageMode(languageId: string | null): void {
    if (!selectedFile) {
      return;
    }

    setLanguageOverrides((overrides) => {
      const nextOverrides = { ...overrides };

      if (languageId) {
        nextOverrides[selectedFile.path] = languageId;
      } else {
        delete nextOverrides[selectedFile.path];
      }

      return nextOverrides;
    });
    setLanguageMenuOpen(false);
    setStatus(languageId ? `已切换语言模式：${getLanguageLabel(languageId)}` : `已自动检测语言：${getLanguageLabel(getEditorLanguage(selectedFile.path))}`);
  }

  function updateWorkspaceSearchQuery(query: string): void {
    setWorkspaceSearchQuery(query);

    if (!query.trim()) {
      setWorkspaceSearchError('');
      setWorkspaceSearchResults([]);
    }
  }


  async function loadBackendSettings(): Promise<void> {
    try {
      const settings = await window.workstation.getBackendSettings();
      setBackendSettings(settings);
      void refreshBackendHealth();
    } catch (error: unknown) {
      setStatus(`后端设置加载失败：${toErrorMessage(error)}`);
    }
  }

  async function saveBackendSettings(settings: BackendSettings): Promise<void> {
    try {
      const savedSettings = await window.workstation.saveBackendSettings(settings);
      setBackendSettings(savedSettings);
      void refreshBackendHealth();
    } catch (error: unknown) {
      setStatus(`后端设置保存失败：${toErrorMessage(error)}`);
    }
  }

  function loadWorkstationBuildSettings(): void {
    window.workstation.getWorkstationBuildSettings()
      .then((settings) => {
        setWorkspaceBuildSettings(settings);
        setBuildSettingsValidation(settings?.validation ?? null);
      })
      .catch((error: unknown) => {
        setStatus(`工作站构建环境加载失败：${toErrorMessage(error)}`);
      });
  }

  async function selectBuildSettingsPath(kind: BuildSettingsPathKind): Promise<string | null> {
    try {
      return await window.workstation.selectWorkstationBuildSettingsPath(kind);
    } catch (error: unknown) {
      setStatus(`路径选择失败：${toErrorMessage(error)}`);
      return null;
    }
  }

  async function resolveMavenHomeDefaults(mavenHome: string): Promise<MavenHomeDefaults | null> {
    try {
      return await window.workstation.resolveWorkstationMavenHomeDefaults(mavenHome);
    } catch (error: unknown) {
      setStatus(`解析 Maven 默认配置失败：${toErrorMessage(error)}`);
      return null;
    }
  }

  async function validateWorkspaceBuildSettings(
    settings: WorkstationBuildSettings
  ): Promise<BuildSettingsValidationResult> {
    const request = buildWorkstationBuildSettingsRequest(settings);
    setIsBuildSettingsBusy(true);
    try {
      const validation = await window.workstation.validateWorkstationBuildSettings(request);
      setBuildSettingsValidation(validation);
      setStatus(validation.valid ? '构建环境校验通过' : `构建环境校验失败：${validation.error ?? '未知错误'}`);
      return validation;
    } catch (error: unknown) {
      const validation: BuildSettingsValidationResult = {
        valid: false,
        command: '',
        checkedAt: new Date().toISOString(),
        error: toErrorMessage(error)
      };
      setBuildSettingsValidation(validation);
      setStatus(`构建环境校验失败：${validation.error}`);
      return validation;
    } finally {
      setIsBuildSettingsBusy(false);
    }
  }

  async function saveWorkspaceBuildSettings(settings: WorkstationBuildSettings): Promise<void> {
    setIsBuildSettingsBusy(true);
    try {
      const saved = await window.workstation.saveWorkstationBuildSettings(buildWorkstationBuildSettingsRequest(settings));
      setWorkspaceBuildSettings(saved);
      setBuildSettingsValidation(saved.validation ?? null);
      setStatus('工作站全局构建环境已保存');
    } catch (error: unknown) {
      setStatus(`构建环境保存失败：${toErrorMessage(error)}`);
    } finally {
      setIsBuildSettingsBusy(false);
    }
  }

  function buildWorkstationBuildSettingsRequest(settings: WorkstationBuildSettings) {
    return {
      mavenHome: settings.mavenHome.trim(),
      javaHome: settings.javaHome.trim(),
      ...(settings.settingsPath?.trim() ? { settingsPath: settings.settingsPath.trim() } : {}),
      ...(settings.localRepository?.trim() ? { localRepository: settings.localRepository.trim() } : {})
    };
  }

  async function refreshBackendHealth(): Promise<void> {
    try {
      setBackendHealth(await window.workstation.checkBackendHealth());
    } catch (error: unknown) {
      setStatus(`后端健康检查失败：${toErrorMessage(error)}`);
    }
  }

  function startResize(panel: 'left' | 'right', event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startLeftWidth = leftPanelWidth;
    const startRightWidth = rightPanelWidth;

    function handleMouseMove(moveEvent: globalThis.MouseEvent): void {
      if (panel === 'left') {
        setLeftPanelWidth(clampPanelWidthForViewport(
          'left',
          startLeftWidth + moveEvent.clientX - startX,
          window.innerWidth,
          startRightWidth
        ));
        return;
      }

      setRightPanelWidth(clampPanelWidthForViewport(
        'right',
        startRightWidth - moveEvent.clientX + startX,
        window.innerWidth,
        startLeftWidth
      ));
    }

    function handleMouseUp(): void {
      document.body.classList.remove('is-resizing');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }

    document.body.classList.add('is-resizing');
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }

  function applyClassTaskSnapshot(snapshot: ClassTaskSnapshot): void {
    const activeRoot = activeWorkspaceRootRef.current;
    if (!activeRoot || !isSameWorkspaceRoot(snapshot.workspaceRoot, activeRoot)) {
      return;
    }
    if (deletedClassTaskIdsRef.current.has(snapshot.id)) return;

    const totalPendingTaskIds = new Set(classTaskTotalPendingTaskIdsRef.current);
    const releasedTotalDispatch = totalPendingTaskIds.delete(snapshot.id);
    if (releasedTotalDispatch) {
      classTaskTotalPendingTaskIdsRef.current = totalPendingTaskIds;
      if (totalPendingTaskIds.size === 0) {
        setIsClassTaskTotalCommandBusy(false);
      }
    }
    setBusyClassTaskIds((busyTaskIds) => {
      if (!busyTaskIds.has(snapshot.id)) {
        return busyTaskIds;
      }
      const released = releaseClassTaskCommandDispatch({
        busyTaskIds,
        totalPendingTaskIds
      }, snapshot.id);
      return new Set(released.busyTaskIds);
    });
    setClassTaskSnapshots((snapshots) => ({ ...snapshots, [snapshot.id]: snapshot }));
    setClassTaskOrder((taskIds) => taskIds.includes(snapshot.id)
      ? taskIds
      : [...taskIds, snapshot.id]
    );
  }

  function applyClassTaskSnapshots(snapshots: readonly ClassTaskSnapshot[]): void {
    snapshots.forEach(applyClassTaskSnapshot);
  }

  async function restoreClassTasks(selectedRoot: string, loadRequestId: number): Promise<void> {
    const snapshots = await window.workstation.listClassTasks({ workspaceRoot: selectedRoot });
    if (
      loadRequestId !== workspaceLoadRequestRef.current ||
      !isSameWorkspaceRoot(selectedRoot, activeWorkspaceRootRef.current)
    ) {
      return;
    }

    setClassTaskSnapshots(Object.fromEntries(snapshots.map((snapshot) => [snapshot.id, snapshot])));
    setClassTaskOrder(snapshots.map((snapshot) => snapshot.id));
  }

  async function restoreLastWorkspace(requestId: number): Promise<void> {
    try {
      const candidate = await window.workstation.getLastWorkspace();
      if (requestId !== startupRestoreRequestRef.current || manualWorkspaceImportStartedRef.current) return;

      if (candidate.state === 'missing') {
        setStatus('上次工作区已不存在，请重新选择。');
        return;
      }

      if (candidate.state === 'ready') {
        await loadWorkspaceRoot(candidate.workspaceRoot, '正在恢复上次工作区...', true);
      }
    } catch (error: unknown) {
      if (requestId === startupRestoreRequestRef.current && !manualWorkspaceImportStartedRef.current) {
        setStatus(`上次工作区恢复失败：${toErrorMessage(error)}`);
      }
    }
  }

  async function loadWorkspaceRoot(selectedRoot: string, loadingMessage = '正在加载资源管理器...', restoreViewState = false): Promise<void> {
    const loadRequestId = workspaceLoadRequestRef.current + 1;
    workspaceLoadRequestRef.current = loadRequestId;
    quickFileSearchRequestRef.current += 1;
    quickFileSearchCacheRef.current = null;
    setIsQuickFileSearchOpen(false);
    setQuickFileSearchFiles([]);
    setQuickFileSearchQuery('');
    cancelPendingWorkspaceViewStateSave();
    setStatus(loadingMessage);
    isRestoringViewStateRef.current = restoreViewState;
    if (activeWorkspaceRootRef.current !== selectedRoot) {
      clearWorkspacePresentationState();
    }
    activeWorkspaceRootRef.current = selectedRoot;
    setWorkspaceRoot(selectedRoot);
    setFiles([]);
    setExpandedPaths(new Set());
    setLoadingPaths(new Set());
    setJavaProject(null);
    setOpenFiles([]);
    setActiveFilePath(null);
    setWorkbenchTabs(createEmptyWorkbenchTabs());
    setClassTaskCatalogs({});
    setClassTaskMethodCatalogLoadStates({});
    classTaskMethodCatalogRequestIdsRef.current.clear();
    setClassTaskSnapshots({});
    setClassTaskOrder([]);
    setBusyClassTaskIds(new Set());
    setClassTaskFocusRequest(null);
    setIsClassTaskTotalCommandBusy(false);
    classTaskTotalCommandSequenceRef.current += 1;
    classTaskTotalPendingTaskIdsRef.current = new Set();
    setSavingMethodSelectionTaskId(null);
    clearAllMethodSelectionSaveErrors();
    void restoreClassTasks(selectedRoot, loadRequestId).catch((error: unknown) => {
      if (loadRequestId === workspaceLoadRequestRef.current) {
        setStatus(`类任务恢复失败：${toErrorMessage(error)}`);
      }
    });
    const rootChildren = await window.workstation.listChildren(selectedRoot);
    if (loadRequestId !== workspaceLoadRequestRef.current) {
      return;
    }
    setFiles(rootChildren);
    setStatus('资源管理器已就绪，正在索引 Java 类...');

    if (restoreViewState) {
      void restoreWorkspaceViewState(
        selectedRoot,
        rootChildren,
        loadRequestId
      )
        .catch((error: unknown) => {
          if (loadRequestId === workspaceLoadRequestRef.current) {
            setStatus(`工作区视图恢复失败：${toErrorMessage(error)}`);
          }
        })
        .finally(() => {
          if (loadRequestId === workspaceLoadRequestRef.current) {
            isRestoringViewStateRef.current = false;
          }
        });
    }

    window.workstation
      .scanJavaProject(selectedRoot)
      .then((scanResult) => {
        if (loadRequestId !== workspaceLoadRequestRef.current) {
          return;
        }
        setJavaProject(scanResult);
        setStatus(`已索引 ${scanResult.files.length} 个 Java 文件`);
      })
      .catch((error: unknown) => {
        if (loadRequestId === workspaceLoadRequestRef.current) {
          setStatus(`资源管理器已就绪，Java 索引失败：${toErrorMessage(error)}`);
        }
      });

    if (!restoreViewState) {
      isRestoringViewStateRef.current = false;
    }
  }

  async function restoreWorkspaceViewState(
    selectedRoot: string,
    rootChildren: WorkspaceFile[],
    loadRequestId: number
  ): Promise<void> {
    const viewState = await window.workstation.getWorkspaceViewState(selectedRoot);
    if (loadRequestId !== workspaceLoadRequestRef.current) {
      return;
    }
    if (!viewState) {
      return;
    }

    if (viewState.activityView) {
      setActivityView(viewState.activityView);
    }

    const restoredExpandedPaths = viewState.expandedPaths.slice(0, MAX_RESTORED_EXPANDED_PATHS);
    const restoredOpenFilePaths = viewState.openFilePaths.slice(0, MAX_RESTORED_OPEN_FILES);
    const expandedPathSet = new Set(restoredExpandedPaths);
    setExpandedPaths(expandedPathSet);

    if (restoredExpandedPaths.length > 0) {
      const restoredFiles = await loadExpandedDirectoryChildren(selectedRoot, rootChildren, restoredExpandedPaths);
      if (loadRequestId !== workspaceLoadRequestRef.current) {
        return;
      }
      setFiles(restoredFiles);
    }

    const restoredOpenFiles = await Promise.all(
      restoredOpenFilePaths.map(async (filePath) => {
        try {
          const content = await window.workstation.readFile(selectedRoot, filePath);
          return {
            path: filePath,
            relativePath: getRelativePath(selectedRoot, filePath),
            content,
            savedContent: content
          };
        } catch {
          return null;
        }
      })
    );
    const nextOpenFiles = restoredOpenFiles.filter((file): file is SelectedFile => Boolean(file));
    if (loadRequestId !== workspaceLoadRequestRef.current) {
      return;
    }

    const restoredActiveFilePath = nextOpenFiles.some((file) => file.path === viewState.activeFilePath)
      ? viewState.activeFilePath ?? null
      : nextOpenFiles[0]?.path ?? null;
    const restoredTabs = restorePersistedWorkbenchTabs({
      persistedTabs: viewState.workbenchTabs,
      availableSourceFilePaths: nextOpenFiles.map((file) => file.path),
      activeId: viewState.activeWorkbenchTabId
        ?? (restoredActiveFilePath ? `source:${restoredActiveFilePath}` : undefined)
    });
    const restoredMethodTabs = (viewState.workbenchTabs ?? [])
      .filter((tab): tab is Extract<WorkspaceWorkbenchTabState, { kind: 'method_configuration' }> => (
        tab.kind === 'method_configuration'
      ));
    const restoredCatalogs = Object.fromEntries(
      restoredMethodTabs.flatMap((tab) => tab.catalog ? [[tab.taskId, tab.catalog]] : [])
    );

    setOpenFiles(nextOpenFiles);
    setActiveFilePath(restoredActiveFilePath);
    setClassTaskCatalogs(restoredCatalogs);
    setWorkbenchTabs(restoredTabs);
    setStatus(nextOpenFiles.length > 0 ? '工作区已恢复' : '资源管理器已恢复');
    for (const tab of restoredMethodTabs) {
      void refreshClassTaskCatalogIfNeeded({
        workspaceRoot: selectedRoot,
        taskId: tab.taskId,
        qualifiedClassName: tab.qualifiedClassName,
        cachedCatalog: tab.catalog,
        workspaceLoadRequestId: loadRequestId
      });
    }
  }

  async function openWorkspace(): Promise<void> {
    if (workspaceSelectionPendingRef.current) {
      setStatus('正在选择工作区，请先完成或取消。');
      return;
    }

    // 用户已主动选择其他工作区时，不能再让迟到的启动恢复覆盖当前操作。
    manualWorkspaceImportStartedRef.current = true;
    startupRestoreRequestRef.current += 1;
    // 目录选择框显示期间也要废止已开始的恢复读取；否则用户取消选择后，
    // 迟到的目录、标签和展开状态仍会写回界面。
    workspaceLoadRequestRef.current += 1;
    isRestoringViewStateRef.current = false;
    cancelPendingWorkspaceViewStateSave();
    const selectionRequestId = workspaceSelectionRequestRef.current + 1;
    workspaceSelectionRequestRef.current = selectionRequestId;
    let selectedRoot: string | null = null;
    workspaceSelectionPendingRef.current = true;
    setIsWorkspaceSelectionPending(true);
    try {
      selectedRoot = await window.workstation.selectWorkspace();
    } catch (error: unknown) {
      setStatus(`工作区选择失败：${toErrorMessage(error)}`);
      return;
    } finally {
      if (selectionRequestId === workspaceSelectionRequestRef.current) {
        workspaceSelectionPendingRef.current = false;
        setIsWorkspaceSelectionPending(false);
      }
    }
    if (
      !selectedRoot ||
      selectionRequestId !== workspaceSelectionRequestRef.current
    ) {
      return;
    }

    // 用户每次显式导入项目都从折叠目录和空编辑器开始，不恢复旧标签或代码位置。
    await loadWorkspaceRoot(selectedRoot);
  }

  async function refreshWorkspace(): Promise<void> {
    if (!workspaceRoot) {
      return;
    }

    quickFileSearchCacheRef.current = null;
    quickFileSearchRequestRef.current += 1;
    const loadRequestId = workspaceLoadRequestRef.current;
    const refreshWorkspaceRoot = workspaceRoot;
    setStatus('正在刷新资源管理器...');
    const rootChildren = await window.workstation.listChildren(refreshWorkspaceRoot);
    if (loadRequestId !== workspaceLoadRequestRef.current) {
      return;
    }
    setFiles(rootChildren);
    setExpandedPaths(new Set());
    setLoadingPaths(new Set());
    setStatus('资源管理器已刷新，正在索引 Java 类...');

    try {
      const scanResult = await window.workstation.scanJavaProject(refreshWorkspaceRoot);
      if (loadRequestId !== workspaceLoadRequestRef.current) {
        return;
      }
      setJavaProject(scanResult);
      setStatus('工作区已刷新');
    } catch (error: unknown) {
      if (loadRequestId === workspaceLoadRequestRef.current) {
        setStatus(`资源管理器已刷新，Java 索引失败：${toErrorMessage(error)}`);
      }
    }
  }

  async function openQuickFileSearch(): Promise<void> {
    const activeRoot = workspaceRoot;
    if (!activeRoot) {
      setStatus('请先打开一个工作区。');
      return;
    }

    setIsQuickFileSearchOpen(true);
    setQuickFileSearchQuery('');
    setQuickFileSearchSelectedIndex(0);
    setQuickFileSearchError('');

    const cached = quickFileSearchCacheRef.current;
    if (cached && isSameWorkspaceRoot(cached.workspaceRoot, activeRoot)) {
      setQuickFileSearchFiles(cached.files);
      setIsQuickFileSearchLoading(false);
    } else {
      setQuickFileSearchFiles([]);
      setIsQuickFileSearchLoading(true);
    }

    const requestId = quickFileSearchRequestRef.current + 1;
    quickFileSearchRequestRef.current = requestId;
    try {
      const candidates = await collectWorkspaceSearchFiles(activeRoot);
      if (
        requestId !== quickFileSearchRequestRef.current ||
        !isSameWorkspaceRoot(activeRoot, activeWorkspaceRootRef.current)
      ) {
        return;
      }
      quickFileSearchCacheRef.current = {
        workspaceRoot: activeRoot,
        files: candidates
      };
      setQuickFileSearchFiles(candidates);
    } catch (error: unknown) {
      if (requestId === quickFileSearchRequestRef.current) {
        setQuickFileSearchError(`文件列表读取失败：${toErrorMessage(error)}`);
      }
    } finally {
      if (requestId === quickFileSearchRequestRef.current) {
        setIsQuickFileSearchLoading(false);
      }
    }
  }

  function closeQuickFileSearch(): void {
    setIsQuickFileSearchOpen(false);
    setQuickFileSearchError('');
  }

  async function openQuickFileSearchResult(file: WorkspaceFile): Promise<void> {
    try {
      await selectFile(file);
      closeQuickFileSearch();
      await revealFileInExplorer(file.path);
    } catch (error: unknown) {
      setQuickFileSearchError(`文件打开失败：${toErrorMessage(error)}`);
    }
  }

  async function revealCurrentFileInExplorer(): Promise<void> {
    if (!selectedFile) {
      setStatus('请先打开需要定位的文件');
      return;
    }

    await revealFileInExplorer(selectedFile.path);
  }

  async function revealFileInExplorer(filePath: string): Promise<void> {
    const activeRoot = workspaceRoot;
    if (!activeRoot) {
      setStatus('请先打开工作区');
      return;
    }

    treeFileRevealSequenceRef.current += 1;
    const revealSequence = treeFileRevealSequenceRef.current;
    setActivityView('explorer');
    const parentPaths = getWorkspaceParentDirectoryPaths(activeRoot, filePath);
    const loadedDirectories: Array<{ path: string; children: WorkspaceFile[] }> = [];
    const failedDirectories: string[] = [];

    setLoadingPaths((paths) => {
      const next = new Set(paths);
      parentPaths.forEach((path) => next.add(path));
      return next;
    });

    // 目录树采用懒加载；定位时只读取当前文件所在链路，不扫描或展开无关目录。
    for (const parentPath of parentPaths) {
      try {
        const children = await window.workstation.listChildren(activeRoot, parentPath);
        loadedDirectories.push({ path: parentPath, children });
      } catch {
        failedDirectories.push(parentPath);
      }
    }

    setLoadingPaths((paths) => {
      const next = new Set(paths);
      parentPaths.forEach((path) => next.delete(path));
      return next;
    });

    if (
      revealSequence !== treeFileRevealSequenceRef.current ||
      !isSameWorkspaceRoot(activeRoot, activeWorkspaceRootRef.current)
    ) {
      return;
    }

    setFiles((currentFiles) =>
      loadedDirectories.reduce(
        (nextFiles, directory) => mergeTreeChildren(nextFiles, directory.path, directory.children),
        currentFiles
      )
    );
    setExpandedPaths((paths) => {
      const next = new Set(paths);
      loadedDirectories.forEach((directory) => next.add(directory.path));
      return next;
    });
    setTreeFileRevealRequest({
      path: filePath,
      sequence: revealSequence
    });

    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    setStatus(
      failedDirectories.length === 0
        ? `已在资源管理器中定位：${fileName}`
        : `文件已打开，但部分父目录无法读取：${fileName}`
    );
  }

  async function toggleDirectory(directory: WorkspaceFile): Promise<void> {
    if (!workspaceRoot || directory.type !== 'directory') {
      return;
    }

    if (expandedPaths.has(directory.path)) {
      setExpandedPaths((paths) => {
        const next = new Set(paths);
        next.delete(directory.path);
        return next;
      });
      return;
    }

    setExpandedPaths((paths) => new Set(paths).add(directory.path));

    if (directory.children) {
      return;
    }

    setLoadingPaths((paths) => new Set(paths).add(directory.path));
    try {
      const children = await window.workstation.listChildren(workspaceRoot, directory.path);
      setFiles((currentFiles) => updateTreeChildren(currentFiles, directory.path, children));
    } finally {
      setLoadingPaths((paths) => {
        const next = new Set(paths);
        next.delete(directory.path);
        return next;
      });
    }
  }

  function activateSourceFileTab(filePath: string): void {
    setActiveFilePath(filePath);
    setWorkbenchTabs((tabs) => openSourceTab(tabs, { sourceFilePath: filePath }));
  }

  function focusClassTask(taskId: string): void {
    classTaskFocusSequenceRef.current += 1;
    setClassTaskFocusRequest({
      taskId,
      sequence: classTaskFocusSequenceRef.current
    });
  }

  function setClassTaskCommandBusy(taskIds: readonly string[], busy: boolean): void {
    setBusyClassTaskIds((current) => {
      const next = new Set(current);
      taskIds.forEach((taskId) => busy ? next.add(taskId) : next.delete(taskId));
      return next;
    });
  }

  async function addClassTaskPaths(classFilePaths: string[]): Promise<void> {
    const activeRoot = workspaceRoot;
    if (!activeRoot || classFilePaths.length === 0) {
      return;
    }

    try {
      const snapshots = await window.workstation.addClassTasks({
        workspaceRoot: activeRoot,
        classFilePaths
      });
      if (!isSameWorkspaceRoot(activeRoot, activeWorkspaceRootRef.current)) {
        return;
      }
      applyClassTaskSnapshots(snapshots);
      if (snapshots[0]) {
        focusClassTask(snapshots[0].id);
      }
      setStatus(snapshots.length > 0
        ? `已添加或定位 ${snapshots.length} 个类任务`
        : '没有可添加的生产源码类'
      );
    } catch (error: unknown) {
      setStatus(`类任务添加失败：${toErrorMessage(error)}`);
    }
  }

  async function reorderClassTasks(taskIds: string[]): Promise<void> {
    const activeRoot = workspaceRoot;
    if (!activeRoot || taskIds.length !== classTaskOrder.length) return;
    const previousOrder = [...classTaskOrder];
    setClassTaskOrder([...taskIds]);
    try {
      const snapshots = await window.workstation.reorderClassTasks({
        workspaceRoot: activeRoot,
        taskIds
      });
      if (!isSameWorkspaceRoot(activeRoot, activeWorkspaceRootRef.current)) return;
      setClassTaskSnapshots((current) => ({
        ...current,
        ...Object.fromEntries(snapshots.map((snapshot) => [snapshot.id, snapshot]))
      }));
      setClassTaskOrder(snapshots.map((snapshot) => snapshot.id));
    } catch (error: unknown) {
      if (isSameWorkspaceRoot(activeRoot, activeWorkspaceRootRef.current)) {
        setClassTaskOrder(previousOrder);
        setStatus(`类任务排序保存失败：${toErrorMessage(error)}`);
      }
    }
  }

  async function locateClassTaskSource(task: ClassTaskSnapshot): Promise<void> {
    const fileName = task.sourceFilePath.split(/[\\/]/).pop() ?? task.sourceFilePath;
    try {
      await selectFile({
        name: fileName,
        path: task.sourceFilePath,
        relativePath: getRelativePath(workspaceRoot, task.sourceFilePath),
        type: 'file'
      });
      await revealFileInExplorer(task.sourceFilePath);
    } catch (error: unknown) {
      setStatus(`源码定位失败：${toErrorMessage(error)}`);
    }
  }

  async function runSingleClassTask(task: ClassTaskSnapshot): Promise<void> {
    const reconciliationController = new AbortController();
    setClassTaskCommandBusy([task.id], true);
    setStatus(`正在执行 ${task.qualifiedClassName}...`);
    try {
      const command = window.workstation.runClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      void reconcileClassTaskCommandStart({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id,
        initialSnapshot: task,
        signal: reconciliationController.signal,
        listClassTasks: () => window.workstation.listClassTasks({
          workspaceRoot: task.workspaceRoot
        }),
        onSnapshot: applyClassTaskSnapshot
      });
      applyClassTaskSnapshot(await command);
    } catch (error: unknown) {
      setStatus(`类任务执行失败：${toErrorMessage(error)}`);
    } finally {
      reconciliationController.abort();
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function pauseSingleClassTask(task: ClassTaskSnapshot): Promise<void> {
    setClassTaskCommandBusy([task.id], true);
    try {
      applyClassTaskSnapshot(await window.workstation.pauseClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      }));
      setStatus(`正在暂停 ${task.qualifiedClassName}`);
    } catch (error: unknown) {
      setStatus(`任务暂停失败：${toErrorMessage(error)}`);
    } finally {
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function resumeSingleClassTask(task: ClassTaskSnapshot): Promise<void> {
    setClassTaskCommandBusy([task.id], true);
    try {
      applyClassTaskSnapshot(await window.workstation.resumeClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      }));
      setStatus(`已继续 ${task.qualifiedClassName}`);
    } catch (error: unknown) {
      setStatus(`任务继续失败：${toErrorMessage(error)}`);
    } finally {
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function terminateSingleClassTask(task: ClassTaskSnapshot): Promise<void> {
    setClassTaskCommandBusy([task.id], true);
    try {
      applyClassTaskSnapshot(await window.workstation.terminateClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      }));
      setStatus(`已终止 ${task.qualifiedClassName}`);
    } catch (error: unknown) {
      setStatus(`任务终止失败：${toErrorMessage(error)}`);
    } finally {
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function runAllPendingClassTasks(): Promise<void> {
    if (!workspaceRoot || isClassTaskTotalCommandBusy) {
      return;
    }
    const eligibleTaskIds = classTaskTotalRunEligibleIds(classTasks, busyClassTaskIds);
    if (eligibleTaskIds.length === 0) {
      return;
    }

    const commandSequence = classTaskTotalCommandSequenceRef.current + 1;
    classTaskTotalCommandSequenceRef.current = commandSequence;
    classTaskTotalPendingTaskIdsRef.current = new Set(eligibleTaskIds);
    setIsClassTaskTotalCommandBusy(true);
    setClassTaskCommandBusy(eligibleTaskIds, true);
    setStatus(`正在执行 ${eligibleTaskIds.length} 个类任务...`);
    try {
      const snapshots = await window.workstation.runAllClassTasks({ workspaceRoot });
      applyClassTaskSnapshots(snapshots);
      setStatus(describeClassTaskRunAllOutcome(eligibleTaskIds.length, snapshots));
    } catch (error: unknown) {
      setStatus(`批量执行失败：${toErrorMessage(error)}`);
    } finally {
      if (commandSequence === classTaskTotalCommandSequenceRef.current) {
        classTaskTotalPendingTaskIdsRef.current = new Set();
        setClassTaskCommandBusy(eligibleTaskIds, false);
        setIsClassTaskTotalCommandBusy(false);
      }
    }
  }

  async function terminateAllActiveClassTasks(): Promise<void> {
    if (!workspaceRoot || isClassTaskTotalCommandBusy) {
      return;
    }
    const activeTaskIds = classTasks
      .filter((task) => ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'].includes(task.state))
      .map((task) => task.id);
    if (activeTaskIds.length === 0) {
      return;
    }

    const commandSequence = classTaskTotalCommandSequenceRef.current + 1;
    classTaskTotalCommandSequenceRef.current = commandSequence;
    classTaskTotalPendingTaskIdsRef.current = new Set(activeTaskIds);
    setIsClassTaskTotalCommandBusy(true);
    setClassTaskCommandBusy(activeTaskIds, true);
    try {
      applyClassTaskSnapshots(await window.workstation.terminateAllClassTasks({ workspaceRoot }));
      setStatus(`已终止 ${activeTaskIds.length} 个类任务`);
    } catch (error: unknown) {
      setStatus(`批量终止失败：${toErrorMessage(error)}`);
    } finally {
      if (commandSequence === classTaskTotalCommandSequenceRef.current) {
        classTaskTotalPendingTaskIdsRef.current = new Set();
        setClassTaskCommandBusy(activeTaskIds, false);
        setIsClassTaskTotalCommandBusy(false);
      }
    }
  }

  async function removeSingleClassTask(task: ClassTaskSnapshot): Promise<void> {
    setClassTaskCommandBusy([task.id], true);
    try {
      await window.workstation.removeClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      deletedClassTaskIdsRef.current.add(task.id);
      setClassTaskSnapshots((snapshots) => omitRecordKey(snapshots, task.id));
      setClassTaskOrder((taskIds) => taskIds.filter((taskId) => taskId !== task.id));
      setClassTaskCatalogs((catalogs) => omitRecordKey(catalogs, task.id));
      classTaskMethodCatalogRequestIdsRef.current.delete(task.id);
      setClassTaskMethodCatalogLoadStates((states) => omitRecordKey(states, task.id));
      clearMethodSelectionSaveError(task.id);
      setWorkbenchTabs((tabs) => closeWorkbenchTab(tabs, `methods:${task.id}`));
      setClassTaskFocusRequest((request) => request?.taskId === task.id ? null : request);
      setStatus(`已删除 ${task.qualifiedClassName}`);
    } catch (error: unknown) {
      setStatus(`任务删除失败：${toErrorMessage(error)}`);
    } finally {
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function retryClassTaskPreload(task: ClassTaskSnapshot): Promise<void> {
    setClassTaskCommandBusy([task.id], true);
    try {
      await window.workstation.retryModulePreload({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      setStatus(`正在重新检测：${task.qualifiedClassName}`);
    } catch (error: unknown) {
      setStatus(`当前类重新检测失败：${toErrorMessage(error)}`);
    } finally {
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function stopClassTaskPreload(task: ClassTaskSnapshot): Promise<void> {
    setClassTaskCommandBusy([task.id], true);
    try {
      await window.workstation.stopModulePreload({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      setStatus(`已停止检测：${task.qualifiedClassName}`);
    } catch (error: unknown) {
      setStatus(`停止预加载失败：${toErrorMessage(error)}`);
    } finally {
      setClassTaskCommandBusy([task.id], false);
    }
  }

  async function loadClassTaskResult(taskId: string): Promise<ClassTaskResultSnapshot | null> {
    const task = classTaskSnapshots[taskId];
    if (!task) throw new Error('当前类任务不存在或已删除');
    try {
      const result = await window.workstation.getClassTaskResult({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      setStatus(result
        ? `已读取 ${task.qualifiedClassName} 的 ${result.artifacts.length} 个测试文件`
        : '当前任务没有运行结果'
      );
      return result;
    } catch (error: unknown) {
      setStatus(`运行结果读取失败：${toErrorMessage(error)}`);
      throw error;
    }
  }

  async function acceptClassTaskResult(taskId: string): Promise<ClassTaskResultSnapshot> {
    const task = classTaskSnapshots[taskId];
    if (!task) throw new Error('当前类任务不存在或已删除');
    try {
      const result = await window.workstation.acceptClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      setStatus(`已接受 ${task.qualifiedClassName} 的测试文件`);
      return result;
    } catch (error: unknown) {
      setStatus(`接受测试文件失败：${toErrorMessage(error)}`);
      throw error;
    }
  }

  async function revokeClassTaskResult(taskId: string): Promise<ClassTaskResultSnapshot> {
    const task = classTaskSnapshots[taskId];
    if (!task) throw new Error('当前类任务不存在或已删除');
    const requestedWorkspaceLoadRequestId = workspaceLoadRequestRef.current;
    try {
      const result = await window.workstation.revokeClassTask({
        workspaceRoot: task.workspaceRoot,
        taskId: task.id
      });
      setClassTaskCatalogs((catalogs) => omitRecordKey(catalogs, task.id));
      if (isSameWorkspaceRoot(task.workspaceRoot, activeWorkspaceRootRef.current)) {
        setStatus(`已撤回 ${task.qualifiedClassName} 的未接受测试文件，正在后台刷新覆盖率...`);
        void refreshClassTaskCatalogIfNeeded({
          workspaceRoot: task.workspaceRoot,
          taskId: task.id,
          qualifiedClassName: task.qualifiedClassName,
          workspaceLoadRequestId: requestedWorkspaceLoadRequestId,
          forceReload: true,
          requireLiveCatalog: true
        });
      } else {
        setStatus(`已撤回 ${task.qualifiedClassName} 的未接受测试文件`);
      }
      return result;
    } catch (error: unknown) {
      setStatus(`撤回测试文件失败：${toErrorMessage(error)}`);
      throw error;
    }
  }

  function handleClassTaskCardIntent(intent: ClassTaskCardIntent): void {
    const task = classTaskSnapshots[intent.taskId];
    if (!task) {
      return;
    }

    switch (intent.kind) {
      case 'open_result':
        return;
      case 'locate_source':
        void locateClassTaskSource(task);
        return;
      case 'open_configuration':
        void openClassTaskMethodConfiguration(task);
        return;
      case 'run':
        void runSingleClassTask(task);
        return;
      case 'pause':
        void pauseSingleClassTask(task);
        return;
      case 'resume':
        void resumeSingleClassTask(task);
        return;
      case 'terminate':
        void terminateSingleClassTask(task);
        return;
      case 'retry_preload':
        void retryClassTaskPreload(task);
        return;
      case 'stop_preload':
        void stopClassTaskPreload(task);
        return;
      case 'delete':
        void removeSingleClassTask(task);
        return;
      case 'show_empty_result_hint':
      case 'show_method_selection_hint':
      case 'none':
        return;
    }
  }

  async function openClassTaskMethodConfiguration(task: ClassTaskSnapshot): Promise<void> {
    if (!workspaceRoot) {
      setStatus('请先打开工作区');
      return;
    }

    setWorkbenchTabs((tabs) => openMethodConfigurationTab(tabs, task));
    clearMethodSelectionSaveError(task.id);
    await refreshClassTaskCatalogIfNeeded({
      workspaceRoot,
      taskId: task.id,
      qualifiedClassName: task.qualifiedClassName,
      cachedCatalog: classTaskCatalogs[task.id],
      workspaceLoadRequestId: workspaceLoadRequestRef.current
    });
  }

  async function retryClassTaskMethodConfiguration(): Promise<void> {
    if (
      !workspaceRoot ||
      activeWorkbenchTab?.kind !== 'method_configuration' ||
      !activeMethodConfigurationTask
    ) {
      setStatus('方法配置不可用，请从类任务重新打开配置');
      return;
    }

    await refreshClassTaskCatalogIfNeeded({
      workspaceRoot,
      taskId: activeMethodConfigurationTask.id,
      qualifiedClassName: activeMethodConfigurationTask.qualifiedClassName,
      cachedCatalog: classTaskCatalogs[activeMethodConfigurationTask.id],
      workspaceLoadRequestId: workspaceLoadRequestRef.current,
      requireLiveCatalog: true
    });
  }

  async function refreshClassTaskMethodConfiguration(): Promise<void> {
    if (
      !workspaceRoot ||
      activeWorkbenchTab?.kind !== 'method_configuration' ||
      !activeMethodConfigurationTask
    ) {
      setStatus('方法配置不可用，请从类任务重新打开配置');
      return;
    }

    await refreshClassTaskCatalogIfNeeded({
      workspaceRoot,
      taskId: activeMethodConfigurationTask.id,
      qualifiedClassName: activeMethodConfigurationTask.qualifiedClassName,
      cachedCatalog: classTaskCatalogs[activeMethodConfigurationTask.id],
      workspaceLoadRequestId: workspaceLoadRequestRef.current,
      requireLiveCatalog: true
    });
  }

  async function refreshClassTaskCatalogIfNeeded(input: {
    workspaceRoot: string;
    taskId: string;
    qualifiedClassName: string;
    cachedCatalog?: ClassMethodCatalog;
    workspaceLoadRequestId: number;
    forceReload?: boolean;
    requireLiveCatalog?: boolean;
  }): Promise<void> {
    const requestedWorkspaceRoot = input.workspaceRoot;
    const taskId = input.taskId;

    if (classTaskMethodCatalogRequestIdsRef.current.has(taskId) && !input.forceReload) {
      return;
    }

    const requestId = classTaskMethodCatalogRequestSequenceRef.current + 1;
    classTaskMethodCatalogRequestSequenceRef.current = requestId;
    classTaskMethodCatalogRequestIdsRef.current.set(taskId, requestId);

    setStatus(`正在读取 ${input.qualifiedClassName} 的最新方法覆盖情况...`);
    setClassTaskMethodCatalogLoadStates((states) => ({
      ...states,
      [taskId]: { status: 'loading' }
    }));

    try {
      if (!input.forceReload && input.cachedCatalog?.fingerprint) {
        try {
          const freshness = await window.workstation.checkClassTaskMethods({
            workspaceRoot: requestedWorkspaceRoot,
            taskId,
            fingerprint: input.cachedCatalog.fingerprint
          });
          if (
            classTaskMethodCatalogRequestIdsRef.current.get(taskId) !== requestId ||
            input.workspaceLoadRequestId !== workspaceLoadRequestRef.current ||
            !isSameWorkspaceRoot(requestedWorkspaceRoot, activeWorkspaceRootRef.current)
          ) {
            return;
          }
          if (freshness.current) {
            if (freshness.catalog) {
              if (freshness.catalog.taskId !== taskId) {
                throw new Error('方法目录与当前类任务不匹配');
              }
              setClassTaskCatalogs((catalogs) => ({
                ...catalogs,
                [taskId]: freshness.catalog as ClassMethodCatalog
              }));
              setStatus(`已刷新 ${freshness.catalog.methods.length} 个方法`);
              setClassTaskMethodCatalogLoadStates((states) => omitRecordKey(states, taskId));
              return;
            }
            if (!input.requireLiveCatalog) {
              setStatus(`已恢复 ${input.cachedCatalog.methods.length} 个方法，源码未变化`);
              setClassTaskMethodCatalogLoadStates((states) => omitRecordKey(states, taskId));
              return;
            }
          }
        } catch (error: unknown) {
          if (
            classTaskMethodCatalogRequestIdsRef.current.get(taskId) === requestId &&
            input.workspaceLoadRequestId === workspaceLoadRequestRef.current &&
            isSameWorkspaceRoot(requestedWorkspaceRoot, activeWorkspaceRootRef.current)
          ) {
            setClassTaskMethodCatalogLoadStates((states) => omitRecordKey(states, taskId));
            setStatus(`方法指纹检查失败，已保留上次数据：${toErrorMessage(error)}`);
          }
          return;
        }
      }

      const catalog = await window.workstation.getClassTaskMethods({
        workspaceRoot: requestedWorkspaceRoot,
        taskId,
        ...(input.forceReload ? { forceReload: true } : {})
      });
      if (
        classTaskMethodCatalogRequestIdsRef.current.get(taskId) !== requestId ||
        input.workspaceLoadRequestId !== workspaceLoadRequestRef.current ||
        !isSameWorkspaceRoot(requestedWorkspaceRoot, activeWorkspaceRootRef.current)
      ) {
        return;
      }
      if (catalog.taskId !== taskId) {
        throw new Error('方法目录与当前类任务不匹配');
      }

      setClassTaskCatalogs((catalogs) => ({ ...catalogs, [taskId]: catalog }));
      setClassTaskMethodCatalogLoadStates((states) => omitRecordKey(states, taskId));
      setStatus(`已加载 ${catalog.methods.length} 个方法`);
    } catch (error: unknown) {
      if (
        classTaskMethodCatalogRequestIdsRef.current.get(taskId) === requestId &&
        input.workspaceLoadRequestId === workspaceLoadRequestRef.current &&
        isSameWorkspaceRoot(requestedWorkspaceRoot, activeWorkspaceRootRef.current)
      ) {
        const message = toErrorMessage(error);
        setClassTaskMethodCatalogLoadStates((states) => ({
          ...states,
          [taskId]: { status: 'error', message }
        }));
        setStatus(`方法配置加载失败：${message}`);
      }
    } finally {
      if (classTaskMethodCatalogRequestIdsRef.current.get(taskId) === requestId) {
        classTaskMethodCatalogRequestIdsRef.current.delete(taskId);
      }
    }
  }

  async function saveClassTaskMethodConfiguration(
    taskId: string,
    draft: MethodSelectionDraft
  ): Promise<boolean> {
    if (!workspaceRoot || savingMethodSelectionTaskId === taskId) {
      return false;
    }

    const requestedWorkspaceRoot = workspaceRoot;
    setSavingMethodSelectionTaskId(taskId);
    clearMethodSelectionSaveError(taskId);
    try {
      const snapshot = await window.workstation.saveClassTaskMethodSelection({
        workspaceRoot: requestedWorkspaceRoot,
        taskId,
        selectionMode: draft.selectionMode,
        selectedMethodIds: draft.selectedMethodIds,
        methodOrder: draft.methodOrder,
        ragEnabled: draft.ragEnabled,
        repairAttemptLimit: draft.repairAttemptLimit,
        unlimitedRepair: draft.unlimitedRepair
      });
      if (!isSameWorkspaceRoot(requestedWorkspaceRoot, activeWorkspaceRootRef.current)) {
        return false;
      }
      setClassTaskSnapshots((snapshots) => ({ ...snapshots, [taskId]: snapshot }));
      setStatus(draft.selectionMode === 'ALL_BY_DEFAULT'
        ? '已保存默认方法配置，将对全部可生成方法执行'
        : `已保存 ${draft.methodOrder.length} 个方法的执行顺序`);
      return true;
    } catch (error: unknown) {
      const message = toErrorMessage(error);
      showMethodSelectionSaveError(taskId, message);
      setStatus(`方法配置保存失败：${message}`);
      return false;
    } finally {
      if (isSameWorkspaceRoot(requestedWorkspaceRoot, activeWorkspaceRootRef.current)) {
        setSavingMethodSelectionTaskId(null);
      }
    }
  }

  function clearMethodSelectionSaveError(taskId: string): void {
    const timer = methodSelectionSaveErrorTimersRef.current.get(taskId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      methodSelectionSaveErrorTimersRef.current.delete(taskId);
    }
    setMethodSelectionSaveErrors((errors) => omitRecordKey(errors, taskId));
  }

  function clearAllMethodSelectionSaveErrors(): void {
    for (const timer of methodSelectionSaveErrorTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    methodSelectionSaveErrorTimersRef.current.clear();
    setMethodSelectionSaveErrors({});
  }

  function showMethodSelectionSaveError(taskId: string, message: string): void {
    const previousTimer = methodSelectionSaveErrorTimersRef.current.get(taskId);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
    }
    setMethodSelectionSaveErrors((errors) => ({ ...errors, [taskId]: message }));
    const timer = window.setTimeout(() => {
      if (methodSelectionSaveErrorTimersRef.current.get(taskId) !== timer) return;
      methodSelectionSaveErrorTimersRef.current.delete(taskId);
      setMethodSelectionSaveErrors((errors) => omitRecordKey(errors, taskId));
    }, METHOD_SELECTION_SAVE_ERROR_VISIBLE_MS);
    methodSelectionSaveErrorTimersRef.current.set(taskId, timer);
  }

  async function selectFile(file: WorkspaceFile): Promise<void> {
    if (file.type !== 'file') {
      return;
    }

    const existingFile = openFiles.find((openFile) => openFile.path === file.path);
    if (existingFile) {
      activateSourceFileTab(existingFile.path);
      setStatus(`正在显示 ${existingFile.relativePath}`);
      return;
    }

    setStatus(`正在打开 ${file.relativePath}`);
    const content = await window.workstation.readFile(workspaceRoot, file.path);
    const openFile = { path: file.path, relativePath: file.relativePath, content, savedContent: content };
    setOpenFiles((files) => [...files, openFile]);
    activateSourceFileTab(file.path);
    setStatus('文件已打开');

  }

  async function searchWorkspace(): Promise<void> {
    const query = workspaceSearchQuery.trim();
    const requestId = workspaceSearchRequestRef.current + 1;
    workspaceSearchRequestRef.current = requestId;
    setWorkspaceSearchError('');
    setWorkspaceSearchResults([]);

    if (!workspaceRoot) {
      setWorkspaceSearchError('请先打开一个工作区。');
      return;
    }

    if (!query) {
      setStatus('请输入搜索内容');
      return;
    }

    setIsSearchingWorkspace(true);
    setStatus(`正在全局搜索内容：${query}`);

    try {
      const matcher = createWorkspaceSearchMatcher(query, {
        caseSensitive: workspaceSearchCaseSensitive,
        regex: workspaceSearchRegex,
        wholeWord: workspaceSearchWholeWord
      });
      const candidates = await collectWorkspaceSearchFiles(workspaceRoot);
      const results: WorkspaceSearchFileResult[] = [];
      let matchCount = 0;

      for (const file of candidates) {
        if (requestId !== workspaceSearchRequestRef.current || matchCount >= MAX_WORKSPACE_SEARCH_MATCHES) {
          break;
        }

        const openedFile = openFiles.find((item) => item.path === file.path);
        const content = openedFile?.content ?? (await window.workstation.readFile(workspaceRoot, file.path));
        const matches = findWorkspaceSearchMatches(content, matcher, MAX_WORKSPACE_SEARCH_MATCHES - matchCount);

        if (matches.length > 0) {
          results.push({ file, matches });
          matchCount += matches.length;
        }
      }

      if (requestId !== workspaceSearchRequestRef.current) {
        return;
      }

      setWorkspaceSearchResults(results);
      setStatus(`搜索完成：${matchCount} 个匹配`);
    } catch (error: unknown) {
      if (requestId === workspaceSearchRequestRef.current) {
        const message = toErrorMessage(error);
        setWorkspaceSearchError(message);
        setStatus(`搜索失败：${message}`);
      }
    } finally {
      if (requestId === workspaceSearchRequestRef.current) {
        setIsSearchingWorkspace(false);
      }
    }
  }

  async function openSearchMatch(result: WorkspaceSearchFileResult, match: WorkspaceSearchMatch): Promise<void> {
    const existingFile = openFiles.find((file) => file.path === result.file.path);
    pendingEditorRevealRef.current = {
      path: result.file.path,
      line: match.line,
      column: match.column
    };

    if (existingFile) {
      activateSourceFileTab(existingFile.path);
      setStatus(`已定位到 ${existingFile.relativePath}:${match.line}`);
      return;
    }

    const content = await window.workstation.readFile(workspaceRoot, result.file.path);
    setOpenFiles((files) => [
      ...files,
      {
        path: result.file.path,
        relativePath: result.file.relativePath,
        content,
        savedContent: content
      }
    ]);
    activateSourceFileTab(result.file.path);
    setStatus(`已定位到 ${result.file.relativePath}:${match.line}`);

  }

  function closeOpenFile(filePath: string, event?: MouseEvent<HTMLButtonElement>): void {
    event?.stopPropagation();
    const tab = workbenchTabs.items.find(
      (candidate): candidate is Extract<WorkbenchTab, { kind: 'source' }> =>
        candidate.kind === 'source' && candidate.filePath === filePath
    );
    if (tab) {
      closeEditorTab(tab);
      return;
    }
    setOpenFiles((files) => files.filter((file) => file.path !== filePath));
  }

  function closeEditorTab(tab: WorkbenchTab, event?: MouseEvent<HTMLButtonElement>): void {
    event?.stopPropagation();
    const nextTabs = closeWorkbenchTab(workbenchTabs, tab.id);
    const nextOpenFiles = tab.kind === 'source'
      ? openFiles.filter((file) => file.path !== tab.filePath)
      : openFiles;
    const activeTab = nextTabs.items.find((candidate) => candidate.id === nextTabs.activeId) ?? null;

    setWorkbenchTabs(nextTabs);
    if (tab.kind === 'source') {
      setOpenFiles(nextOpenFiles);
    }
    if (activeTab?.kind === 'source') {
      setActiveFilePath(activeTab.filePath);
    } else if (
      tab.kind === 'source' &&
      activeFilePath === tab.filePath
    ) {
      setActiveFilePath(nextOpenFiles[0]?.path ?? null);
    }
  }

  function openTabContextMenu(tab: WorkbenchTab, event: MouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.stopPropagation();
    if (tab.kind === 'source') {
      activateSourceFileTab(tab.filePath);
    } else {
      setWorkbenchTabs((tabs) => activateWorkbenchTab(tabs, tab.id));
    }
    setTabContextMenu({
      tabId: tab.id,
      x: event.clientX,
      y: event.clientY
    });
  }

  function closeTabsAround(
    targetId: WorkbenchTab['id'],
    mode: 'current' | 'left' | 'right' | 'others' | 'all'
  ): void {
    setTabContextMenu(null);
    const targetIndex = workbenchTabs.items.findIndex((tab) => tab.id === targetId);
    if (targetIndex === -1) {
      return;
    }

    const items = workbenchTabs.items.filter((tab, index) => {
      switch (mode) {
        case 'current':
          return tab.id !== targetId;
        case 'left':
          return index >= targetIndex;
        case 'right':
          return index <= targetIndex;
        case 'others':
          return tab.id === targetId;
        case 'all':
          return false;
      }
    });
    const activeId = items.some((tab) => tab.id === workbenchTabs.activeId)
      ? workbenchTabs.activeId
      : (items[Math.min(targetIndex, items.length - 1)] ?? items[items.length - 1] ?? null)?.id ?? null;
    const nextTabs: WorkbenchTabs = { items, activeId };
    const sourcePaths = new Set(
      items.filter((tab): tab is Extract<WorkbenchTab, { kind: 'source' }> => tab.kind === 'source')
        .map((tab) => tab.filePath)
    );
    const nextOpenFiles = openFiles.filter((file) => sourcePaths.has(file.path));
    const activeTab = items.find((tab) => tab.id === activeId) ?? null;

    setWorkbenchTabs(nextTabs);
    setOpenFiles(nextOpenFiles);
    if (activeTab?.kind === 'source') {
      setActiveFilePath(activeTab.filePath);
    } else if (!activeFilePath || !sourcePaths.has(activeFilePath)) {
      setActiveFilePath(nextOpenFiles[0]?.path ?? null);
    }
  }

  function cancelPendingWorkspaceViewStateSave(): void {
    if (workspaceViewStateSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceViewStateSaveTimerRef.current);
      workspaceViewStateSaveTimerRef.current = null;
    }
  }

  function sendChatMessage(): void {
    const trimmed = chatInput.trim();
    if (!trimmed) {
      return;
    }

    setChatInput('');
    setChatMessages((messages) => [
      ...messages,
      { role: 'user', content: trimmed },
      {
        role: 'assistant',
        content: '后端智能体聊天 API 尚未接入。这个面板已经准备好对接 SSE 或 WebSocket。'
      }
    ]);
  }

  return (
    <main className="ide-shell">
      <header className="titlebar">
        <nav className="menu-strip" aria-label="应用菜单" />
        <div className="workspace-title">
          <Code2 size={15} />
          <span>{workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() : 'AI Unit Test Workstation'}</span>
        </div>
      </header>

      <section
        className="workbench"
        style={{
          gridTemplateColumns: `${ACTIVITY_BAR_WIDTH}px ${leftPanelWidth}px ${RESIZE_HANDLE_WIDTH}px minmax(${MIN_EDITOR_COLUMN_WIDTH}px, 1fr) ${RESIZE_HANDLE_WIDTH}px ${rightPanelWidth}px`
        }}
      >
        <ActivityBar
          activeView={activityView}
          onChange={setActivityView}
          currentUser={authenticatedUser}
          onLogout={() => void window.workstation.logout()}
        />

        <aside className={activityView === 'rag-knowledge'
          ? 'side-panel rag-knowledge-side-panel'
          : 'side-panel'}>
          {activityView === 'explorer' ? (
            <ExplorerView
              files={files}
              expandedPaths={expandedPaths}
              loadingPaths={loadingPaths}
              selectedPath={selectedFile?.path}
              workspaceRoot={workspaceRoot}
              onOpenWorkspace={openWorkspace}
              onRefresh={refreshWorkspace}
              onRevealCurrentFile={() => void revealCurrentFileInExplorer()}
              onSelectFile={selectFile}
              onToggleDirectory={toggleDirectory}
              revealPath={treeFileRevealRequest?.path}
            />
          ) : activityView === 'search' ? (
            <SearchView
              caseSensitive={workspaceSearchCaseSensitive}
              error={workspaceSearchError}
              isSearching={isSearchingWorkspace}
              query={workspaceSearchQuery}
              regex={workspaceSearchRegex}
              results={workspaceSearchResults}
              treeView={workspaceSearchTreeView}
              wholeWord={workspaceSearchWholeWord}
              workspaceRoot={workspaceRoot}
              onCaseSensitiveChange={setWorkspaceSearchCaseSensitive}
              onClear={() => updateWorkspaceSearchQuery('')}
              onOpenMatch={openSearchMatch}
              onQueryChange={updateWorkspaceSearchQuery}
              onRegexChange={setWorkspaceSearchRegex}
              onSearch={searchWorkspace}
              onTreeViewChange={setWorkspaceSearchTreeView}
              onWholeWordChange={setWorkspaceSearchWholeWord}
            />
          ) : activityView === 'rag-knowledge' ? (
            <RagKnowledgePanel
              key={`global:${ragConfigurationVersion}`}
              workspaceRoot={workspaceRoot}
              api={window.workstation}
              onOpenMethod={openRagSource}
              activeMethodId={activeWorkbenchTab?.kind === 'rag_method' ? activeWorkbenchTab.methodId : undefined}
              onOpenRagSettings={() => {
                setRagSettingsOpenRequestId((requestId) => requestId + 1);
              }}
            />
          ) : authenticatedUser?.role === 'ADMIN' ? (
            <UserManagementPanel currentUser={authenticatedUser} />
          ) : null}
        </aside>

        <div className="resize-handle" role="separator" aria-label="调整资源管理器宽度" onMouseDown={(event) => startResize('left', event)} />

        <section className="editor-column">
            <div className="editor-tabs">
              {workbenchTabs.items.length > 0 ? (
                <div className="editor-tab-list" onWheel={scrollEditorTabsWithWheel}>
                  {workbenchTabs.items.map((tab) => {
                    const isActive = tab.id === workbenchTabs.activeId;

                    if (tab.kind === 'rag_method') {
                      return <div key={tab.id} className={isActive ? 'editor-tab active' : 'editor-tab'}
                        title={`${tab.ownerFqn}\n${tab.canonicalSignature}`} role="button" tabIndex={0}
                        onClick={() => setWorkbenchTabs(tabs => activateWorkbenchTab(tabs, tab.id))}
                        onContextMenu={event => openTabContextMenu(tab, event)}
                        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault(); setWorkbenchTabs(tabs => activateWorkbenchTab(tabs, tab.id));
                        } }}>
                        <FileCode2 size={14} /><span>{tab.ownerFqn.split('.').pop()} · {tab.methodName}</span>
                        <button className="editor-tab-close" title="关闭知识库方法源码" aria-label={`关闭 ${tab.canonicalSignature} 标签页`} onClick={event => closeEditorTab(tab, event)}><X size={20} /></button>
                      </div>;
                    }

                    if (tab.kind === 'method_configuration') {
                      const className = tab.qualifiedClassName.split('.').pop() ?? tab.qualifiedClassName;
                      return (
                        <div
                          key={tab.id}
                          className={isActive ? 'editor-tab active' : 'editor-tab'}
                          title={`${tab.qualifiedClassName} · 方法配置`}
                          onClick={() => setWorkbenchTabs((tabs) => activateWorkbenchTab(tabs, tab.id))}
                          onContextMenu={(event) => openTabContextMenu(tab, event)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              setWorkbenchTabs((tabs) => activateWorkbenchTab(tabs, tab.id));
                            }
                          }}
                        >
                          <Settings size={14} />
                          <span>{className} · 方法</span>
                          <button
                            className="editor-tab-close"
                            title="关闭方法配置"
                            onClick={(event) => closeEditorTab(tab, event)}
                          >
                            <X size={20} />
                          </button>
                        </div>
                      );
                    }

                    const file = openFiles.find((candidate) => candidate.path === tab.filePath);
                    if (!file) {
                      return null;
                    }
                    const fileIsDirty = file.content !== file.savedContent;

                    return (
                      <div
                        key={tab.id}
                        className={isActive ? 'editor-tab active' : 'editor-tab'}
                        title={file.relativePath}
                        onClick={() => activateSourceFileTab(file.path)}
                        onContextMenu={(event) => openTabContextMenu(tab, event)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            activateSourceFileTab(file.path);
                          }
                        }}
                      >
                        <FileCode2 size={14} />
                        <span>{file.relativePath.split(/[\\/]/).pop()}</span>
                        {fileIsDirty && <i />}
                        <button className="editor-tab-close" title="关闭文件" onClick={(event) => closeOpenFile(file.path, event)}>
                          <X size={20} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="editor-tab placeholder">未打开文件</div>
              )}
              {tabContextMenu && (
                <div className="tab-context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
                  <button onClick={() => closeTabsAround(tabContextMenu.tabId, 'current')}>关闭当前标签页</button>
                  <button onClick={() => closeTabsAround(tabContextMenu.tabId, 'left')}>关闭左侧标签页</button>
                  <button onClick={() => closeTabsAround(tabContextMenu.tabId, 'right')}>关闭右侧标签页</button>
                  <button onClick={() => closeTabsAround(tabContextMenu.tabId, 'others')}>关闭其他所有标签页</button>
                  <button onClick={() => closeTabsAround(tabContextMenu.tabId, 'all')}>关闭所有标签页</button>
                </div>
              )}
              <div className="editor-actions">
              </div>
            </div>

            <div className="breadcrumbs">
              {activeWorkbenchTab?.kind === 'rag_method'
                ? `${activeWorkbenchTab.ownerFqn} / ${activeWorkbenchTab.methodName}`
                : activeWorkbenchTab?.kind === 'method_configuration'
                ? `${activeWorkbenchTab.qualifiedClassName} / 方法配置`
                : selectedFile
                ? selectedFile.relativePath.replace(/[\\/]/g, ' / ')
                : '从资源管理器打开代码文件，或按 Ctrl+N 搜索文件'}
            </div>

            <div className="editor-surface">
              {activeWorkbenchTab?.kind === 'rag_method' ? (
                ragSources[activeWorkbenchTab.id] ? <RagMethodSourcePanel workspaceRoot={workspaceRoot}
                  source={ragSources[activeWorkbenchTab.id]} openSources={Object.values(ragSources)} />
                  : activeRagSourceLoadState?.status === 'error'
                    ? <div className="empty-editor" role="alert"><CircleAlert size={24}/><strong>源码加载失败</strong><span>{activeRagSourceLoadState.message}</span></div>
                    : <div className="empty-editor" role="status"><LoaderCircle className="spin" size={24}/><span>正在加载知识库方法源码…</span></div>
              ) : activeWorkbenchTab?.kind === 'method_configuration' ? (
                activeMethodConfigurationTask
                  && activeMethodConfigurationCatalog
                  && activeMethodConfigurationLoadState?.status !== 'error' ? (
                  <MethodConfigurationTab
                    task={activeMethodConfigurationTask}
                    catalog={activeMethodConfigurationCatalog}
                    isSaving={savingMethodSelectionTaskId === activeWorkbenchTab.taskId}
                    isRefreshing={activeMethodConfigurationLoadState?.status === 'loading'}
                    saveError={methodSelectionSaveErrors[activeWorkbenchTab.taskId] ?? null}
                    onRefresh={refreshClassTaskMethodConfiguration}
                    onSave={(draft) => saveClassTaskMethodConfiguration(activeWorkbenchTab.taskId, draft)}
                  />
                ) : activeMethodConfigurationTask && activeMethodConfigurationLoadState?.status === 'loading' ? (
                  <div
                    className="empty-editor class-task-method-loading"
                    role="status"
                    aria-live="polite"
                  >
                    <RefreshCw className="spin" size={38} />
                    <strong>正在读取覆盖率信息</strong>
                    <span>{activeWorkbenchTab.qualifiedClassName}</span>
                  </div>
                ) : activeMethodConfigurationTask && activeMethodConfigurationLoadState?.status === 'error' ? (
                  <div className="empty-editor class-task-method-load-error" role="alert">
                    <CircleAlert size={38} aria-hidden="true" />
                    <strong>覆盖率信息读取失败</strong>
                    <button
                      type="button"
                      className="class-task-method-retry"
                      aria-label="重试加载覆盖率信息"
                      onClick={() => void retryClassTaskMethodConfiguration()}
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      <span>重试</span>
                    </button>
                  </div>
                ) : (
                  <div className="empty-editor">
                    <Settings size={38} />
                    <strong>方法配置不可用</strong>
                    <span>请关闭该标签页并从类任务重新打开配置。</span>
                  </div>
                )
              ) : selectedFile ? (
                <LocalMonacoEditor
                  session={editorSession}
                  onError={handleEditorError}
                />
              ) : (
                <div className="empty-editor">
                  <Code2 size={42} />
                  <strong>打开项目</strong>
                  <span>使用资源管理器选择工作区，然后打开 Java 或 Python 源文件进行编辑。</span>
                </div>
              )}
            </div>

            <footer className="statusbar">
              <span className="statusbar-message">{status}</span>
              <div className="statusbar-actions">
                {activeWorkbenchTab?.kind === 'rag_method' ? <span>知识库源码 · 只读</span> : activeWorkbenchTab?.kind === 'method_configuration' ? (
                  <span>方法配置</span>
                ) : (
                  <>
                    <span>{selectedFile ? (isDirty ? '未保存' : '已保存') : '无文件'}</span>
                    <LanguageModePicker
                      currentLanguage={editorLanguage}
                      currentLabel={editorLanguageLabel}
                      detectedLanguage={selectedFile ? getEditorLanguage(selectedFile.path) : 'plaintext'}
                      disabled={!selectedFile}
                      isOpen={languageMenuOpen}
                      isOverridden={Boolean(selectedFile && languageOverrides[selectedFile.path])}
                      onSelect={selectLanguageMode}
                      onToggle={() => setLanguageMenuOpen((open) => !open)}
                    />
                  </>
                )}
              </div>
            </footer>
        </section>

        <div className="resize-handle" role="separator" aria-label="调整智能体面板宽度" onMouseDown={(event) => startResize('right', event)} />

        <AgentPanel
          classTasks={classTasks}
          busyClassTaskIds={busyClassTaskIds}
          canManageModelCallLogs={authenticatedUser?.role === 'ADMIN'}
          classTaskFocusRequest={classTaskFocusRequest}
          isClassTaskTotalCommandBusy={isClassTaskTotalCommandBusy}
          buildSettings={workspaceBuildSettings}
          buildSettingsValidation={buildSettingsValidation}
          isBuildSettingsBusy={isBuildSettingsBusy}
          getPathForDroppedFile={window.workstation.getPathForFile}
          onAddClassPaths={(filePaths) => void addClassTaskPaths(filePaths)}
          onReorderClassTasks={reorderClassTasks}
          onClassTaskCardIntent={handleClassTaskCardIntent}
          onLoadClassTaskResult={loadClassTaskResult}
          onAcceptClassTaskResult={acceptClassTaskResult}
          onRevokeClassTaskResult={revokeClassTaskResult}
          onRunAllClassTasks={() => void runAllPendingClassTasks()}
          onTerminateAllClassTasks={() => void terminateAllActiveClassTasks()}
          onResolveMavenHomeDefaults={resolveMavenHomeDefaults}
          onSaveBuildSettings={saveWorkspaceBuildSettings}
          onSelectBuildSettingsPath={selectBuildSettingsPath}
          onValidateBuildSettings={validateWorkspaceBuildSettings}
          ragSettingsOpenRequestId={ragSettingsOpenRequestId}
          workspaceRoot={workspaceRoot}
        />
      </section>
      {isQuickFileSearchOpen && (
        <QuickFileSearchDialog
          error={quickFileSearchError}
          isLoading={isQuickFileSearchLoading}
          query={quickFileSearchQuery}
          results={quickFileSearchResults}
          selectedIndex={quickFileSearchSelectedIndex}
          onClose={closeQuickFileSearch}
          onOpen={(file) => void openQuickFileSearchResult(file)}
          onQueryChange={setQuickFileSearchQuery}
          onSelectedIndexChange={setQuickFileSearchSelectedIndex}
        />
      )}
    </main>
  );
}

function QuickFileSearchDialog({
  error,
  isLoading,
  query,
  results,
  selectedIndex,
  onClose,
  onOpen,
  onQueryChange,
  onSelectedIndexChange
}: {
  error: string;
  isLoading: boolean;
  query: string;
  results: WorkspaceFile[];
  selectedIndex: number;
  onClose: () => void;
  onOpen: (file: WorkspaceFile) => void;
  onQueryChange: (query: string) => void;
  onSelectedIndexChange: (index: number) => void;
}): JSX.Element {
  const activeIndex = Math.min(selectedIndex, Math.max(results.length - 1, 0));
  const moveSelection = (delta: number): void => {
    if (results.length === 0) return;
    const nextIndex = (activeIndex + delta + results.length) % results.length;
    onSelectedIndexChange(nextIndex);
    window.requestAnimationFrame(() => {
      document.getElementById(`quick-file-result-${nextIndex}`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  return (
    <div
      className="quick-file-search-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="quick-file-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="搜索文件"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="quick-file-search-input">
          <Search size={17} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder="输入文件名进行模糊搜索"
            aria-controls="quick-file-search-results"
            aria-activedescendant={results[activeIndex] ? `quick-file-result-${activeIndex}` : undefined}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === 'Enter' && results[activeIndex]) {
                event.preventDefault();
                onOpen(results[activeIndex]);
              }
            }}
          />
          <kbd>Ctrl N</kbd>
        </div>

        <div id="quick-file-search-results" className="quick-file-search-results" role="listbox">
          {isLoading ? (
            <div className="quick-file-search-state">
              <span className="quick-file-search-spinner" aria-hidden="true" />
              正在读取工作区文件…
            </div>
          ) : error ? (
            <div className="quick-file-search-state error">{error}</div>
          ) : results.length === 0 ? (
            <div className="quick-file-search-state">
              {query.trim() ? '没有匹配的文件' : '当前工作区没有可打开的代码文件'}
            </div>
          ) : (
            results.map((file, index) => (
              <button
                id={`quick-file-result-${index}`}
                key={file.path}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'quick-file-search-result selected' : 'quick-file-search-result'}
                onMouseEnter={() => onSelectedIndexChange(index)}
                onClick={() => onOpen(file)}
              >
                <FileCode2 size={15} aria-hidden="true" />
                <span>{file.name}</span>
                <small>{getParentRelativePath(file.relativePath)}</small>
              </button>
            ))
          )}
        </div>

        <footer className="quick-file-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
      </section>
    </div>
  );
}

function LanguageModePicker({
  currentLanguage,
  currentLabel,
  detectedLanguage,
  disabled,
  isOpen,
  isOverridden,
  onSelect,
  onToggle
}: {
  currentLanguage: string;
  currentLabel: string;
  detectedLanguage: string;
  disabled: boolean;
  isOpen: boolean;
  isOverridden: boolean;
  onSelect: (languageId: string | null) => void;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="language-mode">
      <button className="language-mode-button" disabled={disabled} title="选择语言模式" onClick={onToggle}>
        <Code2 size={13} />
        <span>{currentLabel}</span>
        <ChevronDown size={12} />
      </button>
      {isOpen && (
        <div className="language-mode-menu">
          <div className="language-mode-menu-title">选择语言模式</div>
          <button className={!isOverridden ? 'selected' : ''} onClick={() => onSelect(null)}>
            <Check size={13} />
            <span>自动检测</span>
            <small>{getLanguageLabel(detectedLanguage)}</small>
          </button>
          <div className="language-mode-menu-separator" />
          {LANGUAGE_CHOICES.map((language) => (
            <button
              key={language.id}
              className={currentLanguage === language.id && isOverridden ? 'selected' : ''}
              title={language.aliases}
              onClick={() => onSelect(language.id)}
            >
              <Check size={13} />
              <span>{language.label}</span>
              <small>{language.id}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityBar({
  activeView,
  onChange,
  currentUser,
  onLogout
}: {
  activeView: ActivityView;
  onChange: (view: ActivityView) => void;
  currentUser: AuthUser | null;
  onLogout: () => void;
}): JSX.Element {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent): void => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen]);

  return (
    <aside className="activity-bar">
      <button className={activeView === 'explorer' ? 'active' : ''} title="资源管理器" onClick={() => onChange('explorer')}>
        <Files size={21} />
      </button>
      <button className={activeView === 'search' ? 'active' : ''} title="搜索" onClick={() => onChange('search')}>
        <Search size={21} />
      </button>
      <button
        className={activeView === 'rag-knowledge' ? 'active' : ''}
        title="RAG 知识库"
        aria-label="RAG 知识库"
        onClick={() => onChange('rag-knowledge')}
      >
        <RagKnowledgeIcon className="rag-knowledge-activity-icon" />
      </button>
      {currentUser?.role === 'ADMIN' && (
        <button
          className={activeView === 'user-management' ? 'active' : ''}
          title="用户管理"
          aria-label="用户管理"
          onClick={() => onChange('user-management')}
        >
          <Users size={21} />
        </button>
      )}
      <div className="activity-spacer" />
      {currentUser && (
        <div className="activity-account" ref={accountMenuRef}>
          <button
            className={accountMenuOpen ? 'activity-account-trigger open' : 'activity-account-trigger'}
            title={currentUser.loginName}
            aria-label="账号菜单"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen((open) => !open)}
          >
            <span className="activity-account-avatar" aria-hidden="true">
              <User size={15} strokeWidth={1.6} />
            </span>
          </button>
          {accountMenuOpen && (
            <div className="activity-account-menu" role="menu">
              <div className="activity-account-name" title={currentUser.loginName}>
                {currentUser.loginName}
              </div>
              <button
                className="activity-account-logout"
                role="menuitem"
                onClick={() => {
                  setAccountMenuOpen(false);
                  onLogout();
                }}
              >
                <LogOut size={16} strokeWidth={1.7} />
                <span>退出登录</span>
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

function ExplorerView({
  files,
  expandedPaths,
  loadingPaths,
  selectedPath,
  workspaceRoot,
  onOpenWorkspace,
  onRefresh,
  onRevealCurrentFile,
  onSelectFile,
  onToggleDirectory,
  revealPath
}: {
  files: WorkspaceFile[];
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  selectedPath?: string;
  workspaceRoot: string;
  onOpenWorkspace: () => void;
  onRefresh: () => void;
  onRevealCurrentFile: () => void;
  onSelectFile: (file: WorkspaceFile) => void;
  onToggleDirectory: (directory: WorkspaceFile) => void;
  revealPath?: string;
}): JSX.Element {
  const visibleFilePaths = useMemo(
    () => collectVisibleWorkspaceFilePaths(files, expandedPaths),
    [expandedPaths, files]
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(selectedPath ? [selectedPath] : [])
  );
  const selectionAnchorPathRef = useRef<string | null>(selectedPath ?? null);

  useEffect(() => {
    const next = new Set(selectedPath ? [selectedPath] : []);
    selectionAnchorPathRef.current = selectedPath ?? null;
    setSelectedPaths(next);
  }, [workspaceRoot]);

  useEffect(() => {
    if (!selectedPath) return;
    setSelectedPaths((current) => {
      if (current.has(selectedPath)) return current;
      selectionAnchorPathRef.current = selectedPath;
      return new Set([selectedPath]);
    });
  }, [selectedPath]);

  const selectExplorerFile = (
    file: WorkspaceFile,
    modifiers: ExplorerFileSelectionModifiers
  ): void => {
    const wasSelected = selectedPaths.has(file.path);
    const selection = resolveExplorerFileSelection({
      currentPaths: selectedPaths,
      anchorPath: selectionAnchorPathRef.current,
      clickedPath: file.path,
      orderedVisiblePaths: visibleFilePaths,
      additive: modifiers.ctrlKey || modifiers.metaKey,
      range: modifiers.shiftKey
    });
    selectionAnchorPathRef.current = selection.anchorPath;
    setSelectedPaths(selection.paths);

    if (!(wasSelected && (modifiers.ctrlKey || modifiers.metaKey) && !modifiers.shiftKey)) {
      onSelectFile(file);
    }
  };

  return (
    <>
      <div className="panel-header">
        <span>资源管理器</span>
        <div>
          <button
            title="定位当前文件"
            onClick={onRevealCurrentFile}
            disabled={!workspaceRoot || !selectedPath}
          >
            <Crosshair size={15} />
          </button>
          <button title="打开工作区" onClick={onOpenWorkspace}>
            <FolderOpen size={15} />
          </button>
          <button title="刷新" onClick={onRefresh} disabled={!workspaceRoot}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      <div className="workspace-caption">
        <span>{workspaceRoot ? workspaceRoot.split(/[\\/]/).pop()?.toUpperCase() : '未打开工作区'}</span>
      </div>
      {files.length > 0 ? (
        <FileTree
          files={files}
          expandedPaths={expandedPaths}
          loadingPaths={loadingPaths}
          onToggleDirectory={onToggleDirectory}
          revealPath={revealPath}
          selectedPaths={selectedPaths}
          visibleFilePaths={visibleFilePaths}
          onSelectFileWithModifiers={selectExplorerFile}
        />
      ) : (
        <div className="empty-panel">点击文件夹图标打开 Java 或 Python 项目。</div>
      )}
    </>
  );
}

function SearchView({
  caseSensitive,
  error,
  isSearching,
  query,
  regex,
  results,
  treeView,
  wholeWord,
  workspaceRoot,
  onCaseSensitiveChange,
  onClear,
  onOpenMatch,
  onQueryChange,
  onRegexChange,
  onSearch,
  onTreeViewChange,
  onWholeWordChange
}: {
  caseSensitive: boolean;
  error: string;
  isSearching: boolean;
  query: string;
  regex: boolean;
  results: WorkspaceSearchFileResult[];
  treeView: boolean;
  wholeWord: boolean;
  workspaceRoot: string;
  onCaseSensitiveChange: (enabled: boolean) => void;
  onClear: () => void;
  onOpenMatch: (result: WorkspaceSearchFileResult, match: WorkspaceSearchMatch) => void;
  onQueryChange: (query: string) => void;
  onRegexChange: (enabled: boolean) => void;
  onSearch: () => void;
  onTreeViewChange: (enabled: boolean) => void;
  onWholeWordChange: (enabled: boolean) => void;
}): JSX.Element {
  const matchCount = results.reduce((sum, result) => sum + result.matches.length, 0);
  const flatMatches = results.flatMap((result) => result.matches.map((match) => ({ result, match })));

  return (
    <>
      <div className="panel-header">
        <span>搜索</span>
        <div>
          <button title="刷新搜索" disabled={!workspaceRoot || !query.trim() || isSearching} onClick={onSearch}>
            <RefreshCw size={15} />
          </button>
          <button title="清空搜索内容" disabled={!query} onClick={onClear}>
            <X size={15} />
          </button>
          <button className={treeView ? 'active' : ''} title="按树形结构展示" onClick={() => onTreeViewChange(!treeView)}>
            <Files size={15} />
          </button>
        </div>
      </div>
      <div className="search-panel">
        <div className="search-input-row">
          <Search size={15} />
          <div className="search-input-field">
            <input
              autoComplete="off"
              disabled={!workspaceRoot}
              placeholder={workspaceRoot ? '搜索' : '请先打开工作区'}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </div>
          <div className="search-input-options">
            <button className={caseSensitive ? 'active' : ''} title="区分大小写" onClick={() => onCaseSensitiveChange(!caseSensitive)}>
              Aa
            </button>
            <button className={wholeWord ? 'active' : ''} title="全字匹配" onClick={() => onWholeWordChange(!wholeWord)}>
              <span className="whole-word-icon">ab</span>
            </button>
            <button className={regex ? 'active' : ''} title="使用正则表达式" onClick={() => onRegexChange(!regex)}>
              .*
            </button>
          </div>
        </div>
        {isSearching && <div className="search-summary">正在搜索...</div>}
        {error && <div className="search-error">{error}</div>}
        {!error && !isSearching && query.trim() && matchCount === 0 && <div className="empty-panel">没有匹配结果。</div>}
        {!error && !query.trim() && <div className="empty-panel">输入关键词后自动搜索当前工作区文件内容。</div>}
        {results.length > 0 && (
          <div className="search-summary">
            {matchCount} 个结果，位于 {results.length} 个文件
          </div>
        )}
        <div className="search-results">
          {treeView
            ? results.map((result) => (
                <div className="search-result-file" key={result.file.path}>
                  <div className="search-result-file-title">
                    <FileCode2 size={13} />
                    <span>{result.file.relativePath}</span>
                    <small>{result.matches.length}</small>
                  </div>
                  {result.matches.map((match) => (
                    <button
                      className="search-match"
                      key={`${result.file.path}:${match.line}:${match.column}:${match.preview}`}
                      title={`${result.file.relativePath}:${match.line}:${match.column}`}
                      onClick={() => onOpenMatch(result, match)}
                    >
                      <span>{match.line}</span>
                      <code>{match.preview}</code>
                    </button>
                  ))}
                </div>
              ))
            : flatMatches.map(({ result, match }) => (
                <button
                  className="search-match flat"
                  key={`${result.file.path}:${match.line}:${match.column}:${match.preview}`}
                  title={`${result.file.relativePath}:${match.line}:${match.column}`}
                  onClick={() => onOpenMatch(result, match)}
                >
                  <span>{match.line}</span>
                  <code>
                    {result.file.relativePath} - {match.preview}
                  </code>
                </button>
              ))}
        </div>
      </div>
    </>
  );
}


function AgentPanel({
  classTasks,
  busyClassTaskIds,
  canManageModelCallLogs,
  classTaskFocusRequest,
  isClassTaskTotalCommandBusy,
  buildSettings,
  buildSettingsValidation,
  isBuildSettingsBusy,
  getPathForDroppedFile,
  onAddClassPaths,
  onReorderClassTasks,
  onClassTaskCardIntent,
  onLoadClassTaskResult,
  onAcceptClassTaskResult,
  onRevokeClassTaskResult,
  onRunAllClassTasks,
  onTerminateAllClassTasks,
  onResolveMavenHomeDefaults,
  onSaveBuildSettings,
  onSelectBuildSettingsPath,
  onValidateBuildSettings,
  ragSettingsOpenRequestId,
  workspaceRoot
}: {
  classTasks: ClassTaskSnapshot[];
  busyClassTaskIds: ReadonlySet<string>;
  canManageModelCallLogs: boolean;
  classTaskFocusRequest: ClassTaskFocusRequest | null;
  isClassTaskTotalCommandBusy: boolean;
  buildSettings: WorkstationBuildSettings | null;
  buildSettingsValidation: BuildSettingsValidationResult | null;
  isBuildSettingsBusy: boolean;
  getPathForDroppedFile: (file: File) => string;
  onAddClassPaths: (filePaths: string[]) => void;
  onReorderClassTasks: (taskIds: string[]) => Promise<void>;
  onClassTaskCardIntent: (intent: ClassTaskCardIntent) => void;
  onLoadClassTaskResult: (taskId: string) => Promise<ClassTaskResultSnapshot | null>;
  onAcceptClassTaskResult: (taskId: string) => Promise<ClassTaskResultSnapshot>;
  onRevokeClassTaskResult: (taskId: string) => Promise<ClassTaskResultSnapshot>;
  onRunAllClassTasks: () => void;
  onTerminateAllClassTasks: () => void;
  onResolveMavenHomeDefaults: (mavenHome: string) => Promise<MavenHomeDefaults | null>;
  onSaveBuildSettings: (settings: WorkstationBuildSettings) => Promise<void>;
  onSelectBuildSettingsPath: (kind: BuildSettingsPathKind) => Promise<string | null>;
  onValidateBuildSettings: (settings: WorkstationBuildSettings) => Promise<BuildSettingsValidationResult>;
  ragSettingsOpenRequestId: number;
  workspaceRoot: string;
}): JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const isSettingsCloseBlocked = isBuildSettingsBusy;
  const isAnyGenerationRunning = classTasks.some((task) =>
    ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'].includes(task.state)
  );

  useEffect(() => {
    if (ragSettingsOpenRequestId > 0) setIsSettingsOpen(true);
  }, [ragSettingsOpenRequestId]);

  return (
    <aside className="agent-panel class-task-agent-panel">
      <ClassTaskPanel
        tasks={classTasks}
        workspaceRoot={workspaceRoot}
        busyTaskIds={busyClassTaskIds}
        focusRequest={classTaskFocusRequest}
        totalCommandBusy={isClassTaskTotalCommandBusy}
        getPathForDroppedFile={getPathForDroppedFile}
        onAddClassPaths={onAddClassPaths}
        onReorderTasks={onReorderClassTasks}
        onCardIntent={onClassTaskCardIntent}
        onLoadTaskResult={onLoadClassTaskResult}
        onAcceptTaskResult={onAcceptClassTaskResult}
        onRevokeTaskResult={onRevokeClassTaskResult}
        onRunAll={onRunAllClassTasks}
        onTerminateAll={onTerminateAllClassTasks}
        headerTrailing={(
          <button
            className="agent-settings-button"
            type="button"
            title="设置"
            aria-label="设置"
            aria-expanded={isSettingsOpen}
            disabled={isSettingsOpen && isSettingsCloseBlocked}
            onClick={() => {
              if (isSettingsOpen && !canCloseModelSettings(isSettingsCloseBlocked)) return;
              setIsSettingsOpen((open) => !open);
            }}
          >
            <Settings size={14} />
          </button>
        )}
      />

      <div className="class-task-settings-host">
        <WorkspaceSettingsDialog
          buildSettings={buildSettings}
          buildSettingsValidation={buildSettingsValidation}
          canManageModelCallLogs={canManageModelCallLogs}
          isRunning={isAnyGenerationRunning}
          isOpen={isSettingsOpen}
          isBuildSettingsBusy={isBuildSettingsBusy}
          sectionRequest={ragSettingsOpenRequestId > 0
            ? { requestId: ragSettingsOpenRequestId, section: 'rag' }
            : null}
          onClose={() => {
            if (!canCloseModelSettings(isSettingsCloseBlocked)) return;
            setIsSettingsOpen(false);
          }}
          onResolveMavenHomeDefaults={onResolveMavenHomeDefaults}
          onSaveBuildSettings={onSaveBuildSettings}
          onSelectBuildSettingsPath={onSelectBuildSettingsPath}
          onValidateBuildSettings={onValidateBuildSettings}
        />
      </div>
    </aside>
  );
}

function FileTree({
  files,
  expandedPaths,
  loadingPaths,
  onToggleDirectory,
  onSelectFileWithModifiers,
  revealPath,
  selectedPaths,
  visibleFilePaths,
  depth = 0
}: {
  files: WorkspaceFile[];
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  onToggleDirectory: (directory: WorkspaceFile) => void;
  onSelectFileWithModifiers: (
    file: WorkspaceFile,
    modifiers: ExplorerFileSelectionModifiers
  ) => void;
  revealPath?: string;
  selectedPaths: ReadonlySet<string>;
  visibleFilePaths: readonly string[];
  depth?: number;
}): JSX.Element {
  return (
    <ul className="file-tree">
      {files.map((file) => {
        const isExpanded = expandedPaths.has(file.path);
        const isLoading = loadingPaths.has(file.path);

        return (
          <li key={file.path}>
            <button
              className={[
                'file-node',
                selectedPaths.has(file.path) ? 'selected' : '',
                file.path === revealPath ? 'revealed' : ''
              ].filter(Boolean).join(' ')}
              data-workspace-file-path={file.path}
              draggable={file.type === 'file' && isJavaSourceFilePath(file.path)}
              onCopy={(event) => {
                if (file.type !== 'file' || !isJavaSourceFilePath(file.path)) return;
                const paths = resolveExplorerTransferPaths(
                  file.path,
                  selectedPaths,
                  visibleFilePaths
                );
                if (paths.length === 0) return;
                const text = paths.join('\r\n');
                event.preventDefault();
                event.clipboardData.setData(CLASS_TASK_FILE_PATH_MIME, text);
                event.clipboardData.setData('text/plain', text);
              }}
              onKeyDown={(event) => {
                if (
                  file.type !== 'file'
                  || !isJavaSourceFilePath(file.path)
                  || event.altKey
                  || (!event.ctrlKey && !event.metaKey)
                  || event.key.toLocaleLowerCase() !== 'c'
                ) {
                  return;
                }
                const paths = resolveExplorerTransferPaths(
                  file.path,
                  selectedPaths,
                  visibleFilePaths
                );
                if (paths.length === 0) return;
                event.preventDefault();
                const text = paths.join('\r\n');
                void navigator.clipboard.writeText(text).catch(() => (
                  window.workstation.writeClipboardText(text)
                ));
              }}
              onDragStart={(event) => {
                if (file.type !== 'file' || !isJavaSourceFilePath(file.path)) return;
                const paths = resolveExplorerTransferPaths(
                  file.path,
                  selectedPaths,
                  visibleFilePaths
                );
                if (paths.length === 0) return;
                const text = paths.join('\r\n');
                event.dataTransfer.setData(CLASS_TASK_FILE_PATH_MIME, text);
                event.dataTransfer.setData('text/plain', text);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={(event) => {
                if (file.type === 'directory') {
                  onToggleDirectory(file);
                  return;
                }
                onSelectFileWithModifiers(file, {
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey
                });
              }}
              title={file.relativePath}
              style={{ paddingLeft: 8 + depth * 13 }}
            >
              {file.type === 'directory' ? (
                <>
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}
                </>
              ) : (
                <>
                  <span className="tree-spacer" />
                  <FileCode2 size={13} />
                </>
              )}
              <span className="file-label">{file.name}</span>
              {isLoading && <span className="tree-loading" />}
            </button>
            {file.type === 'directory' && isExpanded && file.children && file.children.length > 0 && (
              <FileTree
                files={file.children}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                onToggleDirectory={onToggleDirectory}
                onSelectFileWithModifiers={onSelectFileWithModifiers}
                revealPath={revealPath}
                selectedPaths={selectedPaths}
                visibleFilePaths={visibleFilePaths}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

type ExplorerFileSelectionModifiers = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

function collectVisibleWorkspaceFilePaths(
  files: readonly WorkspaceFile[],
  expandedPaths: ReadonlySet<string>
): string[] {
  const paths: string[] = [];
  for (const file of files) {
    if (file.type === 'file') {
      paths.push(file.path);
      continue;
    }
    if (expandedPaths.has(file.path) && file.children) {
      paths.push(...collectVisibleWorkspaceFilePaths(file.children, expandedPaths));
    }
  }
  return paths;
}

function resolveExplorerFileSelection({
  currentPaths,
  anchorPath,
  clickedPath,
  orderedVisiblePaths,
  additive,
  range
}: {
  currentPaths: ReadonlySet<string>;
  anchorPath: string | null;
  clickedPath: string;
  orderedVisiblePaths: readonly string[];
  additive: boolean;
  range: boolean;
}): { paths: Set<string>; anchorPath: string } {
  if (range && anchorPath) {
    const anchorIndex = orderedVisiblePaths.indexOf(anchorPath);
    const clickedIndex = orderedVisiblePaths.indexOf(clickedPath);
    if (anchorIndex >= 0 && clickedIndex >= 0) {
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const paths = additive ? new Set(currentPaths) : new Set<string>();
      orderedVisiblePaths.slice(start, end + 1).forEach((path) => paths.add(path));
      return { paths, anchorPath };
    }
  }

  if (additive) {
    const paths = new Set(currentPaths);
    if (paths.has(clickedPath)) paths.delete(clickedPath);
    else paths.add(clickedPath);
    return { paths, anchorPath: clickedPath };
  }

  return { paths: new Set([clickedPath]), anchorPath: clickedPath };
}

function resolveExplorerTransferPaths(
  sourcePath: string,
  selectedPaths: ReadonlySet<string>,
  orderedVisiblePaths: readonly string[]
): string[] {
  const candidates = selectedPaths.has(sourcePath)
    ? orderedVisiblePaths.filter((path) => selectedPaths.has(path))
    : [sourcePath];
  return candidates.filter(isJavaSourceFilePath);
}

function isJavaSourceFilePath(filePath: string): boolean {
  return filePath.toLocaleLowerCase().endsWith('.java');
}

function updateTreeChildren(files: WorkspaceFile[], directoryPath: string, children: WorkspaceFile[]): WorkspaceFile[] {
  return files.map((file) => {
    if (file.path === directoryPath) {
      return { ...file, children };
    }

    if (file.children) {
      return { ...file, children: updateTreeChildren(file.children, directoryPath, children) };
    }

    return file;
  });
}

function mergeTreeChildren(files: WorkspaceFile[], directoryPath: string, children: WorkspaceFile[]): WorkspaceFile[] {
  return files.map((file) => {
    if (file.path === directoryPath) {
      const existingChildren = new Map((file.children ?? []).map((child) => [child.path, child]));
      return {
        ...file,
        children: children.map((child) => {
          const existing = existingChildren.get(child.path);
          return existing?.children ? { ...child, children: existing.children } : child;
        })
      };
    }

    if (file.children) {
      return { ...file, children: mergeTreeChildren(file.children, directoryPath, children) };
    }

    return file;
  });
}

async function loadExpandedDirectoryChildren(
  workspaceRoot: string,
  rootChildren: WorkspaceFile[],
  expandedPaths: string[]
): Promise<WorkspaceFile[]> {
  let nextFiles = rootChildren;
  const orderedExpandedPaths = [...expandedPaths].sort((left, right) => left.length - right.length);

  for (const expandedPath of orderedExpandedPaths) {
    try {
      const children = await window.workstation.listChildren(workspaceRoot, expandedPath);
      nextFiles = updateTreeChildren(nextFiles, expandedPath, children);
    } catch {
      // Ignore folders that were moved or deleted since the previous session.
    }
  }

  return nextFiles;
}

function getRelativePath(workspaceRoot: string, filePath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = filePath.replace(/\\/g, '/');

  if (normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function getWorkspaceParentDirectoryPaths(workspaceRoot: string, filePath: string): string[] {
  const separator = workspaceRoot.includes('\\') || filePath.includes('\\') ? '\\' : '/';
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, '');
  const relativePath = getRelativePath(workspaceRoot, filePath);
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  segments.pop();

  const parentPaths: string[] = [];
  let currentPath = normalizedRoot;
  for (const segment of segments) {
    currentPath = `${currentPath}${separator}${segment}`;
    parentPaths.push(currentPath);
  }

  return parentPaths;
}

function rankQuickFileSearchResults(
  files: WorkspaceFile[],
  query: string,
  openFiles: SelectedFile[],
  activeFilePath: string | null
): WorkspaceFile[] {
  const normalizedQuery = normalizeQuickFileSearchText(query);
  if (!normalizedQuery) {
    const openFileOrder = new Map(openFiles.map((file, index) => [file.path, index]));
    return [...files]
      .sort((left, right) => {
        if (left.path === activeFilePath) return -1;
        if (right.path === activeFilePath) return 1;
        const leftOpenIndex = openFileOrder.get(left.path);
        const rightOpenIndex = openFileOrder.get(right.path);
        if (leftOpenIndex !== undefined || rightOpenIndex !== undefined) {
          return (leftOpenIndex ?? Number.MAX_SAFE_INTEGER) - (rightOpenIndex ?? Number.MAX_SAFE_INTEGER);
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, MAX_QUICK_FILE_SEARCH_RESULTS);
  }

  return files
    .map((file) => ({ file, score: scoreQuickFileName(file.name, normalizedQuery) }))
    .filter((candidate): candidate is { file: WorkspaceFile; score: number } => candidate.score !== null)
    .sort((left, right) =>
      right.score - left.score ||
      left.file.name.localeCompare(right.file.name) ||
      left.file.relativePath.localeCompare(right.file.relativePath)
    )
    .slice(0, MAX_QUICK_FILE_SEARCH_RESULTS)
    .map((candidate) => candidate.file);
}

function scoreQuickFileName(fileName: string, normalizedQuery: string): number | null {
  const candidate = normalizeQuickFileSearchText(fileName);
  if (candidate === normalizedQuery) return 10_000;
  if (candidate.startsWith(normalizedQuery)) return 9_000 - candidate.length;

  const containedAt = candidate.indexOf(normalizedQuery);
  if (containedAt >= 0) {
    return 7_000 - containedAt * 20 - candidate.length;
  }

  let previousIndex = -1;
  let score = 4_000;
  let consecutiveCount = 0;
  for (const character of normalizedQuery) {
    const nextIndex = candidate.indexOf(character, previousIndex + 1);
    if (nextIndex < 0) return null;
    const gap = nextIndex - previousIndex - 1;
    consecutiveCount = gap === 0 ? consecutiveCount + 1 : 0;
    score += 120 - gap * 8 + consecutiveCount * 18;
    previousIndex = nextIndex;
  }
  return score - candidate.length;
}

function normalizeQuickFileSearchText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s._-]+/g, '');
}

function getParentRelativePath(relativePath: string): string {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  segments.pop();
  return segments.length > 0 ? segments.join(' / ') : '工作区根目录';
}

function isSameWorkspaceRoot(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function scheduleAfterFirstPaint(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.setTimeout(callback, 0);
    });
  });
}

async function collectWorkspaceSearchFiles(workspaceRoot: string): Promise<WorkspaceFile[]> {
  return window.workstation.listSearchFiles(workspaceRoot);
}

function createWorkspaceSearchMatcher(query: string, options: WorkspaceSearchOptions): WorkspaceSearchMatcher {
  const source = options.regex ? query : escapeRegExp(query);
  const boundedSource = options.wholeWord ? `\\b(?:${source})\\b` : source;
  const flags = options.caseSensitive ? 'g' : 'gi';

  return {
    expression: new RegExp(boundedSource, flags)
  };
}

function findWorkspaceSearchMatches(
  content: string,
  matcher: WorkspaceSearchMatcher,
  remainingLimit: number
): WorkspaceSearchMatch[] {
  const matches: WorkspaceSearchMatch[] = [];
  const lines = content.split(/\r?\n/);
  const limit = Math.min(remainingLimit, MAX_WORKSPACE_SEARCH_MATCHES_PER_FILE);

  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index];
    const expression = new RegExp(matcher.expression.source, matcher.expression.flags);
    let match: RegExpExecArray | null = null;

    while ((match = expression.exec(line)) && matches.length < limit) {
      const matchedText = match[0];

      matches.push({
        line: index + 1,
        column: match.index + 1,
        preview: toSearchPreview(line, match.index)
      });

      if (matchedText.length === 0) {
        expression.lastIndex += 1;
      }
    }
  }

  return matches;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toSearchPreview(line: string, matchIndex: number): string {
  const trimmedLine = line.trim();

  if (trimmedLine.length <= 160) {
    return trimmedLine;
  }

  const start = Math.max(0, matchIndex - 45);
  const end = Math.min(line.length, matchIndex + 115);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < line.length ? '...' : '';

  return `${prefix}${line.slice(start, end).trim()}${suffix}`;
}

function getEditorLanguage(path?: string): string {
  const normalizedPath = path?.toLowerCase() ?? '';
  const fileName = normalizedPath.split(/[\\/]/).pop() ?? '';

  if (fileName === 'dockerfile') {
    return 'dockerfile';
  }

  if (fileName === 'makefile') {
    return 'makefile';
  }

  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';

  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

function getLanguageLabel(languageId: string): string {
  return LANGUAGE_CHOICES.find((language) => language.id === languageId)?.label ?? languageId;
}

const LANGUAGE_CHOICES: LanguageChoice[] = [
  { id: 'java', label: 'Java' },
  { id: 'python', label: 'Python', aliases: 'py' },
  { id: 'javascript', label: 'JavaScript', aliases: 'js jsx mjs cjs' },
  { id: 'typescript', label: 'TypeScript', aliases: 'ts tsx' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'xml', label: 'XML' },
  { id: 'yaml', label: 'YAML', aliases: 'yml' },
  { id: 'markdown', label: 'Markdown', aliases: 'md' },
  { id: 'shell', label: 'Shell Script', aliases: 'sh bash zsh' },
  { id: 'powershell', label: 'PowerShell', aliases: 'ps1' },
  { id: 'sql', label: 'SQL' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust', aliases: 'rs' },
  { id: 'cpp', label: 'C++', aliases: 'cc cpp cxx h hpp' },
  { id: 'c', label: 'C' },
  { id: 'csharp', label: 'C#', aliases: 'cs' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby', aliases: 'rb' },
  { id: 'kotlin', label: 'Kotlin', aliases: 'kt kts' },
  { id: 'lua', label: 'Lua' },
  { id: 'dockerfile', label: 'Dockerfile' },
  { id: 'makefile', label: 'Makefile' },
  { id: 'plaintext', label: 'Plain Text' }
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.bat': 'bat',
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'javascript',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.lua': 'lua',
  '.md': 'markdown',
  '.php': 'php',
  '.ps1': 'powershell',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'shell',
  '.sql': 'sql',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml'
};

const DEFAULT_SEMANTIC_TOKEN_STYLES: Record<string, SemanticTokenStyle> = {
  annotation: { foreground: '#dcdcaa' },
  class: { foreground: '#4ec9b0' },
  decorator: { foreground: '#dcdcaa' },
  enum: { foreground: '#4ec9b0' },
  enumMember: { foreground: '#9cdcfe' },
  field: { foreground: '#9cdcfe' },
  function: { foreground: '#dcdcaa' },
  interface: { foreground: '#4ec9b0' },
  keyword: { foreground: '#c586c0' },
  modifier: { foreground: '#569cd6' },
  method: { foreground: '#dcdcaa' },
  namespace: { foreground: '#d4d4d4' },
  package: { foreground: '#d4d4d4' },
  parameter: { foreground: '#9cdcfe' },
  property: { foreground: '#9cdcfe' },
  local: { foreground: '#9cdcfe' },
  type: { foreground: '#4ec9b0' },
  typeParameter: { foreground: '#4ec9b0' },
  variable: { foreground: '#9cdcfe' }
};

function updateSemanticTokenStyles(styles: Record<string, SemanticTokenStyle> | null): void {
  const styleId = 'workstation-semantic-token-theme';
  document.getElementById(styleId)?.remove();

  if (!styles) {
    return;
  }

  const styleElement = document.createElement('style');
  styleElement.id = styleId;
  styleElement.textContent = Object.entries(styles)
    .map(([token, style]) => {
      const declarations = [
        style.foreground ? `color: ${ensureCssColor(style.foreground)} !important;` : '',
        style.fontStyle ? `font-style: ${style.fontStyle || 'normal'} !important;` : ''
      ]
        .filter(Boolean)
        .join(' ');

      return declarations ? `.semantic-token-${sanitizeSemanticTokenKey(token)} { ${declarations} }` : '';
    })
    .filter(Boolean)
    .join('\n');

  document.head.appendChild(styleElement);
}

function sanitizeSemanticTokenKey(token: string): string {
  return token.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function ensureCssColor(color: string): string {
  return color.startsWith('#') ? color : `#${color}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampPanelWidthForViewport(
  panel: 'left' | 'right',
  proposedWidth: number,
  viewportWidth: number,
  otherPanelWidth: number
): number {
  const minimum = panel === 'left'
    ? MIN_LEFT_PANEL_WIDTH
    : MIN_RIGHT_PANEL_WIDTH;
  const configuredMaximum = panel === 'left'
    ? MAX_LEFT_PANEL_WIDTH
    : MAX_RIGHT_PANEL_WIDTH;
  const availableMaximum =
    viewportWidth
    - ACTIVITY_BAR_WIDTH
    - RESIZE_HANDLE_WIDTH * 2
    - MIN_EDITOR_COLUMN_WIDTH
    - otherPanelWidth;
  const maximum = Math.max(
    minimum,
    Math.min(configuredMaximum, availableMaximum)
  );
  return clamp(proposedWidth, minimum, maximum);
}

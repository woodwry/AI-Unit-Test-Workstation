import type { ClassTaskAppApi } from './class-task-contracts.ts';
import type { ClassMethodCatalog } from './class-task-contracts.ts';
import type { RagKnowledgeAppApi } from './rag-knowledge-contracts.ts';
import type { AuthAppApi } from './auth-contracts.ts';

export * from './class-task-contracts.ts';

export type WorkspaceFile = {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  hasChildren?: boolean;
  children?: WorkspaceFile[];
};

export type JavaMethodInfo = {
  name: string;
  signature: string;
  returnType: string;
  parameters: string;
  visibility: 'public' | 'protected' | 'private' | 'package';
  startLine: number;
  endLine: number;
};

export type JavaFileInfo = {
  path: string;
  relativePath: string;
  packageName: string;
  className: string;
  methods: JavaMethodInfo[];
};

export type JavaProjectScanResult = {
  workspaceRoot: string;
  files: JavaFileInfo[];
};

export type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type BuildToolchainSettings = {
  mavenHome: string;
  javaHome: string;
  settingsPath?: string;
  localRepository?: string;
};

export type WorkstationBuildSettings = BuildToolchainSettings & {
  validation?: BuildSettingsValidationResult;
};

export type SaveWorkstationBuildSettingsRequest = BuildToolchainSettings;

export type ModelCallLogSettings = {
  enabled: boolean;
  directory?: string;
};

export type SaveModelCallLogSettingsRequest = ModelCallLogSettings;

/** 旧安装版的逐工作区构建配置，仅用于一次性迁移。 */
export type WorkspaceBuildSettings = BuildToolchainSettings & {
  workspaceRoot: string;
  validation?: BuildSettingsValidationResult;
};

export type MavenHomeDefaults = {
  settingsPath: string;
  localRepository: string;
};

export type BuildSettingsValidationResult = {
  valid: boolean;
  command: string;
  mavenVersion?: string;
  javaVersion?: string;
  javaRuntime?: string;
  checkedAt: string;
  error?: string;
  stdoutTail?: string;
  stderrTail?: string;
};

/**
 * Workstation 通过 `mvn --version` 实际校验出的公开工具链信息。
 * 这里只传版本号，不向 agent-service 暴露用户本机的 JDK/Maven 安装路径。
 */
export type BuildToolchainContext = {
  javaVersion: string;
  mavenVersion: string;
};

/**
 * Electron 主进程为 java-analyzer 收集的本地分析输入。
 * 该对象不得写入渲染器会话快照或工作区持久化设置。
 */
export type GenerationAnalysisInput = {
  workspaceRoot: string;
  moduleRoot: string;
  targetSourcePath: string;
  targetClass: string;
  plannedTestClassName: string;
  plannedRelativeTestPath: string;
  reportPath: string;
  branchSnapshotPath: string;
  reportPairId: string;
  sourceRoots: string[];
  classpathEntries: string[];
  javaHome: string;
  jdkMajorVersion: number;
  buildContextFingerprint: string;
  warnings: Array<{
    code: 'CLASSPATH_COLLECTION_FAILED';
    message: string;
  }>;
};

/** 当前生成测试文件中的结构化 Java 编译诊断。 */
export type CompilerDiagnostic = {
  fileName: string;
  line: number;
  column: number;
  message: string;
};

export type BuildSettingsPathKind = 'mavenHome' | 'javaHome' | 'settingsPath' | 'localRepository';

export type GenerateTestRequest = {
  workspaceRoot: string;
  targetFilePath: string;
  sourceCode: string;
  method?: JavaMethodInfo;
  targetClass?: string;
  forceGeneration?: boolean;
  /** 仅由受信任的 Electron main 进程在构建环境预检后补充。 */
  buildToolchain?: BuildToolchainContext;
};

export type ValidationIssue = {
  code: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
};

export type ToolTraceItem = {
  tool: string;
  status: string;
  input: Record<string, unknown>;
  outputSummary?: string | null;
};

export type CoverageTarget = {
  line: number;
  branch: number;
};

export type ModelGenerationMode = 'agent_tools' | 'deterministic_prompt';

export type ModelInterfaceCredentialMode = 'direct' | 'environment';

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export type ModelRequestParameters = Record<string, JsonValue>;

export type ModelRequestParameterDraft = {
  name: string;
  value: string;
};

export type ModelInterfaceView = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  credentialMode: ModelInterfaceCredentialMode;
  environmentVariableName?: string;
  requestParameters?: ModelRequestParameters;
  hasStoredApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkstationModelInterfacesView = {
  schemaVersion: 2;
  activeInterfaceId: string | null;
  interfaces: ModelInterfaceView[];
  secureStorageAvailable: boolean;
};

export type ModelInterfaceDraft = {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
  credentialMode: ModelInterfaceCredentialMode;
  environmentVariableName: string;
  apiKey: string;
  requestParameters: ModelRequestParameterDraft[];
};

export type CreateModelInterfaceRequest = {
  name: string;
  baseUrl: string;
  model: string;
  credentialMode: ModelInterfaceCredentialMode;
  environmentVariableName?: string;
  apiKey?: string;
  requestParameters?: ModelRequestParameters;
};

export type UpdateModelInterfaceRequest = CreateModelInterfaceRequest & { id: string };

export type DeleteModelInterfaceRequest = { id: string };
export type SelectModelInterfaceRequest = { id: string | null };

export type ModelInterfaceConnectionTestRequest = {
  interfaceId?: string;
  baseUrl: string;
  model: string;
  credentialMode: ModelInterfaceCredentialMode;
  environmentVariableName?: string;
  apiKey?: string;
};

export type ModelInterfaceConnectionTestResult = {
  ok: boolean;
  code:
    | 'success'
    | 'invalid_configuration'
    | 'authentication_failed'
    | 'not_found'
    | 'unsupported'
    | 'timeout'
    | 'network_error';
  message: string;
};

export type RagEmbeddingInterfaceCredentialMode = 'direct' | 'environment';

export type RagEmbeddingInterfaceView = {
  id: string;
  name: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: RagEmbeddingInterfaceCredentialMode;
  environmentVariableName?: string;
  hasStoredApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RagEmbeddingInterfacesView = {
  schemaVersion: 1;
  activeInterfaceId: string | null;
  activeInterfaceConfigured: boolean;
  interfaces: RagEmbeddingInterfaceView[];
  secureStorageAvailable: boolean;
};

export type RagEmbeddingInterfaceDraft = {
  id?: string;
  name: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: RagEmbeddingInterfaceCredentialMode;
  environmentVariableName: string;
  apiKey: string;
};

export type CreateRagEmbeddingInterfaceRequest = {
  name: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: RagEmbeddingInterfaceCredentialMode;
  environmentVariableName?: string;
  apiKey?: string;
};

export type UpdateRagEmbeddingInterfaceRequest =
  CreateRagEmbeddingInterfaceRequest & { id: string };

export type DeleteRagEmbeddingInterfaceRequest = { id: string };
export type SelectRagEmbeddingInterfaceRequest = { id: string | null };

export type RagEmbeddingInterfaceConnectionTestRequest = {
  interfaceId?: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: RagEmbeddingInterfaceCredentialMode;
  environmentVariableName?: string;
  apiKey?: string;
};

export type RagEmbeddingInterfaceConnectionTestResult = {
  ok: boolean;
  code:
    | 'success'
    | 'invalid_configuration'
    | 'authentication_failed'
    | 'unsupported'
    | 'timeout'
    | 'network_error'
    | 'invalid_response';
  message: string;
};

export type BackendLlmConfig = {
  provider: 'custom_openai';
  model: string;
  baseUrl: string;
  credentials: { apiKey: string };
  requestParameters?: ModelRequestParameters;
};

// 仅供 main 进程把本次全局模型配置快照传给 AiClient。
export type ResolvedWorkstationModelRuntime = {
  interfaceId: string;
  interfaceName: string;
  credentialEnvironmentVariable?: string;
  llmConfig: BackendLlmConfig;
};

export type ResolvedRagEmbeddingRuntime = {
  interfaceId: string;
  interfaceName: string;
  credentialEnvironmentVariable?: string;
  embeddingModel: string;
  embeddingConfig: BackendLlmConfig;
};

/** 本次生成中大模型实际返回的 Token 用量。 */
export type { ModelTokenUsage } from './model-token-usage.ts';

export type WriteGeneratedTestRequest = {
  workspaceRoot: string;
  targetFilePath: string;
  content: string;
  suggestedTestPath?: string;
  testClassName?: string;
};

export type WriteGeneratedTestResult = {
  testFilePath: string;
  relativePath: string;
  bytesWritten: number;
  testClassName: string;
};

export type GeneratedTestFileState = 'candidate' | 'best' | 'accepted' | 'revoked';

/** 渲染进程可见的生成文件记录，不包含后端候选身份。 */
export type GeneratedTestFileRecord = {
  filePath: string;
  relativePath: string;
  testClassName: string;
  sha256: string;
  state: GeneratedTestFileState;
};

export type MethodCoverageDetail = {
  methodName: string;
  descriptor: string;
  firstLine: number;
  lineCovered: number;
  lineMissed: number;
  lineTotal: number;
  branchCovered: number;
  branchMissed: number;
  branchTotal: number;
  instructionCovered: number;
  instructionMissed: number;
  instructionTotal: number;
  complexityCovered: number;
  complexityMissed: number;
  complexityTotal: number;
  coverageGap: boolean;
  priorityRank: number;
};

export type CoverageGap = {
  methodName?: string | null;
  line: number;
  type: string;
  description: string;
};

export type CoverageSnapshot = {
  reportFound: boolean;
  reportPath?: string | null;
  lineCoverage?: number | null;
  branchCoverage?: number | null;
  branchTotal?: number;
  lineCovered?: number;
  lineMissed?: number;
  lineTotal?: number;
  branchCovered?: number;
  branchMissed?: number;
  lineTargetReached?: boolean;
  branchTargetReached?: boolean | null;
  targetReached?: boolean;
  uncoveredLines?: number[];
  uncoveredBranches?: CoverageGap[];
  uncoveredMethods?: string[];
  methodCoverage?: MethodCoverageDetail[];
  recommendedMethods?: MethodCoverageDetail[];
};

export type GenerateTargetJacocoReportRequest = {
  projectPath: string;
  targetFilePath: string;
  targetClass: string;
  executionDataPath: string;
  outputPath: string;
  branchSnapshotOutputPath: string;
};

export type GenerateTargetJacocoReportResponse = {
  generated: boolean;
  reportPath: string;
  branchSnapshotPath: string;
  pairId: string;
  targetClass: string;
  generatedAt: string;
  message: string;
};

export type JacocoConfigCheckResult = {
  configured: boolean;
  existingReportPath?: string | null;
  matchedFiles: string[];
  message: string;
};

export type BackendSettings = {
  agentServiceUrl: string;
  javaAnalyzerUrl: string;
};

export type BackendHealthStatus = {
  url: string;
  ok: boolean;
  message: string;
};

export type BackendHealthSummary = {
  agentService: BackendHealthStatus;
  javaAnalyzer: BackendHealthStatus;
};


export type WorkspaceWorkbenchTabState =
  | {
      kind: 'source';
      filePath: string;
    }
  | {
      kind: 'method_configuration';
      taskId: string;
      sourceFilePath: string;
      qualifiedClassName: string;
      catalog?: ClassMethodCatalog;
    };

export type WorkspaceViewState = {
  workspaceRoot: string;
  expandedPaths: string[];
  openFilePaths: string[];
  activeFilePath?: string;
  activityView?: 'explorer' | 'search' | 'rag-knowledge' | 'user-management';
  workbenchTabs?: WorkspaceWorkbenchTabState[];
  activeWorkbenchTabId?: string;
};

/**
 * 主进程在启动时返回的上次工作区候选；生成目标不属于可恢复状态。
 */
export type WorkspaceRestoreCandidate =
  | { state: 'none' }
  | { state: 'ready'; workspaceRoot: string }
  | { state: 'missing' };

/**
 * 安装包内本地服务的安全状态。这里只允许 renderer 获得产品级状态，
 * 不包含 URL、端口、PID、实例标识或访问令牌。
 */
export type ManagedBackendRuntimeStatus = {
  state:
    | 'idle'
    | 'starting-analyzer'
    | 'starting-agent'
    | 'ready'
    | 'failed'
    | 'stopping'
    | 'stopped';
  message: string;
  retryable: boolean;
};

export type AppApi = {
  getWorkstationModelInterfaces: () => Promise<WorkstationModelInterfacesView>;
  createModelInterface: (request: CreateModelInterfaceRequest) => Promise<WorkstationModelInterfacesView>;
  updateModelInterface: (request: UpdateModelInterfaceRequest) => Promise<WorkstationModelInterfacesView>;
  deleteModelInterface: (request: DeleteModelInterfaceRequest) => Promise<WorkstationModelInterfacesView>;
  selectModelInterface: (request: SelectModelInterfaceRequest) => Promise<WorkstationModelInterfacesView>;
  testModelInterfaceConnection: (request: ModelInterfaceConnectionTestRequest) => Promise<ModelInterfaceConnectionTestResult>;
  selectWorkspace: () => Promise<string | null>;
  getLastWorkspace: () => Promise<WorkspaceRestoreCandidate>;
  getWorkspaceViewState: (workspaceRoot: string) => Promise<WorkspaceViewState | null>;
  saveWorkspaceViewState: (state: WorkspaceViewState) => Promise<void>;
  getWorkstationBuildSettings: () => Promise<WorkstationBuildSettings | null>;
  saveWorkstationBuildSettings: (settings: SaveWorkstationBuildSettingsRequest) => Promise<WorkstationBuildSettings>;
  validateWorkstationBuildSettings: (settings: SaveWorkstationBuildSettingsRequest) => Promise<BuildSettingsValidationResult>;
  selectWorkstationBuildSettingsPath: (kind: BuildSettingsPathKind) => Promise<string | null>;
  resolveWorkstationMavenHomeDefaults: (mavenHome: string) => Promise<MavenHomeDefaults>;
  getModelCallLogSettings: () => Promise<ModelCallLogSettings>;
  saveModelCallLogSettings: (request: SaveModelCallLogSettingsRequest) => Promise<ModelCallLogSettings>;
  selectModelCallLogDirectory: () => Promise<string | null>;
  getRagEmbeddingInterfaces: () => Promise<RagEmbeddingInterfacesView>;
  createRagEmbeddingInterface: (
    request: CreateRagEmbeddingInterfaceRequest
  ) => Promise<RagEmbeddingInterfacesView>;
  updateRagEmbeddingInterface: (
    request: UpdateRagEmbeddingInterfaceRequest
  ) => Promise<RagEmbeddingInterfacesView>;
  deleteRagEmbeddingInterface: (
    request: DeleteRagEmbeddingInterfaceRequest
  ) => Promise<RagEmbeddingInterfacesView>;
  selectRagEmbeddingInterface: (
    request: SelectRagEmbeddingInterfaceRequest
  ) => Promise<RagEmbeddingInterfacesView>;
  testRagEmbeddingInterfaceConnection: (
    request: RagEmbeddingInterfaceConnectionTestRequest
  ) => Promise<RagEmbeddingInterfaceConnectionTestResult>;
  playAttentionSound: () => Promise<void>;
  setWindowModalBlocked: (blocked: boolean) => Promise<void>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  listFiles: (workspaceRoot: string) => Promise<WorkspaceFile[]>;
  listChildren: (workspaceRoot: string, directoryPath?: string) => Promise<WorkspaceFile[]>;
  listSearchFiles: (workspaceRoot: string) => Promise<WorkspaceFile[]>;
  readFile: (workspaceRoot: string, filePath: string) => Promise<string>;
  writeFile: (workspaceRoot: string, filePath: string, content: string) => Promise<number>;
  scanJavaProject: (workspaceRoot: string) => Promise<JavaProjectScanResult>;
  runMavenTest: (workspaceRoot: string, testName?: string) => Promise<CommandResult>;
  getManagedBackendRuntimeStatus: () => Promise<ManagedBackendRuntimeStatus | null>;
  retryManagedBackendRuntime: () => Promise<ManagedBackendRuntimeStatus | null>;
  probeBackendAvailability: () => Promise<boolean>;
  onManagedBackendRuntimeStatusChanged: (callback: (status: ManagedBackendRuntimeStatus) => void) => () => void;
  getBackendSettings: () => Promise<BackendSettings>;
  saveBackendSettings: (settings: BackendSettings) => Promise<BackendSettings>;
  checkBackendHealth: () => Promise<BackendHealthSummary>;
} & ClassTaskAppApi & RagKnowledgeAppApi & AuthAppApi;

export type {
  AdminUser,
  AuthState,
  AuthUser,
  CreateUserRequest,
  DeleteUserRequest,
  LoginRequest,
  UpdateUserRequest
} from './auth-contracts.ts';

export type {
  RagKnowledgeChangedEvent,
  RagKnowledgeEntriesPage,
  RagKnowledgeEntryView
} from './rag-knowledge-contracts';

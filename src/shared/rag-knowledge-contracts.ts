export type RagKnowledgeEntryView = {
  entryId: string;
  simpleName: string;
  classFqn: string;
  versionPath: string;
  binaryLocation: string | null;
  moduleNames: string[];
  updatedAt: string;
};

export type RagKnowledgeEntriesPage = {
  workspaceId: string;
  indexGeneration: number;
  items: RagKnowledgeEntryView[];
  nextCursor: string | null;
};

export type RagKnowledgeMethodView = {
  methodId: string;
  methodKey: string;
  ownerFqn: string;
  methodName: string;
  canonicalSignature: string;
  declarationSignature?: string;
  sourceKind: string;
  chunkCount: number;
};

export type RagKnowledgeMethodsPage = {
  configurationId: string;
  workspaceId: string;
  entryId: string;
  indexGeneration: number;
  items: RagKnowledgeMethodView[];
  nextCursor: string | null;
};

export type RagKnowledgeMethodRequest = {
  configurationId: string;
  workspaceRoot: string;
  entryId: string;
  methodId: string;
  indexGeneration: number;
};

export type RagKnowledgeMethodSource = {
  entryId: string;
  indexGeneration: number;
  method: RagKnowledgeMethodView;
  sourceText: string;
};

export type RagKnowledgeChangedEvent = {
  workspaceId: string;
  indexGeneration: number;
  reason: 'imported' | 'deleted' | 'reconciled' | 'configuration-changed';
  deletedEntryId?: string;
  deletedMethodId?: string;
};

export type GlobalKnowledgeRequest = {
  action:
    | 'pick-files'
    | 'browse-files'
    | 'clipboard-paths'
    | 'modules'
    | 'add-poms'
    | 'import'
    | 'entries'
    | 'methods'
    | 'source'
    | 'delete';
  fileKind?: 'pom' | 'class';
  archiveEntries?: string[];
  paths?: string[];
  moduleId?: string;
  entryId?: string;
  methodId?: string;
  entryIds?: string[];
  methodIds?: string[];
  query?: string;
  cursor?: string | null;
};

export type GlobalKnowledgeModule = {
  moduleId: string;
  groupId: string;
  artifactId: string;
  version: string;
  coordinate: string;
};

export type GlobalFileBrowserPage = {
  path: string;
  prefix: string;
  archive: boolean;
  parent: string;
  parentPrefix: string;
  items: Array<{
    name: string;
    path: string;
    kind: 'directory' | 'archive' | 'file';
  }>;
};

export type RagKnowledgeAppApi = {
  globalKnowledge<T = unknown>(request: GlobalKnowledgeRequest): Promise<T>;
  cancelGlobalKnowledgeImport(): Promise<boolean>;
  getRagKnowledgeMethodSource(
    request: RagKnowledgeMethodRequest
  ): Promise<RagKnowledgeMethodSource>;
  onRagKnowledgeChanged(
    callback: (event: RagKnowledgeChangedEvent) => void
  ): () => void;
};

export const RAG_KNOWLEDGE_CHANNELS = {
  changed: 'rag-knowledge:changed'
} as const;

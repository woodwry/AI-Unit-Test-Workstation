export type RagEmbeddingCredentialMode = 'direct' | 'environment';

export type RagEmbeddingInterfaceView = {
  id: string;
  name: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: RagEmbeddingCredentialMode;
  environmentVariableName?: string;
};

export type RagEmbeddingInterfacesView = {
  schemaVersion: 1;
  interfaces: RagEmbeddingInterfaceView[];
  activeInterfaceId: string | null;
  activeInterfaceConfigured: boolean;
  secureStorageAvailable: boolean;
};

export type RagConfigurationReadinessApi = {
  getRagEmbeddingInterfaces: () => Promise<RagEmbeddingInterfacesView>;
};

export type RagEmbeddingInterfaceDraft = {
  id?: string;
  name: string;
  baseUrl: string;
  embeddingModel: string;
  credentialMode: RagEmbeddingCredentialMode;
  environmentVariableName: string;
  apiKey: string;
};

export type RagEmbeddingConnectionResult = {
  ok: boolean;
  code: string;
  message: string;
};

export type RagEmbeddingEditorState = {
  mode: 'list' | 'create' | 'edit';
  editingId: string | null;
  draft: RagEmbeddingInterfaceDraft;
  initialDraft: RagEmbeddingInterfaceDraft;
  feedback: string;
  connectionResult: RagEmbeddingConnectionResult | null;
};

export type RagEmbeddingEditorAction =
  | { type: 'create-started' }
  | { type: 'edit-started'; item: RagEmbeddingInterfaceView }
  | { type: 'draft-changed'; draft: RagEmbeddingInterfaceDraft }
  | { type: 'feedback-shown'; feedback: string }
  | { type: 'connection-result-shown'; result: RagEmbeddingConnectionResult }
  | { type: 'list-returned' | 'save-succeeded' };

export type CreateRagEmbeddingInterfaceRequest = Omit<
  RagEmbeddingInterfaceDraft,
  'id' | 'environmentVariableName' | 'apiKey'
> & {
  environmentVariableName?: string;
  apiKey?: string;
};

export type UpdateRagEmbeddingInterfaceRequest = CreateRagEmbeddingInterfaceRequest & {
  id: string;
};

export type RagEmbeddingConnectionTestRequest = Omit<
  CreateRagEmbeddingInterfaceRequest,
  'name'
> & {
  interfaceId?: string;
};

const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const EMPTY_DRAFT: RagEmbeddingInterfaceDraft = {
  name: '',
  baseUrl: '',
  embeddingModel: '',
  credentialMode: 'direct',
  environmentVariableName: '',
  apiKey: ''
};

export function createInitialRagEmbeddingEditorState(): RagEmbeddingEditorState {
  return {
    mode: 'list',
    editingId: null,
    draft: { ...EMPTY_DRAFT },
    initialDraft: { ...EMPTY_DRAFT },
    feedback: '',
    connectionResult: null
  };
}

export function reduceRagEmbeddingEditorState(
  state: RagEmbeddingEditorState,
  action: RagEmbeddingEditorAction
): RagEmbeddingEditorState {
  switch (action.type) {
    case 'create-started': {
      const draft = { ...EMPTY_DRAFT };
      return {
        mode: 'create',
        editingId: null,
        draft,
        initialDraft: { ...draft },
        feedback: '',
        connectionResult: null
      };
    }
    case 'edit-started': {
      const draft: RagEmbeddingInterfaceDraft = {
        id: action.item.id,
        name: action.item.name,
        baseUrl: action.item.baseUrl,
        embeddingModel: action.item.embeddingModel,
        credentialMode: action.item.credentialMode,
        environmentVariableName: action.item.environmentVariableName ?? '',
        apiKey: ''
      };
      return {
        mode: 'edit',
        editingId: action.item.id,
        draft,
        initialDraft: { ...draft },
        feedback: '',
        connectionResult: null
      };
    }
    case 'draft-changed':
      return { ...state, draft: action.draft, feedback: '', connectionResult: null };
    case 'feedback-shown':
      return { ...state, feedback: action.feedback, connectionResult: null };
    case 'connection-result-shown':
      return { ...state, feedback: '', connectionResult: action.result };
    case 'list-returned':
    case 'save-succeeded':
      return createInitialRagEmbeddingEditorState();
  }
}

export function filterRagEmbeddingInterfaces(
  items: RagEmbeddingInterfaceView[],
  query: string
): RagEmbeddingInterfaceView[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  return items.filter((item) => [
    item.name,
    item.embeddingModel,
    item.baseUrl,
    item.credentialMode === 'direct' ? 'API Key' : '环境变量',
    item.environmentVariableName ?? ''
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
}

export async function inspectRagConfigurationReadiness(
  api: RagConfigurationReadinessApi
): Promise<boolean> {
  const embeddingInterfaces = await api.getRagEmbeddingInterfaces();
  const activeInterfaceId = embeddingInterfaces.activeInterfaceId;
  return activeInterfaceId !== null
    && embeddingInterfaces.activeInterfaceConfigured
    && embeddingInterfaces.interfaces.some((item) => item.id === activeInterfaceId);
}

export function validateRagEmbeddingInterfaceDraft(
  draft: RagEmbeddingInterfaceDraft,
  options: { existingNames?: string[]; mode?: 'create' | 'update' } = {}
): string | null {
  const name = draft.name.trim();
  if (!name) return '请输入接口名称。';
  const normalizedName = name.toLocaleLowerCase();
  if ((options.existingNames ?? []).some((item) => item.trim().toLocaleLowerCase() === normalizedName)) {
    return '接口名称不能重复。';
  }
  if (!draft.embeddingModel.trim()) return '请输入 Embedding 模型。';
  if (!isValidBaseUrl(normalizeBaseUrl(draft.baseUrl))) {
    return '请输入有效的 HTTPS Base URL（本机地址可使用 HTTP）。';
  }
  if (draft.credentialMode === 'environment') {
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(draft.environmentVariableName.trim())) {
      return '环境变量名格式无效。';
    }
  } else if ((options.mode ?? 'create') === 'create' && !draft.apiKey.trim()) {
    return '请输入 API Key。';
  }
  return null;
}

export function buildCreateRagEmbeddingInterfaceRequest(
  draft: RagEmbeddingInterfaceDraft
): CreateRagEmbeddingInterfaceRequest {
  const request: CreateRagEmbeddingInterfaceRequest = {
    name: draft.name.trim(),
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    embeddingModel: draft.embeddingModel.trim(),
    credentialMode: draft.credentialMode
  };
  if (draft.credentialMode === 'environment') {
    request.environmentVariableName = draft.environmentVariableName.trim();
  } else if (draft.apiKey) {
    request.apiKey = draft.apiKey;
  }
  return request;
}

export function buildUpdateRagEmbeddingInterfaceRequest(
  draft: RagEmbeddingInterfaceDraft & { id: string }
): UpdateRagEmbeddingInterfaceRequest {
  return { id: draft.id, ...buildCreateRagEmbeddingInterfaceRequest(draft) };
}

export function buildRagEmbeddingConnectionTestRequest(
  draft: RagEmbeddingInterfaceDraft,
  interfaceId: string | null
): RagEmbeddingConnectionTestRequest {
  const { name: _name, ...request } = buildCreateRagEmbeddingInterfaceRequest(draft);
  return {
    ...request,
    ...(interfaceId ? { interfaceId } : {})
  };
}

export function isRagEmbeddingDraftDirty(
  draft: RagEmbeddingInterfaceDraft,
  initialDraft: RagEmbeddingInterfaceDraft
): boolean {
  return draft.name.trim() !== initialDraft.name.trim()
    || normalizeBaseUrl(draft.baseUrl) !== normalizeBaseUrl(initialDraft.baseUrl)
    || draft.embeddingModel.trim() !== initialDraft.embeddingModel.trim()
    || draft.credentialMode !== initialDraft.credentialMode
    || draft.environmentVariableName.trim() !== initialDraft.environmentVariableName.trim()
    || draft.apiKey !== initialDraft.apiKey;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

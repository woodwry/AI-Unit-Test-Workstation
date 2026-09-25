import type {
  CreateModelInterfaceRequest,
  JsonValue,
  ModelInterfaceConnectionTestResult,
  ModelInterfaceDraft,
  ModelInterfaceView,
  ModelRequestParameterDraft,
  ModelRequestParameters,
  UpdateModelInterfaceRequest
} from '../../shared/types';
import {
  isProtectedModelRequestParameterName,
  isValidModelRequestParameterName,
  MAX_MODEL_REQUEST_PARAMETER_COUNT,
  MAX_MODEL_REQUEST_PARAMETERS_BYTES,
  measureModelRequestParametersBytes,
  validateModelRequestParameters
} from '../../shared/model-request-parameters.ts';

const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeInterfaceNameForComparison(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function validateModelInterfaceDraft(
  draft: ModelInterfaceDraft,
  options: { existingNames?: string[]; mode?: 'create' | 'update' } = {}
): string | null {
  const name = draft.name.trim();
  if (!name) return '请输入接口名称。';
  const duplicate = (options.existingNames ?? []).some(
    (item) => normalizeInterfaceNameForComparison(item) === normalizeInterfaceNameForComparison(name)
  );
  if (duplicate) return '接口名称不能重复。';
  if (!draft.model.trim()) return '请输入模型名。';
  const baseUrl = normalizeBaseUrl(draft.baseUrl);
  if (!isValidBaseUrl(baseUrl)) return '请输入有效的 HTTPS Base URL（本机地址可使用 HTTP）。';
  if (draft.credentialMode === 'environment') {
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(draft.environmentVariableName.trim())) {
      return '环境变量名格式无效。';
    }
  } else if ((options.mode ?? 'create') === 'create' && !draft.apiKey.trim()) {
    return '请输入 API Key。';
  }
  const requestParameterValidation = validateModelRequestParameterDrafts(draft.requestParameters);
  if (requestParameterValidation.message) return requestParameterValidation.message;
  return null;
}

export function buildCreateModelInterfaceRequest(
  draft: ModelInterfaceDraft
): CreateModelInterfaceRequest {
  const request: CreateModelInterfaceRequest = {
    name: draft.name.trim(),
    baseUrl: normalizeBaseUrl(draft.baseUrl),
    model: draft.model.trim(),
    credentialMode: draft.credentialMode
  };
  if (draft.credentialMode === 'environment') {
    request.environmentVariableName = draft.environmentVariableName.trim();
  } else {
    request.apiKey = draft.apiKey;
  }
  const requestParameterValidation = validateModelRequestParameterDrafts(draft.requestParameters);
  if (requestParameterValidation.message) {
    throw new TypeError(requestParameterValidation.message);
  }
  if (requestParameterValidation.requestParameters) {
    request.requestParameters = requestParameterValidation.requestParameters;
  }
  return request;
}

export function buildModelInterfaceDraft(item: ModelInterfaceView): ModelInterfaceDraft {
  return {
    id: item.id,
    name: item.name,
    baseUrl: item.baseUrl,
    model: item.model,
    credentialMode: item.credentialMode,
    environmentVariableName: item.environmentVariableName ?? '',
    apiKey: '',
    requestParameters: Object.entries(item.requestParameters ?? {}).map(([name, value]) => ({
      name,
      value: JSON.stringify(value)
    }))
  };
}

export function buildUpdateModelInterfaceRequest(
  draft: ModelInterfaceDraft & { id: string }
): UpdateModelInterfaceRequest {
  return { id: draft.id, ...buildCreateModelInterfaceRequest(draft) };
}

export function isModelInterfaceDraftDirty(
  draft: ModelInterfaceDraft,
  initial: ModelInterfaceDraft
): boolean {
  return [
    draft.name.trim(),
    normalizeBaseUrl(draft.baseUrl),
    draft.model.trim(),
    draft.credentialMode,
    draft.environmentVariableName.trim(),
    draft.apiKey,
    normalizeRequestParameterDraftsForComparison(draft.requestParameters)
  ].some((value, index) => {
    const initialValue = [
      initial.name.trim(),
      normalizeBaseUrl(initial.baseUrl),
      initial.model.trim(),
      initial.credentialMode,
      initial.environmentVariableName.trim(),
      initial.apiKey,
      normalizeRequestParameterDraftsForComparison(initial.requestParameters)
    ][index];
    return value !== initialValue;
  });
}

export type ModelRequestParameterRowError = {
  name?: string;
  value?: string;
};

export type ModelRequestParameterDraftValidation = {
  errors: ModelRequestParameterRowError[];
  message: string | null;
  requestParameters?: ModelRequestParameters;
};

export function validateModelRequestParameterDrafts(
  rows: readonly ModelRequestParameterDraft[] = []
): ModelRequestParameterDraftValidation {
  if (rows.length > MAX_MODEL_REQUEST_PARAMETER_COUNT) {
    return {
      errors: rows.map(() => ({})),
      message: '高级请求参数最多配置 32 项。'
    };
  }

  const errors: ModelRequestParameterRowError[] = rows.map(() => ({}));
  const names = new Set<string>();
  const requestParameters: ModelRequestParameters = {};
  for (const [index, row] of rows.entries()) {
    const name = row.name.trim();
    const comparisonName = name.toLocaleLowerCase();
    if (!isValidModelRequestParameterName(name)) {
      errors[index].name = '请输入有效参数名。';
    } else if (isProtectedModelRequestParameterName(name)) {
      errors[index].name = '该字段由系统管理，不能覆盖。';
    } else if (names.has(comparisonName)) {
      errors[index].name = '参数名不能重复。';
    } else {
      names.add(comparisonName);
    }

    const rawValue = row.value.trim();
    if (!rawValue) {
      errors[index].value = '请输入参数值。';
      continue;
    }
    try {
      const parsed = JSON.parse(rawValue) as JsonValue;
      if (!errors[index].name) requestParameters[name] = parsed;
    } catch {
      errors[index].value = '参数值不是有效 JSON。';
    }
  }

  const firstError = errors.find((error) => error.name || error.value);
  if (firstError) {
    return {
      errors,
      message: firstError.name ?? firstError.value ?? '高级请求参数无效。'
    };
  }
  if (measureModelRequestParametersBytes(requestParameters) > MAX_MODEL_REQUEST_PARAMETERS_BYTES) {
    return {
      errors,
      message: '高级请求参数总大小不能超过 32 KiB。'
    };
  }
  try {
    const normalized = validateModelRequestParameters(requestParameters);
    return {
      errors,
      message: null,
      ...(Object.keys(normalized).length > 0 ? { requestParameters: normalized } : {})
    };
  } catch {
    return { errors, message: '高级请求参数无效。' };
  }
}

function normalizeRequestParameterDraftsForComparison(
  rows: readonly ModelRequestParameterDraft[] = []
): string {
  return JSON.stringify(rows.map((row) => ({
    name: row.name.trim(),
    value: row.value.trim()
  })));
}

export type ModelInterfaceBackAction = 'confirm-discard' | 'return-to-list';

export function resolveModelInterfaceBackAction(isDirty: boolean): ModelInterfaceBackAction {
  return isDirty ? 'confirm-discard' : 'return-to-list';
}

export type ModelInterfaceSaveMode = 'create' | 'update';

export function resolveModelInterfaceSaveMode(editingId: string | null): ModelInterfaceSaveMode {
  return editingId && editingId !== 'new' ? 'update' : 'create';
}

export type ModelInterfaceEditorState = {
  draft: ModelInterfaceDraft;
  feedback: string;
  connectionResult: ModelInterfaceConnectionTestResult | null;
};

export type ModelInterfaceEditorAction =
  | { type: 'draft-changed' | 'draft-replaced'; draft: ModelInterfaceDraft }
  | { type: 'feedback-shown'; feedback: string }
  | { type: 'connection-result-shown'; connectionResult: ModelInterfaceConnectionTestResult }
  | { type: 'messages-cleared' | 'save-succeeded' };

export function reduceModelInterfaceEditorState(
  state: ModelInterfaceEditorState,
  action: ModelInterfaceEditorAction
): ModelInterfaceEditorState {
  switch (action.type) {
    case 'draft-changed':
    case 'draft-replaced':
      return { draft: action.draft, feedback: '', connectionResult: null };
    case 'feedback-shown':
      return { ...state, feedback: action.feedback, connectionResult: null };
    case 'connection-result-shown':
      return { ...state, feedback: '', connectionResult: action.connectionResult };
    case 'messages-cleared':
    case 'save-succeeded':
      return { ...state, feedback: '', connectionResult: null };
  }
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

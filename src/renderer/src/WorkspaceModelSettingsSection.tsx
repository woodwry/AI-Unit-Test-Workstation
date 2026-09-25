import { AlertTriangle, ArrowLeft, Check, ChevronDown, Copy, Info, Pencil, Plus, Save, Search, Trash2, Wifi } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import type {
  CreateModelInterfaceRequest,
  ModelInterfaceConnectionTestResult,
  ModelInterfaceDraft,
  ModelInterfaceView,
  UpdateModelInterfaceRequest,
  WorkstationModelInterfacesView
} from '../../shared/types';
import { copyModelInterfaceEnvironmentVariable } from './model-settings-clipboard';
import { ModelInterfaceDeleteDialog } from './ModelInterfaceDeleteDialog';
import {
  buildCreateModelInterfaceRequest,
  buildModelInterfaceDraft,
  buildUpdateModelInterfaceRequest,
  isModelInterfaceDraftDirty,
  reduceModelInterfaceEditorState,
  resolveModelInterfaceBackAction,
  resolveModelInterfaceSaveMode,
  validateModelRequestParameterDrafts,
  validateModelInterfaceDraft
} from './model-interface-form-state';
import { filterModelInterfaces } from './model-interface-search';

type Props = {
  isOpen?: boolean;
  isBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  [key: string]: unknown;
};

const EMPTY_DRAFT: ModelInterfaceDraft = {
  name: '', baseUrl: '', model: '', credentialMode: 'direct', environmentVariableName: '', apiKey: '',
  requestParameters: []
};

export function WorkspaceModelSettingsSection({
  isOpen = true,
  isBusy = false,
  onBusyChange
}: Props): JSX.Element {
  const [view, setView] = useState<WorkstationModelInterfacesView | null>(null);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [{ draft, feedback, connectionResult }, dispatchEditorState] = useReducer(
    reduceModelInterfaceEditorState,
    { draft: EMPTY_DRAFT, feedback: '', connectionResult: null }
  );
  const [initialDraft, setInitialDraft] = useState<ModelInterfaceDraft>(EMPTY_DRAFT);
  const [copied, setCopied] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ModelInterfaceView | null>(null);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [advancedParametersOpen, setAdvancedParametersOpen] = useState(true);
  const [showRequestParameterErrors, setShowRequestParameterErrors] = useState(false);
  const discardDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    void window.workstation.getWorkstationModelInterfaces().then((next) => {
      setView(next);
    }).catch(() => dispatchEditorState({ type: 'feedback-shown', feedback: '无法读取大模型接口。' }));
  }, [isOpen]);

  useEffect(() => {
    onBusyChange?.(operationBusy);
  }, [onBusyChange, operationBusy]);

  useEffect(() => {
    if (!isOpen) setPendingDelete(null);
  }, [isOpen]);

  useEffect(() => {
    const dialog = discardDialogRef.current;
    if (!dialog) return;
    if (discardConfirmationOpen && !dialog.open) {
      dialog.showModal();
    } else if (!discardConfirmationOpen && dialog.open) {
      dialog.close();
    }
  }, [discardConfirmationOpen]);

  const items = useMemo(() => filterModelInterfaces(view?.interfaces ?? [], query), [view?.interfaces, query]);
  const editing = editingId !== null;
  const saveMode = resolveModelInterfaceSaveMode(editingId);
  const disabled = isBusy || operationBusy;
  const requestParameterValidation = useMemo(
    () => validateModelRequestParameterDrafts(draft.requestParameters),
    [draft.requestParameters]
  );

  function startCreate(): void {
    setDiscardConfirmationOpen(false); setAdvancedParametersOpen(true); setShowRequestParameterErrors(false); setEditingId('new'); dispatchEditorState({ type: 'draft-replaced', draft: EMPTY_DRAFT }); setInitialDraft(EMPTY_DRAFT);
  }
  function startEdit(item: ModelInterfaceView): void {
    const next = buildModelInterfaceDraft(item);
    setDiscardConfirmationOpen(false); setAdvancedParametersOpen(true); setShowRequestParameterErrors(false); setEditingId(item.id); dispatchEditorState({ type: 'draft-replaced', draft: next }); setInitialDraft(next);
  }
  function finishBackToList(): void {
    setDiscardConfirmationOpen(false); setEditingId(null); dispatchEditorState({ type: 'messages-cleared' });
  }
  function backToList(): void {
    const action = resolveModelInterfaceBackAction(editing && isModelInterfaceDraftDirty(draft, initialDraft));
    if (action === 'confirm-discard') {
      setDiscardConfirmationOpen(true);
      return;
    }
    finishBackToList();
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setShowRequestParameterErrors(true);
    const existingNames = (view?.interfaces ?? []).filter((item) => item.id !== editingId).map((item) => item.name);
    const validation = validateModelInterfaceDraft(draft, { existingNames, mode: saveMode });
    if (validation) { dispatchEditorState({ type: 'feedback-shown', feedback: validation }); return; }
    dispatchEditorState({ type: 'messages-cleared' });
    setOperationBusy(true);
    try {
      const request = saveMode === 'update'
        ? buildUpdateModelInterfaceRequest(draft as ModelInterfaceDraft & { id: string })
        : buildCreateModelInterfaceRequest(draft);
      const next = saveMode === 'update'
        ? await window.workstation.updateModelInterface(request as UpdateModelInterfaceRequest)
        : await window.workstation.createModelInterface(request as CreateModelInterfaceRequest);
      setView(next); setEditingId(null); dispatchEditorState({ type: 'save-succeeded' });
    } catch (error) {
      dispatchEditorState({ type: 'feedback-shown', feedback: error instanceof Error ? error.message : '保存失败，请检查填写内容。' });
    } finally {
      setOperationBusy(false);
    }
  }

  async function select(id: string): Promise<void> {
    setOperationBusy(true);
    try {
      const next = await window.workstation.selectModelInterface({ id });
      setView(next);
    } catch { dispatchEditorState({ type: 'feedback-shown', feedback: '选择接口失败。' }); }
    finally { setOperationBusy(false); }
  }
  async function remove(): Promise<void> {
    if (!pendingDelete) return;
    setOperationBusy(true);
    try {
      const next = await window.workstation.deleteModelInterface({ id: pendingDelete.id });
      setView(next);
      setPendingDelete(null);
    } catch {
      setPendingDelete(null);
      dispatchEditorState({ type: 'feedback-shown', feedback: '删除接口失败。' });
    }
    finally { setOperationBusy(false); }
  }
  async function testConnection(): Promise<void> {
    setOperationBusy(true);
    dispatchEditorState({ type: 'messages-cleared' });
    try {
      const result = await window.workstation.testModelInterfaceConnection({
        ...(editingId && editingId !== 'new' ? { interfaceId: editingId } : {}),
        baseUrl: draft.baseUrl, model: draft.model, credentialMode: draft.credentialMode,
        ...(draft.environmentVariableName.trim() ? { environmentVariableName: draft.environmentVariableName.trim() } : {}),
        ...(draft.credentialMode === 'direct' && draft.apiKey ? { apiKey: draft.apiKey } : {})
      });
      dispatchEditorState({ type: 'connection-result-shown', connectionResult: result });
    } catch { dispatchEditorState({ type: 'connection-result-shown', connectionResult: { ok: false, code: 'network_error', message: '连接测试失败。' } }); }
    finally { setOperationBusy(false); }
  }
  async function copyEnvironmentVariable(): Promise<void> {
    try {
      await copyModelInterfaceEnvironmentVariable(draft.environmentVariableName, navigator.clipboard);
      setCopied(true); window.setTimeout(() => setCopied(false), 1400);
    } catch { dispatchEditorState({ type: 'feedback-shown', feedback: '复制环境变量名失败。' }); }
  }

  function addRequestParameter(): void {
    if (draft.requestParameters.length >= 32) {
      setShowRequestParameterErrors(true);
      dispatchEditorState({ type: 'feedback-shown', feedback: '高级请求参数最多配置 32 项。' });
      return;
    }
    setAdvancedParametersOpen(true);
    setShowRequestParameterErrors(false);
    dispatchEditorState({
      type: 'draft-changed',
      draft: {
        ...draft,
        requestParameters: [...draft.requestParameters, { name: '', value: '' }]
      }
    });
  }

  function updateRequestParameter(index: number, field: 'name' | 'value', value: string): void {
    setShowRequestParameterErrors(false);
    dispatchEditorState({
      type: 'draft-changed',
      draft: {
        ...draft,
        requestParameters: draft.requestParameters.map((item, itemIndex) => (
          itemIndex === index ? { ...item, [field]: value } : item
        ))
      }
    });
  }

  function removeRequestParameter(index: number): void {
    setShowRequestParameterErrors(false);
    dispatchEditorState({
      type: 'draft-changed',
      draft: {
        ...draft,
        requestParameters: draft.requestParameters.filter((_, itemIndex) => itemIndex !== index)
      }
    });
  }

  if (editing) {
    return (
      <form className="model-interface-editor" onSubmit={(event) => void save(event)}>
        <div className="model-interface-editor-heading">
          <button type="button" className="model-interface-back" onClick={backToList}><ArrowLeft size={15} /> 返回</button>
          <h3>{editingId === 'new' ? '新建大模型接口' : '编辑大模型接口'}</h3>
        </div>
        <label>接口名称<input value={draft.name} disabled={disabled} onChange={(e) => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, name: e.target.value } })} /></label>
        <label>Base URL<input value={draft.baseUrl} disabled={disabled} spellCheck={false} placeholder="https://api.example.com/v1" onChange={(e) => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, baseUrl: e.target.value } })} /></label>
        <label>模型名<input value={draft.model} disabled={disabled} spellCheck={false} onChange={(e) => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, model: e.target.value } })} /></label>
        <div className="model-interface-credential-mode" role="radiogroup" aria-label="凭证方式">
          <label className="model-interface-credential-option">
            <input type="radio" name="model-interface-credential-mode" checked={draft.credentialMode === 'direct'} disabled={disabled} onChange={() => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, credentialMode: 'direct' } })} />
            <span className="model-interface-credential-indicator" aria-hidden="true" />
            <span>直接输入 API Key</span>
          </label>
          <label className="model-interface-credential-option">
            <input type="radio" name="model-interface-credential-mode" checked={draft.credentialMode === 'environment'} disabled={disabled} onChange={() => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, credentialMode: 'environment' } })} />
            <span className="model-interface-credential-indicator" aria-hidden="true" />
            <span>使用环境变量</span>
          </label>
        </div>
        {draft.credentialMode === 'direct' ? (
          <label>API Key<input type="password" autoComplete="new-password" value={draft.apiKey} disabled={disabled} placeholder={editingId === 'new' ? '请输入 API Key' : '留空以保留已保存密钥'} onChange={(e) => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, apiKey: e.target.value } })} /></label>
        ) : (
          <label>环境变量名<div className="model-interface-env-input"><input value={draft.environmentVariableName} disabled={disabled} spellCheck={false} placeholder="MY_MODEL_API_KEY" onChange={(e) => dispatchEditorState({ type: 'draft-changed', draft: { ...draft, environmentVariableName: e.target.value } })} /><button type="button" onClick={() => void copyEnvironmentVariable()} disabled={disabled} aria-label="复制环境变量名">{copied ? <Check size={14} /> : <Copy size={14} />}</button></div></label>
        )}
        <section className="model-interface-advanced" aria-label="高级请求参数">
          <button
            type="button"
            className="model-interface-advanced-header"
            aria-expanded={advancedParametersOpen}
            onClick={() => setAdvancedParametersOpen((open) => !open)}
          >
            <span className="model-interface-advanced-title">高级请求参数 <small>可选</small></span>
            <ChevronDown className={advancedParametersOpen ? 'expanded' : ''} size={16} aria-hidden="true" />
          </button>
          {advancedParametersOpen && (
            <div className="model-interface-advanced-body">
              <div className="model-interface-advanced-copy">
                <p>参数会随当前接口写入模型请求；没有配置时使用平台默认值。</p>
                <button type="button" onClick={addRequestParameter} disabled={disabled} aria-label="添加参数"><Plus size={14} /> 添加参数</button>
              </div>
              {draft.requestParameters.length > 0 ? (
                <>
                  <div className="model-interface-parameter-heading" aria-hidden="true"><span>参数名</span><span>参数值（JSON）</span><span /></div>
                  <div className="model-interface-parameter-list">
                    {draft.requestParameters.map((parameter, index) => {
                      const error = showRequestParameterErrors ? requestParameterValidation.errors[index] : undefined;
                      return (
                        <div className={`model-interface-parameter-row${error?.name || error?.value ? ' invalid' : ''}`} key={index}>
                          <div className="model-interface-parameter-cell">
                            <input
                              value={parameter.name}
                              disabled={disabled}
                              spellCheck={false}
                              aria-label={`参数名 ${index + 1}`}
                              placeholder="请输入参数名"
                              onChange={(event) => updateRequestParameter(index, 'name', event.target.value)}
                            />
                            {error?.name && <small className="model-interface-parameter-error">{error.name}</small>}
                          </div>
                          <div className="model-interface-parameter-cell">
                            <input
                              value={parameter.value}
                              disabled={disabled}
                              spellCheck={false}
                              aria-label={`参数值 ${index + 1}`}
                              placeholder="请输入参数值"
                              onChange={(event) => updateRequestParameter(index, 'value', event.target.value)}
                            />
                            {error?.value && <small className="model-interface-parameter-error">{error.value}</small>}
                          </div>
                          <button type="button" className="model-interface-parameter-remove" onClick={() => removeRequestParameter(index)} disabled={disabled} aria-label="删除参数"><Trash2 size={14} /></button>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="model-interface-parameter-empty">暂未配置请求参数，模型将使用平台默认值。</p>
              )}
              <div className="model-interface-parameter-guard">
                <Info size={13} aria-hidden="true" />
                <span><code>model</code>、<code>messages</code>、<code>stream</code>、<code>stream_options</code>、<code>tools</code>、<code>tool_choice</code>、凭证和 Base URL 由系统管理，不能在这里覆盖。</span>
              </div>
            </div>
          )}
        </section>
        <div className="model-interface-editor-footer">
          <div className="model-interface-editor-messages">
            {connectionResult && <p className={connectionResult.ok ? 'model-interface-result success' : 'model-interface-result error'} role="status">{connectionResult.message}</p>}
            {feedback && <p className="model-interface-feedback" role="alert">{feedback}</p>}
          </div>
          <div className="model-interface-editor-actions"><button type="button" onClick={() => void testConnection()} disabled={disabled}><Wifi size={14} /> 测试连接</button><button type="submit" disabled={disabled}><Save size={14} /> 保存</button></div>
        </div>
        <dialog
          ref={discardDialogRef}
          className="model-interface-discard-dialog"
          aria-labelledby="model-interface-discard-title"
          aria-describedby="model-interface-discard-description"
          onCancel={(event) => {
            event.preventDefault();
            setDiscardConfirmationOpen(false);
          }}
        >
          <div className="model-interface-discard-content">
            <span className="model-interface-discard-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
            <div>
              <h4 id="model-interface-discard-title">放弃未保存的修改？</h4>
              <p id="model-interface-discard-description">返回接口列表后，当前修改将丢失。</p>
            </div>
          </div>
          <div className="model-interface-discard-actions">
            <button type="button" className="model-interface-discard-danger" onClick={finishBackToList}>放弃修改</button>
            <button type="button" className="model-interface-discard-primary" autoFocus onClick={() => setDiscardConfirmationOpen(false)}>继续编辑</button>
          </div>
        </dialog>
      </form>
    );
  }

  return (
    <section className="model-interface-manager" aria-label="大模型接口管理">
      <div className="model-interface-manager-heading"><div><h3>大模型接口</h3></div><button type="button" onClick={startCreate} disabled={disabled}><Plus size={14} /> 新增</button></div>
      <div className="model-interface-search"><Search size={14} /><input value={query} placeholder="查询接口名称、模型、Base URL 或环境变量" onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="model-interface-list">
        {items.length === 0 && <p className="model-interface-empty">{query ? '没有匹配的接口。' : '还没有接口，点击“新增”开始配置。'}</p>}
        {items.map((item) => <div className={`model-interface-row${view?.activeInterfaceId === item.id ? ' active' : ''}`} key={item.id}>
          <label className="model-interface-row-select">
            <input type="radio" name="active-model-interface" checked={view?.activeInterfaceId === item.id} disabled={disabled} onChange={() => void select(item.id)} aria-label={`选择 ${item.name}`} />
            <div className="model-interface-row-main"><strong>{item.name}</strong><span>{item.model}</span><small>{item.baseUrl}</small><em>{item.credentialMode === 'environment' ? `环境变量：${item.environmentVariableName}` : 'API Key'}</em></div>
          </label>
          <div className="model-interface-row-actions"><button type="button" onClick={() => startEdit(item)} aria-label={`编辑 ${item.name}`}><Pencil size={14} /></button><button type="button" onClick={() => setPendingDelete(item)} aria-label={`删除 ${item.name}`}><Trash2 size={14} /></button></div>
        </div>)}
      </div>
      {feedback && <p className="model-interface-feedback" role="status">{feedback}</p>}
      {pendingDelete && (
        <ModelInterfaceDeleteDialog
          interfaceId={pendingDelete.id}
          interfaceName={pendingDelete.name}
          busy={operationBusy}
          onCancel={() => setPendingDelete(null)}
          onDelete={() => void remove()}
        />
      )}
    </section>
  );
}

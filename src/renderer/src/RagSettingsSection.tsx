import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Wifi
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent
} from 'react';

import { copyModelInterfaceEnvironmentVariable } from './model-settings-clipboard';
import {
  buildCreateRagEmbeddingInterfaceRequest,
  buildRagEmbeddingConnectionTestRequest,
  buildUpdateRagEmbeddingInterfaceRequest,
  createInitialRagEmbeddingEditorState,
  filterRagEmbeddingInterfaces,
  isRagEmbeddingDraftDirty,
  reduceRagEmbeddingEditorState,
  validateRagEmbeddingInterfaceDraft,
  type CreateRagEmbeddingInterfaceRequest,
  type RagEmbeddingConnectionResult,
  type RagEmbeddingConnectionTestRequest,
  type RagEmbeddingInterfaceDraft,
  type RagEmbeddingInterfacesView,
  type UpdateRagEmbeddingInterfaceRequest
} from './rag-embedding-interface-state';

type RagSettingsSectionProps = {
  isOpen: boolean;
  onBusyChange?: (busy: boolean) => void;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type RagEmbeddingApi = {
  getRagEmbeddingInterfaces: () => Promise<RagEmbeddingInterfacesView>;
  createRagEmbeddingInterface: (
    request: CreateRagEmbeddingInterfaceRequest
  ) => Promise<RagEmbeddingInterfacesView>;
  updateRagEmbeddingInterface: (
    request: UpdateRagEmbeddingInterfaceRequest
  ) => Promise<RagEmbeddingInterfacesView>;
  selectRagEmbeddingInterface: (
    request: { id: string | null }
  ) => Promise<RagEmbeddingInterfacesView>;
  deleteRagEmbeddingInterface: (request: { id: string }) => Promise<RagEmbeddingInterfacesView>;
  testRagEmbeddingInterfaceConnection: (
    request: RagEmbeddingConnectionTestRequest
  ) => Promise<RagEmbeddingConnectionResult>;
};

export function RagSettingsSection({
  isOpen,
  onBusyChange
}: RagSettingsSectionProps): JSX.Element {
  const ragApi = window.workstation as typeof window.workstation & RagEmbeddingApi;
  const [interfacesView, setInterfacesView] = useState<RagEmbeddingInterfacesView | null>(null);
  const [query, setQuery] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [isBusy, setIsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const discardDialogRef = useRef<HTMLDialogElement>(null);
  const [editor, dispatchEditor] = useReducer(
    reduceRagEmbeddingEditorState,
    undefined,
    createInitialRagEmbeddingEditorState
  );

  useEffect(() => {
    onBusyChange?.(isBusy || loadState === 'loading');
    return () => onBusyChange?.(false);
  }, [isBusy, loadState, onBusyChange]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadState('loading');
    setSettingsMessage('');
    void ragApi.getRagEmbeddingInterfaces().then(
      (nextInterfacesView) => {
        if (cancelled) return;
        setInterfacesView(nextInterfacesView);
        setLoadState('ready');
      },
      () => {
        if (cancelled) return;
        setLoadState('error');
        setSettingsMessage('RAG 设置加载失败，请重新打开设置后重试。');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    const dialog = discardDialogRef.current;
    if (!dialog) return;
    if (discardConfirmationOpen && !dialog.open) dialog.showModal();
    if (!discardConfirmationOpen && dialog.open) dialog.close();
  }, [discardConfirmationOpen]);

  const items = useMemo(
    () => filterRagEmbeddingInterfaces(interfacesView?.interfaces ?? [], query),
    [interfacesView?.interfaces, query]
  );
  const controlsDisabled = isBusy;

  function changeDraft(patch: Partial<RagEmbeddingInterfaceDraft>): void {
    dispatchEditor({ type: 'draft-changed', draft: { ...editor.draft, ...patch } });
  }

  function returnToList(): void {
    setDiscardConfirmationOpen(false);
    dispatchEditor({ type: 'list-returned' });
  }

  function requestReturnToList(): void {
    if (isRagEmbeddingDraftDirty(editor.draft, editor.initialDraft)) {
      setDiscardConfirmationOpen(true);
      return;
    }
    returnToList();
  }

  async function saveEmbeddingInterface(event: FormEvent): Promise<void> {
    event.preventDefault();
    const existingNames = (interfacesView?.interfaces ?? [])
      .filter((item) => item.id !== editor.editingId)
      .map((item) => item.name);
    const validation = validateRagEmbeddingInterfaceDraft(editor.draft, {
      existingNames,
      mode: editor.mode === 'edit' ? 'update' : 'create'
    });
    if (validation) {
      dispatchEditor({ type: 'feedback-shown', feedback: validation });
      return;
    }

    setIsBusy(true);
    try {
      const next = editor.mode === 'edit'
        ? await ragApi.updateRagEmbeddingInterface(
            buildUpdateRagEmbeddingInterfaceRequest(
              editor.draft as RagEmbeddingInterfaceDraft & { id: string }
            )
          )
        : await ragApi.createRagEmbeddingInterface(
            buildCreateRagEmbeddingInterfaceRequest(editor.draft)
          );
      setInterfacesView(next);
      dispatchEditor({ type: 'save-succeeded' });
    } catch (error) {
      dispatchEditor({
        type: 'feedback-shown',
        feedback: `保存失败：${boundedErrorMessage(error)}`
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function selectEmbeddingInterface(id: string): Promise<void> {
    setIsBusy(true);
    try {
      setInterfacesView(await ragApi.selectRagEmbeddingInterface({ id }));
    } catch (error) {
      dispatchEditor({
        type: 'feedback-shown',
        feedback: `选择接口失败：${boundedErrorMessage(error)}`
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteEmbeddingInterface(id: string): Promise<void> {
    setIsBusy(true);
    try {
      setInterfacesView(await ragApi.deleteRagEmbeddingInterface({ id }));
    } catch (error) {
      dispatchEditor({
        type: 'feedback-shown',
        feedback: `删除接口失败：${boundedErrorMessage(error)}`
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function testEmbeddingConnection(): Promise<void> {
    const validation = validateRagEmbeddingInterfaceDraft(editor.draft, {
      existingNames: [],
      mode: editor.mode === 'edit' ? 'update' : 'create'
    });
    if (validation) {
      dispatchEditor({ type: 'feedback-shown', feedback: validation });
      return;
    }

    setIsBusy(true);
    try {
      const result = await ragApi.testRagEmbeddingInterfaceConnection(
        buildRagEmbeddingConnectionTestRequest(editor.draft, editor.editingId)
      );
      dispatchEditor({ type: 'connection-result-shown', result });
    } catch (error) {
      dispatchEditor({
        type: 'connection-result-shown',
        result: {
          ok: false,
          code: 'network_error',
          message: `连接测试失败：${boundedErrorMessage(error)}`
        }
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function copyEnvironmentVariable(): Promise<void> {
    try {
      await copyModelInterfaceEnvironmentVariable(
        editor.draft.environmentVariableName,
        navigator.clipboard
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      dispatchEditor({ type: 'feedback-shown', feedback: '复制环境变量名失败。' });
    }
  }

  if (loadState === 'loading' || loadState === 'idle') {
    return <div className="model-settings-load-state" role="status">正在加载 RAG 设置…</div>;
  }
  if (loadState === 'error') {
    return (
      <div className="model-settings-load-state" role="alert">
        <strong>RAG 设置加载失败</strong>
        <span>{settingsMessage}</span>
      </div>
    );
  }

  return (
    <section className="rag-settings-card" aria-label="RAG 设置">
      {editor.mode === 'list' ? (
        <section
          className="model-interface-manager rag-embedding-interface-manager"
          aria-label="Embedding 接口管理"
        >
          <div className="model-interface-manager-heading">
            <div><h3>Embedding 接口</h3></div>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => dispatchEditor({ type: 'create-started' })}
            >
              <Plus size={14} /> 新增
            </button>
          </div>
          <div className="model-interface-search">
            <Search size={14} />
            <input
              value={query}
              disabled={controlsDisabled}
              placeholder="查询名称、Embedding 模型、Base URL 或环境变量"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="model-interface-list">
            {items.length === 0 && (
              <p className="model-interface-empty">
                {query ? '没有匹配的接口。' : '还没有接口，点击“新增”开始配置。'}
              </p>
            )}
            {items.map((item) => (
              <div
                className={`model-interface-row${
                  interfacesView?.activeInterfaceId === item.id ? ' active' : ''
                }`}
                key={item.id}
              >
                <label className="model-interface-row-select">
                  <input
                    type="radio"
                    name="active-rag-embedding-interface"
                    checked={interfacesView?.activeInterfaceId === item.id}
                    disabled={controlsDisabled}
                    aria-label={`选择 ${item.name}`}
                    onChange={() => void selectEmbeddingInterface(item.id)}
                  />
                  <div className="model-interface-row-main">
                    <strong>{item.name}</strong>
                    <span>{item.embeddingModel}</span>
                    <small>{item.baseUrl}</small>
                    <em>
                      {item.credentialMode === 'environment'
                        ? `环境变量：${item.environmentVariableName}`
                        : 'API Key'}
                    </em>
                  </div>
                </label>
                <div className="model-interface-row-actions">
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    aria-label={`编辑 ${item.name}`}
                    onClick={() => dispatchEditor({ type: 'edit-started', item })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    aria-label={`删除 ${item.name}`}
                    onClick={() => void deleteEmbeddingInterface(item.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {editor.feedback && (
            <p className="model-interface-feedback" role="alert">{editor.feedback}</p>
          )}
          {interfacesView && !interfacesView.secureStorageAvailable && (
            <p className="model-interface-feedback" role="status">
              当前系统安全存储不可用，建议使用环境变量保存凭证。
            </p>
          )}
        </section>
      ) : (
        <form
          className="model-interface-editor rag-embedding-interface-editor"
          onSubmit={(event) => void saveEmbeddingInterface(event)}
        >
          <div className="model-interface-editor-heading">
            <button
              type="button"
              className="model-interface-back"
              disabled={controlsDisabled}
              onClick={requestReturnToList}
            >
              <ArrowLeft size={15} /> 返回
            </button>
            <h3>{editor.mode === 'create' ? '新增 Embedding 接口' : '编辑 Embedding 接口'}</h3>
          </div>
          <label>
            名称
            <input
              value={editor.draft.name}
              disabled={controlsDisabled}
              onChange={(event) => changeDraft({ name: event.target.value })}
            />
          </label>
          <label>
            Base URL
            <input
              value={editor.draft.baseUrl}
              disabled={controlsDisabled}
              spellCheck={false}
              placeholder="https://api.example.com/v1"
              onChange={(event) => changeDraft({ baseUrl: event.target.value })}
            />
          </label>
          <label>
            Embedding 模型
            <input
              value={editor.draft.embeddingModel}
              disabled={controlsDisabled}
              spellCheck={false}
              placeholder="请输入模型名"
              onChange={(event) => changeDraft({ embeddingModel: event.target.value })}
            />
          </label>
          <div className="model-interface-credential-mode" role="radiogroup" aria-label="凭证方式">
            <label className="model-interface-credential-option">
              <input
                type="radio"
                name="rag-embedding-credential-mode"
                checked={editor.draft.credentialMode === 'direct'}
                disabled={controlsDisabled}
                onChange={() => changeDraft({ credentialMode: 'direct' })}
              />
              <span className="model-interface-credential-indicator" aria-hidden="true" />
              <span>直接输入 API Key</span>
            </label>
            <label className="model-interface-credential-option">
              <input
                type="radio"
                name="rag-embedding-credential-mode"
                checked={editor.draft.credentialMode === 'environment'}
                disabled={controlsDisabled}
                onChange={() => changeDraft({ credentialMode: 'environment' })}
              />
              <span className="model-interface-credential-indicator" aria-hidden="true" />
              <span>使用环境变量</span>
            </label>
          </div>
          {editor.draft.credentialMode === 'direct' ? (
            <label>
              API Key
              <input
                type="password"
                autoComplete="new-password"
                value={editor.draft.apiKey}
                disabled={controlsDisabled}
                placeholder={editor.mode === 'create' ? '请输入 API Key' : '留空以保留已保存密钥'}
                onChange={(event) => changeDraft({ apiKey: event.target.value })}
              />
            </label>
          ) : (
            <label>
              环境变量名
              <div className="model-interface-env-input">
                <input
                  value={editor.draft.environmentVariableName}
                  disabled={controlsDisabled}
                  spellCheck={false}
                  placeholder="请输入自定义环境变量名"
                  onChange={(event) => changeDraft({ environmentVariableName: event.target.value })}
                />
                <button
                  type="button"
                  disabled={controlsDisabled}
                  aria-label="复制环境变量名"
                  onClick={() => void copyEnvironmentVariable()}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </label>
          )}
          <div className="model-interface-editor-footer">
            <div className="model-interface-editor-messages">
              {editor.connectionResult && (
                <p
                  className={`model-interface-result ${editor.connectionResult.ok ? 'success' : 'error'}`}
                  role="status"
                >
                  {editor.connectionResult.message}
                </p>
              )}
              {editor.feedback && (
                <p className="model-interface-feedback" role="alert">{editor.feedback}</p>
              )}
            </div>
            <div className="model-interface-editor-actions">
              <button
                type="button"
                disabled={controlsDisabled}
                onClick={() => void testEmbeddingConnection()}
              >
                <Wifi size={14} /> 测试连接
              </button>
              <button type="submit" disabled={controlsDisabled}>
                <Save size={14} /> 保存
              </button>
            </div>
          </div>
          <dialog
            ref={discardDialogRef}
            className="model-interface-discard-dialog"
            aria-labelledby="rag-embedding-discard-title"
            aria-describedby="rag-embedding-discard-description"
            onCancel={(event) => {
              event.preventDefault();
              setDiscardConfirmationOpen(false);
            }}
          >
            <div className="model-interface-discard-content">
              <span className="model-interface-discard-icon" aria-hidden="true">
                <AlertTriangle size={16} />
              </span>
              <div>
                <h4 id="rag-embedding-discard-title">放弃未保存的修改？</h4>
                <p id="rag-embedding-discard-description">
                  返回接口列表后，当前修改将丢失。
                </p>
              </div>
            </div>
            <div className="model-interface-discard-actions">
              <button
                type="button"
                className="model-interface-discard-danger"
                onClick={returnToList}
              >
                放弃修改
              </button>
              <button
                type="button"
                className="model-interface-discard-primary"
                autoFocus
                onClick={() => setDiscardConfirmationOpen(false)}
              >
                继续编辑
              </button>
            </div>
          </dialog>
        </form>
      )}
    </section>
  );
}

function boundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

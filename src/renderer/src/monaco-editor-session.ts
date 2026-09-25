import type * as Monaco from 'monaco-editor';
import { runMonacoStage } from './monaco-initialization-diagnostics.ts';

export type MonacoEditor = Monaco.editor.IStandaloneCodeEditor;
export type MonacoModel = Monaco.editor.ITextModel;
export type MonacoEditorViewState = Monaco.editor.ICodeEditorViewState;
export type MonacoDecoration = Parameters<MonacoEditor['deltaDecorations']>[1][number];
export type MonacoStandaloneThemeData = Monaco.editor.IStandaloneThemeData;
export type MonacoEditorOptions = Omit<
  Monaco.editor.IStandaloneEditorConstructionOptions,
  'model' | 'value' | 'language' | 'theme'
>;

export type MonacoEditorFacade = {
  Uri: Pick<typeof Monaco.Uri, 'file' | 'parse'>;
  Range: typeof Monaco.Range;
  MarkerSeverity: typeof Monaco.MarkerSeverity;
  editor: Pick<
    typeof Monaco.editor,
    | 'create'
    | 'createModel'
    | 'getModel'
    | 'getModels'
    | 'setModelLanguage'
    | 'setTheme'
    | 'setModelMarkers'
  >;
};

export type MonacoApi = MonacoEditorFacade;

export type MonacoSessionDocument = Readonly<{
  path: string;
  value: string;
  language: string;
}>;

export type MonacoSessionChange = Readonly<{
  path: string;
  uri: string;
  value: string;
  versionId: number;
  epoch: number;
}>;

export type MonacoSessionModelBinding = Readonly<{
  path: string;
  uri: string;
  key: string;
  model: MonacoModel;
  epoch: number;
  ownership: 'owned' | 'borrowed';
}>;

export type MonacoSessionModelEvent =
  | Readonly<{
      kind: 'activate';
      previous: MonacoSessionModelBinding | null;
      current: MonacoSessionModelBinding | null;
    }>
  | Readonly<{ kind: 'release'; model: MonacoSessionModelBinding }>;

export type MonacoEditorDesiredState = Readonly<{
  activeDocument: MonacoSessionDocument | null;
  openFilePaths: readonly string[];
  options: MonacoEditorOptions;
  theme: string;
  onError(error: unknown): void;
  onDidChangeContent(change: MonacoSessionChange): void;
  onDidAttach?(editor: MonacoEditor, monaco: MonacoEditorFacade): void;
  onDidDetach?(editor: MonacoEditor, monaco: MonacoEditorFacade): void;
  onWillChangeModel?(previous: MonacoSessionModelBinding | null, nextPath: string | null): void;
  onDidChangeModel?(event: MonacoSessionModelEvent, monaco: MonacoEditorFacade): void;
}>;

type ModelRecord = {
  key: string;
  uri: Monaco.Uri;
  model: MonacoModel;
  owned: boolean;
  disposeAttempted: boolean;
  lastPath: string;
  lastEpoch: number;
  modelDisposeListener: Monaco.IDisposable;
};

type ActiveBinding = MonacoSessionModelBinding & {
  listener: Monaco.IDisposable;
};

type ModelAcquisition = {
  record: ModelRecord;
  isNewRecord: boolean;
};

type DetachActiveResult = {
  previous: MonacoSessionModelBinding | null;
  error: unknown | null;
};

function captureCleanupError(errors: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

function throwFirstCleanupError(errors: readonly unknown[]): void {
  if (errors.length > 0) throw errors[0];
}

export class MonacoEditorSession {
  private desiredState: MonacoEditorDesiredState | null = null;
  private monaco: MonacoEditorFacade | null = null;
  private editor: MonacoEditor | null = null;
  private activeBinding: ActiveBinding | null = null;
  private readonly modelsByCanonicalUri = new Map<string, ModelRecord>();
  private readonly viewStatesByCanonicalUri = new Map<string, MonacoEditorViewState | null>();
  private nextEpoch = 1;
  private suppressionDepth = 0;
  private modelDisposeTransactionDepth = 0;
  private lifecycleGeneration = 0;
  private nextDesiredApplicationToken = 1;
  private scheduledDesiredApplicationToken: number | null = null;
  private disposed = false;

  updateDesiredState(state: MonacoEditorDesiredState): void {
    if (this.disposed) throw new Error('Cannot update a disposed Monaco editor session');
    this.desiredState = state;
    if (
      this.modelDisposeTransactionDepth > 0 ||
      this.scheduledDesiredApplicationToken !== null
    ) {
      this.scheduleDesiredStateApplication();
      return;
    }
    this.applyDesiredState();
  }

  attachEditor(monaco: MonacoEditorFacade, host: HTMLElement): MonacoEditor {
    if (this.disposed) throw new Error('Cannot attach a disposed Monaco editor session');
    if (this.editor !== null) throw new Error('A Monaco editor is already attached to this session');
    if (this.desiredState === null) {
      throw new Error('Monaco editor desired state must be provided before attach');
    }

    const editor = runMonacoStage('editor-create', () => monaco.editor.create(host, {
      model: null,
      automaticLayout: true,
      ...this.desiredState!.options
    }));
    this.monaco = monaco;
    this.editor = editor;
    this.invalidateScheduledDesiredApplication();

    try {
      runMonacoStage('attach-callback', () => this.desiredState!.onDidAttach?.(editor, monaco));
      runMonacoStage('reconcile', () => this.reconcile());
      return editor;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      this.cleanupAttachedEditor(cleanupErrors, true);
      // acquisition 的原始错误优先；cleanup ledger 已保证其余资源继续回滚。
      throw error;
    }
  }

  detachEditor(): void {
    if (this.editor === null) return;
    this.invalidateScheduledDesiredApplication();
    const cleanupErrors: unknown[] = [];
    this.cleanupAttachedEditor(cleanupErrors, true);
    throwFirstCleanupError(cleanupErrors);
  }

  getModelByCanonicalKey(key: string): MonacoModel | null {
    const record = this.modelsByCanonicalUri.get(key);
    return record !== undefined && !record.model.isDisposed() ? record.model : null;
  }

  getCanonicalKeyForDocumentUri(uri: string): string | null {
    if (this.monaco === null) return null;
    try {
      return this.canonicalKeyFromUri(this.monaco.Uri.parse(uri));
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateScheduledDesiredApplication();
    const cleanupErrors: unknown[] = [];
    this.cleanupAttachedEditor(cleanupErrors, true);
    for (const record of [...this.modelsByCanonicalUri.values()]) {
      this.releaseModelRecord(record, cleanupErrors);
    }
    this.viewStatesByCanonicalUri.clear();
    throwFirstCleanupError(cleanupErrors);
  }

  private reconcile(): void {
    const desiredState = this.desiredState;
    const editor = this.editor;
    const monaco = this.monaco;
    if (desiredState === null || editor === null || monaco === null) return;

    editor.updateOptions(desiredState.options);
    monaco.editor.setTheme(desiredState.theme);

    const document = desiredState.activeDocument;
    if (document === null) {
      const detached = this.detachActiveModel(null);
      if (detached.error !== null) throw detached.error;
      if (detached.previous !== null) {
        desiredState.onDidChangeModel?.(
          { kind: 'activate', previous: detached.previous, current: null },
          monaco
        );
      }
      this.sweepClosedModels(this.getRetainedKeys(desiredState));
      return;
    }

    if (this.activeBinding?.path === document.path) {
      const key = this.activeBinding.key;
      monaco.editor.setModelLanguage(this.activeBinding.model, document.language);
      this.synchronizeModelContent(this.activeBinding.model, document.value);
      this.sweepClosedModels(this.getRetainedKeys(desiredState, key));
      return;
    }

    // 原子切换先让旧 listener/epoch 失效并解除 editor；之后任一点失败都保持 editor=null。
    const detached = this.detachActiveModel(document.path);
    if (detached.error !== null) throw detached.error;

    let acquisition: ModelAcquisition | null = null;
    let binding: ActiveBinding | null = null;
    let activationExposed = false;
    let activeKey: string | null = null;
    try {
      const uri = monaco.Uri.file(document.path);
      const key = this.canonicalKeyFromUri(uri);
      activeKey = key;
      acquisition = this.acquireModelRecord(document, uri, key);
      const record = acquisition.record;
      const epoch = this.nextEpoch++;

      editor.setModel(record.model);
      monaco.editor.setModelLanguage(record.model, document.language);
      this.synchronizeModelContent(record.model, document.value);
      editor.restoreViewState(this.viewStatesByCanonicalUri.get(key) ?? null);

      binding = this.createActiveBinding(record, document.path, epoch);
      record.lastPath = document.path;
      record.lastEpoch = epoch;
      if (acquisition.isNewRecord) this.modelsByCanonicalUri.set(key, record);
      this.activeBinding = binding;
      if (desiredState.onDidChangeModel !== undefined) {
        activationExposed = true;
        desiredState.onDidChangeModel(
          { kind: 'activate', previous: detached.previous, current: this.toPublicBinding(binding) },
          monaco
        );
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (binding !== null && this.activeBinding === binding) this.activeBinding = null;
      if (binding !== null) captureCleanupError(rollbackErrors, () => binding?.listener.dispose());
      this.clearEditorModel(editor, rollbackErrors);
      if (acquisition?.isNewRecord) {
        this.rollbackNewAcquisition(acquisition.record, activationExposed, rollbackErrors);
      }
      // 同步错误交给调用 update/attach 的 App 安全边界；rollback 错误不得遮蔽根因。
      throw error;
    }

    this.sweepClosedModels(this.getRetainedKeys(desiredState, activeKey ?? undefined));
  }

  private detachActiveModel(nextPath: string | null): DetachActiveResult {
    const activeBinding = this.activeBinding;
    const editor = this.editor;
    if (activeBinding === null || editor === null) return { previous: null, error: null };

    const previous = this.toPublicBinding(activeBinding);
    const cleanupErrors: unknown[] = [];
    // 先使 active epoch 失效；即便 dispose 后仍迟到触发，旧 listener 也无法冒充新文档。
    this.activeBinding = null;
    captureCleanupError(cleanupErrors, () => activeBinding.listener.dispose());
    captureCleanupError(cleanupErrors, () => {
      this.viewStatesByCanonicalUri.set(activeBinding.key, editor.saveViewState());
    });
    captureCleanupError(cleanupErrors, () => {
      this.desiredState?.onWillChangeModel?.(previous, nextPath);
    });
    this.clearEditorModel(editor, cleanupErrors);
    return { previous, error: cleanupErrors[0] ?? null };
  }

  private acquireModelRecord(
    document: MonacoSessionDocument,
    uri: Monaco.Uri,
    key: string
  ): ModelAcquisition {
    const monaco = this.monaco;
    if (monaco === null) throw new Error('Cannot acquire a Monaco model without a facade');

    const retained = this.modelsByCanonicalUri.get(key);
    if (retained !== undefined && !retained.model.isDisposed()) {
      return { record: retained, isNewRecord: false };
    }
    if (retained !== undefined) this.modelsByCanonicalUri.delete(key);

    // 查找顺序是契约的一部分：session map → exact getModel → canonical scan → createModel。
    const exactCandidate = monaco.editor.getModel(uri);
    const exact = exactCandidate !== null && !exactCandidate.isDisposed() ? exactCandidate : null;
    const scanned = exact === null
      ? monaco.editor.getModels().find((model) => {
          if (model.isDisposed()) return false;
          try {
            return this.canonicalKeyFromUri(model.uri) === key;
          } catch {
            return false;
          }
        }) ?? null
      : null;
    const existing = exact ?? scanned;
    const model = existing ?? monaco.editor.createModel(document.value, document.language, uri);
    const owned = existing === null;
    let modelDisposeListener: Monaco.IDisposable;
    try {
      modelDisposeListener = model.onWillDispose(() => {
        this.handleExternalModelDispose(key, model);
      });
    } catch (error) {
      if (owned && !model.isDisposed()) {
        try {
          model.dispose();
        } catch {
          // acquisition 根因优先；该 model 尚未进入 session ledger。
        }
      }
      throw error;
    }
    const record: ModelRecord = {
      key,
      uri: model.uri,
      model,
      owned,
      disposeAttempted: false,
      lastPath: document.path,
      lastEpoch: this.nextEpoch,
      modelDisposeListener
    };
    return { record, isNewRecord: true };
  }

  private createActiveBinding(record: ModelRecord, path: string, epoch: number): ActiveBinding {
    const capturedModel = record.model;
    const capturedPath = path;
    const capturedUri = record.uri.toString();
    const capturedEpoch = epoch;
    const listener = record.model.onDidChangeContent(() => {
      if (
        this.suppressionDepth !== 0 ||
        this.disposed ||
        this.activeBinding?.epoch !== capturedEpoch ||
        this.activeBinding.model !== capturedModel
      ) {
        return;
      }
      this.desiredState?.onDidChangeContent({
        path: capturedPath,
        uri: capturedUri,
        value: capturedModel.getValue(),
        versionId: capturedModel.getVersionId(),
        epoch: capturedEpoch
      });
    });
    return {
      path,
      uri: capturedUri,
      key: record.key,
      model: record.model,
      epoch,
      ownership: record.owned ? 'owned' : 'borrowed',
      listener
    };
  }

  private synchronizeModelContent(model: MonacoModel, desiredValue: string): void {
    const editor = this.editor;
    if (editor === null || model.getValue() === desiredValue) return;

    const viewState = editor.saveViewState();
    editor.pushUndoStop();
    this.suppressionDepth += 1;
    try {
      const applied = editor.executeEdits('workstation.external-sync', [
        {
          range: model.getFullModelRange(),
          text: desiredValue,
          forceMoveMarkers: true
        }
      ]);
      if (!applied) throw new Error('Monaco rejected external content synchronization');
    } finally {
      this.suppressionDepth -= 1;
      try {
        editor.pushUndoStop();
      } finally {
        editor.restoreViewState(viewState);
      }
    }
  }

  private getRetainedKeys(state: MonacoEditorDesiredState, activeKey?: string): Set<string> {
    const monaco = this.monaco;
    if (monaco === null) return new Set();
    const keys = new Set<string>();
    if (activeKey !== undefined) keys.add(activeKey);
    for (const path of state.openFilePaths) {
      keys.add(this.canonicalKeyFromUri(monaco.Uri.file(path)));
    }
    return keys;
  }

  private sweepClosedModels(retainedKeys: ReadonlySet<string>): void {
    const cleanupErrors: unknown[] = [];
    for (const [key, record] of [...this.modelsByCanonicalUri]) {
      if (retainedKeys.has(key) || this.activeBinding?.model === record.model) continue;
      this.releaseModelRecord(record, cleanupErrors);
    }
    throwFirstCleanupError(cleanupErrors);
  }

  private releaseModelRecord(record: ModelRecord, cleanupErrors: unknown[]): void {
    if (this.modelsByCanonicalUri.get(record.key) !== record) return;
    // 先从 ledger 删除并标记，确保 listener dispose/model dispose/callback 任一重入都不会重复 release。
    this.modelsByCanonicalUri.delete(record.key);
    record.disposeAttempted = true;
    captureCleanupError(cleanupErrors, () => record.modelDisposeListener.dispose());
    captureCleanupError(cleanupErrors, () => this.emitRelease(record));
    this.viewStatesByCanonicalUri.delete(record.key);
    if (record.owned && !record.model.isDisposed()) {
      captureCleanupError(cleanupErrors, () => record.model.dispose());
    }
  }

  private rollbackNewAcquisition(
    record: ModelRecord,
    activationExposed: boolean,
    cleanupErrors: unknown[]
  ): void {
    if (this.modelsByCanonicalUri.get(record.key) === record) {
      this.modelsByCanonicalUri.delete(record.key);
    }
    record.disposeAttempted = true;
    captureCleanupError(cleanupErrors, () => record.modelDisposeListener.dispose());
    if (activationExposed) captureCleanupError(cleanupErrors, () => this.emitRelease(record));
    if (record.owned && !record.model.isDisposed()) {
      captureCleanupError(cleanupErrors, () => record.model.dispose());
    }
  }

  private cleanupAttachedEditor(cleanupErrors: unknown[], notifyDetach: boolean): void {
    const editor = this.editor;
    if (editor === null) return;

    if (notifyDetach && this.monaco !== null) {
      captureCleanupError(cleanupErrors, () => {
        this.desiredState?.onDidDetach?.(editor, this.monaco as MonacoEditorFacade);
      });
    }

    const activeBinding = this.activeBinding;
    this.activeBinding = null;
    if (activeBinding !== null) {
      captureCleanupError(cleanupErrors, () => activeBinding.listener.dispose());
      captureCleanupError(cleanupErrors, () => {
        this.viewStatesByCanonicalUri.set(activeBinding.key, editor.saveViewState());
      });
    }
    this.clearEditorModel(editor, cleanupErrors);
    this.editor = null;
    captureCleanupError(cleanupErrors, () => editor.dispose());
  }

  private clearEditorModel(editor: MonacoEditor, cleanupErrors: unknown[]): void {
    if (editor.getModel() === null) return;
    captureCleanupError(cleanupErrors, () => editor.setModel(null));
    // 一次性失败注入或瞬时 Monaco 失败后再做一次 best-effort，优先维持稳定 null 状态。
    if (editor.getModel() !== null) {
      captureCleanupError(cleanupErrors, () => editor.setModel(null));
    }
  }

  private canonicalKeyFromUri(uri: Monaco.Uri): string {
    const scheme = uri.scheme.toLowerCase();
    const authority = uri.authority.toLowerCase();
    const normalizedPath = uri.path.replaceAll('\\', '/');
    const path = scheme === 'file' ? normalizedPath.toLowerCase() : normalizedPath;
    return uri.with({ scheme, authority, path }).toString();
  }

  private handleExternalModelDispose(key: string, model: MonacoModel): void {
    const record = this.modelsByCanonicalUri.get(key);
    if (record === undefined || record.model !== model) return;

    const cleanupErrors: unknown[] = [];
    this.modelDisposeTransactionDepth += 1;
    try {
      // will-dispose 在 model 真正标记 disposed 前同步触发；先从表中移除，防止回调重入再次释放。
      this.modelsByCanonicalUri.delete(key);
      const activeBinding = this.activeBinding?.model === model ? this.activeBinding : null;
      if (activeBinding !== null) {
        this.activeBinding = null;
        captureCleanupError(cleanupErrors, () => activeBinding.listener.dispose());
        if (this.editor?.getModel() === model) this.clearEditorModel(this.editor, cleanupErrors);
      }

      // release callback 允许只更新 desired snapshot；transaction gate 禁止此处同步 reconcile。
      captureCleanupError(cleanupErrors, () => this.emitRelease(record));
    } finally {
      this.modelDisposeTransactionDepth -= 1;
      this.scheduleDesiredStateApplication();
    }
    if (cleanupErrors.length > 0) this.reportError(cleanupErrors[0]);
  }

  private applyDesiredState(): void {
    const desiredState = this.desiredState;
    if (desiredState === null || this.disposed) return;
    if (this.editor !== null) {
      runMonacoStage('reconcile', () => this.reconcile());
    } else if (this.monaco !== null) {
      // detach 后仍保留 facade，因此关闭文件无需等到下一次 attach 才释放。
      this.sweepClosedModels(this.getRetainedKeys(desiredState));
    }
  }

  private scheduleDesiredStateApplication(): void {
    if (this.disposed || this.scheduledDesiredApplicationToken !== null) return;
    const token = this.nextDesiredApplicationToken++;
    const lifecycleGeneration = this.lifecycleGeneration;
    this.scheduledDesiredApplicationToken = token;
    queueMicrotask(() => {
      if (this.scheduledDesiredApplicationToken !== token) return;
      this.scheduledDesiredApplicationToken = null;
      if (this.disposed || this.lifecycleGeneration !== lifecycleGeneration) return;
      try {
        this.applyDesiredState();
      } catch (error) {
        this.reportError(error);
      }
    });
  }

  private invalidateScheduledDesiredApplication(): void {
    this.lifecycleGeneration += 1;
    this.scheduledDesiredApplicationToken = null;
  }

  private reportError(error: unknown): void {
    try {
      this.desiredState?.onError(error);
    } catch {
      // onError 自身失败也不能制造未处理的 Promise rejection。
    }
  }

  private emitRelease(record: ModelRecord): void {
    if (this.monaco === null) return;
    this.desiredState?.onDidChangeModel?.(
      {
        kind: 'release',
        model: {
          path: record.lastPath,
          uri: record.uri.toString(),
          key: record.key,
          model: record.model,
          epoch: record.lastEpoch,
          ownership: record.owned ? 'owned' : 'borrowed'
        }
      },
      this.monaco
    );
  }

  private toPublicBinding(binding: ActiveBinding | null): MonacoSessionModelBinding | null {
    if (binding === null) return null;
    return {
      path: binding.path,
      uri: binding.uri,
      key: binding.key,
      model: binding.model,
      epoch: binding.epoch,
      ownership: binding.ownership
    };
  }
}

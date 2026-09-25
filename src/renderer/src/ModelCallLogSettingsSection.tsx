import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ModelCallLogSettings } from '../../shared/types';

type ModelCallLogSettingsSectionProps = {
  isOpen: boolean;
  onBusyChange?: (busy: boolean) => void;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

const DEFAULT_SETTINGS: ModelCallLogSettings = {
  enabled: false
};

export function ModelCallLogSettingsSection({
  isOpen,
  onBusyChange
}: ModelCallLogSettingsSectionProps): JSX.Element {
  const [draft, setDraft] = useState<ModelCallLogSettings>(
    DEFAULT_SETTINGS
  );
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    onBusyChange?.(isBusy || loadState === 'loading');
    return () => onBusyChange?.(false);
  }, [isBusy, loadState, onBusyChange]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    setLoadState('loading');
    setMessage('');
    void window.workstation.getModelCallLogSettings().then(
      (settings) => {
        if (cancelled) return;
        setDraft(settings);
        setLoadState('ready');
      },
      () => {
        if (cancelled) return;
        setLoadState('error');
        setMessage('模型调用记录设置加载失败，请重试。');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  async function reload(): Promise<void> {
    setLoadState('loading');
    setMessage('');
    try {
      setDraft(await window.workstation.getModelCallLogSettings());
      setLoadState('ready');
    } catch {
      setLoadState('error');
      setMessage('模型调用记录设置加载失败，请重试。');
    }
  }

  async function chooseDirectory(): Promise<void> {
    const previous = draft;
    let next: ModelCallLogSettings | undefined;
    setIsBusy(true);
    setMessage('');
    try {
      const directory = await window.workstation
        .selectModelCallLogDirectory();
      if (directory) {
        next = {
          ...draft,
          directory
        };
        setDraft(next);
        const saved = await window.workstation.saveModelCallLogSettings({
          enabled: next.enabled,
          directory: directory.trim()
        });
        setDraft(saved);
        setMessage('已自动保存。');
      }
    } catch (error) {
      if (next) setDraft(previous);
      setMessage(`${next ? '自动保存' : '目录选择'}失败：${toErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function changeEnabled(enabled: boolean): Promise<void> {
    const previous = draft;
    const next = { ...draft, enabled };
    setDraft(next);
    setMessage('');
    if (enabled && !next.directory?.trim()) {
      return;
    }
    setIsBusy(true);
    try {
      const saved = await window.workstation.saveModelCallLogSettings({
        enabled: next.enabled,
        ...(next.directory?.trim()
          ? { directory: next.directory.trim() }
          : {})
      });
      setDraft(saved);
      setMessage('已自动保存。');
    } catch (error) {
      setDraft(previous);
      setMessage(`自动保存失败：${toErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }

  if (loadState === 'loading' || loadState === 'idle') {
    return (
      <div className="model-settings-load-state" role="status">
        正在加载文件管理设置…
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="model-settings-load-state" role="alert">
        <strong>文件管理设置加载失败</strong>
        <span>{message}</span>
        <button type="button" onClick={() => void reload()}>
          重新加载
        </button>
      </div>
    );
  }

  const controlsDisabled = isBusy;
  const directoryMissing =
    draft.enabled && !draft.directory?.trim();

  return (
    <section
      className="model-call-log-settings-card"
      aria-label="模型调用记录文件管理"
    >
      <div className="model-call-log-settings-heading">
        <span>文件管理</span>
        <strong>模型调用记录</strong>
      </div>

      <label className="model-call-log-toggle">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={controlsDisabled}
          onChange={(event) => {
            void changeEnabled(event.target.checked);
          }}
        />
        <span>保存模型调用记录</span>
      </label>

      <label className="model-call-log-directory-field">
        <span>存储目录</span>
        <div>
          <input
            type="text"
            value={draft.directory ?? ''}
            placeholder="尚未选择目录"
            readOnly
            disabled={!draft.enabled || controlsDisabled}
            title={draft.directory}
          />
          <button
            type="button"
            className="model-call-log-directory-button"
            aria-label="选择存储目录"
            title="选择存储目录"
            disabled={!draft.enabled || controlsDisabled}
            onClick={() => void chooseDirectory()}
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </label>

      {directoryMissing && (
        <div className="model-call-log-warning" role="alert">
          勾选后必须选择一个存在且可写的本地目录。
        </div>
      )}

      {message && (
        <span className="model-call-log-save-status" aria-live="polite">
          {message}
        </span>
      )}
    </section>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}

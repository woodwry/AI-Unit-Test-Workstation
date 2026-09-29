import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react';
import type {
  BuildSettingsPathKind,
  BuildSettingsValidationResult,
  MavenHomeDefaults,
  WorkstationBuildSettings
} from '../../shared/types';
import workstationBrandIcon from '../../../assets/branding/ai-unit-test-workstation.svg?url';
import { ModelCallLogSettingsSection } from './ModelCallLogSettingsSection';
import { RagSettingsSection } from './RagSettingsSection';
import { WorkspaceModelSettingsSection } from './WorkspaceModelSettingsSection';
import { useDraggableDialog } from './use-draggable-dialog';

type WorkspaceSettingsDialogProps = {
  buildSettings: WorkstationBuildSettings | null;
  buildSettingsValidation: BuildSettingsValidationResult | null;
  isOpen: boolean;
  isRunning: boolean;
  isBuildSettingsBusy: boolean;
  canManageModelCallLogs: boolean;
  sectionRequest: { requestId: number; section: 'rag' } | null;
  onClose: () => void;
  onResolveMavenHomeDefaults: (mavenHome: string) => Promise<MavenHomeDefaults | null>;
  onSaveBuildSettings: (settings: WorkstationBuildSettings) => Promise<void>;
  onSelectBuildSettingsPath: (kind: BuildSettingsPathKind) => Promise<string | null>;
  onValidateBuildSettings: (
    settings: WorkstationBuildSettings
  ) => Promise<BuildSettingsValidationResult>;
};

const BUILD_SETTINGS_AUTO_SAVE_DELAY_MS = 600;

export function WorkspaceSettingsDialog({
  buildSettings,
  buildSettingsValidation,
  isOpen,
  isRunning,
  isBuildSettingsBusy,
  canManageModelCallLogs,
  sectionRequest,
  onClose,
  onResolveMavenHomeDefaults,
  onSaveBuildSettings,
  onSelectBuildSettingsPath,
  onValidateBuildSettings
}: WorkspaceSettingsDialogProps): JSX.Element {
  const { dialogRef, dialogStyle, dragHandleProps } =
    useDraggableDialog<HTMLDialogElement>(isOpen);
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<'build' | 'model' | 'rag' | 'files'>('build');
  const visibleSettingsSection = !canManageModelCallLogs && activeSettingsSection === 'files'
    ? 'build'
    : activeSettingsSection;
  const isSettingsCloseBlocked = isBuildSettingsBusy;
  const [draftBuildSettings, setDraftBuildSettings] = useState<WorkstationBuildSettings>(() =>
    createBuildSettingsDraft(buildSettings)
  );
  const [draftBuildValidation, setDraftBuildValidation] =
    useState<BuildSettingsValidationResult | null>(buildSettingsValidation);
  const lastAutoSaveAttemptRef = useRef<string | null>(null);
  const onSaveBuildSettingsRef = useRef(onSaveBuildSettings);

  useEffect(() => {
    setDraftBuildSettings(createBuildSettingsDraft(buildSettings));
  }, [buildSettings]);

  useEffect(() => {
    setDraftBuildValidation(buildSettingsValidation);
  }, [buildSettingsValidation]);

  useEffect(() => {
    onSaveBuildSettingsRef.current = onSaveBuildSettings;
  }, [onSaveBuildSettings]);

  useEffect(() => {
    if (sectionRequest) setActiveSettingsSection(sectionRequest.section);
  }, [sectionRequest?.requestId, sectionRequest?.section]);

  useEffect(() => {
    if (!canManageModelCallLogs && activeSettingsSection === 'files') {
      setActiveSettingsSection('build');
    }
  }, [activeSettingsSection, canManageModelCallLogs]);

  useEffect(() => {
    if (
      isRunning
      || isBuildSettingsBusy
      || !canValidateBuildSettings(draftBuildSettings)
    ) {
      return undefined;
    }
    const draftFingerprint = buildSettingsFingerprint(draftBuildSettings);
    const savedFingerprint = buildSettingsFingerprint(buildSettings);
    if (
      draftFingerprint === savedFingerprint
      || lastAutoSaveAttemptRef.current === draftFingerprint
    ) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      lastAutoSaveAttemptRef.current = draftFingerprint;
      void onSaveBuildSettingsRef.current(draftBuildSettings);
    }, BUILD_SETTINGS_AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [buildSettings, draftBuildSettings, isBuildSettingsBusy, isRunning]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      void window.workstation.setWindowModalBlocked(true).catch(() => undefined);
      if (!dialog.open) dialog.showModal();
      return () => {
        void window.workstation.setWindowModalBlocked(false).catch(() => undefined);
      };
    }

    if (dialog.open) dialog.close();
    return undefined;
  }, [isOpen]);

  function updateBuildSettings(patch: Partial<WorkstationBuildSettings>): void {
    lastAutoSaveAttemptRef.current = null;
    setDraftBuildSettings((settings) => ({ ...settings, ...patch, validation: undefined }));
    setDraftBuildValidation(null);
  }

  async function chooseBuildPath(kind: BuildSettingsPathKind): Promise<void> {
    const selectedPath = await onSelectBuildSettingsPath(kind);
    if (!selectedPath) return;

    if (kind === 'mavenHome') {
      updateBuildSettings({ mavenHome: selectedPath });
      const defaults = await onResolveMavenHomeDefaults(selectedPath);
      if (defaults) {
        updateBuildSettings({
          mavenHome: selectedPath,
          settingsPath: defaults.settingsPath,
          localRepository: defaults.localRepository
        });
      }
      return;
    }

    updateBuildSettings({ [kind]: selectedPath });
  }

  function handleDialogMouseDown(event: MouseEvent<HTMLDialogElement>): void {
    const dialog = event.currentTarget;
    const rect = dialog.getBoundingClientRect();
    const isInside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (isInside) return;

    event.preventDefault();
    void window.workstation.playAttentionSound().catch(() => undefined);
    dialog.classList.remove('attention');
    void dialog.offsetWidth;
    dialog.classList.add('attention');
    dialog.addEventListener('animationend', () => dialog.classList.remove('attention'), {
      once: true
    });
  }

  function handleDialogCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    if (isSettingsCloseBlocked) event.preventDefault();
  }

  async function validateBuildSettingsDraft(): Promise<void> {
    const validation = await onValidateBuildSettings(draftBuildSettings);
    setDraftBuildValidation(validation);
    lastAutoSaveAttemptRef.current = validation.valid
      ? null
      : buildSettingsFingerprint(draftBuildSettings);
  }

  return (
    <dialog
      ref={dialogRef}
      style={dialogStyle}
      className="workspace-settings-dialog"
      aria-labelledby="workspace-settings-title"
      onClose={onClose}
      onCancel={handleDialogCancel}
      onMouseDown={handleDialogMouseDown}
    >
      <div className="workspace-settings-dialog-shell">
        <header className="workspace-settings-dialog-header" {...dragHandleProps}>
          <div className="workspace-settings-title">
            <img src={workstationBrandIcon} alt="AI Unit Test Workstation" />
            <strong id="workspace-settings-title">设置</strong>
          </div>
          <button
            type="button"
            title="关闭设置"
            aria-label="关闭设置"
            disabled={isSettingsCloseBlocked}
            onClick={() => dialogRef.current?.close()}
          >
            <X size={15} />
          </button>
        </header>

        <div className="workspace-settings-dialog-content">
          <nav className="workspace-settings-nav" aria-label="设置分类">
            <button
              type="button"
              disabled={isSettingsCloseBlocked}
              className={activeSettingsSection === 'build' ? 'active' : ''}
              aria-current={activeSettingsSection === 'build' ? 'page' : undefined}
              onClick={() => setActiveSettingsSection('build')}
            >
              构建环境
            </button>
            <button
              type="button"
              disabled={isSettingsCloseBlocked}
              className={activeSettingsSection === 'model' ? 'active' : ''}
              aria-current={activeSettingsSection === 'model' ? 'page' : undefined}
              onClick={() => setActiveSettingsSection('model')}
            >
              大模型
            </button>
            <button
              type="button"
              disabled={isSettingsCloseBlocked}
              className={activeSettingsSection === 'rag' ? 'active' : ''}
              aria-current={activeSettingsSection === 'rag' ? 'page' : undefined}
              onClick={() => setActiveSettingsSection('rag')}
            >
              RAG
            </button>
            {canManageModelCallLogs && (
              <button
                type="button"
                disabled={isSettingsCloseBlocked}
                className={visibleSettingsSection === 'files' ? 'active' : ''}
                aria-current={visibleSettingsSection === 'files' ? 'page' : undefined}
                onClick={() => setActiveSettingsSection('files')}
              >
                文件管理
              </button>
            )}
          </nav>

          <div className={`workspace-settings-view${
            visibleSettingsSection === 'model' ? ' model-interface-settings-view' : ''
          }${
            visibleSettingsSection === 'rag' ? ' rag-settings-view' : ''
          }`}>
            {visibleSettingsSection === 'build' ? (
              <section className="build-settings-card" aria-label="工作站全局构建环境">
                <div className="build-settings-heading">
                  <div>
                    <span>工作站全局配置</span>
                    <strong>当前工作站</strong>
                  </div>
                  <BuildValidationBadge validation={draftBuildValidation} />
                </div>
                <p>
                  这套 Maven/JDK 工具链用于本工作站打开的项目，不会修改系统环境变量、POM
                  或 Maven settings。
                </p>
                <BuildPathField
                  label="Maven Home"
                  value={draftBuildSettings.mavenHome}
                  disabled={isRunning || isBuildSettingsBusy}
                  onBrowse={() => void chooseBuildPath('mavenHome')}
                  onChange={(mavenHome) => updateBuildSettings({ mavenHome })}
                />
                <BuildPathField
                  label="Java Home"
                  value={draftBuildSettings.javaHome}
                  disabled={isRunning || isBuildSettingsBusy}
                  onBrowse={() => void chooseBuildPath('javaHome')}
                  onChange={(javaHome) => updateBuildSettings({ javaHome })}
                />
                <BuildPathField
                  label="settings.xml"
                  value={draftBuildSettings.settingsPath ?? ''}
                  disabled={isRunning || isBuildSettingsBusy}
                  onBrowse={() => void chooseBuildPath('settingsPath')}
                  onChange={(settingsPath) => updateBuildSettings({ settingsPath })}
                />
                <BuildPathField
                  label="本地仓库"
                  value={draftBuildSettings.localRepository ?? ''}
                  disabled={isRunning || isBuildSettingsBusy}
                  onBrowse={() => void chooseBuildPath('localRepository')}
                  onChange={(localRepository) => updateBuildSettings({ localRepository })}
                />
                <div className="build-settings-actions">
                  <button
                    type="button"
                    disabled={
                      !canValidateBuildSettings(draftBuildSettings) ||
                      isRunning ||
                      isBuildSettingsBusy
                    }
                    onClick={() => void validateBuildSettingsDraft()}
                  >
                    <RefreshCw className={isBuildSettingsBusy ? 'spin' : ''} size={13} />
                    校验配置
                  </button>
                </div>
                {draftBuildValidation && (
                  <div
                    className={`build-validation-detail ${
                      draftBuildValidation.valid ? 'valid' : 'invalid'
                    }`}
                  >
                    <strong>
                      {draftBuildValidation.valid
                        ? `Maven ${draftBuildValidation.mavenVersion} · Java ${draftBuildValidation.javaVersion}`
                        : '配置不可用'}
                    </strong>
                    <span>
                      {draftBuildValidation.error ??
                        `最后校验：${formatDateTime(draftBuildValidation.checkedAt)}`}
                    </span>
                  </div>
                )}
              </section>
            ) : visibleSettingsSection === 'files' && canManageModelCallLogs ? (
              <ModelCallLogSettingsSection
                isOpen={isOpen}
              />
            ) : visibleSettingsSection === 'rag' ? (
              <RagSettingsSection
                isOpen={isOpen && visibleSettingsSection === 'rag'}
              />
            ) : (
              <WorkspaceModelSettingsSection
                isOpen={isOpen && visibleSettingsSection === 'model'}
              />
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function BuildPathField({
  label,
  value,
  disabled,
  onChange,
  onBrowse
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onBrowse: () => void;
}): JSX.Element {
  return (
    <label className="build-path-field">
      <span>{label}</span>
      <div>
        <input
          value={value}
          disabled={disabled}
          spellCheck={false}
          placeholder={`选择或输入 ${label}`}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" disabled={disabled} title={`浏览 ${label}`} onClick={onBrowse}>
          <FolderOpen size={13} />
        </button>
      </div>
    </label>
  );
}

function BuildValidationBadge({
  validation
}: {
  validation: BuildSettingsValidationResult | null;
}): JSX.Element {
  if (!validation) return <span className="build-validation-badge pending">未校验</span>;
  return (
    <span className={`build-validation-badge ${validation.valid ? 'valid' : 'invalid'}`}>
      {validation.valid ? '可用' : '需修正'}
    </span>
  );
}

function createBuildSettingsDraft(
  settings: WorkstationBuildSettings | null
): WorkstationBuildSettings {
  return settings ?? { mavenHome: '', javaHome: '' };
}

function canValidateBuildSettings(settings: WorkstationBuildSettings): boolean {
  return Boolean(settings.mavenHome.trim() && settings.javaHome.trim());
}

function buildSettingsFingerprint(settings: WorkstationBuildSettings | null): string {
  const draft = createBuildSettingsDraft(settings);
  return JSON.stringify([
    draft.mavenHome.trim(),
    draft.javaHome.trim(),
    draft.settingsPath?.trim() ?? '',
    draft.localRepository?.trim() ?? ''
  ]);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

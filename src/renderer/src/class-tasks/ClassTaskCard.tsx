import {
  Crosshair,
  FileText,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Square,
  Trash2
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react';
import { createPortal } from 'react-dom';
import type { ClassTaskSnapshot } from '../../../shared/class-task-contracts.ts';
import {
  actionsForClassTask,
  buildClassTaskCardView,
  resolveClassTaskCardClick,
  resolveClassTaskIconClick,
  type ClassTaskCardAction,
  type ClassTaskCardErrorView,
  type ClassTaskCardIntent
} from './class-task-card-view';

type ClassTaskCardProps = {
  task: ClassTaskSnapshot;
  attentionAcknowledged: boolean;
  commandBusy: boolean;
  methodSelectionHintVisible?: boolean;
  onIntent: (intent: ClassTaskCardIntent) => void;
};

const ACTION_TITLES: Record<ClassTaskCardAction, string> = {
  run: '执行当前类',
  result: '查看并处理结果',
  spinner: '任务处理中',
  pause: '暂停当前类',
  resume: '继续当前类',
  terminate: '终止当前类',
  locate: '定位源码',
  configure: '配置生成方法',
  retry_preload: '重新检测当前类',
  stop_preload: '停止检测当前类',
  delete: '删除当前任务'
};

export function ClassTaskCard({
  task,
  attentionAcknowledged,
  commandBusy,
  methodSelectionHintVisible = false,
  onIntent
}: ClassTaskCardProps): JSX.Element {
  const [timingNowMs, setTimingNowMs] = useState(() => Date.now());
  const view = buildClassTaskCardView(task, attentionAcknowledged, timingNowMs);
  const actions = actionsForClassTask(task).filter((action) => action !== 'spinner' || !view.execution);
  const moduleName = compactModuleName(task.moduleDisplayPath);
  const runningMethodProgress = view.methodProgress?.showBar ? view.methodProgress : null;
  const stoppedMethodProgress = view.methodProgress && !view.methodProgress.showBar
    ? view.methodProgress
    : null;
  const hasSummary = stoppedMethodProgress !== null || view.testFileCount > 0;
  const className = [
    'class-task-card',
    view.needsAttention
      ? task.state === 'TERMINATED'
        ? 'class-task-termination-pulse'
        : 'class-task-completion-pulse'
      : '',
    methodSelectionHintVisible ? 'method-selection-missing' : '',
    task.state === 'PRELOAD_FAILED' ? 'preload-failed' : '',
    runningMethodProgress ? 'has-method-progress' : '',
    hasSummary ? 'has-summary' : '',
    task.state === 'PAUSED' ? 'is-paused' : ''
  ].filter(Boolean).join(' ');
  const timingIsLive = task.startedAt !== null
    && task.finishedAt === null
    && ['RUNNING', 'PAUSE_REQUESTED', 'STOPPING'].includes(task.state);

  useEffect(() => {
    setTimingNowMs(Date.now());
    if (!timingIsLive) return;
    const intervalId = window.setInterval(() => setTimingNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [timingIsLive, task.startedAt]);

  const openCard = (): void => onIntent(resolveClassTaskCardClick(task));
  const handleCardKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCard();
    }
  };

  return (
    <article
      id={`class-task-card-${task.id}`}
      className={className}
      role="button"
      tabIndex={0}
      aria-label={`${view.className}，${view.statusLabel}`}
      onClick={openCard}
      onKeyDown={handleCardKey}
    >
      <div className="class-task-card-main">
        <div className="class-task-card-heading">
          <span
            className={`class-task-card-status-dot ${view.statusTone}`}
            aria-hidden="true"
          />
          <strong className="class-task-card-name">
            {view.fileName}
          </strong>
        </div>
        {runningMethodProgress && (
          <div className={`class-task-card-progress ${runningMethodProgress.tone}`}>
            <div
              className="class-task-card-progress-track"
              role="progressbar"
              aria-label={runningMethodProgress.label}
              aria-valuemin={0}
              aria-valuenow={runningMethodProgress.completed}
              aria-valuemax={runningMethodProgress.total}
              title={runningMethodProgress.label}
            >
              <span
                className="class-task-card-progress-fill"
                style={{
                  width: `${(runningMethodProgress.completed / runningMethodProgress.total) * 100}%`
                }}
              />
              {runningMethodProgress.activeBatch && (
                <span
                  aria-hidden="true"
                  className="class-task-card-progress-active-batch"
                  style={{
                    left: `${(runningMethodProgress.completed
                      / runningMethodProgress.total) * 100}%`,
                    right: 0
                  }}
                />
              )}
            </div>
            <span className="class-task-card-progress-count">
              {runningMethodProgress.countLabel}
            </span>
          </div>
        )}
        <div className="class-task-card-meta">
          <span className={`class-task-status ${view.statusTone}`}>{view.statusLabel}</span>
          {view.elapsedTimeLabel && (
            <>
              <span className="class-task-card-meta-separator" aria-hidden="true" />
              <time
                className="class-task-card-elapsed"
                aria-label={`执行时间 ${view.elapsedTimeLabel}`}
              >
                {view.elapsedTimeLabel}
              </time>
            </>
          )}
          <span className="class-task-card-meta-separator" aria-hidden="true" />
          <code className="class-task-card-module" title={task.moduleDisplayPath}>
            {moduleName}
          </code>
          {view.error && (
            <>
              <span className="class-task-card-meta-separator" aria-hidden="true" />
              <ClassTaskErrorDetails error={view.error} />
            </>
          )}
          {methodSelectionHintVisible && (
            <>
              <span className="class-task-card-meta-separator" aria-hidden="true" />
              <span className="class-task-card-selection-hint" role="alert">
                请先选择至少一个方法
              </span>
            </>
          )}
        </div>
      </div>

      <div className="class-task-card-actions" aria-label="任务操作">
        {actions.map((action, index) => action === 'spinner' ? (
          <span
            key={`${action}-${index}`}
            className="class-task-card-spinner-slot"
            title={ACTION_TITLES[action]}
            aria-label={ACTION_TITLES[action]}
          >
            <LoaderCircle size={16} aria-hidden="true" />
          </span>
        ) : (
          <button
            key={`${action}-${index}`}
            type="button"
            className={`class-task-card-action ${action}`}
            title={ACTION_TITLES[action]}
            aria-label={ACTION_TITLES[action]}
            disabled={commandBusy}
            onClick={(event) => handleActionClick(event, task, action, onIntent)}
          >
            <ActionIcon action={action} />
          </button>
        ))}
      </div>

      {hasSummary && (
        <div className="class-task-card-summary">
          {stoppedMethodProgress && (
            <span className="class-task-card-progress-label">{stoppedMethodProgress.label}</span>
          )}
          {stoppedMethodProgress && view.testFileCount > 0 && (
            <span className="class-task-card-summary-separator" aria-hidden="true" />
          )}
          {view.testFileCount > 0 && (
            <small
              className="class-task-card-test-summary"
              title={`${view.testFileCount} 个测试文件，共 ${view.testMethodCount} 个测试方法`}
            >
              {view.testFileCount} 个文件 · {view.testMethodCount} 个测试
            </small>
          )}
        </div>
      )}
      {view.execution && (
        <div
          className={`class-task-card-execution ${view.execution.animated ? 'is-active' : 'is-paused'}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          title={view.execution.label}
        >
          <span className="class-task-card-execution-indicator" aria-hidden="true">
            {!view.execution.animated && <Pause size={12} />}
          </span>
          <span className="class-task-card-execution-label">{view.execution.label}</span>
        </div>
      )}
    </article>
  );
}

function ClassTaskErrorDetails({ error }: { error: ClassTaskCardErrorView }): JSX.Element {
  const anchorRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const interactionRef = useRef({ anchorHovered: false, popoverHovered: false, focused: false });
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; right: number } | null>(null);

  const updatePopoverPosition = useCallback((): void => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const anchorBox = anchor.getBoundingClientRect();
    setPopoverPosition({
      top: anchorBox.bottom + 5,
      right: Math.max(8, window.innerWidth - anchorBox.right)
    });
  }, []);

  const cancelScheduledClose = useCallback((): void => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const showPopover = useCallback((): void => {
    cancelScheduledClose();
    updatePopoverPosition();
    setPopoverOpen(true);
  }, [cancelScheduledClose, updatePopoverPosition]);

  const schedulePopoverClose = useCallback((): void => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      const interaction = interactionRef.current;
      if (!interaction.anchorHovered && !interaction.popoverHovered && !interaction.focused) {
        setPopoverOpen(false);
      }
    }, 80);
  }, [cancelScheduledClose]);

  useEffect(() => {
    if (!popoverOpen) return;
    updatePopoverPosition();
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);
    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [popoverOpen, updatePopoverPosition]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  const popover = popoverOpen && popoverPosition
    ? createPortal(
      <div
        className="class-task-card-error-popover"
        role="tooltip"
        style={popoverPosition}
        onMouseEnter={() => {
          interactionRef.current.popoverHovered = true;
          cancelScheduledClose();
        }}
        onMouseLeave={() => {
          interactionRef.current.popoverHovered = false;
          schedulePopoverClose();
        }}
      >
        <strong>{error.moduleName}</strong>
        <code>{error.modulePath}</code>
        <code>{error.command}</code>
        <p>{error.message}</p>
      </div>,
      document.body
    )
    : null;

  return (
    <>
      <div
        ref={anchorRef}
        className="class-task-card-error-anchor"
        tabIndex={0}
        onMouseEnter={() => {
          interactionRef.current.anchorHovered = true;
          showPopover();
        }}
        onMouseLeave={() => {
          interactionRef.current.anchorHovered = false;
          schedulePopoverClose();
        }}
        onFocus={() => {
          interactionRef.current.focused = true;
          showPopover();
        }}
        onBlur={() => {
          interactionRef.current.focused = false;
          schedulePopoverClose();
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            interactionRef.current.focused = false;
            setPopoverOpen(false);
            event.currentTarget.blur();
          }
        }}
      >
        <span>查看详情</span>
      </div>
      {popover}
    </>
  );
}

function compactModuleName(moduleDisplayPath: string): string {
  const withoutTrailingSeparator = moduleDisplayPath.replace(/[\\/]+$/, '');
  return withoutTrailingSeparator.split(/[\\/]/).pop() || moduleDisplayPath;
}

function handleActionClick(
  event: MouseEvent<HTMLButtonElement>,
  task: ClassTaskSnapshot,
  action: ClassTaskCardAction,
  onIntent: (intent: ClassTaskCardIntent) => void
): void {
  event.stopPropagation();
  onIntent(resolveClassTaskIconClick(task, action));
}

function ActionIcon({ action }: { action: Exclude<ClassTaskCardAction, 'spinner'> }): JSX.Element {
  switch (action) {
    case 'run':
    case 'resume':
      return <Play size={16} fill="currentColor" aria-hidden="true" />;
    case 'result':
      return <FileText size={16} aria-hidden="true" />;
    case 'pause':
      return <Pause size={16} fill="currentColor" aria-hidden="true" />;
    case 'terminate':
    case 'stop_preload':
      return <Square size={13} fill="currentColor" aria-hidden="true" />;
    case 'locate':
      return <Crosshair size={16} aria-hidden="true" />;
    case 'configure':
      return <Settings size={16} aria-hidden="true" />;
    case 'retry_preload':
      return <RefreshCw size={16} aria-hidden="true" />;
    case 'delete':
      return <Trash2 size={16} aria-hidden="true" />;
  }
}

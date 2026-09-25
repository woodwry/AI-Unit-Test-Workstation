import { Bot, CircleAlert, FilePlus2, LoaderCircle, Play, Square } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ClassTaskResultSnapshot,
  ClassTaskSnapshot
} from '../../../shared/class-task-contracts';
import { ClassTaskCard } from './ClassTaskCard';
import { DeleteClassTaskDialog } from './DeleteClassTaskDialog';
import { ClassTaskResultPage } from './ClassTaskResultPage';
import { normalizeClassTaskResultActionError } from './class-task-result-view';
import {
  presentClassTaskResultDuringAction,
  type PendingClassTaskResultAction
} from './coverage-view';
import {
  resolveClassTaskDeleteRequest,
  resolveClassTaskTotalControl,
  requiresClassTaskMethodSelection,
  type ClassTaskCardIntent
} from './class-task-card-view';
import { TerminateAllDialog } from './TerminateAllDialog';
import './class-tasks.css';

export type ClassTaskFocusRequest = {
  taskId: string;
  sequence: number;
};

type ClassTaskPanelProps = {
  tasks: ClassTaskSnapshot[];
  workspaceRoot: string;
  busyTaskIds: ReadonlySet<string>;
  focusRequest?: ClassTaskFocusRequest | null;
  headerTrailing?: ReactNode;
  totalCommandBusy?: boolean;
  getPathForDroppedFile: (file: File) => string;
  onAddClassPaths: (filePaths: string[]) => void;
  onReorderTasks: (taskIds: string[]) => Promise<void>;
  onCardIntent: (intent: ClassTaskCardIntent) => void;
  onLoadTaskResult: (taskId: string) => Promise<ClassTaskResultSnapshot | null>;
  onAcceptTaskResult: (taskId: string) => Promise<ClassTaskResultSnapshot>;
  onRevokeTaskResult: (taskId: string) => Promise<ClassTaskResultSnapshot>;
  onRunAll: () => void;
  onTerminateAll: () => void;
};

const MAX_CLASS_TASKS = 5;
const CAPACITY_WARNING_MILLISECONDS = 3_000;
const RUN_ALL_FEEDBACK_MINIMUM_MILLISECONDS = 600;
const CLASS_TASK_REORDER_MIME = 'application/x-aiunittest-class-task-id';
export const CLASS_TASK_FILE_PATH_MIME = 'application/x-aiunittest-file-path';

type BackgroundResultAction = {
  action: Exclude<PendingClassTaskResultAction, null>;
  result: ClassTaskResultSnapshot | null;
};

export function ClassTaskPanel({
  tasks,
  workspaceRoot,
  busyTaskIds,
  focusRequest = null,
  headerTrailing,
  totalCommandBusy = false,
  getPathForDroppedFile,
  onAddClassPaths,
  onReorderTasks,
  onCardIntent,
  onLoadTaskResult,
  onAcceptTaskResult,
  onRevokeTaskResult,
  onRunAll,
  onTerminateAll
}: ClassTaskPanelProps): JSX.Element {
  const dragDepthRef = useRef(0);
  const taskSlotRefs = useRef(new Map<string, HTMLDivElement>());
  const previousTaskRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const dropCommittedRef = useRef(false);
  const previousTaskCountRef = useRef(tasks.length);
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragTaskOrder, setDragTaskOrder] = useState<string[] | null>(null);
  const [acknowledgedAttention, setAcknowledgedAttention] = useState<Set<string>>(new Set());
  const [isTerminateDialogOpen, setIsTerminateDialogOpen] = useState(false);
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(null);
  const [methodSelectionHintTaskIds, setMethodSelectionHintTaskIds] = useState<Set<string>>(
    new Set()
  );
  const [activeResultTaskId, setActiveResultTaskId] = useState<string | null>(null);
  const [activeResult, setActiveResult] = useState<ClassTaskResultSnapshot | null>(null);
  const [resultActionBusy, setResultActionBusy] = useState(false);
  const [resultActionError, setResultActionError] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [isCapacityLimitVisible, setIsCapacityLimitVisible] = useState(false);
  const [isRunAllFeedbackVisible, setIsRunAllFeedbackVisible] = useState(false);
  const [hasRunAllFeedbackMinimumElapsed, setHasRunAllFeedbackMinimumElapsed] = useState(false);
  const resultRequestSequenceRef = useRef(0);
  const resultRefreshKeyRef = useRef<string | null>(null);
  const backgroundResultActionsRef = useRef(new Map<string, BackgroundResultAction>());
  const capacityWarningTimerRef = useRef<number | null>(null);
  const runAllFeedbackTimerRef = useRef<number | null>(null);
  const totalControl = resolveClassTaskTotalControl(tasks, busyTaskIds);
  const activeResultTask = activeResultTaskId
    ? tasks.find((task) => task.id === activeResultTaskId) ?? null
    : null;
  const displayedActiveResult = activeResult
    ? presentClassTaskResultDuringAction(
        activeResult,
        activeResultTaskId !== null
          ? backgroundResultActionsRef.current.get(activeResultTaskId)?.action ?? null
          : null
      )
    : null;
  const pendingDeleteTask = pendingDeleteTaskId
    ? tasks.find((task) => task.id === pendingDeleteTaskId) ?? null
    : null;
  const showResultPage = Boolean(activeResultTask && displayedActiveResult);
  const displayedTasks = (dragTaskOrder ?? tasks.map((task) => task.id)).flatMap((taskId) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    return task ? [task] : [];
  });
  const displayedTaskOrderKey = displayedTasks.map((task) => task.id).join('|');

  const hideCapacityLimitWarning = (): void => {
    if (capacityWarningTimerRef.current !== null) {
      window.clearTimeout(capacityWarningTimerRef.current);
      capacityWarningTimerRef.current = null;
    }
    setIsCapacityLimitVisible(false);
  };

  const showCapacityLimitWarning = (): void => {
    if (capacityWarningTimerRef.current !== null) {
      window.clearTimeout(capacityWarningTimerRef.current);
    }
    setIsCapacityLimitVisible(true);
    capacityWarningTimerRef.current = window.setTimeout(() => {
      capacityWarningTimerRef.current = null;
      setIsCapacityLimitVisible(false);
    }, CAPACITY_WARNING_MILLISECONDS);
  };

  useEffect(() => {
    if (!focusRequest) return;
    const card = document.getElementById(`class-task-card-${focusRequest.taskId}`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusRequest]);

  useEffect(() => {
    if (!activeResultTaskId || activeResultTask) return;
    resultRequestSequenceRef.current += 1;
    resultRefreshKeyRef.current = null;
    setActiveResultTaskId(null);
    setActiveResult(null);
    setResultActionBusy(false);
    setResultActionError(null);
  }, [activeResultTask, activeResultTaskId]);

  useEffect(() => {
    if (!activeResultTaskId || !activeResultTask || !activeResult || resultActionBusy) return;
    const refreshKey = `${activeResultTaskId}:${activeResultTask.updatedAt}`;
    if (resultRefreshKeyRef.current === refreshKey) return;
    resultRefreshKeyRef.current = refreshKey;
    const requestSequence = resultRequestSequenceRef.current + 1;
    resultRequestSequenceRef.current = requestSequence;
    void onLoadTaskResult(activeResultTaskId).then((result) => {
      if (requestSequence !== resultRequestSequenceRef.current || !result) return;
      setActiveResult(result);
      setResultActionError(null);
    }).catch(() => {
      // Keep the last valid snapshot. A later task update triggers another refresh.
    });
  }, [
    activeResult,
    activeResultTask,
    activeResultTaskId,
    onLoadTaskResult,
    resultActionBusy
  ]);

  useEffect(() => () => {
    if (capacityWarningTimerRef.current !== null) {
      window.clearTimeout(capacityWarningTimerRef.current);
    }
    if (runAllFeedbackTimerRef.current !== null) {
      window.clearTimeout(runAllFeedbackTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (
      !isRunAllFeedbackVisible
      || !hasRunAllFeedbackMinimumElapsed
      || (totalCommandBusy && totalControl.kind !== 'terminate')
    ) {
      return;
    }
    setIsRunAllFeedbackVisible(false);
  }, [
    hasRunAllFeedbackMinimumElapsed,
    isRunAllFeedbackVisible,
    totalCommandBusy,
    totalControl.kind
  ]);

  useEffect(() => {
    setMethodSelectionHintTaskIds((current) => {
      const next = new Set(current);
      for (const taskId of current) {
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (!task || !requiresClassTaskMethodSelection(task)) next.delete(taskId);
      }
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  useEffect(() => {
    if (tasks.length < previousTaskCountRef.current) hideCapacityLimitWarning();
    previousTaskCountRef.current = tasks.length;
  }, [tasks.length]);

  const captureTaskPositions = (): void => {
    previousTaskRectsRef.current = new Map(
      [...taskSlotRefs.current].map(([taskId, element]) => (
        [taskId, element.getBoundingClientRect()]
      ))
    );
  };

  useLayoutEffect(() => {
    const previousRects = previousTaskRectsRef.current;
    previousTaskRectsRef.current = null;
    if (!previousRects) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [taskId, element] of taskSlotRefs.current) {
      const previousRect = previousRects.get(taskId);
      if (!previousRect) continue;
      for (const animation of element.getAnimations()) animation.cancel();
      const nextRect = element.getBoundingClientRect();
      const deltaY = previousRect.top - nextRect.top;
      if (reduceMotion || Math.abs(deltaY) < 0.5) continue;
      element.animate([
        { transform: `translate3d(0, ${deltaY}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' }
      ], {
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      });
    }
  }, [displayedTaskOrderKey]);

  const resolveTaskOrder = (
    sourceTaskId: string,
    targetTaskId: string,
    edge: 'before' | 'after'
  ): string[] => {
    const currentIds = dragTaskOrder ?? tasks.map((task) => task.id);
    if (sourceTaskId === targetTaskId || !currentIds.includes(sourceTaskId)) return currentIds;
    const nextIds = currentIds.filter((taskId) => taskId !== sourceTaskId);
    const targetIndex = nextIds.indexOf(targetTaskId);
    if (targetIndex < 0) return currentIds;
    nextIds.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, sourceTaskId);
    return nextIds;
  };

  const finishTaskDrag = (revertPreview: boolean): void => {
    if (revertPreview && dragTaskOrder) captureTaskPositions();
    setDraggedTaskId(null);
    setDragTaskOrder(null);
  };

  const handleTaskDragStart = (
    event: DragEvent<HTMLDivElement>,
    taskId: string
  ): void => {
    const origin = event.target;
    if (origin instanceof Element && origin.closest('button')) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(CLASS_TASK_REORDER_MIME, taskId);
    dropCommittedRef.current = false;
    setDraggedTaskId(taskId);
    setDragTaskOrder(tasks.map((task) => task.id));
    setIsDragOver(false);
  };

  const handleTaskDragOver = (
    event: DragEvent<HTMLDivElement>,
    taskId: string
  ): void => {
    if (!isClassTaskReorderDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const sourceTaskId = event.dataTransfer.getData(CLASS_TASK_REORDER_MIME)
      || draggedTaskId;
    if (!sourceTaskId || sourceTaskId === taskId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    const currentIds = dragTaskOrder ?? tasks.map((task) => task.id);
    const nextIds = resolveTaskOrder(sourceTaskId, taskId, edge);
    if (nextIds.every((candidate, index) => candidate === currentIds[index])) return;
    captureTaskPositions();
    setDragTaskOrder(nextIds);
  };

  const handleTaskDrop = (
    event: DragEvent<HTMLDivElement>,
    taskId: string
  ): void => {
    if (!isClassTaskReorderDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceTaskId = event.dataTransfer.getData(CLASS_TASK_REORDER_MIME)
      || draggedTaskId;
    const currentIds = dragTaskOrder ?? tasks.map((task) => task.id);
    let nextIds = currentIds;
    if (sourceTaskId && sourceTaskId !== taskId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const edge = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      nextIds = resolveTaskOrder(sourceTaskId, taskId, edge);
    }
    dropCommittedRef.current = true;
    if (!nextIds.every((candidate, index) => candidate === tasks[index]?.id)) {
      setListHint(null);
      void onReorderTasks(nextIds);
    }
    finishTaskDrag(false);
  };

  const handleTaskDragEnd = (): void => {
    const shouldRevert = !dropCommittedRef.current;
    dropCommittedRef.current = false;
    finishTaskDrag(shouldRevert);
  };

  const addFiles = (files: readonly File[]): AddClassPathsResult => {
    const filePaths = files
      .filter((file) => file.name.toLocaleLowerCase().endsWith('.java'))
      .map(getPathForDroppedFile)
      .filter(Boolean);
    return addPaths(filePaths);
  };

  const addPaths = (candidatePaths: readonly string[]): AddClassPathsResult => {
    if (!workspaceRoot || candidatePaths.length === 0) {
      return { acceptedCount: 0, limitExceeded: false };
    }
    const existing = new Set(tasks.map((task) => normalizePath(task.sourceFilePath)));
    let remaining = Math.max(0, MAX_CLASS_TASKS - tasks.length);
    const accepted: string[] = [];
    const seen = new Set<string>();
    let limitExceeded = false;

    for (const candidate of candidatePaths) {
      if (!candidate.toLocaleLowerCase().endsWith('.java')) continue;
      const key = normalizePath(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      if (existing.has(key)) {
        accepted.push(candidate);
      } else if (remaining > 0) {
        accepted.push(candidate);
        remaining -= 1;
      } else {
        limitExceeded = true;
      }
    }
    if (limitExceeded) showCapacityLimitWarning();
    else hideCapacityLimitWarning();
    if (accepted.length > 0) setListHint(null);
    if (accepted.length > 0) onAddClassPaths(accepted);
    return { acceptedCount: accepted.length, limitExceeded };
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>): void => {
    if (!workspaceRoot) return;
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
      return;
    }
    const text = event.clipboardData.getData(CLASS_TASK_FILE_PATH_MIME)
      || event.clipboardData.getData('text/plain');
    const paths = parseClipboardClassPaths(text);
    if (paths.length === 0) return;
    event.preventDefault();
    addPaths(paths);
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (isClassTaskReorderDrag(event)) return;
    event.preventDefault();
    if (!workspaceRoot) return;
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (isClassTaskReorderDrag(event)) return;
    event.preventDefault();
    if (!workspaceRoot) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    if (isClassTaskReorderDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = workspaceRoot ? 'copy' : 'none';
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    if (isClassTaskReorderDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) {
      addFiles(files);
      return;
    }
    const internalPath = event.dataTransfer.getData(CLASS_TASK_FILE_PATH_MIME)
      || event.dataTransfer.getData('text/plain');
    if (internalPath) addPaths(parseClipboardClassPaths(internalPath));
  };

  const openResultPage = async (taskId: string): Promise<void> => {
    const backgroundAction = backgroundResultActionsRef.current.get(taskId) ?? null;
    resultRefreshKeyRef.current = null;
    const requestSequence = resultRequestSequenceRef.current + 1;
    resultRequestSequenceRef.current = requestSequence;
    setListHint('正在读取运行结果...');
    setResultActionError(null);
    try {
      const loadedResult = await onLoadTaskResult(taskId);
      if (requestSequence !== resultRequestSequenceRef.current) return;
      const result = backgroundAction?.result ?? loadedResult;
      if (!result) {
        setListHint('当前任务没有运行结果');
        return;
      }
      const taskUpdatedAt = tasks.find((task) => task.id === taskId)?.updatedAt;
      resultRefreshKeyRef.current = taskUpdatedAt
        ? `${taskId}:${taskUpdatedAt}`
        : null;
      setActiveResultTaskId(taskId);
      setActiveResult(result);
      setListHint(null);
    } catch (error: unknown) {
      if (requestSequence !== resultRequestSequenceRef.current) return;
      setListHint(`运行结果读取失败：${toErrorMessage(error)}`);
    }
  };

  const closeResultPage = (): void => {
    resultRequestSequenceRef.current += 1;
    resultRefreshKeyRef.current = null;
    setActiveResultTaskId(null);
    setActiveResult(null);
    setResultActionBusy(false);
    setResultActionError(null);
  };

  const runResultAction = (action: 'accept' | 'revoke'): void => {
    if (!activeResultTaskId || resultActionBusy) return;
    const taskId = activeResultTaskId;
    if (backgroundResultActionsRef.current.has(taskId)) return;
    const backgroundAction: BackgroundResultAction = { action, result: null };
    backgroundResultActionsRef.current.set(taskId, backgroundAction);
    closeResultPage();
    setListHint(action === 'accept' ? '正在后台接受测试文件...' : '正在后台撤回测试文件...');
    const request = action === 'accept'
      ? onAcceptTaskResult(taskId)
      : onRevokeTaskResult(taskId);
    void request.then((result) => {
      backgroundAction.result = result;
      setActiveResult((current) => current?.taskId === taskId ? result : current);
      setListHint(action === 'accept' ? '测试文件已接受' : '测试文件已撤回');
    }).catch((error: unknown) => {
      setListHint(normalizeClassTaskResultActionError(error));
    }).finally(() => {
      if (backgroundResultActionsRef.current.get(taskId) === backgroundAction) {
        backgroundResultActionsRef.current.delete(taskId);
      }
    });
  };

  const handleCardIntent = (intent: ClassTaskCardIntent): void => {
    if (intent.kind === 'show_method_selection_hint') {
      setMethodSelectionHintTaskIds((current) => new Set(current).add(intent.taskId));
      return;
    }
    if (intent.kind === 'delete') {
      const task = tasks.find((candidate) => candidate.id === intent.taskId);
      if (!task) return;
      const request = resolveClassTaskDeleteRequest(task);
      if (request.kind === 'confirm_delete') {
        setPendingDeleteTaskId(request.taskId);
        return;
      }
      onCardIntent(request);
      return;
    }
    if (intent.kind === 'show_empty_result_hint') {
      setListHint('当前任务没有运行结果');
      return;
    }
    if (intent.kind === 'open_result') {
      const task = tasks.find((candidate) => candidate.id === intent.taskId);
      if (task) {
        setAcknowledgedAttention((current) => new Set(current).add(attentionKey(task)));
      }
      void openResultPage(intent.taskId);
      return;
    }
    onCardIntent(intent);
  };

  const runAll = (): void => {
    if (totalCommandBusy || totalControl.kind !== 'run') return;
    if (runAllFeedbackTimerRef.current !== null) {
      window.clearTimeout(runAllFeedbackTimerRef.current);
    }
    setHasRunAllFeedbackMinimumElapsed(false);
    setIsRunAllFeedbackVisible(true);
    runAllFeedbackTimerRef.current = window.setTimeout(() => {
      runAllFeedbackTimerRef.current = null;
      setHasRunAllFeedbackMinimumElapsed(true);
    }, RUN_ALL_FEEDBACK_MINIMUM_MILLISECONDS);
    onRunAll();
  };

  return (
    <section
      className="class-task-panel"
      aria-label="多类单元测试任务"
    >
      <div className="class-task-panel-page-track">
        <div
          className={`class-task-panel-page class-task-list-page${isDragOver ? ' drag-over' : ''}`}
          onMouseDownCapture={hideCapacityLimitWarning}
          onClick={(event) => {
            if (event.currentTarget !== event.target) return;
            setListHint(null);
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onPaste={handlePaste}
        >
          <header className="class-task-panel-header">
            <div className="class-task-panel-title">
              <span className="class-task-panel-brand-icon" aria-hidden="true">
                <Bot size={15} />
              </span>
              <strong>生成单元测试</strong>
              {isRunAllFeedbackVisible ? (
                <button
                  type="button"
                  className="class-task-total-control run busy"
                  title="正在执行批量任务"
                  aria-label="正在执行批量任务"
                  disabled
                >
                  <LoaderCircle size={15} aria-hidden="true" />
                </button>
              ) : totalControl.kind === 'terminate' ? (
                <button
                  type="button"
                  className="class-task-total-control terminate"
                  title="终止全部任务"
                  aria-label="终止全部任务"
                  disabled={totalCommandBusy}
                  onClick={() => setIsTerminateDialogOpen(true)}
                >
                  <Square size={13} fill="currentColor" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="class-task-total-control run"
                  title={totalControl.kind === 'run'
                    ? `执行其余 ${totalControl.eligibleCount} 个任务`
                    : '暂无可执行任务'}
                  aria-label={totalControl.kind === 'run'
                    ? `执行其余 ${totalControl.eligibleCount} 个任务`
                    : '暂无可执行任务'}
                  disabled={totalCommandBusy || totalControl.kind === 'idle'}
                  onClick={runAll}
                >
                  <Play size={16} fill="currentColor" aria-hidden="true" />
                </button>
              )}
            </div>
            {headerTrailing}
          </header>

          <div className="class-task-add-area">
            <div
              className={`class-task-dropzone${isDragOver ? ' drag-over' : ''}`}
              aria-disabled={!workspaceRoot}
              tabIndex={workspaceRoot ? 0 : -1}
            >
              <div className="class-task-dropzone-prompt">
                <FilePlus2 size={18} aria-hidden="true" />
                <strong>{workspaceRoot ? '拖拽或粘贴文件到下方' : '请先打开工作区'}</strong>
              </div>
              <span
                className="class-task-capacity"
                title={`已添加 ${tasks.length} 个类，最多 ${MAX_CLASS_TASKS} 个`}
                aria-label={`已添加 ${tasks.length} 个类，最多 ${MAX_CLASS_TASKS} 个`}
              >
                {tasks.length}/{MAX_CLASS_TASKS}
              </span>
            </div>
          </div>

          <div
            className="class-task-card-list"
            aria-label="类任务空白区域"
            role="region"
            tabIndex={workspaceRoot ? 0 : -1}
            onClick={(event) => {
              if (event.currentTarget !== event.target) return;
              event.currentTarget.focus({ preventScroll: true });
              setListHint(null);
            }}
          >
            {displayedTasks.map((task) => (
              <div
                key={task.id}
                className={[
                  'class-task-card-drag-slot',
                  draggedTaskId === task.id ? 'dragging' : ''
                ].filter(Boolean).join(' ')}
                data-class-task-id={task.id}
                draggable={tasks.length > 1}
                ref={(element) => {
                  if (element) taskSlotRefs.current.set(task.id, element);
                  else taskSlotRefs.current.delete(task.id);
                }}
                onDragStart={(event) => handleTaskDragStart(event, task.id)}
                onDragOver={(event) => handleTaskDragOver(event, task.id)}
                onDrop={(event) => handleTaskDrop(event, task.id)}
                onDragEnd={handleTaskDragEnd}
              >
                <ClassTaskCard
                  task={task}
                  attentionAcknowledged={acknowledgedAttention.has(attentionKey(task))}
                  commandBusy={busyTaskIds.has(task.id)}
                  methodSelectionHintVisible={methodSelectionHintTaskIds.has(task.id)}
                  onIntent={handleCardIntent}
                />
              </div>
            ))}
            {isCapacityLimitVisible && (
              <div className="class-task-capacity-warning" role="status">
                <CircleAlert size={11} aria-hidden="true" />
                <span>最多添加5个</span>
              </div>
            )}
          </div>

          <footer className={listHint ? 'class-task-panel-hint empty-result' : 'class-task-panel-hint'}>
            {listHint ?? '点击任务查看运行结果'}
          </footer>

          {isTerminateDialogOpen && totalControl.kind === 'terminate' && (
            <TerminateAllDialog
              activeCount={totalControl.activeCount}
              busy={totalCommandBusy}
              onCancel={() => setIsTerminateDialogOpen(false)}
              onConfirm={() => {
                setIsTerminateDialogOpen(false);
                onTerminateAll();
              }}
            />
          )}
          {pendingDeleteTask && (
            <DeleteClassTaskDialog
              task={pendingDeleteTask}
              onCancel={() => setPendingDeleteTaskId(null)}
              onConfirm={() => {
                const taskId = pendingDeleteTask.id;
                setPendingDeleteTaskId(null);
                onCardIntent({ kind: 'delete', taskId });
              }}
            />
          )}
        </div>

        {showResultPage && activeResultTask && displayedActiveResult && createPortal(
          <div className="class-task-result-layer">
            <ClassTaskResultPage
              key={activeResultTask.id}
              task={activeResultTask}
              result={displayedActiveResult}
              actionBusy={resultActionBusy}
              actionError={resultActionError}
              onBack={closeResultPage}
              onAccept={() => runResultAction('accept')}
              onRevoke={() => runResultAction('revoke')}
            />
          </div>
        , document.body)}
      </div>
    </section>
  );
}

function isClassTaskReorderDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(CLASS_TASK_REORDER_MIME);
}

function attentionKey(task: ClassTaskSnapshot): string {
  return `${task.id}:${task.updatedAt}`;
}

type AddClassPathsResult = {
  acceptedCount: number;
  limitExceeded: boolean;
};

function parseClipboardClassPaths(text: string): string[] {
  return text
    .split(/\r\n|\n|\r/u)
    .map((line) => unquoteClipboardPath(line.trim()))
    .filter(Boolean);
}

function unquoteClipboardPath(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').toLocaleLowerCase();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

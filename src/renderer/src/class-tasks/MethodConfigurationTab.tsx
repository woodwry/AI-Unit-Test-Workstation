import { Check, Minus, Plus, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClassMethodCatalog,
  ClassMethodSummary,
  ClassTaskSnapshot,
  MethodSelectionMode
} from '../../../shared/class-task-contracts';
import {
  areAllMethodsSelected,
  createMethodListState,
  selectedMethodOrder,
  selectAllMethods,
  refreshMethodListState,
  setMethodQuery,
  setMethodSort,
  toggleMethodSelection,
  visibleMethodIds,
  type MethodListState,
  type MethodSortKey
} from './method-list-state';
import { inspectRagConfigurationReadiness } from '../rag-embedding-interface-state';
import { resolveRepairConfiguration } from './method-configuration-repair-state';
import './class-tasks.css';

export type MethodSelectionDraft = {
  selectionMode: MethodSelectionMode;
  selectedMethodIds: string[];
  methodOrder: string[];
  ragEnabled: boolean;
  repairAttemptLimit: number | null;
  unlimitedRepair: boolean;
};

type MethodConfigurationTabProps = {
  task: ClassTaskSnapshot;
  catalog: ClassMethodCatalog;
  isSaving?: boolean;
  isRefreshing?: boolean;
  saveError?: string | null;
  onRefresh: () => void | Promise<void>;
  onSave: (draft: MethodSelectionDraft) => boolean | Promise<boolean>;
};

type RagConfigurationState = 'idle' | 'checking' | 'configured' | 'unconfigured';

const SAVE_SUCCESS_VISIBLE_MS = 1800;

const METRIC_HEADERS: Array<{
  key: MethodSortKey;
  label: string;
  title: string;
  centered?: boolean;
}> = [
  {
    key: 'uncovered_instructions',
    label: '未覆盖指令',
    title: 'JaCoCo 未覆盖指令；点击排序'
  },
  {
    key: 'instruction_coverage',
    label: '指令覆盖率',
    title: '指令覆盖率；点击排序',
    centered: true
  },
  {
    key: 'uncovered_branches',
    label: '未覆盖分支',
    title: 'JaCoCo 未覆盖分支；点击排序'
  },
  {
    key: 'branch_coverage',
    label: '分支覆盖率',
    title: '分支覆盖率；点击排序',
    centered: true
  },
  {
    key: 'uncovered_complexity',
    label: '未覆盖圈复杂度',
    title: 'JaCoCo 未覆盖圈复杂度，表示仍需测试覆盖的独立路径复杂度；点击排序',
    centered: true
  },
  {
    key: 'total_complexity',
    label: '总圈复杂度',
    title: 'JaCoCo 统计的方法总圈复杂度；点击排序',
    centered: true
  },
  {
    key: 'uncovered_lines',
    label: '未覆盖行数',
    title: '完全没有执行到的可执行源码行数；点击排序',
    centered: true
  },
  {
    key: 'total_lines',
    label: '总行数',
    title: '该方法包含可执行字节码的源码总行数；点击排序',
    centered: true
  }
];

export function MethodConfigurationTab({
  task,
  catalog,
  isSaving = false,
  isRefreshing = false,
  saveError = null,
  onRefresh,
  onSave
}: MethodConfigurationTabProps): JSX.Element {
  const [listState, setListState] = useState<MethodListState>(() => createState(task, catalog));
  const [draftSelectionMode, setDraftSelectionMode] = useState(task.selectionMode);
  const [ragEnabled, setRagEnabled] = useState(task.ragEnabled);
  const [repairAttemptLimitInput, setRepairAttemptLimitInput] = useState(
    task.repairAttemptLimit?.toString() ?? ''
  );
  const [unlimitedRepair, setUnlimitedRepair] = useState(task.unlimitedRepair);
  const [ragConfigurationState, setRagConfigurationState] =
    useState<RagConfigurationState>('idle');
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [saveSuccessVisible, setSaveSuccessVisible] = useState(false);
  const ragCheckSequence = useRef(0);
  const listStateTaskId = useRef(task.id);

  useEffect(() => {
    const taskChanged = listStateTaskId.current !== task.id;
    listStateTaskId.current = task.id;
    setListState((current) => {
      const refreshed = taskChanged
        ? createState(task, catalog)
        : refreshMethodListState(current, catalog);
      return taskChanged
        ? refreshed
        : {
            ...refreshed,
            query: current.query,
            sortKey: current.sortKey,
            sortDirection: current.sortDirection
          };
    });
    if (taskChanged) {
      setDraftSelectionMode(task.selectionMode);
      setRepairAttemptLimitInput(task.repairAttemptLimit?.toString() ?? '');
      setUnlimitedRepair(task.unlimitedRepair);
      setSaveWarning(null);
    }
  }, [
    catalog,
    task.id,
    task.repairAttemptLimit,
    task.selectionMode,
    task.unlimitedRepair,
    task.updatedAt
  ]);

  useEffect(() => {
    ++ragCheckSequence.current;
    setRagEnabled(task.ragEnabled);
    setRagConfigurationState('idle');
  }, [task.id, task.ragEnabled]);

  useEffect(() => {
    setSaveSuccessVisible(false);
  }, [catalog, task.id]);

  useEffect(() => {
    if (!saveSuccessVisible) return undefined;
    const timeout = window.setTimeout(() => {
      setSaveSuccessVisible(false);
    }, SAVE_SUCCESS_VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [saveSuccessVisible]);

  const methodsById = useMemo(
    () => new Map(catalog.methods.map((method) => [method.methodId, method])),
    [catalog.methods]
  );
  const visibleMethods = useMemo(
    () => visibleMethodIds(listState)
      .map((methodId) => methodsById.get(methodId))
      .filter((method): method is ClassMethodSummary => Boolean(method)),
    [listState, methodsById]
  );
  const selectedIds = useMemo(() => new Set(listState.selectedMethodIds), [listState.selectedMethodIds]);
  const selectableCount = listState.methods.filter((method) => method.generatable).length;
  const selectedCount = listState.selectedMethodIds.length;
  const allSelected = areAllMethodsSelected(listState);
  const configurationLocked = isConfigurationLocked(task.state);
  const ragUnconfigured = ragConfigurationState === 'unconfigured';
  const refreshLocked = isSaving
    || isRefreshing
    || ragConfigurationState === 'checking';
  const selectionLocked = isSaving
    || isRefreshing
    || configurationLocked
    || ragConfigurationState === 'checking';

  const changeSort = (sortKey: MethodSortKey): void => {
    setSaveSuccessVisible(false);
    setListState((current) => {
      if (current.sortKey !== sortKey) return setMethodSort(current, sortKey, 'desc');
      if (current.sortDirection === 'desc') return setMethodSort(current, sortKey, 'asc');
      return setMethodSort(current, 'jacoco', 'asc');
    });
  };

  const stepRepairAttemptLimit = (direction: -1 | 1): void => {
    const parsed = Number(repairAttemptLimitInput);
    const current = Number.isSafeInteger(parsed) && parsed >= 1
      ? parsed
      : direction === 1 ? 0 : 1;
    const next = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, current + direction));
    setSaveSuccessVisible(false);
    setSaveWarning(null);
    setRepairAttemptLimitInput(String(next));
  };

  const save = (): void => {
    void saveConfiguration();
  };

  const saveConfiguration = async (): Promise<void> => {
    if (ragConfigurationState === 'checking') return;
    setSaveSuccessVisible(false);
    const repairConfiguration = resolveRepairConfiguration(
      repairAttemptLimitInput,
      unlimitedRepair
    );
    if (!repairConfiguration.valid) {
      setSaveWarning(repairConfiguration.message);
      return;
    }
    if (selectedCount === 0) {
      setSaveWarning('请至少选择一个方法');
      return;
    }
    if (ragEnabled) {
      const sequence = ++ragCheckSequence.current;
      const configured = await inspectRagConfiguration(
        sequence,
        ragCheckSequence,
        setRagConfigurationState
      );
      if (configured === null) return;
      setRagEnabled(configured);
      if (!configured) return;
    }
    setSaveWarning(null);
    const methodOrder = selectedMethodOrder(listState);
    const saved = await onSave({
      selectionMode: draftSelectionMode,
      selectedMethodIds: draftSelectionMode === 'ALL_BY_DEFAULT' ? [] : methodOrder,
      methodOrder: draftSelectionMode === 'ALL_BY_DEFAULT' ? [] : methodOrder,
      ragEnabled,
      repairAttemptLimit: repairConfiguration.repairAttemptLimit,
      unlimitedRepair: repairConfiguration.unlimitedRepair
    });
    setSaveSuccessVisible(saved);
  };

  return (
    <section
      className="class-task-method-page"
      aria-label={`${task.qualifiedClassName} 方法配置`}
      onPointerDown={(event) => {
        if (!ragUnconfigured) return;
        const target = event.target;
        if (
          target instanceof Element
          && target.closest('.class-task-rag-control, .class-task-rag-warning')
        ) return;
        setRagConfigurationState('idle');
      }}
    >
      <header className="class-task-method-heading">
        <div className="class-task-method-title">
          <strong title={task.qualifiedClassName}>{shortClassName(task.qualifiedClassName)}</strong>
          <span title={task.qualifiedClassName}>{task.qualifiedClassName}</span>
        </div>

        <div className="class-task-method-heading-actions">
          {ragUnconfigured && (
            <span
              id={`rag-warning-${task.id}`}
              className="class-task-rag-warning"
              role="alert"
            >
              请先在设置中完成 Embedding 配置
            </span>
          )}
          {saveSuccessVisible && (
            <span className="class-task-method-save-success" role="status">
              <Check size={13} strokeWidth={2.5} aria-hidden="true" />
              保存成功
            </span>
          )}
          <button
            type="button"
            className="class-task-method-refresh"
            aria-label="刷新方法与覆盖率信息"
            title="刷新方法与覆盖率信息"
            disabled={refreshLocked}
            onClick={() => void onRefresh()}
          >
            <RefreshCw className={isRefreshing ? 'spin' : undefined} size={14} aria-hidden="true" />
            <span>{isRefreshing ? '刷新中…' : '刷新'}</span>
          </button>
          <div className="class-task-repair-control">
            <div className="class-task-repair-limit">
              <label
                className="class-task-repair-limit-label"
                htmlFor={`repair-attempt-limit-${task.id}`}
              >
                修复轮次
              </label>
              <div className="class-task-repair-stepper">
                <button
                  type="button"
                  className="class-task-repair-step-button"
                  aria-label="减少修复轮次"
                  title="减少修复轮次"
                  disabled={selectionLocked || unlimitedRepair}
                  onClick={() => stepRepairAttemptLimit(-1)}
                >
                  <Minus size={11} strokeWidth={2.4} aria-hidden="true" />
                </button>
                <input
                  id={`repair-attempt-limit-${task.id}`}
                  className="class-task-repair-limit-input"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={repairAttemptLimitInput}
                  disabled={selectionLocked || unlimitedRepair}
                  aria-label="修复轮次"
                  onChange={(event) => {
                    setSaveSuccessVisible(false);
                    setSaveWarning(null);
                    setRepairAttemptLimitInput(event.target.value);
                  }}
                />
                <button
                  type="button"
                  className="class-task-repair-step-button"
                  aria-label="增加修复轮次"
                  title="增加修复轮次"
                  disabled={selectionLocked || unlimitedRepair}
                  onClick={() => stepRepairAttemptLimit(1)}
                >
                  <Plus size={11} strokeWidth={2.4} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
          <div className="class-task-rag-control">
            <label
              className={`class-task-rag-option${ragUnconfigured ? ' unconfigured' : ''}`}
              title="基于RAG提升单元测试质量"
            >
              <input
                type="checkbox"
                checked={ragEnabled}
                disabled={selectionLocked}
                aria-describedby={ragUnconfigured ? `rag-warning-${task.id}` : undefined}
                onChange={(event) => {
                  setSaveSuccessVisible(false);
                  const sequence = ++ragCheckSequence.current;
                  if (!event.target.checked) {
                    setRagEnabled(false);
                    setRagConfigurationState('idle');
                    return;
                  }
                  setRagEnabled(true);
                  void inspectRagConfiguration(
                    sequence,
                    ragCheckSequence,
                    setRagConfigurationState
                  ).then((configured) => {
                    if (configured !== null) setRagEnabled(configured);
                  });
                }}
              />
              <span aria-hidden="true" className="class-task-rag-checkmark">
                <Check size={10} strokeWidth={2.4} />
              </span>
              <strong>RAG</strong>
            </label>
          </div>

          <span className="class-task-method-summary" aria-live="polite">
            已选择 <strong>{selectedCount}</strong> / <strong>{selectableCount}</strong>
          </span>
          <button
            className="class-task-method-select-all"
            type="button"
            aria-pressed={allSelected}
            disabled={selectionLocked}
            onClick={() => {
              setSaveSuccessVisible(false);
              setSaveWarning(null);
              setDraftSelectionMode('EXPLICIT');
              setListState(selectAllMethods);
            }}
          >
            <span aria-hidden="true">{allSelected && <Check size={10} strokeWidth={2.4} />}</span>
            全选
          </button>
          <div className="class-task-method-save-control">
            <button
              className="class-task-method-save"
              type="button"
              disabled={selectionLocked}
              onClick={save}
            >
              {isSaving ? '正在保存…' : '保存配置'}
            </button>
            {(saveWarning || saveError) && (
              <span className="class-task-method-save-warning" role="alert">
                {saveWarning ?? saveError}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="class-task-method-toolbar">
        <label className="class-task-method-query">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={listState.query}
            placeholder="可在此处搜索方法"
            aria-label="可在此处搜索方法"
            onChange={(event) => setListState((current) => setMethodQuery(current, event.target.value))}
          />
        </label>
      </div>

      <div className="class-task-method-table" role="region" aria-label="类方法及覆盖情况">
        <table>
          <colgroup>
            <col className="class-task-method-col-select" />
            <col className="class-task-method-col-name" />
            <col className="class-task-method-col-bar" />
            <col className="class-task-method-col-rate" />
            <col className="class-task-method-col-bar" />
            <col className="class-task-method-col-rate" />
            <col className="class-task-method-col-number" />
            <col className="class-task-method-col-number" />
            <col className="class-task-method-col-number" />
            <col className="class-task-method-col-number" />
          </colgroup>
          <thead>
            <tr>
              <th className="center" scope="col"><span>选择</span></th>
              <th scope="col"><span>方法</span></th>
              {METRIC_HEADERS.map((header) => (
                <SortableHeader
                  key={header.key}
                  sortKey={header.key}
                  label={header.label}
                  title={header.title}
                  centered={header.centered}
                  activeSortKey={listState.sortKey}
                  activeDirection={listState.sortDirection}
                  onChange={changeSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleMethods.map((method) => {
              const checked = selectedIds.has(method.methodId);
              const unavailableTitle = method.unavailableReason ?? '当前方法不可生成单元测试';
              return (
                <tr
                  key={method.methodId}
                  className={`class-task-method-row${checked ? ' selected' : ''}${method.generatable ? '' : ' unavailable'}`}
                  aria-disabled={!method.generatable || selectionLocked}
                  title={method.generatable ? undefined : unavailableTitle}
                  tabIndex={method.generatable && !selectionLocked ? 0 : -1}
                  onClick={() => {
                    if (!method.generatable || selectionLocked) return;
                    setSaveSuccessVisible(false);
                    setSaveWarning(null);
                    setDraftSelectionMode('EXPLICIT');
                    setListState((current) => toggleMethodSelection(current, method.methodId));
                  }}
                  onKeyDown={(event) => {
                    if (!method.generatable || selectionLocked) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSaveSuccessVisible(false);
                      setSaveWarning(null);
                      setDraftSelectionMode('EXPLICIT');
                      setListState((current) => toggleMethodSelection(current, method.methodId));
                    }
                  }}
                >
                  <td className="class-task-method-check-cell">
                    <button
                      type="button"
                      className="class-task-method-checkbox"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={`${checked ? '取消选择' : '选择'} ${method.displaySignature}`}
                      disabled={!method.generatable || selectionLocked}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSaveSuccessVisible(false);
                        setSaveWarning(null);
                        setDraftSelectionMode('EXPLICIT');
                        setListState((current) => toggleMethodSelection(current, method.methodId));
                      }}
                    >
                      {checked && <Check size={11} strokeWidth={2.4} aria-hidden="true" />}
                    </button>
                  </td>
                  <td className="class-task-method-signature" title={method.displaySignature}>
                    <strong>{method.displaySignature}</strong>
                  </td>
                  <CoverageBarCell
                    label="指令覆盖"
                    covered={method.instructionCovered}
                    missed={method.instructionMissed}
                  />
                  <CoverageRateCell covered={method.instructionCovered} missed={method.instructionMissed} />
                  <CoverageBarCell
                    label="分支覆盖"
                    covered={method.branchCovered}
                    missed={method.branchMissed}
                  />
                  <CoverageRateCell covered={method.branchCovered} missed={method.branchMissed} />
                  <NumberCell value={method.complexityMissed} />
                  <NumberCell value={method.complexityCovered + method.complexityMissed} />
                  <NumberCell value={method.lineMissed} />
                  <NumberCell value={method.lineCovered + method.lineMissed} />
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="class-task-method-total-row" aria-label="JaCoCo 报告总计">
              <td className="class-task-method-check-cell" aria-hidden="true" />
              <td className="class-task-method-total-label">
                <strong>总计</strong>
              </td>
              <CoverageCountCell
                label="未覆盖指令总计"
                covered={catalog.reportCoverageTotals.instructionCovered}
                missed={catalog.reportCoverageTotals.instructionMissed}
              />
              <CoverageRateCell
                covered={catalog.reportCoverageTotals.instructionCovered}
                missed={catalog.reportCoverageTotals.instructionMissed}
                wholePercent
              />
              <CoverageCountCell
                label="未覆盖分支总计"
                covered={catalog.reportCoverageTotals.branchCovered}
                missed={catalog.reportCoverageTotals.branchMissed}
              />
              <CoverageRateCell
                covered={catalog.reportCoverageTotals.branchCovered}
                missed={catalog.reportCoverageTotals.branchMissed}
                wholePercent
              />
              <NumberCell value={catalog.reportCoverageTotals.complexityMissed} />
              <NumberCell
                value={catalog.reportCoverageTotals.complexityCovered
                  + catalog.reportCoverageTotals.complexityMissed}
              />
              <NumberCell value={catalog.reportCoverageTotals.lineMissed} />
              <NumberCell
                value={catalog.reportCoverageTotals.lineCovered
                  + catalog.reportCoverageTotals.lineMissed}
              />
            </tr>
          </tfoot>
        </table>

        {visibleMethods.length === 0 && (
          <div className="class-task-method-empty">没有符合查询条件的方法</div>
        )}
      </div>

    </section>
  );
}

function SortableHeader({
  sortKey,
  label,
  title,
  centered = false,
  activeSortKey,
  activeDirection,
  onChange
}: {
  sortKey: MethodSortKey;
  label: string;
  title: string;
  centered?: boolean;
  activeSortKey: MethodSortKey;
  activeDirection: MethodListState['sortDirection'];
  onChange: (sortKey: MethodSortKey) => void;
}): JSX.Element {
  const direction = activeSortKey === sortKey ? activeDirection : 'none';
  return (
    <th
      className={centered ? 'center' : undefined}
      scope="col"
      aria-sort={direction === 'none' ? 'none' : direction === 'asc' ? 'ascending' : 'descending'}
    >
      <button
        type="button"
        className="class-task-method-sort"
        data-direction={direction}
        title={title}
        onClick={() => onChange(sortKey)}
      >
        <span>{label}</span>
        <i aria-hidden="true" />
      </button>
    </th>
  );
}

function CoverageBarCell({
  label,
  covered,
  missed
}: {
  label: string;
  covered: number;
  missed: number;
}): JSX.Element {
  const total = covered + missed;
  const missedPercentage = total === 0 ? 0 : (missed / total) * 100;
  const coveredPercentage = total === 0 ? 0 : (covered / total) * 100;
  return (
    <td title={`${label}：已覆盖 ${covered}，未覆盖 ${missed}`}>
      <span className="class-task-method-coverage-bar" aria-label={`${label} ${formatCoverage(covered, missed)}`}>
        <i className="missed" style={{ width: `${missedPercentage}%` }} />
        <i className="covered" style={{ width: `${coveredPercentage}%` }} />
      </span>
    </td>
  );
}

function CoverageCountCell({
  label,
  covered,
  missed
}: {
  label: string;
  covered: number;
  missed: number;
}): JSX.Element {
  const total = covered + missed;
  const text = total === 0
    ? '-'
    : `${missed.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
  return (
    <td className="class-task-method-number" title={`${label}：${text}`}>
      {text}
    </td>
  );
}

function CoverageRateCell({
  covered,
  missed,
  wholePercent = false
}: {
  covered: number;
  missed: number;
  wholePercent?: boolean;
}): JSX.Element {
  return <td className="class-task-method-number">{formatCoverage(covered, missed, wholePercent)}</td>;
}

function NumberCell({ value }: { value: number }): JSX.Element {
  return <td className="class-task-method-number">{value}</td>;
}

async function inspectRagConfiguration(
  sequence: number,
  sequenceRef: { current: number },
  setState: (state: RagConfigurationState) => void
): Promise<boolean | null> {
  setState('checking');
  try {
    const configured = await inspectRagConfigurationReadiness({
      getRagEmbeddingInterfaces: () => window.workstation.getRagEmbeddingInterfaces()
    });
    if (sequenceRef.current !== sequence) return null;
    setState(configured ? 'configured' : 'unconfigured');
    return configured;
  } catch {
    if (sequenceRef.current !== sequence) return null;
    setState('unconfigured');
    return false;
  }
}

function isConfigurationLocked(state: ClassTaskSnapshot['state']): boolean {
  return ['PRELOADING', 'PRELOAD_FAILED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING']
    .includes(state);
}

function createState(task: ClassTaskSnapshot, catalog: ClassMethodCatalog): MethodListState {
  return createMethodListState(
    catalog,
    task.selectionMode === 'EXPLICIT' ? task.selectedMethodIds : undefined
  );
}

function shortClassName(qualifiedClassName: string): string {
  return qualifiedClassName.split('.').pop() ?? qualifiedClassName;
}

function formatCoverage(covered: number, missed: number, wholePercent = false): string {
  const total = covered + missed;
  if (total === 0) return '-';
  const value = (covered / total) * 100;
  if (wholePercent) return `${Math.floor(value)}%`;
  return `${value.toFixed(value >= 99.95 || Number.isInteger(value) ? 0 : 1)}%`;
}

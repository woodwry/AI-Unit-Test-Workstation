import {
  ArrowLeft,
  Check,
  CircleAlert,
  LoaderCircle,
  Pause,
  Square,
  Undo2,
  X
} from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type {
  ClassTaskResultSnapshot,
  ClassTaskSnapshot,
  GeneratedClassTaskArtifact
} from '../../../shared/class-task-contracts';
import { CoverageRing } from './CoverageRing';
import {
  buildCoverageView,
  resolveClassTaskResultStatus,
  shouldShowClassTaskResultActions,
  type CoverageMetricKind,
  type CoverageMetricView
} from './coverage-view';
import {
  buildClassTaskResultProgress,
  buildClassTaskResultMethodRows,
  buildClassTaskResultSummary
} from './class-task-result-view';
import { resolveTokenUsageDisplay } from '../model-token-usage';
import { useDraggableDialog } from '../use-draggable-dialog';

type ClassTaskResultPageProps = {
  task: ClassTaskSnapshot;
  result: ClassTaskResultSnapshot;
  actionBusy: boolean;
  actionError: string | null;
  onBack: () => void;
  onAccept: () => void;
  onRevoke: () => void;
};

export function ClassTaskResultPage({
  task,
  result,
  actionBusy,
  actionError,
  onBack,
  onAccept,
  onRevoke
}: ClassTaskResultPageProps): JSX.Element {
  const { dialogRef, dialogStyle, dragHandleProps } =
    useDraggableDialog<HTMLElement>(task.id);
  const [dialogMetric, setDialogMetric] = useState<CoverageMetricKind | null>(null);
  const view = useMemo(() => buildCoverageView(result), [result]);
  const methodRows = useMemo(() => buildClassTaskResultMethodRows(result), [result]);
  const summary = useMemo(() => buildClassTaskResultSummary(result), [result]);
  const status = resolveClassTaskResultStatus(task.state);
  const showActions = shouldShowClassTaskResultActions(result);
  const selectedMetric = dialogMetric === null ? null : view[dialogMetric];
  const accepted = result.artifacts.length > 0
    && result.artifacts.every((artifact) => artifact.accepted);
  const className = task.qualifiedClassName.split('.').pop() ?? task.qualifiedClassName;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (dialogMetric !== null) setDialogMetric(null);
      else onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dialogMetric, onBack]);

  const handleBackdropPointerDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.currentTarget !== event.target) return;
    dialogRef.current?.classList.remove('attention');
    void dialogRef.current?.offsetWidth;
    dialogRef.current?.classList.add('attention');
  };

  return (
    <div className="class-task-result-backdrop" onMouseDown={handleBackdropPointerDown}>
      <section
        ref={dialogRef}
        style={dialogStyle}
        className="class-task-result-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-task-result-title"
        onAnimationEnd={() => dialogRef.current?.classList.remove('attention')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="class-task-result-header" {...dragHandleProps}>
          <div className="class-task-result-header-main">
            {dialogMetric !== null && (
              <button
                type="button"
                className="class-task-result-back"
                title="返回结果页"
                aria-label="返回结果页"
                onClick={() => setDialogMetric(null)}
              >
                <ArrowLeft size={18} aria-hidden="true" />
              </button>
            )}
            <div>
              <strong id="class-task-result-title">
                {selectedMetric ? `${selectedMetric.label}新增详情` : `${className}.java`}
              </strong>
              {dialogMetric === null && <span>单元测试生成结果</span>}
            </div>
          </div>
          <button
            type="button"
            className="class-task-result-close"
            title="关闭运行结果"
            aria-label="关闭运行结果"
            onClick={onBack}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {dialogMetric === null ? (
          <ResultOverview
            task={task}
            result={result}
            accepted={accepted}
            status={status}
            summary={summary}
            methodRows={methodRows}
            lines={view.lines}
            branches={view.branches}
            onOpenContributions={setDialogMetric}
          />
        ) : selectedMetric ? (
          <ContributionDetail metric={selectedMetric} />
        ) : null}

        {dialogMetric === null && (
          <footer className="class-task-result-footer">
            <span className={actionError ? 'error' : ''}>{actionError}</span>
            {showActions && (
              <div className="class-task-result-actions">
                {result.canRevoke && (
                  <button type="button" disabled={actionBusy} onClick={onRevoke}>
                    <Undo2 size={18} aria-hidden="true" />
                    <span>撤回</span>
                  </button>
                )}
                {result.canAccept && (
                  <button
                    type="button"
                    className="primary"
                    disabled={actionBusy}
                    onClick={onAccept}
                  >
                    <Check size={18} aria-hidden="true" />
                    <span>接受</span>
                  </button>
                )}
              </div>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}

type ResultOverviewProps = {
  task: ClassTaskSnapshot;
  result: ClassTaskResultSnapshot;
  accepted: boolean;
  status: ReturnType<typeof resolveClassTaskResultStatus>;
  summary: ReturnType<typeof buildClassTaskResultSummary>;
  methodRows: ReturnType<typeof buildClassTaskResultMethodRows>;
  lines: CoverageMetricView;
  branches: CoverageMetricView;
  onOpenContributions: (metric: CoverageMetricKind) => void;
};

function ResultOverview({
  task,
  result,
  accepted,
  status,
  summary,
  methodRows,
  lines,
  branches,
  onOpenContributions
}: ResultOverviewProps): JSX.Element {
  const tokenUsageDisplay = resolveTokenUsageDisplay(
    result.tokenUsage ?? undefined,
    result.modelCallCount ?? undefined,
    result.usageReportedCallCount ?? undefined
  );
  const progress = buildClassTaskResultProgress(task, result, summary);
  return (
    <div className="class-task-result-scroll">
      <section className="class-task-result-overview" aria-label="生成结果概览">
        <div className="class-task-result-completion">
          <span className={`class-task-result-completion-icon ${status.tone}`} aria-hidden="true">
            <ResultStatusIcon tone={status.tone} />
          </span>
          <div>
            <strong>{progress.heading}</strong>
            <span>{progress.description}</span>
          </div>
          <span className={`class-task-result-overview-status ${status.tone}`}>
            {accepted ? '已接受' : status.label}
          </span>
        </div>
        <dl className="class-task-result-metrics">
          <div><dt>总用时</dt><dd>{formatElapsed(task.startedAt, task.finishedAt)}</dd></div>
          <div><dt>Token</dt><dd>{tokenUsageDisplay.total}</dd></div>
          <div><dt>正式文件</dt><dd>{summary.formalFileCount} 个</dd></div>
        </dl>
      </section>

      <ResultSectionHeading
        title="覆盖情况"
        trailing={accepted ? '当前覆盖率' : '本次生成前 → 当前'}
      />
      <section className="class-task-result-coverage-panel" aria-label="覆盖情况">
        <div className="class-task-result-coverage-summary">
          <CoverageChangeSummary metric={lines} />
          <CoverageChangeSummary metric={branches} />
        </div>
        <div className="class-task-result-coverage">
          <CoverageRing metric={lines} onOpenContributions={() => onOpenContributions('lines')} />
          <CoverageRing metric={branches} onOpenContributions={() => onOpenContributions('branches')} />
        </div>
      </section>

      <ResultSectionHeading
        title="方法结果"
        trailing={progress.methodCountLabel}
      />
      <section className="class-task-result-generation-list" aria-label="方法结果">
        {methodRows.map((row, index) => (
          <article key={row.rowId} className={row.legacy ? 'legacy' : ''}>
            <span className="class-task-result-generation-index">{index + 1}</span>
            <code title={row.displaySignature}>{row.methodName}</code>
            <span title={row.filePath}>{row.fileName}</span>
            <b>{row.testMethodCount} 个测试</b>
          </article>
        ))}
        {methodRows.length === 0 && <div className="class-task-result-empty">暂无方法结果</div>}
      </section>

      <ResultSectionHeading title="本次生成文件" trailing={`${result.artifacts.length} 个`} />
      <section className="class-task-result-file-list" aria-label="本次生成文件">
        {result.artifacts.map((artifact) => (
          <GeneratedFileRow key={artifact.id} artifact={artifact} methodRows={methodRows} />
        ))}
        {result.artifacts.length === 0 && <div className="class-task-result-empty">暂无生成文件</div>}
      </section>
    </div>
  );
}

function ResultSectionHeading({ title, trailing }: { title: string; trailing: string }): JSX.Element {
  return (
    <div className="class-task-result-section-heading">
      <strong>{title}</strong>
      <span>{trailing}</span>
    </div>
  );
}

function ResultStatusIcon({
  tone
}: {
  tone: ResultOverviewProps['status']['tone'];
}): JSX.Element {
  switch (tone) {
    case 'success': return <Check size={22} />;
    case 'terminated': return <Square size={18} />;
    case 'active': return <LoaderCircle size={22} />;
    case 'warning': return <CircleAlert size={21} />;
    case 'neutral': return <Pause size={20} />;
  }
}

function CoverageChangeSummary({ metric }: { metric: CoverageMetricView }): JSX.Element {
  return (
    <section
      className={`class-task-result-change-summary${metric.available ? '' : ' unavailable'}`}
      aria-label={`${metric.label}变化`}
    >
      <header>
        <strong>{metric.label}</strong>
        {metric.available && (
          <span>{metric.currentCovered}/{metric.total} {metric.unitLabel}</span>
        )}
      </header>
      <div className="class-task-result-change-values">
        {metric.accepted ? (
          <b>{metric.currentLabel}</b>
        ) : (
          <>
            <b>{metric.originalLabel}</b>
            <i aria-hidden="true">→</i>
            <b>{metric.currentLabel}</b>
            <em>新增 {metric.addedLabel.replace(/^\+/, '')}</em>
          </>
        )}
      </div>
      <div
        className="class-task-result-change-bar"
        aria-label={metric.available
          ? metric.accepted
            ? `已覆盖 ${metric.currentLabel}，未覆盖 ${metric.uncoveredLabel}`
            : `原覆盖 ${metric.originalLabel}，新增 ${metric.addedLabel}，未覆盖 ${metric.uncoveredLabel}`
          : '本次生成的单元测试未涉及分支'}
      >
        {metric.segments.map((segment) => (
          <span
            key={segment.kind}
            className={segment.kind}
            style={{ width: `${segment.percent}%` }}
          />
        ))}
      </div>
    </section>
  );
}

function ContributionDetail({ metric }: { metric: CoverageMetricView }): JSX.Element {
  return (
    <div className="class-task-result-detail">
      <dl className="class-task-result-detail-metrics">
        <div><dt>原覆盖率</dt><dd>{metric.originalLabel}</dd></div>
        <div><dt>当前覆盖率</dt><dd>{metric.currentLabel}</dd></div>
        <div className="added"><dt>本次新增</dt><dd>{metric.addedLabel}</dd></div>
      </dl>
      <div className="class-task-result-detail-table-wrap">
        <table className="class-task-result-detail-table">
          <thead>
            <tr><th>排名</th><th>测试文件</th><th>提升覆盖率</th></tr>
          </thead>
          <tbody>
            {metric.contributions.map((contribution, index) => (
              <tr key={contribution.artifactId}>
                <td>{index + 1}</td>
                <td title={contribution.filePath}>{contribution.fileName}</td>
                <td>{contribution.percentLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {metric.contributions.length === 0 && (
          <div className="class-task-result-empty">暂无可用的单文件覆盖率贡献记录</div>
        )}
      </div>
    </div>
  );
}

function GeneratedFileRow({
  artifact,
  methodRows
}: {
  artifact: GeneratedClassTaskArtifact;
  methodRows: ReturnType<typeof buildClassTaskResultMethodRows>;
}): JSX.Element {
  const methodNames = methodRows
    .filter((row) => row.filePath === artifact.filePath)
    .map((row) => row.methodName)
    .join('、');
  const fileName = artifact.filePath.split(/[\\/]/).at(-1) ?? artifact.filePath;
  return (
    <article>
      <code title={artifact.filePath}>{fileName}</code>
      <span title={methodNames}>{methodNames || `${artifact.ordinaryTestMethodCount} 个测试`}</span>
    </article>
  );
}

function formatElapsed(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '--';
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '--';
  const totalSeconds = Math.floor((end - start) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

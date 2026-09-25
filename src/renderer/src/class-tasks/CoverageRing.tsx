import { useState, type KeyboardEvent } from 'react';
import type { CoverageMetricView, CoverageSegmentView } from './coverage-view';

type CoverageRingProps = {
  metric: CoverageMetricView;
  onOpenContributions: (metric: CoverageMetricView) => void;
};

export function CoverageRing({
  metric,
  onOpenContributions
}: CoverageRingProps): JSX.Element {
  const [isContributionHoverOpen, setIsContributionHoverOpen] = useState(false);
  const addedSegment = metric.segments.find((segment) => segment.kind === 'added');
  const canOpenContributions = Boolean(metric.available && addedSegment && addedSegment.count > 0);

  const openContributions = (): void => {
    if (canOpenContributions) onOpenContributions(metric);
  };
  const handleAddedKeyDown = (event: KeyboardEvent<SVGCircleElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openContributions();
  };

  return (
    <section className="class-task-coverage-card" aria-label={metric.label}>
      <header className="class-task-coverage-card-heading">
        <strong>{metric.label}</strong>
        <span className={metric.available ? '' : 'unavailable'}>
          {metric.accepted
            ? `当前 ${metric.currentLabel}`
            : `新增 ${metric.addedLabel.replace(/^\+/, '')}`}
        </span>
      </header>
      <div className="class-task-coverage-card-body">
        <div className="class-task-coverage-ring-wrap">
          <svg
            className="class-task-coverage-ring"
            viewBox="0 0 100 100"
            role="img"
            aria-label={`${metric.label}，当前 ${metric.currentLabel}`}
          >
            <circle className="class-task-coverage-ring-track" cx="50" cy="50" r="41" pathLength="100" />
            {metric.segments.map((segment) => (
              <CoverageArc
                key={segment.kind}
                segment={segment}
                interactive={segment.kind === 'added' && canOpenContributions}
                onClick={openContributions}
                onFocus={() => setIsContributionHoverOpen(true)}
                onBlur={() => setIsContributionHoverOpen(false)}
                onMouseEnter={() => setIsContributionHoverOpen(true)}
                onMouseLeave={() => setIsContributionHoverOpen(false)}
                onKeyDown={handleAddedKeyDown}
              />
            ))}
          </svg>
          <div className="class-task-coverage-ring-center" aria-hidden="true">
            <strong>{metric.currentLabel}</strong>
          </div>

          {isContributionHoverOpen && canOpenContributions && (
            <div className="class-task-coverage-hover" role="tooltip">
              <strong>{metric.label}新增贡献</strong>
              <div>
                {metric.contributions.map((contribution) => (
                  <span key={contribution.artifactId} title={contribution.filePath}>
                    <code>{contribution.fileName}</code>
                    <b>{contribution.percentLabel}</b>
                  </span>
                ))}
                {metric.contributions.length === 0 && <small>暂无单文件贡献记录</small>}
              </div>
              <small>点击蓝色区域查看全部详情</small>
            </div>
          )}
        </div>

        <dl className="class-task-coverage-legend">
          <div className="original">
            <i aria-hidden="true" />
            <dt>{metric.accepted ? '已覆盖' : '原有'}</dt>
            <dd>{metric.originalLabel}</dd>
          </div>
          {!metric.accepted && (
            <div className="added">
              <i aria-hidden="true" />
              <dt>新增</dt>
              <dd>{metric.addedLabel.replace(/^\+/, '')}</dd>
            </div>
          )}
          <div className="uncovered">
            <i aria-hidden="true" />
            <dt>未覆盖</dt>
            <dd>{metric.uncoveredLabel}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

type CoverageArcProps = {
  segment: CoverageSegmentView;
  interactive: boolean;
  onClick: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onKeyDown: (event: KeyboardEvent<SVGCircleElement>) => void;
};

function CoverageArc({
  segment,
  interactive,
  onClick,
  onFocus,
  onBlur,
  onMouseEnter,
  onMouseLeave,
  onKeyDown
}: CoverageArcProps): JSX.Element | null {
  if (segment.percent <= 0) return null;
  return (
    <circle
      className={`class-task-coverage-segment ${segment.kind}${interactive ? ' interactive' : ''}`}
      cx="50"
      cy="50"
      r="41"
      pathLength="100"
      stroke={segment.color}
      strokeDasharray={`${segment.percent} ${100 - segment.percent}`}
      strokeDashoffset={-segment.offsetPercent}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `新增覆盖 ${segment.percent}%，查看贡献文件` : `${segment.label} ${segment.percent}%`}
      onClick={interactive ? onClick : undefined}
      onFocus={interactive ? onFocus : undefined}
      onBlur={interactive ? onBlur : undefined}
      onMouseEnter={interactive ? onMouseEnter : undefined}
      onMouseLeave={interactive ? onMouseLeave : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
    />
  );
}

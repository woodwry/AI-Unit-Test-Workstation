import type {
  ClassTaskResultSnapshot,
  ClassTaskState,
  CoverageContribution,
  ExactCoverageCounts,
  GeneratedClassTaskArtifact
} from '../../../shared/class-task-contracts';

export type CoverageMetricKind = 'lines' | 'branches';
export type CoverageSegmentKind = 'original' | 'added' | 'uncovered';

export type CoverageSegmentView = {
  kind: CoverageSegmentKind;
  label: string;
  count: number;
  percent: number;
  offsetPercent: number;
  color: string;
};

export type CoverageContributionView = {
  fileId: string;
  artifactId: string;
  fileName: string;
  filePath: string;
  testClassName: string;
  addedCount: number;
  totalCount: number;
  percent: number;
  percentLabel: string;
  cumulativeCovered: number;
  cumulativeLabel: string;
};

export type CoverageMetricView = {
  kind: CoverageMetricKind;
  label: string;
  unitLabel: string;
  available: boolean;
  accepted: boolean;
  total: number;
  currentCovered: number;
  counts: {
    original: number;
    added: number;
    uncovered: number;
  };
  segments: CoverageSegmentView[];
  originalLabel: string;
  addedLabel: string;
  currentLabel: string;
  uncoveredLabel: string;
  contributions: CoverageContributionView[];
};

export type ClassTaskCoverageView = {
  lines: CoverageMetricView;
  branches: CoverageMetricView;
};

export type ClassTaskResultStatusView = {
  label: string;
  tone: 'success' | 'terminated' | 'active' | 'warning' | 'neutral';
};

export type ContributionOutsideClickSource = 'right_backdrop' | 'left_panel' | 'center_panel';
export type ContributionOutsideClickAction = 'shake' | 'ignore';

const SEGMENTS: Array<{
  kind: CoverageSegmentKind;
  label: string;
  color: string;
}> = [
  { kind: 'original', label: '原覆盖', color: '#62b985' },
  { kind: 'added', label: '新增覆盖', color: '#4b9dea' },
  { kind: 'uncovered', label: '未覆盖', color: '#525c65' }
];

export function buildCoverageView(result: ClassTaskResultSnapshot): ClassTaskCoverageView {
  const artifactById = new Map(result.artifacts.map((artifact) => [artifact.id, artifact]));
  const acceptedArtifactIds = new Set(
    result.artifacts.filter((artifact) => artifact.accepted).map((artifact) => artifact.id)
  );
  const accepted = result.artifacts.length > 0
    && result.artifacts.every((artifact) => artifact.accepted);
  return {
    lines: buildMetricView(
      'lines',
      result.coverageBaseline,
      result.coverageCurrent,
      result.coverageContributions,
      artifactById,
      accepted,
      acceptedArtifactIds
    ),
    branches: buildMetricView(
      'branches',
      result.coverageBaseline,
      result.coverageCurrent,
      result.coverageContributions,
      artifactById,
      accepted,
      acceptedArtifactIds
    )
  };
}

export function resolveClassTaskResultStatus(state: ClassTaskState): ClassTaskResultStatusView {
  switch (state) {
    case 'COMPLETED': return { label: '已完成', tone: 'success' };
    case 'TERMINATED': return { label: '已终止', tone: 'terminated' };
    case 'RUNNING': return { label: '执行中', tone: 'active' };
    case 'PAUSE_REQUESTED': return { label: '正在暂停', tone: 'active' };
    case 'PAUSED': return { label: '已暂停', tone: 'neutral' };
    case 'STOPPING': return { label: '正在终止', tone: 'active' };
    case 'PRELOADING': return { label: '正在预加载', tone: 'active' };
    case 'READY': return { label: '待执行', tone: 'neutral' };
    case 'PRELOAD_FAILED': return { label: 'Maven 执行失败', tone: 'warning' };
    case 'FAILED': return { label: '执行失败', tone: 'warning' };
    case 'INTERRUPTED': return { label: '已中断', tone: 'warning' };
  }
}

export function shouldShowClassTaskResultActions(result: {
  artifacts: readonly unknown[];
  canAccept: boolean;
  canRevoke: boolean;
}): boolean {
  return result.artifacts.length > 0 && (result.canAccept || result.canRevoke);
}

export type PendingClassTaskResultAction = 'accept' | 'revoke' | null;

export function presentClassTaskResultDuringAction<
  T extends {
    artifacts: Array<{ accepted: boolean }>;
    canAccept: boolean;
    canRevoke: boolean;
  }
>(result: T, pendingAction: PendingClassTaskResultAction): T {
  if (!pendingAction || (!result.canAccept && !result.canRevoke)) return result;
  return {
    ...result,
    artifacts: pendingAction === 'accept'
      ? result.artifacts.map((artifact) => ({ ...artifact, accepted: true }))
      : result.artifacts,
    canAccept: false,
    canRevoke: false
  } as T;
}

export function handleContributionOutsideClick(
  source: ContributionOutsideClickSource
): ContributionOutsideClickAction {
  return source === 'right_backdrop' ? 'shake' : 'ignore';
}

function buildMetricView(
  kind: CoverageMetricKind,
  baseline: ExactCoverageCounts,
  current: ExactCoverageCounts,
  contributions: readonly CoverageContribution[],
  artifactById: ReadonlyMap<string, GeneratedClassTaskArtifact>,
  accepted: boolean,
  acceptedArtifactIds: ReadonlySet<string>
): CoverageMetricView {
  const baselineCovered = kind === 'lines' ? baseline.lineCovered : baseline.branchCovered;
  const currentCovered = kind === 'lines' ? current.lineCovered : current.branchCovered;
  const total = kind === 'lines' ? current.lineTotal : current.branchTotal;
  const available = total > 0;
  const previouslyAcceptedAdded = contributions.reduce((sum, contribution) => (
    acceptedArtifactIds.has(contribution.artifactId)
      ? sum + (kind === 'lines'
          ? contribution.addedLineCount
          : contribution.addedBranchCount)
      : sum
  ), 0);
  const original = accepted
    ? Math.min(currentCovered, total)
    : Math.min(baselineCovered + previouslyAcceptedAdded, currentCovered, total);
  const added = accepted
    ? 0
    : Math.max(0, Math.min(currentCovered - original, total - original));
  const uncovered = Math.max(0, total - original - added);
  const counts = { original, added, uncovered };
  const percentages = available
    ? allocatePercentages([original, added, uncovered], total)
    : [100, 0, 0];
  let offsetPercent = 0;
  const segments = SEGMENTS.map((definition, index) => {
    const segment: CoverageSegmentView = {
      ...definition,
      label: accepted && definition.kind === 'original' ? '已覆盖' : definition.label,
      count: counts[definition.kind],
      percent: percentages[index] ?? 0,
      offsetPercent
    };
    offsetPercent += segment.percent;
    return segment;
  });
  const contributionViews = available && !accepted
    ? buildContributionViews(
        kind,
        original,
        total,
        contributions,
        artifactById,
        acceptedArtifactIds
      )
    : [];

  return {
    kind,
    label: kind === 'lines' ? '行覆盖率' : '分支覆盖率',
    unitLabel: kind === 'lines' ? '行' : '分支',
    available,
    accepted,
    total,
    currentCovered: original + added,
    counts,
    segments,
    originalLabel: available ? formatPercent(percentages[0] ?? 0) : '--',
    addedLabel: available ? formatPercent(percentages[1] ?? 0, true) : '--',
    currentLabel: available
      ? formatPercent((percentages[0] ?? 0) + (percentages[1] ?? 0))
      : '--',
    uncoveredLabel: available ? formatPercent(percentages[2] ?? 0) : '--',
    contributions: contributionViews
  };
}

function buildContributionViews(
  kind: CoverageMetricKind,
  originalCovered: number,
  currentTotal: number,
  contributions: readonly CoverageContribution[],
  artifactById: ReadonlyMap<string, GeneratedClassTaskArtifact>,
  acceptedArtifactIds: ReadonlySet<string>
): CoverageContributionView[] {
  const sorted = contributions.filter(
    (contribution) => !acceptedArtifactIds.has(contribution.artifactId)
  ).map((contribution) => {
    const artifact = artifactById.get(contribution.artifactId);
    const addedCount = kind === 'lines'
      ? contribution.addedLineCount
      : contribution.addedBranchCount;
    const contributionTotal = kind === 'lines'
      ? contribution.lineTotal
      : contribution.branchTotal;
    const totalCount = contributionTotal || currentTotal;
    const percent = roundPercent(addedCount, totalCount);
    const filePath = artifact?.filePath ?? contribution.filePath;
    return {
      fileId: contribution.artifactId,
      artifactId: contribution.artifactId,
      fileName: filePath.split(/[\\/]/).pop() ?? filePath,
      filePath,
      testClassName: artifact?.testClassName ?? filePath.split(/[\\/]/).pop()?.replace(/\.java$/i, '') ?? filePath,
      addedCount,
      totalCount,
      percent,
      percentLabel: formatPercent(percent, true)
    };
  }).filter((contribution) => contribution.addedCount > 0)
    .sort((left, right) =>
    right.percent - left.percent
    || right.addedCount - left.addedCount
    || left.filePath.localeCompare(right.filePath)
  );

  let cumulativeCovered = originalCovered;
  return sorted.map((contribution) => {
    cumulativeCovered = Math.min(currentTotal, cumulativeCovered + contribution.addedCount);
    return {
      ...contribution,
      cumulativeCovered,
      cumulativeLabel: `${cumulativeCovered}/${currentTotal}`
    };
  });
}

function allocatePercentages(counts: readonly number[], total: number): number[] {
  if (total <= 0) {
    return counts.map(() => 0);
  }

  const exactUnits = counts.map((count) => Math.max(0, count) * 100 / total);
  const units = exactUnits.map(Math.floor);
  let remainder = 100 - units.reduce((sum, value) => sum + value, 0);
  const distributionOrder = exactUnits
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  let cursor = 0;
  while (remainder > 0 && distributionOrder.length > 0) {
    const target = distributionOrder[cursor % distributionOrder.length];
    if (target) units[target.index] += 1;
    remainder -= 1;
    cursor += 1;
  }
  return units;
}

function roundPercent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(count * 1000 / total) / 10;
}

function formatPercent(percent: number, signed = false): string {
  const normalized = Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1);
  return `${signed ? '+' : ''}${normalized}%`;
}

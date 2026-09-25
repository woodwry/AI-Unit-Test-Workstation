import type {
  CoverageContribution,
  ExactCoverageCounts
} from '../../shared/class-task-contracts.ts';
import {
  CoverageContributionService,
  type CoverageArtifactIdentity,
  type CoverageContributionDetail,
  type CoverageIdentitySnapshot,
  validateCoverageIdentitySnapshot
} from './coverage-contribution.service.ts';

export type CoverageSegmentCounts = {
  original: number;
  added: number;
  uncovered: number;
  total: number;
};

export type CoverageSegmentView = {
  lines: CoverageSegmentCounts;
  branches: CoverageSegmentCounts;
};

export type ClassCoverageLedgerSnapshot = {
  taskId: string;
  baseline: CoverageIdentitySnapshot;
  current: CoverageIdentitySnapshot;
  artifacts: CoverageArtifactIdentity[];
  artifactSnapshots: CoverageIdentitySnapshot[];
  contributions: CoverageContributionDetail[];
};

type LedgerState = ClassCoverageLedgerSnapshot & {
  revision: number;
};

export type ClassCoverageLedgerOptions = {
  contributions?: CoverageContributionService;
};

export class ClassCoverageLedgerService {
  private readonly contributionService: CoverageContributionService;
  private readonly states = new Map<string, LedgerState>();

  constructor(options: ClassCoverageLedgerOptions = {}) {
    this.contributionService = options.contributions
      ?? new CoverageContributionService();
  }

  initialize(taskIdValue: string, baselineValue: CoverageIdentitySnapshot): void {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const baseline = validateCoverageIdentitySnapshot(baselineValue);
    const existing = this.states.get(taskId);
    if (existing) {
      if (sameSnapshot(existing.baseline, baseline)) return;
      throw new Error('Class coverage ledger already has a different baseline.');
    }
    this.states.set(taskId, {
      taskId,
      baseline,
      current: cloneCoverage(baseline),
      artifacts: [],
      artifactSnapshots: [],
      contributions: [],
      revision: 0
    });
  }

  commit(
    taskIdValue: string,
    artifactValue: CoverageArtifactIdentity,
    snapshotValue: CoverageIdentitySnapshot
  ): ClassCoverageLedgerSnapshot {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const state = this.requireState(taskId);
    const artifact = validateArtifact(artifactValue);
    const snapshot = validateCoverageIdentitySnapshot(snapshotValue);
    const artifacts = state.artifacts.map(cloneArtifact);
    const artifactSnapshots = state.artifactSnapshots.map(cloneCoverage);
    const existingIndex = artifacts.findIndex((item) => item.id === artifact.id);

    if (existingIndex >= 0) {
      if (existingIndex !== artifacts.length - 1) {
        throw new Error('Only the current formal tail artifact can receive more coverage.');
      }
      if (artifacts[existingIndex].filePath !== artifact.filePath) {
        throw new Error('Formal artifact identity cannot change its file path.');
      }
      artifacts[existingIndex] = artifact;
      artifactSnapshots[existingIndex] = snapshot;
    } else {
      if (artifacts.some((item) => item.filePath === artifact.filePath)) {
        throw new Error('Formal artifact file path is already owned by another identity.');
      }
      artifacts.push(artifact);
      artifactSnapshots.push(snapshot);
    }

    return this.replaceState(
      taskId,
      state.baseline,
      artifacts,
      artifactSnapshots,
      state.revision + 1
    );
  }

  replace(
    taskIdValue: string,
    artifactValues: readonly CoverageArtifactIdentity[],
    snapshotValues: readonly CoverageIdentitySnapshot[]
  ): ClassCoverageLedgerSnapshot {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const state = this.requireState(taskId);
    return this.replaceState(
      taskId,
      state.baseline,
      artifactValues,
      snapshotValues,
      state.revision + 1
    );
  }

  /**
   * Makes the last verified coverage snapshot the starting point for the next
   * group of formal files. Accepted artifacts are now part of the baseline, so
   * only later files should appear as new coverage contributions.
   */
  rebase(
    taskIdValue: string,
    baselineValue: CoverageIdentitySnapshot
  ): ClassCoverageLedgerSnapshot {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const state = this.requireState(taskId);
    const baseline = validateCoverageIdentitySnapshot(baselineValue);
    if (!sameCoverageState(state.current, baseline)) {
      throw new Error('Accepted coverage baseline must match the current verified coverage.');
    }
    const next: LedgerState = {
      taskId,
      baseline,
      current: cloneCoverage(baseline),
      artifacts: [],
      artifactSnapshots: [],
      contributions: [],
      revision: state.revision + 1
    };
    this.states.set(taskId, next);
    return cloneState(next);
  }

  async revoke(
    taskIdValue: string,
    artifactIdValue: string,
    reverify: (
      remainingArtifacts: readonly CoverageArtifactIdentity[]
    ) => Promise<readonly CoverageIdentitySnapshot[]>
  ): Promise<ClassCoverageLedgerSnapshot> {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const artifactId = requireIdentity(artifactIdValue, 'artifactId');
    if (typeof reverify !== 'function') {
      throw new TypeError('Coverage revoke requires a re-verification callback.');
    }
    const state = this.requireState(taskId);
    const remaining = state.artifacts
      .filter((artifact) => artifact.id !== artifactId)
      .map(cloneArtifact);
    if (remaining.length === state.artifacts.length) {
      throw new Error('Cannot revoke an unknown formal coverage artifact.');
    }
    const expectedRevision = state.revision;
    const reverified = await reverify(remaining.map(cloneArtifact));
    const latest = this.requireState(taskId);
    if (latest.revision !== expectedRevision) {
      throw new Error('Class coverage ledger changed during revoke re-verification.');
    }
    return this.replaceState(
      taskId,
      latest.baseline,
      remaining,
      reverified,
      latest.revision + 1
    );
  }

  segmentView(input: {
    baseline: ExactCoverageCounts;
    current: ExactCoverageCounts;
  }): CoverageSegmentView {
    const baseline = validateCounts(input.baseline);
    const current = validateCounts(input.current);
    if (
      baseline.lineTotal !== current.lineTotal
      || baseline.branchTotal !== current.branchTotal
    ) {
      throw new Error('Coverage segment totals must remain unchanged.');
    }
    if (
      current.lineCovered < baseline.lineCovered
      || current.branchCovered < baseline.branchCovered
    ) {
      throw new Error('Current coverage cannot be below the baseline.');
    }
    return {
      lines: {
        original: baseline.lineCovered,
        added: current.lineCovered - baseline.lineCovered,
        uncovered: current.lineMissed,
        total: current.lineTotal
      },
      branches: {
        original: baseline.branchCovered,
        added: current.branchCovered - baseline.branchCovered,
        uncovered: current.branchMissed,
        total: current.branchTotal
      }
    };
  }

  taskSegmentView(taskId: string): CoverageSegmentView {
    const state = this.requireState(taskId);
    return this.segmentView({
      baseline: state.baseline.counts,
      current: state.current.counts
    });
  }

  baseline(taskId: string): CoverageIdentitySnapshot {
    return cloneCoverage(this.requireState(taskId).baseline);
  }

  current(taskId: string): CoverageIdentitySnapshot {
    return cloneCoverage(this.requireState(taskId).current);
  }

  artifacts(taskId: string): CoverageArtifactIdentity[] {
    return this.requireState(taskId).artifacts.map(cloneArtifact);
  }

  artifactSnapshots(taskId: string): CoverageIdentitySnapshot[] {
    return this.requireState(taskId).artifactSnapshots.map(cloneCoverage);
  }

  contributionDetails(taskId: string): CoverageContributionDetail[] {
    return this.requireState(taskId).contributions.map(cloneContribution);
  }

  contributions(taskId: string): CoverageContribution[] {
    return this.requireState(taskId).contributions.map((item) => ({
      artifactId: item.artifactId,
      filePath: item.filePath,
      addedLineCount: item.addedLineCount,
      lineTotal: item.lineTotal,
      addedBranchCount: item.addedBranchCount,
      branchTotal: item.branchTotal
    }));
  }

  snapshot(taskId: string): ClassCoverageLedgerSnapshot {
    return cloneState(this.requireState(taskId));
  }

  remove(taskIdValue: string): void {
    this.states.delete(requireIdentity(taskIdValue, 'taskId'));
  }

  private replaceState(
    taskId: string,
    baselineValue: CoverageIdentitySnapshot,
    artifactValues: readonly CoverageArtifactIdentity[],
    snapshotValues: readonly CoverageIdentitySnapshot[],
    revision: number
  ): ClassCoverageLedgerSnapshot {
    const baseline = validateCoverageIdentitySnapshot(baselineValue);
    const artifacts = artifactValues.map(validateArtifact);
    const recalculated = this.contributionService.recalculate(
      baseline,
      artifacts,
      snapshotValues
    );
    const next: LedgerState = {
      taskId,
      baseline,
      current: recalculated.current,
      artifacts,
      artifactSnapshots: snapshotValues.map(validateCoverageIdentitySnapshot),
      contributions: recalculated.contributions,
      revision
    };
    this.states.set(taskId, next);
    return cloneState(next);
  }

  private requireState(taskIdValue: string): LedgerState {
    const taskId = requireIdentity(taskIdValue, 'taskId');
    const state = this.states.get(taskId);
    if (!state) throw new Error(`Class coverage ledger is not initialized for ${taskId}.`);
    return state;
  }
}

function validateArtifact(value: CoverageArtifactIdentity): CoverageArtifactIdentity {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Formal coverage artifact is invalid.');
  }
  return {
    id: requireIdentity(value.id, 'artifactId'),
    filePath: requireIdentity(value.filePath, 'artifact file path')
  };
}

function validateCounts(value: ExactCoverageCounts): ExactCoverageCounts {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Exact coverage counters are invalid.');
  }
  const result: ExactCoverageCounts = {
    lineCovered: requireCount(value.lineCovered),
    lineMissed: requireCount(value.lineMissed),
    lineTotal: requireCount(value.lineTotal),
    branchCovered: requireCount(value.branchCovered),
    branchMissed: requireCount(value.branchMissed),
    branchTotal: requireCount(value.branchTotal)
  };
  if (
    result.lineCovered + result.lineMissed !== result.lineTotal
    || result.branchCovered + result.branchMissed !== result.branchTotal
  ) {
    throw new Error('Exact coverage counters do not sum to their totals.');
  }
  return result;
}

function requireCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Coverage count must be a non-negative safe integer.');
  }
  return value;
}

function requireIdentity(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 32_768
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function cloneArtifact(value: CoverageArtifactIdentity): CoverageArtifactIdentity {
  return { ...value };
}

function cloneCoverage(value: CoverageIdentitySnapshot): CoverageIdentitySnapshot {
  return {
    pair: { ...value.pair },
    counts: { ...value.counts },
    lineIds: [...value.lineIds],
    coveredLineIds: [...value.coveredLineIds],
    branchIds: [...value.branchIds],
    coveredBranchIds: [...value.coveredBranchIds]
  };
}

function cloneContribution(
  value: CoverageContributionDetail
): CoverageContributionDetail {
  return {
    ...value,
    newLineIds: [...value.newLineIds],
    newBranchIds: [...value.newBranchIds]
  };
}

function cloneState(state: LedgerState): ClassCoverageLedgerSnapshot {
  return {
    taskId: state.taskId,
    baseline: cloneCoverage(state.baseline),
    current: cloneCoverage(state.current),
    artifacts: state.artifacts.map(cloneArtifact),
    artifactSnapshots: state.artifactSnapshots.map(cloneCoverage),
    contributions: state.contributions.map(cloneContribution)
  };
}

function sameSnapshot(
  left: CoverageIdentitySnapshot,
  right: CoverageIdentitySnapshot
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCoverageState(
  left: CoverageIdentitySnapshot,
  right: CoverageIdentitySnapshot
): boolean {
  return JSON.stringify({
    counts: left.counts,
    lineIds: left.lineIds,
    coveredLineIds: left.coveredLineIds,
    branchIds: left.branchIds,
    coveredBranchIds: left.coveredBranchIds
  }) === JSON.stringify({
    counts: right.counts,
    lineIds: right.lineIds,
    coveredLineIds: right.coveredLineIds,
    branchIds: right.branchIds,
    coveredBranchIds: right.coveredBranchIds
  });
}

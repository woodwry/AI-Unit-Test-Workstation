import type {
  CoverageContribution,
  ExactCoverageCounts
} from '../../shared/class-task-contracts.ts';
import type { JacocoArtifactPair } from './jacoco-artifacts.service.ts';

const MAX_COVERAGE_IDENTITIES = 1_000_000;
const MAX_IDENTITY_LENGTH = 4_096;

export type CoverageIdentitySnapshot = {
  pair: JacocoArtifactPair;
  counts: ExactCoverageCounts;
  lineIds: string[];
  coveredLineIds: string[];
  branchIds: string[];
  coveredBranchIds: string[];
};

export type CoverageArtifactIdentity = {
  id: string;
  filePath: string;
};

export type CoverageContributionDetail = CoverageContribution & {
  newLineIds: string[];
  newBranchIds: string[];
};

export type CoverageContributionRecalculation = {
  current: CoverageIdentitySnapshot;
  contributions: CoverageContributionDetail[];
};

export class CoverageContributionService {
  recalculate(
    baselineValue: CoverageIdentitySnapshot,
    artifactValues: readonly CoverageArtifactIdentity[],
    snapshotValues: readonly CoverageIdentitySnapshot[]
  ): CoverageContributionRecalculation {
    const baseline = validateSnapshot(baselineValue);
    const artifacts = artifactValues.map(validateArtifact);
    if (artifacts.length !== snapshotValues.length) {
      throw new Error('Formal artifacts and coverage snapshots must have the same length.');
    }
    requireUnique(artifacts.map((artifact) => artifact.id), 'artifact identity');
    requireUnique(artifacts.map((artifact) => artifact.filePath), 'artifact path');

    const snapshots = snapshotValues.map((value) => validateSnapshot(value));
    const baselineLines = new Set(baseline.lineIds);
    const baselineBranches = new Set(baseline.branchIds);
    let seenLines = new Set(baseline.coveredLineIds);
    let seenBranches = new Set(baseline.coveredBranchIds);

    const contributions = snapshots.map((snapshot, index) => {
      requireSameUniverse(
        baselineLines,
        snapshot.lineIds,
        'line identity universe changed while generated tests were added.'
      );
      requireSameUniverse(
        baselineBranches,
        snapshot.branchIds,
        'branch identity universe changed while generated tests were added.'
      );
      requireSubset(
        new Set(snapshot.coveredLineIds),
        [...seenLines],
        'Covered line identity cannot regress or move backwards.'
      );
      requireSubset(
        new Set(snapshot.coveredBranchIds),
        [...seenBranches],
        'Covered branch identity cannot regress or move backwards.'
      );
      const coveredLines = new Set(snapshot.coveredLineIds);
      const coveredBranches = new Set(snapshot.coveredBranchIds);
      const newLineIds = snapshot.coveredLineIds.filter((id) => !seenLines.has(id));
      const newBranchIds = snapshot.coveredBranchIds.filter((id) => !seenBranches.has(id));
      seenLines = coveredLines;
      seenBranches = coveredBranches;
      return {
        artifactId: artifacts[index].id,
        filePath: artifacts[index].filePath,
        addedLineCount: newLineIds.length,
        lineTotal: baseline.counts.lineTotal,
        addedBranchCount: newBranchIds.length,
        branchTotal: baseline.counts.branchTotal,
        newLineIds,
        newBranchIds
      };
    });

    return {
      current: snapshots.at(-1) ?? baseline,
      contributions
    };
  }
}

export function validateCoverageIdentitySnapshot(
  value: CoverageIdentitySnapshot
): CoverageIdentitySnapshot {
  return validateSnapshot(value);
}

function validateSnapshot(
  value: CoverageIdentitySnapshot
): CoverageIdentitySnapshot {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Coverage identity snapshot is invalid.');
  }
  const pair = validatePair(value.pair);
  const counts = validateCounts(value.counts);
  const lineIds = normalizeIdentities(value.lineIds, 'line identity');
  const coveredLineIds = normalizeIdentities(
    value.coveredLineIds,
    'covered line identity'
  );
  const branchIds = normalizeIdentities(value.branchIds, 'branch identity');
  const coveredBranchIds = normalizeIdentities(
    value.coveredBranchIds,
    'covered branch identity'
  );
  requireSubset(new Set(lineIds), coveredLineIds, 'Covered line identity is outside the line universe.');
  requireSubset(
    new Set(branchIds),
    coveredBranchIds,
    'Covered branch identity is outside the branch universe.'
  );
  if (
    lineIds.length !== counts.lineTotal
    || coveredLineIds.length !== counts.lineCovered
    || branchIds.length !== counts.branchTotal
    || coveredBranchIds.length !== counts.branchCovered
  ) {
    throw new Error('Coverage counters do not match the exact covered identities.');
  }
  return {
    pair,
    counts,
    lineIds,
    coveredLineIds,
    branchIds,
    coveredBranchIds
  };
}

function validateArtifact(value: CoverageArtifactIdentity): CoverageArtifactIdentity {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Coverage artifact is invalid.');
  }
  return {
    id: requireText(value.id, 'artifact identity'),
    filePath: requireText(value.filePath, 'artifact path')
  };
}

function validatePair(value: JacocoArtifactPair): JacocoArtifactPair {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Coverage pair is invalid.');
  }
  const pairId = requireText(value.pairId, 'coverage pair identity');
  if (!/^[0-9a-f]{64}$/i.test(pairId)) {
    throw new TypeError('Coverage pair identity is invalid.');
  }
  return {
    reportPath: requireText(value.reportPath, 'coverage report path'),
    branchSnapshotPath: requireText(
      value.branchSnapshotPath,
      'coverage branch snapshot path'
    ),
    pairId: pairId.toLowerCase()
  };
}

function validateCounts(value: ExactCoverageCounts): ExactCoverageCounts {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Exact coverage counters are invalid.');
  }
  const counts: ExactCoverageCounts = {
    lineCovered: requireCount(value.lineCovered, 'lineCovered'),
    lineMissed: requireCount(value.lineMissed, 'lineMissed'),
    lineTotal: requireCount(value.lineTotal, 'lineTotal'),
    branchCovered: requireCount(value.branchCovered, 'branchCovered'),
    branchMissed: requireCount(value.branchMissed, 'branchMissed'),
    branchTotal: requireCount(value.branchTotal, 'branchTotal')
  };
  if (
    counts.lineCovered + counts.lineMissed !== counts.lineTotal
    || counts.branchCovered + counts.branchMissed !== counts.branchTotal
  ) {
    throw new Error('Exact coverage counters do not sum to their totals.');
  }
  return counts;
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeIdentities(
  value: readonly string[],
  label: string
): string[] {
  if (!Array.isArray(value) || value.length > MAX_COVERAGE_IDENTITIES) {
    throw new TypeError(`${label} list is invalid.`);
  }
  const result = value.map((identity) => requireText(identity, label));
  requireUnique(result, label);
  return result;
}

function requireText(value: string, label: string): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > MAX_IDENTITY_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} values must be unique.`);
  }
}

function requireSubset(
  expectedSuperset: ReadonlySet<string>,
  subset: readonly string[],
  message: string
): void {
  if (subset.some((identity) => !expectedSuperset.has(identity))) {
    throw new Error(message);
  }
}

function requireSameUniverse(
  expected: ReadonlySet<string>,
  actual: readonly string[],
  message: string
): void {
  if (
    expected.size !== actual.length
    || actual.some((identity) => !expected.has(identity))
  ) {
    throw new Error(message);
  }
}

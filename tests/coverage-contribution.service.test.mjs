import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CoverageContributionService
} from '../src/main/services/coverage-contribution.service.ts';

const PAIR_A = 'a'.repeat(64);
const PAIR_B = 'b'.repeat(64);
const PAIR_C = 'c'.repeat(64);

function coverageSnapshot({
  pairId,
  lineIds,
  coveredLineIds,
  branchIds,
  coveredBranchIds
}) {
  return {
    pair: {
      reportPath: `C:/coverage/${pairId}.xml`,
      branchSnapshotPath: `C:/coverage/${pairId}.branches.json`,
      pairId
    },
    counts: {
      lineCovered: coveredLineIds.length,
      lineMissed: lineIds.length - coveredLineIds.length,
      lineTotal: lineIds.length,
      branchCovered: coveredBranchIds.length,
      branchMissed: branchIds.length - coveredBranchIds.length,
      branchTotal: branchIds.length
    },
    lineIds,
    coveredLineIds,
    branchIds,
    coveredBranchIds
  };
}

const baseline = coverageSnapshot({
  pairId: PAIR_A,
  lineIds: ['L10', 'L11', 'L12', 'L13'],
  coveredLineIds: ['L10'],
  branchIds: ['B_FALSE', 'B_TRUE', 'B_EXIT'],
  coveredBranchIds: ['B_FALSE']
});

const artifactA = { id: 'artifact-a', filePath: 'C:/tests/TaskService1Test.java' };
const artifactB = { id: 'artifact-b', filePath: 'C:/tests/TaskService2Test.java' };

test('overlapping coverage belongs only to the first formal file that adds it', () => {
  const service = new CoverageContributionService();
  const afterA = coverageSnapshot({
    pairId: PAIR_B,
    lineIds: baseline.lineIds,
    coveredLineIds: ['L10', 'L11', 'L12'],
    branchIds: baseline.branchIds,
    coveredBranchIds: ['B_FALSE', 'B_TRUE']
  });
  const afterB = coverageSnapshot({
    pairId: PAIR_C,
    lineIds: baseline.lineIds,
    coveredLineIds: ['L10', 'L11', 'L12', 'L13'],
    branchIds: baseline.branchIds,
    coveredBranchIds: ['B_FALSE', 'B_TRUE', 'B_EXIT']
  });

  const result = service.recalculate(
    baseline,
    [artifactA, artifactB],
    [afterA, afterB]
  );

  assert.deepEqual(result.contributions[0].newLineIds, ['L11', 'L12']);
  assert.deepEqual(result.contributions[1].newLineIds, ['L13']);
  assert.deepEqual(result.contributions[0].newBranchIds, ['B_TRUE']);
  assert.deepEqual(result.contributions[1].newBranchIds, ['B_EXIT']);
  assert.deepEqual(
    result.contributions.map((item) => ({
      artifactId: item.artifactId,
      addedLineCount: item.addedLineCount,
      addedBranchCount: item.addedBranchCount
    })),
    [
      { artifactId: 'artifact-a', addedLineCount: 2, addedBranchCount: 1 },
      { artifactId: 'artifact-b', addedLineCount: 1, addedBranchCount: 1 }
    ]
  );
  assert.deepEqual(result.current, afterB);
});

test('a later cumulative snapshot cannot lose an identity covered by an earlier file', () => {
  const service = new CoverageContributionService();
  const afterA = coverageSnapshot({
    pairId: PAIR_B,
    lineIds: baseline.lineIds,
    coveredLineIds: ['L10', 'L11'],
    branchIds: baseline.branchIds,
    coveredBranchIds: ['B_FALSE', 'B_TRUE']
  });
  const regressed = coverageSnapshot({
    pairId: PAIR_C,
    lineIds: baseline.lineIds,
    coveredLineIds: ['L10', 'L12'],
    branchIds: baseline.branchIds,
    coveredBranchIds: ['B_FALSE']
  });

  assert.throws(
    () => service.recalculate(
      baseline,
      [artifactA, artifactB],
      [afterA, regressed]
    ),
    /covered identity|move backwards|regress/i
  );
});

test('identity universes and exact counters must remain consistent', () => {
  const service = new CoverageContributionService();
  const changedUniverse = coverageSnapshot({
    pairId: PAIR_B,
    lineIds: ['L10', 'L11', 'L99'],
    coveredLineIds: ['L10'],
    branchIds: baseline.branchIds,
    coveredBranchIds: ['B_FALSE']
  });
  const inconsistent = {
    ...baseline,
    counts: { ...baseline.counts, lineCovered: 2 }
  };

  assert.throws(
    () => service.recalculate(baseline, [artifactA], [changedUniverse]),
    /identity universe|line.*total|source/i
  );
  assert.throws(
    () => service.recalculate(inconsistent, [], []),
    /counter|covered.*identit/i
  );
});

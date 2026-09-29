import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClassCoverageLedgerService
} from '../src/main/services/class-coverage-ledger.service.ts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const PAIRS = ['a', 'b', 'c', 'd', 'e'].map((value) => value.repeat(64));

function snapshot(index, coveredLines, coveredBranches, options = {}) {
  const lineIds = options.lineIds ?? ['L1', 'L2', 'L3', 'L4'];
  const branchIds = options.branchIds ?? ['B1', 'B2', 'B3'];
  return {
    pair: {
      reportPath: `C:/coverage/${PAIRS[index]}.xml`,
      branchSnapshotPath: `C:/coverage/${PAIRS[index]}.branches.json`,
      pairId: PAIRS[index]
    },
    counts: {
      lineCovered: coveredLines.length,
      lineMissed: lineIds.length - coveredLines.length,
      lineTotal: lineIds.length,
      branchCovered: coveredBranches.length,
      branchMissed: branchIds.length - coveredBranches.length,
      branchTotal: branchIds.length
    },
    lineIds,
    coveredLineIds: coveredLines,
    branchIds,
    coveredBranchIds: coveredBranches
  };
}

const artifactA = { id: 'artifact-a', filePath: 'C:/tests/TaskService1Test.java' };
const artifactB = { id: 'artifact-b', filePath: 'C:/tests/TaskService2Test.java' };

test('green blue gray segments use exact counts and sum to each total', () => {
  const ledger = new ClassCoverageLedgerService();
  const view = ledger.segmentView({
    baseline: {
      lineCovered: 40, lineMissed: 60, lineTotal: 100,
      branchCovered: 10, branchMissed: 20, branchTotal: 30
    },
    current: {
      lineCovered: 70, lineMissed: 30, lineTotal: 100,
      branchCovered: 22, branchMissed: 8, branchTotal: 30
    }
  });

  assert.deepEqual(view.lines, {
    original: 40, added: 30, uncovered: 30, total: 100
  });
  assert.deepEqual(view.branches, {
    original: 10, added: 12, uncovered: 8, total: 30
  });
});

test('committing another bundle into the same tail artifact accumulates only its new delta', () => {
  const ledger = new ClassCoverageLedgerService();
  const baseline = snapshot(0, ['L1'], ['B1']);
  ledger.initialize(TASK_ID, baseline);
  ledger.commit(TASK_ID, artifactA, snapshot(1, ['L1', 'L2'], ['B1']));
  ledger.commit(
    TASK_ID,
    artifactA,
    snapshot(2, ['L1', 'L2', 'L3'], ['B1', 'B2'])
  );

  assert.deepEqual(ledger.artifacts(TASK_ID), [artifactA]);
  assert.deepEqual(
    ledger.contributionDetails(TASK_ID).map((item) => ({
      artifactId: item.artifactId,
      newLineIds: item.newLineIds,
      newBranchIds: item.newBranchIds
    })),
    [{
      artifactId: artifactA.id,
      newLineIds: ['L2', 'L3'],
      newBranchIds: ['B2']
    }]
  );
  assert.deepEqual(ledger.current(TASK_ID).counts, {
    lineCovered: 3, lineMissed: 1, lineTotal: 4,
    branchCovered: 2, branchMissed: 1, branchTotal: 3
  });
});

test('accepting current coverage rebases the next file delta and clears prior contributions', () => {
  const ledger = new ClassCoverageLedgerService();
  ledger.initialize(TASK_ID, snapshot(0, ['L1'], ['B1']));
  ledger.commit(TASK_ID, artifactA, snapshot(1, ['L1', 'L2'], ['B1', 'B2']));

  const accepted = ledger.rebase(
    TASK_ID,
    snapshot(2, ['L1', 'L2'], ['B1', 'B2'])
  );

  assert.deepEqual(accepted.baseline.counts, {
    lineCovered: 2, lineMissed: 2, lineTotal: 4,
    branchCovered: 2, branchMissed: 1, branchTotal: 3
  });
  assert.deepEqual(accepted.current, accepted.baseline);
  assert.deepEqual(accepted.artifacts, []);
  assert.deepEqual(accepted.artifactSnapshots, []);
  assert.deepEqual(accepted.contributions, []);

  ledger.commit(
    TASK_ID,
    artifactB,
    snapshot(3, ['L1', 'L2', 'L3'], ['B1', 'B2', 'B3'])
  );
  assert.deepEqual(
    ledger.contributionDetails(TASK_ID).map((item) => ({
      artifactId: item.artifactId,
      newLineIds: item.newLineIds,
      newBranchIds: item.newBranchIds
    })),
    [{
      artifactId: artifactB.id,
      newLineIds: ['L3'],
      newBranchIds: ['B3']
    }]
  );
});

test('revoke recomputes contributions from the remaining formal files', async () => {
  const ledger = new ClassCoverageLedgerService();
  const baseline = snapshot(0, ['L1'], ['B1']);
  ledger.initialize(TASK_ID, baseline);
  ledger.commit(TASK_ID, artifactA, snapshot(1, ['L1', 'L2'], ['B1', 'B2']));
  ledger.commit(
    TASK_ID,
    artifactB,
    snapshot(2, ['L1', 'L2', 'L3'], ['B1', 'B2', 'B3'])
  );
  const beforeRevoke = ledger.current(TASK_ID);

  await ledger.revoke(TASK_ID, artifactA.id, async (remaining) => {
    assert.deepEqual(remaining, [artifactB]);
    return [snapshot(3, ['L1', 'L3'], ['B1', 'B3'])];
  });

  assert.deepEqual(
    ledger.contributions(TASK_ID).map((item) => item.artifactId),
    [artifactB.id]
  );
  assert.deepEqual(
    ledger.contributionDetails(TASK_ID)[0].newLineIds,
    ['L3']
  );
  assert.ok(
    ledger.current(TASK_ID).counts.lineCovered
      < beforeRevoke.counts.lineCovered
  );
});

test('a failed revoke re-verification leaves the last successful ledger intact', async () => {
  const ledger = new ClassCoverageLedgerService();
  ledger.initialize(TASK_ID, snapshot(0, ['L1'], ['B1']));
  ledger.commit(TASK_ID, artifactA, snapshot(1, ['L1', 'L2'], ['B1', 'B2']));
  const before = ledger.snapshot(TASK_ID);

  await assert.rejects(
    ledger.revoke(TASK_ID, artifactA.id, async () => {
      throw new Error('re-verification failed');
    }),
    /re-verification failed/
  );

  assert.deepEqual(ledger.snapshot(TASK_ID), before);
});

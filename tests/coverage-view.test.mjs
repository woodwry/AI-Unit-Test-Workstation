import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoverageView,
  presentClassTaskResultDuringAction
} from '../src/renderer/src/class-tasks/coverage-view.ts';

test('line and branch segments retain exact totals and formatted percentages sum to 100', () => {
  const view = buildCoverageView(resultSnapshot());

  assert.deepEqual(view.lines.counts, { original: 40, added: 30, uncovered: 30 });
  assert.deepEqual(view.branches.counts, { original: 10, added: 6, uncovered: 4 });
  assert.equal(view.lines.segments.reduce((sum, item) => sum + item.percent, 0), 100);
  assert.equal(view.branches.segments.reduce((sum, item) => sum + item.percent, 0), 100);
  assert.equal(view.lines.currentLabel, '70%');
  assert.equal(view.branches.currentLabel, '80%');
  assert.match(view.lines.originalLabel, /%$/);
  assert.match(view.lines.addedLabel, /%$/);
  assert.match(view.lines.uncoveredLabel, /%$/);
});

test('percentage allocation uses exact counts and keeps repeating fractions at exactly 100', () => {
  const view = buildCoverageView(resultSnapshot({
    coverageBaseline: coverage(1, 2, 1, 2),
    coverageCurrent: coverage(2, 1, 2, 1),
    coverageContributions: [{
      artifactId: 'artifact-a',
      filePath: 'D:\\work\\TaskService1Test.java',
      addedLineCount: 1,
      lineTotal: 3,
      addedBranchCount: 1,
      branchTotal: 3
    }]
  }));

  assert.deepEqual(view.lines.segments.map((item) => item.percent), [34, 33, 33]);
  assert.equal(view.lines.segments.reduce((sum, item) => sum + item.percent, 0), 100);
});

test('blue hover entries sort descending independently for lines and branches', () => {
  const view = buildCoverageView(resultSnapshot());

  assert.deepEqual(view.lines.contributions.map((item) => item.fileId), ['artifact-b', 'artifact-a']);
  assert.deepEqual(view.branches.contributions.map((item) => item.fileId), ['artifact-a', 'artifact-b']);
  assert.deepEqual(view.lines.contributions.map((item) => item.percentLabel), ['+20%', '+10%']);
  assert.deepEqual(view.branches.contributions.map((item) => item.percentLabel), ['+20%', '+10%']);
  assert.deepEqual(view.lines.contributions.map((item) => item.cumulativeLabel), ['60/100', '70/100']);
  assert.deepEqual(view.branches.contributions.map((item) => item.cumulativeLabel), ['14/20', '16/20']);
  assert.equal(view.lines.contributions[0].fileName, 'TaskService2Test.java');
});

test('accepted artifacts merge generated coverage into green current coverage', () => {
  const acceptedResult = resultSnapshot({
    coverageBaseline: coverage(87, 13, 75, 25),
    coverageCurrent: coverage(100, 0, 82, 18)
  });
  acceptedResult.artifacts = acceptedResult.artifacts.map((item) => ({
    ...item,
    accepted: true
  }));

  const view = buildCoverageView(acceptedResult);

  assert.equal(view.lines.accepted, true);
  assert.equal(view.branches.accepted, true);
  assert.equal(view.lines.currentLabel, '100%');
  assert.equal(view.branches.currentLabel, '82%');
  assert.deepEqual(view.lines.counts, { original: 100, added: 0, uncovered: 0 });
  assert.deepEqual(view.branches.counts, { original: 82, added: 0, uncovered: 18 });
  assert.equal(view.lines.segments[0].label, '已覆盖');
  assert.deepEqual(view.lines.contributions, []);
  assert.deepEqual(view.branches.contributions, []);
});

test('a later result keeps previously accepted coverage green and shows only new files in blue', () => {
  const mixedResult = resultSnapshot();
  mixedResult.artifacts = mixedResult.artifacts.map((item) => ({
    ...item,
    accepted: item.id === 'artifact-a'
  }));

  const view = buildCoverageView(mixedResult);

  assert.equal(view.lines.accepted, false);
  assert.deepEqual(view.lines.counts, { original: 50, added: 20, uncovered: 30 });
  assert.deepEqual(view.branches.counts, { original: 14, added: 2, uncovered: 4 });
  assert.equal(view.lines.originalLabel, '50%');
  assert.equal(view.lines.addedLabel, '+20%');
  assert.equal(view.branches.originalLabel, '70%');
  assert.equal(view.branches.addedLabel, '+10%');
  assert.deepEqual(view.lines.contributions.map((item) => item.artifactId), ['artifact-b']);
  assert.deepEqual(view.branches.contributions.map((item) => item.artifactId), ['artifact-b']);
});

test('a pending accept immediately presents current coverage as green totals', () => {
  const result = resultSnapshot({
    artifacts: [artifact('artifact-a', 'TaskDataService1Test.java', '2026-09-18T08:33:26.092Z')],
    coverageBaseline: coverage(0, 168, 0, 112),
    coverageCurrent: coverage(48, 120, 18, 94),
    coverageContributions: []
  });

  const view = buildCoverageView(presentClassTaskResultDuringAction(result, 'accept'));

  assert.equal(view.lines.accepted, true);
  assert.equal(view.lines.currentLabel, '29%');
  assert.equal(view.branches.currentLabel, '16%');
  assert.deepEqual(view.lines.counts, { original: 48, added: 0, uncovered: 120 });
  assert.deepEqual(view.branches.counts, { original: 18, added: 0, uncovered: 94 });
});

test('a class with no branch counters keeps the branch slot as an unavailable green ring', () => {
  const view = buildCoverageView(resultSnapshot({
    coverageBaseline: coverage(2, 8, 0, 0),
    coverageCurrent: coverage(7, 3, 0, 0),
    coverageContributions: []
  }));

  assert.equal(view.branches.available, false);
  assert.equal(view.branches.originalLabel, '--');
  assert.equal(view.branches.addedLabel, '--');
  assert.equal(view.branches.currentLabel, '--');
  assert.equal(view.branches.uncoveredLabel, '--');
  assert.deepEqual(view.branches.segments.map((segment) => ({
    kind: segment.kind,
    percent: segment.percent
  })), [
    { kind: 'original', percent: 100 },
    { kind: 'added', percent: 0 },
    { kind: 'uncovered', percent: 0 }
  ]);
  assert.deepEqual(view.branches.contributions, []);
});

function resultSnapshot(overrides = {}) {
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    state: 'COMPLETED',
    artifacts: [
      artifact('artifact-a', 'TaskService1Test.java', '2026-08-09T00:00:00.000Z'),
      artifact('artifact-b', 'TaskService2Test.java', '2026-08-09T00:01:00.000Z'),
      artifact('artifact-c', 'TaskService3Test.java', '2026-08-09T00:02:00.000Z')
    ],
    coverageBaseline: coverage(40, 60, 10, 10),
    coverageCurrent: coverage(70, 30, 16, 4),
    coverageContributions: [
      {
        artifactId: 'artifact-a',
        filePath: 'D:\\work\\TaskService1Test.java',
        addedLineCount: 10,
        lineTotal: 100,
        addedBranchCount: 4,
        branchTotal: 20
      },
      {
        artifactId: 'artifact-b',
        filePath: 'D:\\work\\TaskService2Test.java',
        addedLineCount: 20,
        lineTotal: 100,
        addedBranchCount: 2,
        branchTotal: 20
      },
      {
        artifactId: 'artifact-c',
        filePath: 'D:\\work\\TaskService3Test.java',
        addedLineCount: 0,
        lineTotal: 100,
        addedBranchCount: 0,
        branchTotal: 20
      }
    ],
    canAccept: true,
    canRevoke: true,
    ...overrides
  };
}

function coverage(lineCovered, lineMissed, branchCovered, branchMissed) {
  return {
    lineCovered,
    lineMissed,
    lineTotal: lineCovered + lineMissed,
    branchCovered,
    branchMissed,
    branchTotal: branchCovered + branchMissed
  };
}

function artifact(id, fileName, createdAt) {
  return {
    id,
    filePath: `D:\\work\\${fileName}`,
    testClassName: fileName.replace(/\.java$/, ''),
    ordinaryTestMethodCount: 4,
    methodIds: ['method-1'],
    sha256: 'a'.repeat(64),
    sealed: false,
    accepted: false,
    createdAt,
    updatedAt: createdAt
  };
}

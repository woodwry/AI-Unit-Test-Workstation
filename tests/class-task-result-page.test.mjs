import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  presentClassTaskResultDuringAction,
  resolveClassTaskResultStatus,
  shouldShowClassTaskResultActions
} from '../src/renderer/src/class-tasks/coverage-view.ts';

test('only normal completion and user termination receive the approved result labels and tones', () => {
  assert.deepEqual(resolveClassTaskResultStatus('COMPLETED'), { label: '已完成', tone: 'success' });
  assert.deepEqual(resolveClassTaskResultStatus('TERMINATED'), { label: '已终止', tone: 'terminated' });
  assert.deepEqual(resolveClassTaskResultStatus('FAILED'), { label: '执行失败', tone: 'warning' });
});

test('accept and revoke actions require a successful formal file and a permitted transaction', () => {
  assert.equal(shouldShowClassTaskResultActions({ artifacts: [], canAccept: true, canRevoke: true }), false);
  assert.equal(shouldShowClassTaskResultActions({ artifacts: [{}], canAccept: false, canRevoke: false }), false);
  assert.equal(shouldShowClassTaskResultActions({ artifacts: [{}], canAccept: true, canRevoke: true }), true);
});

test('a background result decision hides both actions and previews acceptance without mutating the loaded snapshot', () => {
  const result = { artifacts: [{ accepted: false }], canAccept: true, canRevoke: true };

  const accepting = presentClassTaskResultDuringAction(result, 'accept');
  const revoking = presentClassTaskResultDuringAction(result, 'revoke');

  assert.deepEqual(accepting, {
    artifacts: [{ accepted: true }],
    canAccept: false,
    canRevoke: false
  });
  assert.deepEqual(revoking, {
    artifacts: [{ accepted: false }],
    canAccept: false,
    canRevoke: false
  });
  assert.deepEqual(result, {
    artifacts: [{ accepted: false }],
    canAccept: true,
    canRevoke: true
  });
  assert.equal(presentClassTaskResultDuringAction(result, null), result);
});

test('result opens as one centered dialog and drills into contributions in the same dialog', async () => {
  const [page, ring, panel, styles] = await Promise.all([
    readFile('src/renderer/src/class-tasks/ClassTaskResultPage.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/CoverageRing.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/ClassTaskPanel.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/class-tasks.css', 'utf8')
  ]);

  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /class-task-result-backdrop/);
  assert.match(page, /class-task-result-dialog/);
  assert.match(page, /dialogMetric === null/);
  assert.match(page, /setDialogMetric\(null\)/);
  assert.doesNotMatch(page, /Search/);
  assert.match(page, /lines=\{view\.lines\}/);
  assert.match(page, /branches=\{view\.branches\}/);
  assert.match(page, /progress\.heading/);
  assert.match(page, /ResultStatusIcon/);
  assert.match(page, /总用时/);
  assert.match(page, /Token/);
  assert.match(page, /resolveTokenUsageDisplay/);
  assert.match(page, /tokenUsageDisplay\.total/);
  assert.doesNotMatch(page, /<div><dt>Token<\/dt><dd>--<\/dd><\/div>/);
  assert.match(page, /正式文件/);
  assert.match(page, /覆盖情况/);
  assert.match(page, /accepted \? '当前覆盖率' : '本次生成前 → 当前'/);
  assert.match(page, /metric\.accepted \? \(/);
  assert.match(page, /方法结果/);
  assert.doesNotMatch(page, /生成轮次/);
  assert.match(page, /本次生成文件/);
  assert.match(page, /metric\.available && \(\s*<span>/);
  assert.doesNotMatch(page, /类整体/);
  assert.match(page, /<strong>撤回<\/strong>|<span>撤回<\/span>|>撤回</);
  assert.match(page, /<strong>接受<\/strong>|<span>接受<\/span>|>接受</);
  assert.match(page, /<Undo2 size=\{18\}/);
  assert.match(page, /<Check size=\{18\}/);
  assert.doesNotMatch(page, /row\.methodId\}/);
  assert.match(ring, /onOpenContributions/);
  assert.match(ring, /class-task-coverage-card-body/);
  assert.match(ring, /class-task-coverage-legend/);
  assert.match(ring, /metric\.available/);
  assert.match(panel, /class-task-result-layer/);
  assert.match(panel, /ClassTaskResultPage/);
  assert.match(panel, /resultRefreshKeyRef/);
  assert.match(panel, /activeResultTask\.updatedAt/);
  assert.match(panel, /onLoadTaskResult\(activeResultTaskId\)/);
  assert.match(panel, /closeResultPage\(\);[\s\S]*?onAcceptTaskResult\(taskId\)/);
  assert.match(panel, /closeResultPage\(\);[\s\S]*?onRevokeTaskResult\(taskId\)/);
  assert.match(panel, /presentClassTaskResultDuringAction\([\s\S]*?backgroundResultActionsRef\.current\.get/);
  assert.match(panel, /const backgroundAction = backgroundResultActionsRef\.current\.get\(taskId\)/);
  assert.match(panel, /backgroundAction\?\.result \?\? loadedResult/);
  assert.match(panel, /backgroundAction\.result = result/);
  assert.match(panel, /request\.then\(\(result\)[\s\S]*?current\?\.taskId === taskId \? result : current/);
  assert.doesNotMatch(panel, /await onAcceptTaskResult\(/);
  assert.doesNotMatch(panel, /await onRevokeTaskResult\(/);
  assert.match(styles, /\.class-task-result-dialog\s*\{[\s\S]*?font-size:\s*15px;[\s\S]*?font-weight:\s*500;/);
  assert.match(styles, /\.class-task-result-completion-icon\.active svg[\s\S]*?class-task-spin/);
  assert.match(styles, /\.class-task-result-actions button\s*\{[\s\S]*?font-size:\s*15px;[\s\S]*?gap:\s*7px;/);
});

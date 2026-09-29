import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('class task panel exposes compact drop, total, card, empty-result, and dialog controls', async () => {
  const [panel, card, dialog, deleteDialog, styles] = await Promise.all([
    readFile('src/renderer/src/class-tasks/ClassTaskPanel.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/ClassTaskCard.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/TerminateAllDialog.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/DeleteClassTaskDialog.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/class-tasks.css', 'utf8')
  ]);

  assert.doesNotMatch(panel, /type="file"/);
  assert.doesNotMatch(panel, /inputRef/);
  assert.match(panel, /拖拽或粘贴文件到下方/);
  assert.doesNotMatch(panel, /点击添加/);
  assert.doesNotMatch(panel, /粘贴已复制的类/);
  assert.match(panel, /getPathForDroppedFile/);
  assert.match(panel, /className="class-task-dropzone-prompt"/);
  assert.doesNotMatch(panel, /最多添加 5 个类，可同时执行/);
  assert.match(panel, /点击任务查看运行结果/);
  assert.match(panel, /当前任务没有运行结果/);
  assert.match(panel, /<ClassTaskCard/);
  assert.match(panel, /draggable=\{tasks\.length > 1\}/);
  assert.match(panel, /CLASS_TASK_REORDER_MIME/);
  assert.match(panel, /handleTaskDragStart/);
  assert.match(panel, /handleTaskDragOver/);
  assert.match(panel, /handleTaskDrop/);
  assert.match(panel, /onReorderTasks\(nextIds\)/);
  assert.match(panel, /useLayoutEffect/);
  assert.match(panel, /captureTaskPositions/);
  assert.match(panel, /element\.animate\(/);
  assert.match(panel, /cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  assert.doesNotMatch(styles, /drop-before|drop-after/);
  assert.match(styles, /\.class-task-card-drag-slot\.dragging > \.class-task-card/);
  assert.match(panel, /<TerminateAllDialog/);
  assert.match(panel, /resolveClassTaskDeleteRequest/);
  assert.match(panel, /show_method_selection_hint/);
  assert.match(card, /请先选择至少一个方法/);
  assert.match(styles, /\.class-task-card-selection-hint/);
  assert.match(panel, /<DeleteClassTaskDialog/);
  assert.match(deleteDialog, /describeClassTaskDeleteConfirmation/);
  assert.match(deleteDialog, /class-task-terminate-backdrop/);
  assert.match(deleteDialog, />取消</);
  assert.match(card, /Play/);
  assert.match(card, /Pause/);
  assert.match(card, /Crosshair/);
  assert.match(card, /Settings/);
  assert.match(card, /RefreshCw/);
  assert.match(card, /Trash2/);
  assert.match(card, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(card, /title=\{task\.sourceFilePath\}/);
  assert.doesNotMatch(card, /<code title=\{error\.(?:modulePath|command)\}/);
  assert.match(styles, /\.class-task-card-error-popover code \{[\s\S]*?overflow-wrap: anywhere/);
  assert.match(dialog, /将终止.*个正在执行或暂停的任务/s);
  assert.match(dialog, />取消</);
  assert.match(dialog, />终止</);
  assert.match(styles, /\.class-task-card-actions/);
  assert.match(styles, /31px/);
  assert.match(styles, /class-task-completion-pulse/);
});

test('active method animation scans the unfinished track without painting provisional completion', async () => {
  const [card, styles] = await Promise.all([
    readFile('src/renderer/src/class-tasks/ClassTaskCard.tsx', 'utf8'),
    readFile('src/renderer/src/class-tasks/class-tasks.css', 'utf8')
  ]);

  assert.match(card, /className="class-task-card-progress-active-batch"/);
  assert.match(card, /right:\s*0/);
  assert.doesNotMatch(
    card,
    /activeBatch\.end\s*-\s*runningMethodProgress\.activeBatch\.start/
  );
  assert.match(styles, /background-size:\s*36px 100%/);
  assert.match(styles, /background-repeat:\s*no-repeat/);
  assert.match(styles, /background-position:\s*-36px 0/);
});

test('App restores and subscribes class tasks and wires every named card command', async () => {
  const app = await readFile('src/renderer/src/App.tsx', 'utf8');

  for (const call of [
    'listClassTasks', 'addClassTasks', 'reorderClassTasks', 'runClassTask', 'pauseClassTask', 'resumeClassTask',
    'terminateClassTask', 'runAllClassTasks', 'terminateAllClassTasks', 'removeClassTask',
    'retryModulePreload', 'stopModulePreload', 'getClassTaskResult'
  ]) {
    assert.match(app, new RegExp(`${call}\\(`), `${call} is not wired`);
  }
  assert.match(app, /onClassTaskSnapshotChanged\(/);
  assert.match(app, /getPathForFile/);
  assert.match(app, /openClassTaskMethodConfiguration/);
  assert.match(app, /revealFileInExplorer/);
  assert.match(app, /<ClassTaskPanel/);
});

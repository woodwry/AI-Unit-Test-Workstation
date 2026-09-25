import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('method configuration page exposes the approved compact controls and accessible rows', async () => {
  const component = await readFile(
    'src/renderer/src/class-tasks/MethodConfigurationTab.tsx',
    'utf8'
  );
  const styles = await readFile('src/renderer/src/class-tasks/class-tasks.css', 'utf8');

  assert.match(component, /可在此处搜索方法/);
  assert.doesNotMatch(component, /模糊/);
  assert.match(component, /class-task-method-heading-actions/);
  assert.match(component, /const refreshLocked = isSaving[\s\S]*isRefreshing/);
  assert.match(
    component,
    /className="class-task-method-refresh"[\s\S]{0,220}disabled=\{refreshLocked\}/
  );
  assert.match(component, />\s*修复轮次\s*</);
  assert.match(component, /type="number"/);
  assert.match(component, /min="1"/);
  assert.match(component, /step="1"/);
  assert.match(component, /aria-label="减少修复轮次"/);
  assert.match(component, /aria-label="增加修复轮次"/);
  assert.match(component, /stepRepairAttemptLimit\(-1\)/);
  assert.match(component, /stepRepairAttemptLimit\(1\)/);
  assert.doesNotMatch(component, />\s*无限制\s*</);
  assert.doesNotMatch(component, /class-task-unlimited-repair-option/);
  assert.match(component, /disabled=\{selectionLocked \|\| unlimitedRepair\}/);
  const repairState = await readFile(
    'src/renderer/src/class-tasks/method-configuration-repair-state.ts',
    'utf8'
  );
  assert.match(repairState, /请填写修复轮次或勾选无限制/);
  assert.match(component, /resolveRepairConfiguration\(/);
  assert.match(
    component,
    /if \(!repairConfiguration\.valid\)[\s\S]{0,240}return;[\s\S]*onSave\(\{/
  );
  assert.doesNotMatch(component, /class-task-class-options/);
  assert.match(component, /基于RAG提升单元测试质量/);
  assert.match(component, /ragConfigurationState === 'unconfigured'/);
  assert.doesNotMatch(component, /window\.workstation\.getRagSettings\(\)/);
  assert.match(component, /请先在设置中完成 Embedding 配置/);
  assert.match(component, /class-task-rag-option.*unconfigured/s);
  assert.match(component, /onPointerDown=/);
  assert.match(
    component,
    /closest\(['"]\.class-task-rag-control, \.class-task-rag-warning['"]\)/
  );
  assert.match(component, /setRagConfigurationState\(['"]idle['"]\)/);
  const headingActionsIndex = component.indexOf('className="class-task-method-heading-actions"');
  const ragWarningIndex = component.indexOf('className="class-task-rag-warning"', headingActionsIndex);
  const refreshButtonIndex = component.indexOf('className="class-task-method-refresh"', headingActionsIndex);
  const ragControlIndex = component.indexOf('className="class-task-rag-control"', headingActionsIndex);
  assert.ok(headingActionsIndex >= 0, 'heading actions must exist');
  assert.ok(ragWarningIndex > headingActionsIndex, 'RAG warning must be inside heading actions');
  assert.ok(ragWarningIndex < refreshButtonIndex, 'RAG warning must appear before the refresh button');
  assert.ok(ragWarningIndex < ragControlIndex, 'RAG warning must no longer be inside the RAG control');
  assert.match(component, /已选择.*\{selectedCount\}.*\/.*\{selectableCount\}/s);
  assert.match(component, /selectableCount\s*=\s*listState\.methods\.filter/);
  assert.match(component, /const allSelected = areAllMethodsSelected\(listState\)/);
  assert.match(component, /aria-pressed=\{allSelected\}/);
  assert.match(component, /\{allSelected && <Check/);
  assert.match(component, /const \[draftSelectionMode, setDraftSelectionMode\] = useState\(task\.selectionMode\)/);
  assert.match(component, /setDraftSelectionMode\('EXPLICIT'\)/);
  assert.match(component, /selectionMode: draftSelectionMode/);
  assert.match(
    component,
    /selectedMethodIds: draftSelectionMode === 'ALL_BY_DEFAULT' \? \[\] : methodOrder/
  );
  assert.match(component, />\s*全选\s*</);
  assert.doesNotMatch(component, />取消全选</);
  assert.match(component, /class-task-method-save[\s\S]*保存配置/);
  assert.match(component, /const SAVE_SUCCESS_VISIBLE_MS\s*=\s*1800/);
  assert.match(component, /window\.setTimeout\([\s\S]*setSaveSuccessVisible\(false\)[\s\S]*SAVE_SUCCESS_VISIBLE_MS/);
  assert.match(component, /setMethodSort\(current, 'jacoco', 'asc'\)/);
  assert.match(component, /role="checkbox"/);
  assert.match(component, /title=/);
  assert.match(component, /label: '未覆盖指令'/);
  assert.match(component, /label: '指令覆盖率'/);
  assert.match(component, /label: '未覆盖分支'/);
  assert.match(component, /label: '分支覆盖率'/);
  assert.match(component, /label: '未覆盖圈复杂度'/);
  assert.match(component, /label: '总圈复杂度'/);
  assert.match(component, /label: '未覆盖行数'/);
  assert.match(component, /label: '总行数'/);
  assert.match(component, /<tfoot>/);
  assert.match(component, /aria-label="JaCoCo 报告总计"/);
  assert.match(component, /catalog\.reportCoverageTotals/);
  assert.doesNotMatch(component, /catalog\.classCoverageTotals/);
  assert.match(component, />\s*总计\s*</);
  assert.equal(
    component.match(/<CoverageRateCell[\s\S]{0,180}?wholePercent/g)?.length,
    2,
    'the two Total coverage rates must use JaCoCo whole percentages'
  );
  assert.match(component, /wholePercent[\s\S]{0,80}Math\.floor\(value\)/);
  assert.doesNotMatch(component, /role="columnheader">顺序</);
  assert.doesNotMatch(component, /role="columnheader">行范围</);
  assert.doesNotMatch(component, /role="columnheader">修饰符</);
  assert.doesNotMatch(component, /role="columnheader">方法数</);
  assert.match(styles, /\.class-task-method-checkbox/);
  assert.match(styles, /\.class-task-method-row/);
  assert.match(styles, /\.class-task-method-row\s*\{[^}]*display:\s*table-row/s);
  assert.match(styles, /\.class-task-method-check-cell\s*\{[^}]*display:\s*table-cell/s);
  assert.match(styles, /\.class-task-method-signature\s*\{[^}]*display:\s*table-cell/s);
  assert.match(styles, /\.class-task-method-total-row/);
  assert.match(
    styles,
    /\.class-task-method-total-row td\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/s,
    'the JaCoCo Total cells must remain pinned to the bottom of the method table scrollport'
  );
  assert.match(styles, /\.class-task-rag-option\.unconfigured/);
  assert.match(styles, /\.class-task-repair-control/);
  assert.match(styles, /\.class-task-repair-stepper/);
  assert.match(styles, /\.class-task-repair-step-button/);
  assert.doesNotMatch(styles, /\.class-task-unlimited-repair-option/);
  assert.match(
    styles,
    /\.class-task-repair-limit-input::\-webkit-inner-spin-button[\s\S]*\-webkit-appearance:\s*none/
  );
  assert.match(styles, /\.class-task-repair-limit-input\s*\{[^}]*text-align:\s*center/s);
  assert.match(styles, /\.class-task-repair-limit-input:disabled/);
  assert.match(styles, /\.class-task-method-save-success\s*\{[^}]*border:\s*1px solid #45c878/s);
  assert.match(styles, /@keyframes class-task-save-success-enter/);
  assert.doesNotMatch(styles, /\.class-task-class-options/);
});

test('App opens method configuration while loading its catalog and persists selection', async () => {
  const app = await readFile('src/renderer/src/App.tsx', 'utf8');

  assert.match(app, /getClassTaskMethods\(/);
  assert.match(app, /checkClassTaskMethods\(/);
  assert.match(app, /workbenchTabs:/);
  assert.match(app, /activeWorkbenchTabId:/);
  assert.match(app, /restorePersistedWorkbenchTabs\(/);
  assert.match(app, /openMethodConfigurationTab\(/);
  assert.match(app, /saveClassTaskMethodSelection\(/);
  assert.match(
    app,
    /saveClassTaskMethodSelection\(\{[\s\S]{0,250}selectionMode: draft\.selectionMode/
  );
  assert.match(app, /activeWorkbenchTab\?\.kind === 'method_configuration'/);
  assert.match(app, /<MethodConfigurationTab/);
  assert.match(app, /const METHOD_SELECTION_SAVE_ERROR_VISIBLE_MS = 6_000/);
  assert.match(app, /methodSelectionSaveErrorTimersRef/);
  assert.match(
    app,
    /function showMethodSelectionSaveError[\s\S]*window\.setTimeout\([\s\S]*METHOD_SELECTION_SAVE_ERROR_VISIBLE_MS/
  );
  assert.match(
    app,
    /methodSelectionSaveErrorTimersRef\.current\.get\(taskId\) !== timer[\s\S]*omitRecordKey\(errors, taskId\)/
  );

  const refreshHandler = app.match(
    /async function refreshClassTaskMethodConfiguration\(\): Promise<void> \{[\s\S]*?(?=\n  async function refreshClassTaskCatalogIfNeeded)/
  )?.[0];
  assert.ok(refreshHandler, 'manual refresh handler must exist');
  assert.doesNotMatch(refreshHandler, /forceReload/);
  assert.match(app, /freshness\.catalog/);
  assert.match(
    app,
    /setClassTaskCatalogs\(\(catalogs\) => \(\{[\s\S]{0,160}\[taskId\]: freshness\.catalog/
  );
});

test('method configuration load failures stay concise and omit internal details', async () => {
  const app = await readFile('src/renderer/src/App.tsx', 'utf8');

  assert.match(app, /<strong>覆盖率信息读取失败<\/strong>/);
  assert.doesNotMatch(
    app,
    /<span>\{activeMethodConfigurationLoadState\.message\}<\/span>/
  );
  assert.doesNotMatch(app, /仅在错误明确指出 Maven 或编译失败时才需要修复模块/);
});

test('revoking a class-task result refreshes coverage in the background', async () => {
  const app = await readFile('src/renderer/src/App.tsx', 'utf8');
  const revokeHandler = app.match(
    /async function revokeClassTaskResult\(taskId: string\): Promise<ClassTaskResultSnapshot> \{[\s\S]*?(?=\n  function handleClassTaskCardIntent)/
  )?.[0];

  assert.ok(revokeHandler, 'revoke result handler must exist');
  assert.match(revokeHandler, /void refreshClassTaskCatalogIfNeeded\(\{/);
  assert.doesNotMatch(revokeHandler, /await refreshClassTaskCatalogIfNeeded\(\{/);
  assert.match(revokeHandler, /forceReload:\s*true/);
  assert.match(revokeHandler, /requireLiveCatalog:\s*true/);
  assert.match(
    app,
    /if \(classTaskMethodCatalogRequestIdsRef\.current\.has\(taskId\) && !input\.forceReload\)/
  );
});

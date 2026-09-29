import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('工作区设置从生成进度中独立出来并保留三类设置入口', async () => {
  const [app, dialog] = await Promise.all([
    readFile('src/renderer/src/App.tsx', 'utf8'),
    readFile('src/renderer/src/WorkspaceSettingsDialog.tsx', 'utf8').catch(() => '')
  ]);

  assert.match(app, /<WorkspaceSettingsDialog/);
  assert.doesNotMatch(app, /GenerationProgressPanel/);
  assert.match(dialog, /WorkspaceModelSettingsSection/);
  assert.match(dialog, /ModelCallLogSettingsSection/);
  assert.match(app, /canManageModelCallLogs=\{authenticatedUser\?\.role === 'ADMIN'\}/);
  assert.match(dialog, /canManageModelCallLogs && \(/);
  assert.match(dialog, /visibleSettingsSection === 'files' && canManageModelCallLogs/);
  assert.match(dialog, /Maven Home/);
  assert.match(dialog, /Java Home/);
  assert.doesNotMatch(dialog, /WorkspaceConfigurationResetSection/);
  assert.doesNotMatch(dialog, /activeSettingsSection.*'reset'/);
  assert.doesNotMatch(dialog, />重置</);
  assert.doesNotMatch(app, /onResetWorkspaceConfiguration=\{/);
  assert.doesNotMatch(app, /workspace-model-settings:reset|workspace-build-settings:remove/);
  assert.match(dialog, /isSettingsCloseBlocked/);
  assert.match(dialog, /isBuildSettingsBusy/);
});

test('任务执行时只锁定构建环境配置，不锁定大模型、RAG 和日志配置', async () => {
  const [app, dialog, modelSection, ragSection, logSection] = await Promise.all([
    readFile('src/renderer/src/App.tsx', 'utf8'),
    readFile('src/renderer/src/WorkspaceSettingsDialog.tsx', 'utf8'),
    readFile('src/renderer/src/WorkspaceModelSettingsSection.tsx', 'utf8'),
    readFile('src/renderer/src/RagSettingsSection.tsx', 'utf8'),
    readFile('src/renderer/src/ModelCallLogSettingsSection.tsx', 'utf8')
  ]);

  const closeBlockedExpression =
    dialog.match(/const isSettingsCloseBlocked =\s*([\s\S]*?);/)?.[1] ?? '';
  assert.match(closeBlockedExpression, /isBuildSettingsBusy/);
  assert.doesNotMatch(
    closeBlockedExpression,
    /isModelSettingsBusy|isModelCallLogSettingsBusy|isRagSettingsBusy/
  );

  const appBusyExpression = app.match(/const isSettingsCloseBlocked =\s*([\s\S]*?);/)?.[1] ?? '';
  assert.match(appBusyExpression, /isBuildSettingsBusy/);
  assert.doesNotMatch(
    appBusyExpression,
    /isModelSettingsBusy|isModelCallLogSettingsBusy|isRagSettingsBusy/
  );

  for (const sectionInvocation of [
    dialog.match(/<ModelCallLogSettingsSection[\s\S]*?\/>/)?.[0] ?? '',
    dialog.match(/<RagSettingsSection[\s\S]*?\/>/)?.[0] ?? '',
    dialog.match(/<WorkspaceModelSettingsSection[\s\S]*?\/>/)?.[0] ?? ''
  ]) {
    assert.doesNotMatch(sectionInvocation, /isRunning=\{isRunning\}/);
  }

  assert.doesNotMatch(modelSection, /isRunning/);
  assert.doesNotMatch(ragSection, /isRunning/);
  assert.doesNotMatch(logSection, /isRunning/);
});
test('没有活动接口时保持未选中而不是自动选择第一项', async () => {
  const section = await readFile('src/renderer/src/WorkspaceModelSettingsSection.tsx', 'utf8');

  assert.match(section, /view\?\.activeInterfaceId === item\.id/);
  assert.match(section, /name="active-model-interface"/);
  assert.match(section, /window\.workstation\.selectModelInterface\(\{ id \}\)/);
  assert.doesNotMatch(section, /interfaces\[0\].*(?:active|select)|catalog\[0\]\?\.id/);
});

test('API Key 支持直接输入和自定义环境变量名两种方式', async () => {
  const section = await readFile('src/renderer/src/WorkspaceModelSettingsSection.tsx', 'utf8');

  assert.match(section, /draft\.credentialMode === 'direct'/);
  assert.match(section, /draft\.credentialMode === 'environment'/);
  assert.match(section, /placeholder="MY_MODEL_API_KEY"/);
  assert.match(section, /copyModelInterfaceEnvironmentVariable/);
  assert.match(section, /aria-label="复制环境变量名"/);
  assert.doesNotMatch(section, /留空将使用本机系统环境变量|留空时读取本机系统环境变量/);
});

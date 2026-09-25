import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createFakeMavenHome } from './support/fake-maven.mjs';

const WORKSTATION_ROOT = resolve(import.meta.dirname, '..', '..');

type SettingsFixture = {
  app: ElectronApplication;
  page: Page;
  userDataRoot: string;
  close(): Promise<void>;
};

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    ))
  );
}

async function launchSettingsFixture(): Promise<SettingsFixture> {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'aiut-model-settings-'));
  const app = await electron.launch({
    args: ['--disable-gpu', '--no-sandbox', '.', `--user-data-dir=${userDataRoot}`],
    cwd: WORKSTATION_ROOT,
    env: {
      ...stringEnvironment(process.env),
      AI_UNIT_TEST_DISABLE_REAL_MODEL: 'true',
      AI_UNIT_TEST_E2E_BACKEND_RUNTIME: 'enabled',
      AI_UNIT_TEST_E2E_AGENT_URL: 'http://127.0.0.1:39191',
      AI_UNIT_TEST_E2E_ANALYZER_URL: 'http://127.0.0.1:39192',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    userDataRoot,
    async close() {
      await page.locator('dialog[open]').evaluateAll((dialogs) => {
        for (const dialog of dialogs) {
          if (dialog instanceof HTMLDialogElement) dialog.close();
        }
      }).catch(() => undefined);
      await app.close();
      await rm(userDataRoot, { recursive: true, force: true });
    }
  };
}

async function openModelSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '大模型', exact: true }).click();
  return dialog;
}

async function expectContentToFillSettingsView(content: Locator): Promise<void> {
  await expect(content).toBeVisible();
  const layout = await content.evaluate((element) => {
    const parent = element.parentElement;
    if (!parent) throw new Error('model interface content must have a settings view parent');
    const parentBox = parent.getBoundingClientRect();
    const contentBox = element.getBoundingClientRect();
    const parentStyle = getComputedStyle(parent);
    const contentStyle = getComputedStyle(element);
    return {
      viewPadding: parentStyle.padding,
      borderTopWidth: contentStyle.borderTopWidth,
      borderRadius: contentStyle.borderRadius,
      insetLeft: Math.abs(contentBox.left - parentBox.left),
      insetTop: Math.abs(contentBox.top - parentBox.top),
      widthDelta: Math.abs(contentBox.width - parentBox.width),
      minimumHeightDelta: contentBox.height - parentBox.height
    };
  });

  expect(layout.viewPadding).toBe('0px');
  expect(layout.borderTopWidth).toBe('0px');
  expect(layout.borderRadius).toBe('0px');
  expect(layout.insetLeft).toBeLessThanOrEqual(1);
  expect(layout.insetTop).toBeLessThanOrEqual(1);
  expect(layout.widthDelta).toBeLessThanOrEqual(1);
  expect(layout.minimumHeightDelta).toBeGreaterThanOrEqual(-1);
}

test('model interface list and editor fill the settings pane without an inset card', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const dialog = await openModelSettings(fixture.page);
    const manager = dialog.getByRole('region', { name: '大模型接口管理' });
    await expectContentToFillSettingsView(manager);

    await manager.getByRole('button', { name: '新增', exact: true }).click();
    await expectContentToFillSettingsView(dialog.locator('form.model-interface-editor'));
  } finally {
    await fixture.close();
  }
});

test('settings content hides its scrollbar without disabling scrolling', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const dialog = await openModelSettings(fixture.page);
    const settingsView = dialog.locator('.workspace-settings-view');
    await expect(settingsView).toBeVisible();

    const scrollbarStyle = await settingsView.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element).getPropertyValue('scrollbar-width'),
      webkitDisplay: getComputedStyle(element, '::-webkit-scrollbar').display
    }));

    expect(scrollbarStyle.overflowY).toBe('auto');
    expect(scrollbarStyle.scrollbarWidth).toBe('none');
    expect(scrollbarStyle.webkitDisplay).toBe('none');
  } finally {
    await fixture.close();
  }
});

test('model interface feedback and actions stay at the bottom of the editor', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const dialog = await openModelSettings(fixture.page);
    await dialog.getByRole('button', { name: '新增', exact: true }).click();
    const editor = dialog.locator('form.model-interface-editor');
    const actions = editor.locator('.model-interface-editor-actions');
    await editor.getByRole('button', { name: '测试连接', exact: true }).click();
    const result = editor.locator('.model-interface-result');
    await expect(result).toBeVisible();

    const layout = await editor.evaluate((element) => {
      const actionsElement = element.querySelector<HTMLElement>('.model-interface-editor-actions');
      const resultElement = element.querySelector<HTMLElement>('.model-interface-result');
      if (!actionsElement || !resultElement) throw new Error('editor footer content is missing');
      const editorBox = element.getBoundingClientRect();
      const actionsBox = actionsElement.getBoundingClientRect();
      const resultBox = resultElement.getBoundingClientRect();
      return {
        actionsBottomInset: editorBox.bottom - actionsBox.bottom,
        resultBottomInset: editorBox.bottom - resultBox.bottom,
        actionsOnRight: actionsBox.left > editorBox.left + editorBox.width / 2,
        resultOnLeft: resultBox.left < editorBox.left + editorBox.width / 2
      };
    });

    expect(layout.actionsBottomInset).toBeLessThanOrEqual(30);
    expect(layout.resultBottomInset).toBeLessThanOrEqual(40);
    expect(layout.actionsOnRight).toBe(true);
    expect(layout.resultOnLeft).toBe(true);
    await expect(actions).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('settings dialog moves with its header and keeps the close action usable', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    const header = dialog.locator('.workspace-settings-dialog-header');
    await expect(dialog).toBeVisible();
    await expect(header).toHaveCSS('cursor', 'default');

    const [before, headerBox] = await Promise.all([
      dialog.boundingBox(),
      header.boundingBox()
    ]);
    expect(before).not.toBeNull();
    expect(headerBox).not.toBeNull();

    await page.mouse.move(
      headerBox!.x + headerBox!.width / 2,
      headerBox!.y + headerBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      headerBox!.x + headerBox!.width / 2 + 80,
      headerBox!.y + headerBox!.height / 2 + 50
    );
    await page.mouse.up();

    const after = await dialog.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.x - before!.x).toBeGreaterThan(60);
    expect(after!.y - before!.y).toBeGreaterThan(30);

    await dialog.getByRole('button', { name: '关闭设置' }).click();
    await expect(dialog).not.toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('settings dialog stays inside the window when its header is dragged past an edge', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    const headerBox = await dialog.locator('.workspace-settings-dialog-header').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(headerBox).not.toBeNull();

    await page.mouse.move(
      headerBox!.x + headerBox!.width / 2,
      headerBox!.y + headerBox!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(viewport.width - 1, viewport.height - 1);
    await page.mouse.up();

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height - 7);
  } finally {
    await fixture.close();
  }
});

test('build settings auto-save edits and keep only a compact validation action', async () => {
  const [fixture, toolchain] = await Promise.all([
    launchSettingsFixture(),
    createFakeMavenHome()
  ]);
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    const buildSettings = dialog.getByRole('region', { name: '工作站全局构建环境' });
    const validateButton = buildSettings.getByRole('button', { name: '校验配置', exact: true });
    await expect(buildSettings).toBeVisible();
    await expect(buildSettings.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    await expect(validateButton).toHaveCSS('font-size', '12px');
    await expect(validateButton).toHaveCSS('min-height', '32px');

    const inputs = buildSettings.locator('.build-path-field input');
    await inputs.nth(0).fill(toolchain.mavenHome);
    await inputs.nth(1).fill(toolchain.javaHome);
    await expect.poll(async () => page.evaluate(async () => (
      (window as any).workstation.getWorkstationBuildSettings()
    )), { timeout: 20_000 }).toMatchObject({
      mavenHome: toolchain.mavenHome,
      javaHome: toolchain.javaHome
    });
  } finally {
    await Promise.all([fixture.close(), toolchain.close()]);
  }
});

test('file management auto-saves changes and keeps directory selection icon-only', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const { page, userDataRoot } = fixture;
    await page.evaluate(async (directory) => {
      await (window as any).workstation.saveModelCallLogSettings({
        enabled: false,
        directory
      });
    }, userDataRoot);

    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    await dialog.getByRole('button', { name: '文件管理', exact: true }).click();

    const section = dialog.getByRole('region', { name: '模型调用记录文件管理' });
    const toggle = section.getByRole('checkbox', { name: '保存模型调用记录' });
    const directoryButton = section.getByRole('button', { name: '选择存储目录' });
    await expect(section).toBeVisible();
    await expect(section.locator(':scope > p')).toHaveCount(0);
    await expect(section.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
    await expect(directoryButton.locator('svg')).toHaveCount(1);
    await expect(directoryButton).toHaveText('');

    await toggle.check();
    await expect.poll(async () => page.evaluate(async () => (
      (window as any).workstation.getModelCallLogSettings()
    ))).toMatchObject({ enabled: true, directory: userDataRoot });

    await toggle.uncheck();
    await expect.poll(async () => page.evaluate(async () => (
      (window as any).workstation.getModelCallLogSettings()
    ))).toMatchObject({ enabled: false, directory: userDataRoot });
  } finally {
    await fixture.close();
  }
});

test('RAG settings contain only the server-backed embedding interface manager', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置' });
    await dialog.getByRole('button', { name: 'RAG', exact: true }).click();

    const section = dialog.getByRole('region', { name: 'RAG 设置' });
    const manager = section.getByRole('region', { name: 'Embedding 接口管理' });
    await expectContentToFillSettingsView(section);
    await expect(section.getByText('RAG 源码证据', { exact: true })).toHaveCount(0);
    await expect(manager.getByText('向量数据库根目录', { exact: true })).toHaveCount(0);
    await expect(manager.locator('.rag-settings-field')).toHaveCount(0);
    await expect(manager.getByRole('button', { name: '保存目录', exact: true })).toHaveCount(0);
    await expect(manager.getByRole('button', { name: '新增', exact: true })).toHaveCount(1);
    await expect(manager.getByRole('button', { name: '新建', exact: true })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('model interface create action and empty state use the 新增 wording', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const dialog = await openModelSettings(fixture.page);
    const manager = dialog.getByRole('region', { name: '大模型接口管理' });

    expect(await manager.getByRole('button', { name: '新增', exact: true }).count()).toBe(1);
    expect(await manager.textContent()).toContain('还没有接口，点击“新增”开始配置。');
  } finally {
    await fixture.close();
  }
});

test('advanced request parameters can be added, saved and restored per model interface', async () => {
  const fixture = await launchSettingsFixture();
  try {
    const dialog = await openModelSettings(fixture.page);
    const manager = dialog.getByRole('region', { name: '大模型接口管理' });
    await expect(manager.getByText('高级请求参数', { exact: true })).toHaveCount(0);

    await manager.getByRole('button', { name: '新增', exact: true }).click();
    const editor = dialog.locator('form.model-interface-editor');
    const advanced = editor.getByRole('region', { name: '高级请求参数' });
    await expect(advanced).toBeVisible();
    await expect(advanced.getByText(
      '参数会随当前接口写入模型请求；没有配置时使用平台默认值。',
      { exact: true }
    )).toBeVisible();
    await expect(advanced.getByText(/参数值使用 JSON/)).toHaveCount(0);
    await expect(advanced.getByText(
      '暂未配置请求参数，模型将使用平台默认值。',
      { exact: true }
    )).toBeVisible();

    await advanced.getByRole('button', { name: '添加参数', exact: true }).click();
    const nameInput = advanced.getByPlaceholder('请输入参数名');
    const valueInput = advanced.getByPlaceholder('请输入参数值');
    await expect(nameInput).toBeVisible();
    await expect(valueInput).toBeVisible();
    await nameInput.fill('max_tokens');
    await valueInput.fill('16384');

    await editor.getByLabel('接口名称', { exact: true }).fill('Parameterized API');
    await editor.getByLabel('Base URL', { exact: true }).fill('https://models.example.test/v1');
    await editor.getByLabel('模型名', { exact: true }).fill('gpt-test');
    await editor.getByLabel('使用环境变量', { exact: true }).check();
    await editor.getByLabel('环境变量名', { exact: true }).fill('PARAMETERIZED_API_KEY');
    await editor.getByRole('button', { name: '保存', exact: true }).click();

    expect(await editor.locator('.model-interface-feedback').allTextContents()).toEqual([]);
    await expect(manager.getByText('Parameterized API', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '编辑 Parameterized API' }).click();
    await expect(editor.getByPlaceholder('请输入参数名')).toHaveValue('max_tokens');
    await expect(editor.getByPlaceholder('请输入参数值')).toHaveValue('16384');

    await advanced.getByRole('button', { name: '删除参数', exact: true }).click();
    await expect(advanced.getByText(
      '暂未配置请求参数，模型将使用平台默认值。',
      { exact: true }
    )).toBeVisible();
    await editor.getByRole('button', { name: '保存', exact: true }).click();

    await expect(manager.getByText('Parameterized API', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '编辑 Parameterized API' }).click();
    await expect(advanced.getByPlaceholder('请输入参数名')).toHaveCount(0);
    await expect(advanced.getByPlaceholder('请输入参数值')).toHaveCount(0);
    await expect(advanced.getByText(
      '暂未配置请求参数，模型将使用平台默认值。',
      { exact: true }
    )).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('model interface deletion uses an in-app confirmation dialog', async () => {
  const fixture = await launchSettingsFixture();
  try {
    await fixture.page.evaluate(async () => {
      await (window as any).workstation.createModelInterface({
        name: '待删除接口',
        baseUrl: 'https://delete.example.test',
        model: 'delete-test-model',
        credentialMode: 'environment',
        environmentVariableName: 'DELETE_TEST_API_KEY'
      });
    });

    const settingsDialog = await openModelSettings(fixture.page);
    const manager = settingsDialog.getByRole('region', { name: '大模型接口管理' });
    const interfaceName = manager.getByText('待删除接口', { exact: true });
    await expect(interfaceName).toBeVisible();

    await manager.getByRole('button', { name: '删除 待删除接口' }).click();
    const confirmation = fixture.page.getByRole('dialog', { name: '删除大模型接口' });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveCSS('background-color', 'rgb(29, 36, 45)');
    await expect(confirmation).toHaveCSS('border-radius', '10px');
    await expect(confirmation).toContainText('确定删除“待删除接口”吗？');
    await expect(confirmation).toContainText('删除后不会自动选择其他接口。');

    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(interfaceName).toBeVisible();

    await manager.getByRole('button', { name: '删除 待删除接口' }).click();
    await confirmation.getByRole('button', { name: '删除', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(interfaceName).not.toBeVisible();
  } finally {
    await fixture.close();
  }
});

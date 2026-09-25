import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKSTATION_ROOT = resolve(import.meta.dirname, '..', '..');

test('RAG settings keep only configuration content and use instructive field copy', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aiut-rag-settings-playwright-'));
  const userDataRoot = join(temporaryRoot, 'user-data');
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: ['--disable-gpu', '--no-sandbox', '.', `--user-data-dir=${userDataRoot}`],
      cwd: WORKSTATION_ROOT,
      env: {
        ...stringEnvironment(process.env),
        AI_UNIT_TEST_E2E_BACKEND_RUNTIME: 'enabled',
        AI_UNIT_TEST_E2E_AGENT_URL: 'http://127.0.0.1:39191',
        AI_UNIT_TEST_E2E_ANALYZER_URL: 'http://127.0.0.1:39192',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: '设置', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '设置' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'RAG', exact: true }).click();

    const section = dialog.getByRole('region', { name: 'RAG 设置' });
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Embedding 接口' })).toBeVisible();
    await expect(section.getByRole('region', { name: 'RAG 数据库' })).toHaveCount(0);
    await expect(section.getByText('向量数据库根目录', { exact: true })).toHaveCount(0);
    await expect(section.getByText('数据库根目录', { exact: true })).toHaveCount(0);
    await expect(section).not.toContainText('失败测试修复');
    await expect(section).not.toContainText('RAG 仅在修复生成失败的单元测试时使用');
    await expect(section).not.toContainText('Embedding 接口独立于大模型接口管理');

    await section.getByRole('button', { name: '新增', exact: true }).click();
    await expect.soft(section.getByLabel('Embedding 模型')).toHaveAttribute(
      'placeholder',
      '请输入模型名',
      { timeout: 2_000 }
    );
    await section.getByRole('radio', { name: '使用环境变量' }).check();
    await expect.soft(section.locator('.model-interface-env-input input')).toHaveAttribute(
      'placeholder',
      '请输入自定义环境变量名',
      { timeout: 2_000 }
    );

    const editor = section.locator('form.rag-embedding-interface-editor');
    await editor.getByLabel('名称').fill('布局验证');
    await editor.getByLabel('Base URL').fill('http://127.0.0.1:1/v1');
    await editor.getByLabel('Embedding 模型').fill('test-embedding');
    await editor.getByRole('radio', { name: '直接输入 API Key' }).check();
    await editor.getByRole('textbox', { name: 'API Key', exact: true }).fill('test-only');
    await editor.getByRole('button', { name: '测试连接', exact: true }).click();
    const result = editor.locator('.model-interface-result');
    await expect(result).toBeVisible();
    const footerLayout = await editor.evaluate((element) => {
      const resultElement = element.querySelector<HTMLElement>('.model-interface-result');
      const actionsElement = element.querySelector<HTMLElement>('.model-interface-editor-actions');
      if (!resultElement || !actionsElement) throw new Error('RAG editor footer is missing');
      const editorBox = element.getBoundingClientRect();
      const resultBox = resultElement.getBoundingClientRect();
      const actionsBox = actionsElement.getBoundingClientRect();
      return {
        resultBottom: editorBox.bottom - resultBox.bottom,
        actionsBottom: editorBox.bottom - actionsBox.bottom,
        resultOnLeft: resultBox.left < editorBox.left + editorBox.width / 2,
        actionsOnRight: actionsBox.left > editorBox.left + editorBox.width / 2
      };
    });
    expect(footerLayout.resultBottom).toBeLessThanOrEqual(40);
    expect(footerLayout.actionsBottom).toBeLessThanOrEqual(30);
    expect(footerLayout.resultOnLeft).toBe(true);
    expect(footerLayout.actionsOnRight).toBe(true);
  } finally {
    const settingsDialog = app?.windows()[0]?.getByRole('dialog', { name: '设置' });
    if (await settingsDialog?.isVisible().catch(() => false)) {
      await settingsDialog.getByRole('button', { name: '关闭设置' }).click().catch(() => undefined);
    }
    await app?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    ))
  );
}

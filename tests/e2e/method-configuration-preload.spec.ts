import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { build, normalizePath } from 'vite';
import type { ClassTaskSnapshot } from '../../src/shared/class-task-contracts';

test.use({ channel: 'msedge', viewport: { width: 1440, height: 960 } });

let fixtureBuild: ReturnType<typeof build> | undefined;
async function mountApp(page: Page, settings: {
  deletedTask?: boolean; savedCatalog?: boolean; readyInitially?: boolean;
  holdTaskList?: boolean; holdViewState?: boolean;
  restoreOnRevoke?: boolean;
} = {}): Promise<string[]> {
  const built = await (fixtureBuild ??= build({
    configFile: false, logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    plugins: [{
      name: 'omit-unused-editor-from-method-pane-test',
      resolveId(source) {
        if (source.endsWith('/LocalMonacoEditor')) return '\0unused-editor';
        if (source.endsWith('/RagMethodSourcePanel')) return '\0unused-rag-editor';
        const prefix = '@codingame/monaco-vscode-api/vscode/';
        if (source.startsWith(prefix)) {
          const path = resolve('node_modules/@codingame/monaco-vscode-api/vscode/src', source.slice(prefix.length));
          const match = [`${path}.js`, path, resolve(path, 'index.js')].find(existsSync);
          return match ? normalizePath(match) : null;
        }
      },
      load(id) {
        if (id === '\0unused-editor') return 'export function LocalMonacoEditor() { return null; }';
        if (id === '\0unused-rag-editor') return 'export function RagMethodSourcePanel() { return null; }';
      }
    }],
    build: {
      write: false, minify: false,
      lib: { entry: resolve('tests/e2e/support/method-configuration-preload.tsx'),
        formats: ['iife'], name: 'MethodConfigurationPreloadFixture' }
    }
  }));
  const bundle = (Array.isArray(built) ? built[0] : built) as {
    output: Array<{ type: string; code?: string; fileName: string; source?: string | Uint8Array }>
  };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');
  await page.addStyleTag({ path: resolve('src/renderer/src/styles.css') });
  for (const asset of bundle.output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))) {
    await page.addStyleTag({ content: String(asset.source) });
  }
  await page.evaluate(value => { (window as any).methodConfigurationFixtureSettings = value; }, settings);
  await page.addScriptTag({ content: bundle.output.find(item => item.type === 'chunk')!.code! });
  return errors;
}

test('startup discards a saved method page whose task was deleted without requesting its catalog', async ({ page }) => {
  const errors = await mountApp(page, { deletedTask: true, savedCatalog: true, readyInitially: true });
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.savedViewStates().length)).toBeGreaterThan(0);
  await expect(page.locator('.editor-tab-list')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.freshnessCalls())).toBe(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.savedViewStates().at(-1).workbenchTabs)).toEqual([]);
  await expect(page.locator('.statusbar-message')).not.toContainText('Unknown class task');
  expect(errors).toEqual([]);
});

test('method page restoration waits for the task list before checking its saved catalog', async ({ page }) => {
  const errors = await mountApp(page, { holdTaskList: true, savedCatalog: true, readyInitially: true });
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.viewStateCalls())).toBe(1);
  expect(await page.evaluate(() => (window as any).preloadFixture.freshnessCalls())).toBe(0);
  await page.evaluate(() => (window as any).preloadFixture.finishTaskList());
  await expect(page.locator('.class-task-card')).toHaveCount(1);
  await expect(page.locator('.class-task-method-table')).toContainText('run()');
  expect(await page.evaluate(() => (window as any).preloadFixture.freshnessCalls())).toBe(1);
  expect(errors).toEqual([]);
});

test('deleting a card prevents its delayed saved method page from reopening', async ({ page }) => {
  const errors = await mountApp(page, { holdViewState: true, savedCatalog: true, readyInitially: true });
  await expect(page.locator('.class-task-card')).toHaveCount(1);
  await page.getByRole('button', { name: '删除当前任务', exact: true }).click();
  await expect(page.locator('.class-task-card')).toHaveCount(0);
  await page.evaluate(() => (window as any).preloadFixture.finishViewState());
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.savedViewStates().length)).toBeGreaterThan(0);
  await expect(page.locator('.editor-tab-list')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.freshnessCalls())).toBe(0);
  expect(errors).toEqual([]);
});

test('deleting a card closes its open method page and ignores late coverage and catalog reads', async ({ page }) => {
  const errors = await mountApp(page, { readyInitially: true });
  await expect(page.locator('.class-task-method-table')).toContainText('run()');
  await page.evaluate(() => (window as any).preloadFixture.holdNextCatalog());
  await page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(2);
  await page.getByRole('button', { name: '删除当前任务', exact: true }).click();
  await expect(page.locator('.class-task-card')).toHaveCount(0);
  await expect(page.locator('.editor-tab-list')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).preloadFixture.finishHeldCatalog();
    (window as any).preloadFixture.publishCoverage(2);
    (window as any).preloadFixture.update({ state: 'READY' });
  });
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.savedViewStates().at(-1)?.workbenchTabs)).toEqual([]);
  await expect(page.locator('.class-task-card')).toHaveCount(0);
  await expect(page.locator('.class-task-method-table')).toHaveCount(0);
  await expect(page.locator('.statusbar-message')).toContainText('已删除');
  expect(errors).toEqual([]);
});

test('revoke displays the retained method coverage immediately without requesting another preload', async ({ page }) => {
  const errors = await mountApp(page, { readyInitially: true, restoreOnRevoke: true });
  const table = page.locator('.class-task-method-table');
  await expect(table).toContainText('run()');
  await page.evaluate(() => {
    (window as any).preloadFixture.complete();
    (window as any).preloadFixture.publishCoverage(1);
  });
  await expect(table).toContainText('50%');
  await page.locator('.class-task-card').click();
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await expect(table).toContainText('0%');
  await expect(page.locator('.class-task-method-loading')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(1);
  await page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogRequests()
    .filter((request: any) => request.forceReload).length)).toBe(1);
  expect(errors).toEqual([]);
});

test('each manual coverage refresh bypasses the saved fingerprint cache', async ({ page }) => {
  const errors = await mountApp(page, { readyInitially: true, savedCatalog: true });
  await expect(page.locator('.class-task-method-table')).toContainText('run()');
  const freshnessCalls = await page.evaluate(() => (window as any).preloadFixture.freshnessCalls());
  for (let count = 1; count <= 2; count += 1) {
    await page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogRequests()
      .filter((request: any) => request.forceReload).length)).toBe(count);
    await expect(page.locator('.class-task-method-loading')).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).preloadFixture.freshnessCalls())).toBe(freshnessCalls);
  expect(errors).toEqual([]);
});

test('production App waits for preload, opens methods automatically and retains genuine failures', async ({ page }, testInfo) => {
  const errors = await mountApp(page);
  const loading = page.locator('.class-task-method-loading');
  const readCalls = () => page.evaluate(() => (window as any).preloadFixture.catalogCalls());
  const update = (patch: Partial<ClassTaskSnapshot>) => page.evaluate(value => {
    (window as any).preloadFixture.update(value);
  }, patch);

  await expect(loading).toBeVisible();
  await expect(loading).toContainText('正在加载方法与覆盖率信息');
  await expect(page.getByText('覆盖率信息读取失败', { exact: true })).toHaveCount(0);
  await expect(page.locator('.class-task-method-retry')).toHaveCount(0);
  const geometry = await loading.evaluate(element => ({
    align: getComputedStyle(element).alignItems,
    justify: getComputedStyle(element).justifyContent,
    animation: getComputedStyle(element.querySelector('svg')!).animationName
  }));
  expect(geometry).toEqual({ align: 'center', justify: 'center', animation: 'spin' });
  await page.screenshot({ path: testInfo.outputPath('method-preloading.png') });
  const initialCalls = await readCalls();
  expect(initialCalls).toBe(0);

  await update({ state: 'READY', preloadState: 'READY' });
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(await readCalls()).toBe(initialCalls + 1);

  await update({ state: 'PRELOADING', preloadState: 'RUNNING' });
  await expect(loading).toBeVisible();
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toHaveCount(0);
  await update({ state: 'PRELOAD_FAILED', preloadState: 'FAILED',
    lastError: { code: 'PRELOAD_FAILED', message: 'fixture Maven failure' } });
  await expect(page.getByText('覆盖率信息读取失败', { exact: true })).toBeVisible();
  await expect(page.locator('.class-task-method-retry')).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(await readCalls()).toBe(initialCalls + 1);
  expect(errors).toEqual([]);
});

const runningRefreshConflict = "Error invoking remote method 'class-task:methods:get': Error: 当前类任务正在运行，暂时无法刷新方法与覆盖率信息。";

test('active tasks disable manual refresh while published coverage keeps updating', async ({ page }) => {
  const errors = await mountApp(page, { readyInitially: true });
  const table = page.locator('.class-task-method-table');
  const refresh = page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true });
  await expect(table).toContainText('run()');
  for (const state of ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING']) {
    await page.evaluate(state => (window as any).preloadFixture.update({ state }), state);
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute('title', /不能手动刷新/);
  }
  await page.evaluate(() => {
    (window as any).preloadFixture.update({ state: 'RUNNING' });
    (window as any).preloadFixture.publishCoverage(1);
  });
  await expect(table).toContainText('50%');
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(1);
  await page.evaluate(() => (window as any).preloadFixture.update({ state: 'COMPLETED' }));
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogRequests()
    .filter((request: any) => request.forceReload).length)).toBe(1);
  await expect(refresh).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a manual refresh racing with execution retains the table and the draft without a shared read', async ({ page }, testInfo) => {
  const errors = await mountApp(page, { readyInitially: true });
  const table = page.locator('.class-task-method-table');
  const refresh = page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true });
  await expect(table).toContainText('run()');
  const selected = table.getByRole('checkbox').first();
  await selected.click();
  const checked = await selected.getAttribute('aria-checked');
  await page.evaluate(() => (window as any).preloadFixture.armRace());
  await refresh.click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(2);
  await page.evaluate(message => {
    (window as any).preloadFixture.update({ state: 'RUNNING' });
    (window as any).preloadFixture.rejectForce(message);
  }, runningRefreshConflict);
  await expect(table).toBeVisible();
  await expect(selected).toHaveAttribute('aria-checked', checked!);
  await expect(page.locator('.class-task-method-refresh-error')).toContainText('已保留');
  await expect(page.locator('.class-task-method-retry')).toHaveCount(0);
  await expect(refresh).toBeDisabled();
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogRequests()
    .map((request: any) => Boolean(request.forceReload)))).toEqual([false, true]);
  await page.screenshot({ path: testInfo.outputPath('manual-refresh-running-race.png') });
  await page.evaluate(() => (window as any).preloadFixture.publishCoverage(1));
  await expect(table).toContainText('50%');
  await expect(page.locator('.class-task-method-refresh-error')).toHaveCount(0);
  await expect(selected).toHaveAttribute('aria-checked', checked!);
  expect(errors).toEqual([]);
});

test('a failed manual Maven refresh retains existing coverage and succeeds on retry', async ({ page }, testInfo) => {
  const errors = await mountApp(page, { readyInitially: true });
  const table = page.locator('.class-task-method-table');
  const refresh = page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true });
  await expect(table).toContainText('run()');
  await page.evaluate(() => (window as any).preloadFixture.publishCoverage(1));
  await expect(table).toContainText('50%');
  await page.evaluate(() => (window as any).preloadFixture.armRace());
  await refresh.click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(2);
  await page.evaluate(() => (window as any).preloadFixture.rejectForce('fixture Maven failure'));
  await expect(table).toBeVisible();
  await expect(table).toContainText('50%');
  await expect(page.locator('.class-task-method-refresh-error')).toContainText('fixture Maven failure');
  await expect(page.getByText('覆盖率信息读取失败', { exact: true })).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('manual-refresh-retained-table.png') });
  await page.evaluate(() => (window as any).preloadFixture.clearRace());
  await refresh.click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(3);
  await expect(page.locator('.class-task-method-refresh-error')).toHaveCount(0);
  await expect(table).toBeVisible();
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogRequests()
    .map((request: any) => Boolean(request.forceReload)))).toEqual([false, true, true]);
  expect(errors).toEqual([]);
});

test('each published formal catalog updates the open method table during generation and retains the draft', async ({ page }) => {
  const errors = await mountApp(page);
  await page.evaluate(() => (window as any).preloadFixture.update({ state: 'READY', preloadState: 'READY' }));
  const table = page.locator('.class-task-method-table');
  await expect(table).toContainText('run()');
  const selected = table.getByRole('checkbox').first();
  await selected.click();
  const checked = await selected.getAttribute('aria-checked');
  await page.evaluate(() => (window as any).preloadFixture.update({ state: 'RUNNING', currentAtomicStep: 'MODEL_GENERATION' }));
  const calls = await page.evaluate(() => (window as any).preloadFixture.catalogCalls());
  await page.evaluate(() => (window as any).preloadFixture.publishCoverage(1));
  await expect(table).toContainText('50%');
  await expect(selected).toHaveAttribute('aria-checked', checked!);
  await page.evaluate(() => (window as any).preloadFixture.publishCoverage(2));
  await expect(table).toContainText('100%');
  await expect(selected).toHaveAttribute('aria-checked', checked!);
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(calls);
  expect(errors).toEqual([]);
});

test('a formal catalog supersedes an in-flight old read and ignores another workspace', async ({ page }) => {
  const errors = await mountApp(page);
  await page.evaluate(() => (window as any).preloadFixture.update({ state: 'READY', preloadState: 'READY' }));
  const table = page.locator('.class-task-method-table');
  await expect(table).toContainText('run()');
  await page.evaluate(() => (window as any).preloadFixture.holdNextCatalog());
  await page.getByRole('button', { name: '刷新方法与覆盖率信息', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogCalls())).toBe(2);
  await page.evaluate(() => (window as any).preloadFixture.publishCoverage(2));
  await expect(table).toContainText('100%');
  await page.evaluate(() => (window as any).preloadFixture.finishHeldCatalog());
  await page.evaluate(() => (window as any).preloadFixture.publishCoverage(0, 2, 'D:/other-workspace'));
  await expect(table).toContainText('100%');
  await expect(page.locator('.class-task-method-loading')).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function revokeAndRun(page: Page) {
  const errors = await mountApp(page);
  await page.evaluate(() => (window as any).preloadFixture.complete());
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).preloadFixture.armRace());
  await page.locator('.class-task-card').click();
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogRequests()
    .filter((request: any) => request.forceReload).length)).toBe(1);
  await page.getByRole('button', { name: '执行当前类', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停当前类', exact: true })).toBeVisible();
  return errors;
}

test('revoking then immediately running waits for the shared method catalog without a retry page', async ({ page }, testInfo) => {
  const errors = await revokeAndRun(page);
  await page.evaluate(message => (window as any).preloadFixture.rejectForce(message), runningRefreshConflict);
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogRequests().length)).toBe(3);
  await expect(page.locator('.class-task-method-loading')).toBeVisible();
  await expect(page.locator('.class-task-method-retry')).toHaveCount(0);
  await page.evaluate(() => (window as any).preloadFixture.finishShared());
  await expect(page.locator('.class-task-method-table')).toContainText('run()');
  await expect(page.locator('.class-task-method-loading')).toHaveCount(0);
  await expect(page.getByText('覆盖率信息读取失败', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogRequests().map((r: any) => Boolean(r.forceReload))))
    .toEqual([false, true, false]);
  expect(await page.evaluate(() => (window as any).preloadFixture.runCalls())).toBe(1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('revoke-immediate-run-methods.png') });
});

test('a genuine failure of the shared catalog still displays retry after a running refresh conflict', async ({ page }) => {
  const errors = await revokeAndRun(page);
  await page.evaluate(message => (window as any).preloadFixture.rejectForce(message), runningRefreshConflict);
  await expect.poll(() => page.evaluate(() => (window as any).preloadFixture.catalogRequests().length)).toBe(3);
  await page.evaluate(() => (window as any).preloadFixture.finishShared('fixture Analyzer failure'));
  await expect(page.getByText('覆盖率信息读取失败', { exact: true })).toBeVisible();
  await expect(page.locator('.class-task-method-retry')).toBeVisible();
  await expect(page.locator('.class-task-method-loading')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogRequests().length)).toBe(3);
  expect(errors).toEqual([]);
});

test('a different forced refresh error is not retried as a running conflict', async ({ page }) => {
  const errors = await revokeAndRun(page);
  await page.evaluate(() => (window as any).preloadFixture.rejectForce('fixture Maven failure'));
  await expect(page.getByText('覆盖率信息读取失败', { exact: true })).toBeVisible();
  await expect(page.locator('.class-task-method-retry')).toBeVisible();
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogRequests().length)).toBe(2);
  expect(errors).toEqual([]);
});

test('execute waits for an in-flight result revocation before starting the task', async ({ page }) => {
  const errors = await mountApp(page);
  await page.evaluate(() => (window as any).preloadFixture.complete());
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).preloadFixture.holdRevoke());
  await page.locator('.class-task-card').click();
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await page.getByRole('button', { name: '执行当前类', exact: true }).click();
  await expect(page.locator('.statusbar-message')).toContainText('正在等待撤回完成');
  expect(await page.evaluate(() => (window as any).preloadFixture.runCalls())).toBe(0);
  await page.evaluate(() => (window as any).preloadFixture.finishRevoke());
  await expect(page.getByRole('button', { name: '暂停当前类', exact: true })).toBeVisible();
  await expect(page.locator('.class-task-method-table')).toContainText('run()');
  await expect(page.locator('.class-task-method-retry')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.runCalls())).toBe(1);
  expect(errors).toEqual([]);
});

test('a failed pending revocation reports the error without starting a task', async ({ page }) => {
  const errors = await mountApp(page);
  await page.evaluate(() => (window as any).preloadFixture.complete());
  await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).preloadFixture.holdRevoke());
  await page.locator('.class-task-card').click();
  await page.getByRole('button', { name: '撤回', exact: true }).click();
  await page.getByRole('button', { name: '执行当前类', exact: true }).click();
  await expect(page.locator('.statusbar-message')).toContainText('正在等待撤回完成');
  await page.evaluate(() => (window as any).preloadFixture.finishRevoke('fixture delete failed'));
  await expect(page.locator('.statusbar-message')).toContainText('fixture delete failed');
  await expect(page.getByRole('button', { name: '执行当前类', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).preloadFixture.runCalls())).toBe(0);
  expect(await page.evaluate(() => (window as any).preloadFixture.catalogRequests().length)).toBe(1);
  expect(errors).toEqual([]);
});

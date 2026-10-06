import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { ClassTaskState } from '../../src/shared/class-task-contracts';

test.use({ channel: 'msedge' });

test('result decisions stay hidden until generation ends, including stale result snapshots', async ({ page }) => {
  const built = await build({
    configFile: false, logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsx: 'automatic' },
    build: { write: false, minify: false, lib: {
      entry: resolve('tests/e2e/support/class-task-result-actions.tsx'),
      formats: ['iife'], name: 'ResultActionsFixture'
    } }
  });
  const bundle = (Array.isArray(built) ? built[0] : built) as { output: Array<{ type: string; code?: string }> };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<html lang="zh-CN"><body><main id="root"></main></body></html>');
  await page.addStyleTag({ path: resolve('src/renderer/src/class-tasks/class-tasks.css') });
  await page.addScriptTag({ content: bundle.output.find(item => item.type === 'chunk')!.code! });
  const accept = page.getByRole('button', { name: '接受', exact: true });
  const revoke = page.getByRole('button', { name: '撤回', exact: true });
  const update = (state: ClassTaskState, resultState?: ClassTaskState) => page.evaluate(({ state, resultState }) => {
    (window as unknown as { updateResultActionState: (state: ClassTaskState, resultState?: ClassTaskState) => void })
      .updateResultActionState(state, resultState);
  }, { state, resultState });

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('本次生成文件').getByText('TaskService1Test.java', { exact: true })).toBeVisible();
  for (const state of ['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING', 'PRELOADING'] as const) {
    await update(state);
    await expect(accept).toHaveCount(0, { timeout: 1500 });
    await expect(revoke).toHaveCount(0, { timeout: 1500 });
  }
  for (const state of ['READY', 'COMPLETED', 'TERMINATED', 'FAILED', 'INTERRUPTED'] as const) {
    await update(state, state);
    await expect(accept).toBeVisible();
    await expect(revoke).toBeVisible();
    if (state === 'READY') {
      await expect(page.getByText('已有结果待处理', { exact: true })).toBeVisible();
      await expect(page.getByText('待处理', { exact: true })).toBeVisible();
    }
  }
  await update('COMPLETED', 'RUNNING');
  await expect(accept).toHaveCount(0);
  await expect(revoke).toHaveCount(0);
  await update('COMPLETED', 'COMPLETED');
  await accept.click();
  expect(await page.evaluate(() => (window as unknown as { lastResultAction: string }).lastResultAction)).toBe('accept');
  await revoke.click();
  expect(await page.evaluate(() => (window as unknown as { lastResultAction: string }).lastResultAction)).toBe('revoke');
  expect(errors).toEqual([]);
});

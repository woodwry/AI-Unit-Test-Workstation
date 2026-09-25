import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { ClassTaskSnapshot } from '../../src/shared/class-task-contracts';

test.use({ channel: 'msedge' });

test('production task card shows breathing activity, live stages, pause and completion', async ({ page }, testInfo) => {
  const built = await build({
    configFile: false,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsx: 'automatic' },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve('tests/e2e/support/class-task-card-activity.tsx'),
        formats: ['iife'],
        name: 'TaskCardActivityFixture'
      }
    }
  });
  const bundle = (Array.isArray(built) ? built[0] : built) as { output: Array<{ type: string; code?: string }> };
  const script = bundle.output.find((item) => item.type === 'chunk')!.code!;
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.setContent('<html lang="zh-CN"><body><main id="root" style="width:420px"></main></body></html>');
  await page.addStyleTag({ content: 'body{background:#191919;color:#cbd5e1;font-family:Segoe UI,Microsoft YaHei,sans-serif;padding:24px;--list-hover-bg:#28313a;--panel-bg:#222}' });
  await page.addStyleTag({ path: resolve('src/renderer/src/class-tasks/class-tasks.css') });
  await page.addScriptTag({ content: script });
  const footer = page.getByRole('status');
  const indicator = page.locator('.class-task-card-execution-indicator');
  const animation = () => indicator.evaluate((element) => getComputedStyle(element, '::before').animationName);
  const expectAlignedIndicators = async () => {
    const upper = await page.locator('.class-task-card-status-dot').boundingBox();
    const lower = await indicator.boundingBox();
    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    expect(Math.abs((upper!.x + upper!.width / 2) - (lower!.x + lower!.width / 2))).toBeLessThan(0.1);
  };
  const update = (patch: Partial<ClassTaskSnapshot>) => page.evaluate((value) => {
    (window as unknown as { updateTaskCard: (patch: Partial<ClassTaskSnapshot>) => void }).updateTaskCard(value);
  }, patch);

  await expect(footer).toHaveText('正在生成单元测试');
  await expectAlignedIndicators();
  await expect(page.locator('.class-task-card-spinner-slot')).toHaveCount(0);
  expect(await animation()).toBe('class-task-execution-core-pulse');
  expect(await indicator.evaluate((element) => getComputedStyle(element, '::after').animationName)).toBe('class-task-execution-aura-pulse');
  await page.screenshot({ path: testInfo.outputPath('task-card-running.png') });
  await update({ currentAtomicStep: 'MODEL_REPAIR' });
  await expect(footer).toHaveText('正在修复单元测试');
  await update({ state: 'PAUSE_REQUESTED' });
  await expect(footer).toHaveText('正在暂停 · 等待当前步骤结束');
  expect(await animation()).not.toBe('none');
  await update({ state: 'PAUSED' });
  await expect(footer).toHaveText('已暂停 · 修复单元测试');
  expect(await animation()).toBe('none');
  expect(await page.locator('.class-task-card-progress-active-batch').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await update({ state: 'RUNNING', currentAtomicStep: 'MAVEN_TEST' });
  await expect(footer).toHaveText('正在执行 Maven 测试验证');
  expect(await animation()).not.toBe('none');

  await page.locator('#root').evaluate((element) => { element.style.width = '230px'; });
  await update({ currentAtomicStep: 'ANALYZE_METHOD' });
  const label = page.locator('.class-task-card-execution-label');
  await expect(footer).toHaveAttribute('title', '正在分析方法与准备上下文');
  await expectAlignedIndicators();
  await page.locator('#root').evaluate((element) => { element.style.zoom = '1.5'; });
  await expectAlignedIndicators();
  expect(await label.evaluate((element) => ({
    whiteSpace: getComputedStyle(element).whiteSpace,
    textOverflow: getComputedStyle(element).textOverflow
  }))).toEqual({ whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await animation()).toBe('none');
  await update({ state: 'COMPLETED' });
  await expect(footer).toHaveCount(0);
  expect(browserErrors).toEqual([]);
});

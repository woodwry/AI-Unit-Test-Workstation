import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { build } from 'vite';

test.use({ channel: 'msedge' });
let script: string;

test.beforeAll(async () => {
  const built = await build({
    configFile: false, logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsx: 'automatic' },
    build: {
      write: false, minify: false,
      lib: { entry: resolve('tests/e2e/support/backend-availability.tsx'), formats: ['iife'], name: 'BackendAvailabilityFixture' }
    }
  });
  const bundle = (Array.isArray(built) ? built[0] : built) as { output: Array<{ type: string; code?: string }> };
  script = bundle.output.find(item => item.type === 'chunk')!.code!;
});

async function mount(page: Page, available = true) {
  await page.clock.install();
  await page.setContent('<html><body><main id="root"></main></body></html>');
  await page.addStyleTag({ path: resolve('src/renderer/src/styles.css') });
  // Only the IPC boundary is controlled; the gate and rendered workbench are real.
  await page.evaluate(value => Object.assign(window, { initialBackendAvailable: value }), available);
  await page.addScriptTag({ content: script });
  await expect.poll(() => page.evaluate(() => (window as any).availabilityFixture.probes)).toBe(1);
}

async function configure(page: Page, patch: Record<string, boolean>) {
  await page.evaluate(value => Object.assign((window as any).availabilityFixture, value), patch);
}

async function poll(page: Page) { await page.clock.runFor(5_000); }

test('a transient health failure keeps the connected workbench visible and preserves unsaved input', async ({ page }) => {
  await mount(page);
  const workbench = page.getByRole('region', { name: '工作台' });
  await expect(workbench).toBeVisible();
  await page.getByRole('textbox', { name: '未保存的内容' }).fill('当前编辑不能丢失');
  await configure(page, { available: false });
  await poll(page);
  await expect(workbench).toBeVisible({ timeout: 1_500 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await configure(page, { available: true });
  await poll(page);
  await configure(page, { reject: true });
  await poll(page);
  await poll(page);
  await expect(workbench).toBeVisible();
  await configure(page, { reject: false });
  await poll(page);
  await expect(page.getByRole('textbox', { name: '未保存的内容' })).toHaveValue('当前编辑不能丢失');
});

test('a confirmed outage automatically recovers without remounting the workbench', async ({ page }) => {
  await mount(page);
  const workbench = page.getByRole('region', { name: '工作台' });
  await expect(workbench).toBeVisible();
  await configure(page, { available: false });
  await poll(page);
  await poll(page);
  await poll(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(workbench).toBeHidden();
  await configure(page, { available: true });
  await poll(page);
  await expect(workbench).toBeVisible({ timeout: 1_500 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).availabilityFixture.workbenchMounts)).toBe(1);
});

test('an initially unreachable server is automatically checked again', async ({ page }) => {
  await mount(page, false);
  await expect(page.getByRole('alert')).toBeVisible();
  await configure(page, { available: true });
  await poll(page);
  await expect(page.getByRole('region', { name: '工作台' })).toBeVisible({ timeout: 1_500 });
});

test('slow probes do not overlap and a runtime failure cannot be overwritten by a stale success', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('region', { name: '工作台' })).toBeVisible();
  await configure(page, { hold: true });
  await poll(page);
  await poll(page);
  await poll(page);
  expect(await page.evaluate(() => (window as any).availabilityFixture.probes)).toBe(2);
  await page.evaluate(() => (window as any).availabilityFixture.emit('failed'));
  await expect(page.getByRole('alert')).toBeVisible();
  await page.evaluate(() => (window as any).availabilityFixture.release());
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('region', { name: '工作台' })).toBeVisible();
});

test('manual retry during an unfinished health check performs a fresh check after its stale reply', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('region', { name: '工作台' })).toBeVisible();
  await configure(page, { hold: true });
  await poll(page);
  await page.evaluate(() => (window as any).availabilityFixture.emit('failed'));
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '正在重试…', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).availabilityFixture.release());
  await expect(page.getByRole('region', { name: '工作台' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

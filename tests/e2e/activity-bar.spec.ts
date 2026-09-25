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

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string'
    ))
  );
}

test('Activity Bar 只保留资源管理器、搜索和 RAG 知识库', async () => {
  const userDataRoot = await mkdtemp(join(tmpdir(), 'aiut-activity-bar-'));
  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({
      args: ['--disable-gpu', '--no-sandbox', '.', `--user-data-dir=${userDataRoot}`],
      cwd: WORKSTATION_ROOT,
      env: {
        ...stringEnvironment(process.env),
        AI_UNIT_TEST_DISABLE_REAL_MODEL: 'true',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    const activityBar = page.locator('.activity-bar');
    await expect(activityBar.getByTitle('资源管理器')).toBeVisible();
    await expect(activityBar.getByTitle('搜索')).toBeVisible();
    await expect(activityBar.getByTitle('RAG 知识库')).toBeVisible();
    await expect(activityBar.getByTitle('扩展')).toHaveCount(0);
    await expect(activityBar.locator('button')).toHaveCount(3);
  } finally {
    await app?.close();
    await rm(userDataRoot, { recursive: true, force: true });
  }
});

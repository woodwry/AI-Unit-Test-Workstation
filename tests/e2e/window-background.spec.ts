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

test('native window keeps the workbench background after minimize and restore', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'aiut-window-background-'));
  const userDataRoot = join(temporaryRoot, 'user-data');
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: ['--disable-gpu', '--no-sandbox', '.', `--user-data-dir=${userDataRoot}`],
      cwd: WORKSTATION_ROOT,
      env: {
        ...stringEnvironment(process.env),
        AI_UNIT_TEST_E2E_BACKEND_RUNTIME: 'enabled',
        AI_UNIT_TEST_E2E_AGENT_URL: 'http://127.0.0.1:39291',
        AI_UNIT_TEST_E2E_ANALYZER_URL: 'http://127.0.0.1:39292',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    const backgroundColor = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) throw new Error('Main window is unavailable');
      mainWindow.minimize();
      mainWindow.restore();
      return mainWindow.getBackgroundColor();
    });

    expect(backgroundColor.toUpperCase()).toBe('#161819');
  } finally {
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

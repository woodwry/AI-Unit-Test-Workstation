import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';
import test from 'node:test';
import { resolveConfig } from 'vite';
import workstationConfig from '../electron.vite.config.ts';

const workstationRoot = fileURLToPath(new URL('../', import.meta.url));

function isAllowedByDirectory(allowedDirectory, targetPath) {
  const pathFromAllowedDirectory = relative(
    resolve(allowedDirectory),
    resolve(targetPath)
  );
  return pathFromAllowedDirectory === '' || (
    !pathFromAllowedDirectory.startsWith('..') &&
    !isAbsolute(pathFromAllowedDirectory)
  );
}

test('renderer dev server preserves Vite workspace-root filesystem access', async () => {
  const rendererConfig = workstationConfig.renderer;
  assert.ok(rendererConfig, 'missing renderer Vite configuration');

  const resolvedConfig = await resolveConfig(
    {
      ...rendererConfig,
      configFile: false,
      root: resolve(workstationRoot, rendererConfig.root)
    },
    'serve',
    'development'
  );
  const targets = [
    resolve(workstationRoot, 'src/renderer/index.html'),
    resolve(workstationRoot, 'assets/branding/ai-unit-test-workstation.svg'),
    resolve(workstationRoot, 'node_modules/@codingame/monaco-vscode-api/vscode/src')
  ];

  for (const target of targets) {
    assert.ok(
      resolvedConfig.server.fs.allow.some((allowedDirectory) =>
        isAllowedByDirectory(allowedDirectory, target)
      ),
      `${target} is outside Vite server.fs.allow:\n${resolvedConfig.server.fs.allow.join('\n')}`
    );
  }
});

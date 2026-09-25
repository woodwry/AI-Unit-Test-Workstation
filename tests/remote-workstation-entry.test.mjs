import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const remoteLauncher = await readFile(
  new URL('../scripts/start-remote-workstation.mjs', import.meta.url),
  'utf8'
);

test('npm package exposes a DeepSeek Harness style npx entry', () => {
  assert.equal(packageJson.name, '@woodwry/ai-unit-test-workstation');
  assert.equal(
    packageJson.bin['ai-unit-test-workstation'],
    'scripts/start-remote-workstation.mjs'
  );
  assert.equal(packageJson.scripts['dev:remote'], 'node scripts/start-remote-workstation.mjs dev');
  assert.equal(packageJson.scripts.prepare, 'npm run build');
  assert.equal(packageJson.repository.url, 'git+https://github.com/woodwry/AI-Unit-Test-Workstation.git');
});

test('remote launcher points the client to deployed backend services', () => {
  assert.ok(remoteLauncher.includes('AI_BACKEND_URL'));
  assert.ok(remoteLauncher.includes('JAVA_ANALYZER_URL'));
  assert.ok(remoteLauncher.includes('https://woodwry.cn'));
  assert.ok(remoteLauncher.includes('https://woodwry.cn/java-analyzer'));
  assert.ok(remoteLauncher.includes('run-electron-vite.mjs'));
  assert.ok(remoteLauncher.includes('未检测到构建产物'));
  assert.ok(remoteLauncher.includes('existsSync(builtMainPath)'));
  assert.ok(remoteLauncher.includes("require('electron')"));
});

test('README documents npx and source based startup', () => {
  assert.ok(readme.includes('npx @woodwry/ai-unit-test-workstation'));
  assert.ok(readme.includes('git clone https://github.com/woodwry/AI-Unit-Test-Workstation.git'));
  assert.ok(readme.includes('npm run dev:remote'));
  assert.equal(packageJson.devDependencies.vite, '5.4.21');
});

test('remote launcher exposes a help command for install verification', () => {
  const result = spawnSync(process.execPath, ['scripts/start-remote-workstation.mjs', '--help'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /npx @woodwry\/ai-unit-test-workstation/);
  assert.match(result.stdout, /https:\/\/woodwry\.cn/);
  assert.match(result.stdout, /https:\/\/woodwry\.cn\/java-analyzer/);
});

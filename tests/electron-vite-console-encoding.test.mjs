import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

for (const mode of ['dev', 'preview']) {
  test(`${mode} keeps Electron Chinese output readable from a legacy Windows console`, {
    skip: process.platform !== 'win32'
  }, () => {
    const [command, ...args] = manifest.scripts[mode].split(/\s+/);
    const entry = command === 'node'
      ? resolve(root, args.shift())
      : resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js');
    const probe = `
      import { spawnSync } from 'node:child_process';
      import { pathToFileURL } from 'node:url';
      const cp = (...args) => spawnSync('chcp.com', args, { windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] });
      const original = cp().stdout.toString('latin1').match(/(\\d+)\\s*$/)?.[1];
      if (!original) throw new Error('Windows console code page unavailable');
      try {
        if (cp('936').status !== 0) throw new Error('Cannot initialize legacy console');
        process.argv = [process.execPath, ${JSON.stringify(entry)}, '--version'];
        await import(pathToFileURL(${JSON.stringify(entry)}).href);
        const current = cp().stdout.toString('latin1').match(/(\\d+)\\s*$/)?.[1];
        process.stdout.write('CODE_PAGE=' + current + '\\n');
        process.stdout.write('MESSAGE=[rag] 后台依赖目录准备失败，可在导入时重试。\\n');
      } finally { cp(original); }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: root, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'], timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr?.toString('utf8'));
    const raw = result.stdout.toString('utf8');
    const codePage = raw.match(/CODE_PAGE=(\d+)/)?.[1];
    assert.equal(codePage, '65001', `${mode} must select UTF-8 before Electron starts`);
    const rendered = new TextDecoder(codePage === '65001' ? 'utf-8' : 'gb18030').decode(result.stdout);
    assert.match(rendered, /MESSAGE=\[rag\] 后台依赖目录准备失败，可在导入时重试。/);
    assert.match(raw, /electron-vite\/\d/, 'CLI flags still reach electron-vite');
  });
}

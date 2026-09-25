import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as shellServiceModule from '../src/main/services/shell.service.ts';

test('Windows Maven 输出不是有效 UTF-8 时使用 GB18030 解码', () => {
  const decodeCommandOutput = shellServiceModule.decodeCommandOutput;
  assert.equal(typeof decodeCommandOutput, 'function');
  assert.equal(
    decodeCommandOutput(
      Buffer.from('d5d2b2bbb5bdb7fbbac5', 'hex')
    ),
    '找不到符号'
  );
  assert.equal(
    decodeCommandOutput(Buffer.from('编译失败', 'utf8')),
    '编译失败'
  );
});

test('命令执行结果保留超过 1 MiB 的完整原始输出', async () => {
  const size = 1024 * 1024 + 37;
  const shell = new shellServiceModule.ShellService();

  const command = await shell.runCommand(
    process.execPath,
    ['-e', `process.stdout.write('x'.repeat(${size}))`],
    tmpdir(),
    {
      mavenHome: tmpdir(),
      javaHome: tmpdir()
    }
  );

  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout.length, size);
  assert.equal(command.stdout, 'x'.repeat(size));
  assert.equal(command.stderr, '');
});

test('Windows 直接命令退出后不因后台子进程继承输出管道而永久等待', async (context) => {
  if (process.platform !== 'win32') {
    context.skip('该回归只涉及 Windows shell 的继承句柄。');
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'shell-inherited-pipe-'));
  const scriptPath = join(directory, 'spawn-background-child.cjs');
  await writeFile(
    scriptPath,
    [
      "const { spawn } = require('node:child_process');",
      'const child = spawn(process.execPath, [\'-e\', \'setTimeout(() => {}, 4000)\'], {',
      "  cwd: require('node:os').tmpdir(),",
      "  detached: true, stdio: 'inherit', windowsHide: true",
      '});',
      'child.unref();',
      "process.stdout.write('direct-command-finished');"
    ].join('\n'),
    'utf8'
  );
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const shell = new shellServiceModule.ShellService();
  const startedAt = Date.now();
  const command = await shell.runCommand(
    process.execPath,
    [scriptPath],
    directory,
    {
      mavenHome: tmpdir(),
      javaHome: tmpdir()
    }
  );

  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout, 'direct-command-finished');
  assert.ok(
    Date.now() - startedAt < 2500,
    '直接命令退出后仍等待了继承输出管道的后台进程'
  );
});

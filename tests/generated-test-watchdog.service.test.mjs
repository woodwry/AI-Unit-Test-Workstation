import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { GeneratedTestWatchdogService } from '../src/main/services/generated-test-watchdog.service.ts';

test('installs only runtime bytecode, preserves user extensions and reuses its compilation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const services = join(root, 'target/test-classes/META-INF/services');
  await mkdir(services, { recursive: true });
  const servicePath = join(services, 'org.junit.jupiter.api.extension.Extension');
  await writeFile(servicePath, 'demo.ExistingExtension\n');
  let calls = 0;
  const compile = async (_sources, output) => {
    calls++;
    await mkdir(join(output, 'aiunittest/runtime'), { recursive: true });
    await writeFile(join(output, 'aiunittest/runtime/MethodWatchdog.class'), 'fixture bytecode');
    return { exitCode: 0 };
  };
  const service = new GeneratedTestWatchdogService();
  await service.install(root, compile);
  await service.install(root, compile);
  assert.equal(calls, 1);
  assert.equal(await readFile(servicePath, 'utf8'), 'demo.ExistingExtension\naiunittest.runtime.MethodWatchdog\n');
  assert.deepEqual((await readdir(join(root, 'target/test-classes'))).sort(), ['META-INF', 'aiunittest'].sort());
});

test('does not install a failed compiler output or follow linked target directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'method-watchdog-safe-'));
  const outside = await mkdtemp(join(tmpdir(), 'method-watchdog-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const result = { exitCode: 1, stderr: 'real javac error' };
  const service = new GeneratedTestWatchdogService();
  assert.equal(await service.install(root, async () => result), result);
  await assert.rejects(readdir(join(root, 'target/test-classes')), { code: 'ENOENT' });
  const linkedRoot = join(root, 'linked');
  await mkdir(linkedRoot);
  await symlink(outside, join(linkedRoot, 'target'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.install(linkedRoot, async () => assert.fail('must not compile')), /link/u);
  assert.deepEqual(await readdir(outside), []);
});

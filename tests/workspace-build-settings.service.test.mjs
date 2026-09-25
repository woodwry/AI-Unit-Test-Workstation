import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkspaceBuildSettingsService } from '../src/main/services/workspace-build-settings.service.ts';

test('persists different build settings for different workspaces', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-build-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const service = new WorkspaceBuildSettingsService(join(directory, 'settings.json'), 'win32');

  await service.save({
    workspaceRoot: 'D:\\work\\legacy',
    mavenHome: 'D:\\maven-3.5.4',
    javaHome: 'D:\\jdk8'
  });
  await service.save({
    workspaceRoot: 'D:\\work\\modern',
    mavenHome: 'D:\\maven-3.9.9',
    javaHome: 'D:\\jdk21'
  });

  assert.equal((await service.get('d:\\WORK\\legacy'))?.javaHome, 'D:\\jdk8');
  assert.equal((await service.get('D:\\work\\modern'))?.javaHome, 'D:\\jdk21');
});

test('normalizes required paths and removes blank optional overrides', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-build-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const service = new WorkspaceBuildSettingsService(join(directory, 'settings.json'), 'win32');

  const saved = await service.save({
    workspaceRoot: ' D:\\work\\legacy ',
    mavenHome: ' D:\\maven ',
    javaHome: ' D:\\jdk8 ',
    settingsPath: '   ',
    localRepository: ''
  });

  assert.equal(saved.workspaceRoot, 'D:\\work\\legacy');
  assert.equal(saved.mavenHome, 'D:\\maven');
  assert.equal(saved.javaHome, 'D:\\jdk8');
  assert.equal(saved.settingsPath, undefined);
  assert.equal(saved.localRepository, undefined);
});

test('resolves Maven settings and expands the configured local repository', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-build-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = join(directory, 'home');
  const mavenHome = join(directory, 'maven');
  const settingsPath = join(mavenHome, 'conf', 'settings.xml');
  await mkdir(join(mavenHome, 'conf'), { recursive: true });
  await writeFile(
    settingsPath,
    '<settings><!-- <localRepository>/ignored</localRepository> --><localRepository>${user.home}/maven-repo</localRepository></settings>',
    'utf8'
  );
  const service = new WorkspaceBuildSettingsService(join(directory, 'store.json'), 'linux', homeDirectory);

  const defaults = await service.resolveMavenHomeDefaults(mavenHome);

  assert.equal(defaults.settingsPath, settingsPath);
  assert.equal(defaults.localRepository, join(homeDirectory, 'maven-repo'));
});

test('falls back to the user Maven repository when settings has no local repository', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'workstation-build-settings-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const homeDirectory = join(directory, 'home');
  const mavenHome = join(directory, 'maven');
  await mkdir(join(mavenHome, 'conf'), { recursive: true });
  await writeFile(join(mavenHome, 'conf', 'settings.xml'), '<settings />', 'utf8');
  const service = new WorkspaceBuildSettingsService(join(directory, 'store.json'), 'linux', homeDirectory);

  const defaults = await service.resolveMavenHomeDefaults(mavenHome);

  assert.equal(defaults.localRepository, join(homeDirectory, '.m2', 'repository'));
});

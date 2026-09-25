import assert from 'node:assert/strict';
import { promises as realFs } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ModuleIdentityService
} from '../src/main/services/module-identity.service.ts';

async function createMavenWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'module-identity-'));
  const moduleRoot = join(root, 'nested-module');
  const sourceFilePath = join(
    moduleRoot,
    'src',
    'main',
    'java',
    'com',
    'example',
    'TaskService.java'
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(sourceFilePath, '..'), { recursive: true });
  await writeFile(join(root, 'pom.xml'), '<project><artifactId>parent</artifactId></project>');
  await writeFile(join(moduleRoot, 'pom.xml'), '<project><artifactId>module</artifactId></project>');
  await writeFile(sourceFilePath, 'package com.example; class TaskService {}');
  return { root, moduleRoot, sourceFilePath };
}

test('nearest pom is the module key and Windows aliases compare equally', async (t) => {
  // Mutation caught: choosing the workspace POM, or comparing Windows aliases case-sensitively.
  const { root, moduleRoot, sourceFilePath } = await createMavenWorkspace(t);
  const service = new ModuleIdentityService('win32');

  const first = await service.resolve(root, sourceFilePath);
  const second = await service.resolve(
    root.toLowerCase(),
    sourceFilePath.replaceAll('\\', '/')
  );

  assert.equal(first.moduleKey, second.moduleKey);
  assert.equal(first.moduleDisplayPath, moduleRoot);
  assert.equal(first.pomPath, join(moduleRoot, 'pom.xml'));
});

test('module resolution never selects a pom above the workspace boundary', async (t) => {
  // Mutation caught: upward search continuing after the supplied workspace root.
  const outer = await mkdtemp(join(tmpdir(), 'module-identity-boundary-'));
  const root = join(outer, 'workspace');
  const sourceFilePath = join(root, 'src', 'main', 'java', 'OnlySource.java');
  t.after(() => rm(outer, { recursive: true, force: true }));
  await mkdir(join(sourceFilePath, '..'), { recursive: true });
  await writeFile(join(outer, 'pom.xml'), '<project/>');
  await writeFile(sourceFilePath, 'class OnlySource {}');

  await assert.rejects(
    new ModuleIdentityService().resolve(root, sourceFilePath),
    /pom\.xml|Maven/i
  );
});

test('module resolution rejects a workspace-local pom whose canonical target is outside', async (t) => {
  // Mutation caught: accepting realpath(pom.xml) without rechecking workspace containment.
  const { root, moduleRoot, sourceFilePath } = await createMavenWorkspace(t);
  const externalDirectory = await mkdtemp(join(tmpdir(), 'module-identity-external-'));
  const externalPom = join(externalDirectory, 'pom.xml');
  const workspacePom = join(moduleRoot, 'pom.xml');
  let externalContentReads = 0;
  t.after(() => rm(externalDirectory, { recursive: true, force: true }));
  await writeFile(externalPom, '<project><artifactId>external</artifactId></project>');
  const fileSystem = {
    realpath: async (value) => value === workspacePom
      ? externalPom
      : realFs.realpath(value),
    stat: (value) => realFs.stat(value),
    readFile: async (...args) => {
      if (args[0] === externalPom) externalContentReads += 1;
      return realFs.readFile(...args);
    }
  };

  await assert.rejects(
    new ModuleIdentityService(process.platform, fileSystem).resolve(root, sourceFilePath),
    /工作区|workspace/i
  );
  assert.equal(externalContentReads, 0);
});

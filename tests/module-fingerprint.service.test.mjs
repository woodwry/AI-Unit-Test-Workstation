import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as realFs } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import {
  ModuleFingerprintService
} from '../src/main/services/module-fingerprint.service.ts';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function createFingerprintWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'module-fingerprint-'));
  const moduleRoot = join(root, 'nested-module');
  const sourceFile = join(moduleRoot, 'src', 'main', 'java', 'com', 'example', 'TaskService.java');
  const ownedFile = join(moduleRoot, 'src', 'test', 'java', 'com', 'example', 'TaskServiceGeneratedTest.java');
  const settingsPath = join(root, 'settings.xml');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(sourceFile, '..'), { recursive: true });
  await mkdir(join(ownedFile, '..'), { recursive: true });
  await mkdir(join(moduleRoot, 'src', 'test', 'resources'), { recursive: true });
  await writeFile(join(root, 'pom.xml'), '<project><artifactId>parent</artifactId></project>');
  await writeFile(join(moduleRoot, 'pom.xml'), '<project><artifactId>module</artifactId></project>');
  await writeFile(sourceFile, 'package com.example; class TaskService {}');
  await writeFile(ownedFile, 'package com.example; class TaskServiceGeneratedTest {}');
  await writeFile(join(moduleRoot, 'src', 'test', 'resources', 'fixture.txt'), 'fixture');
  await writeFile(settingsPath, '<settings/>');
  return {
    root,
    moduleRoot,
    sourceFile,
    ownedFile,
    settingsPath,
    input: {
      workspaceRoot: root,
      sourceFilePath: sourceFile,
      buildSettings: {
        mavenHome: join(root, 'maven'),
        javaHome: join(root, 'jdk'),
        settingsPath,
        localRepository: join(root, 'repository')
      },
      toolchain: { mavenVersion: '3.9.9', javaVersion: '21.0.7' },
      watcherVersion: 1
    }
  };
}

test('fingerprint changes for source, parent pom, toolchain, or watcher version', async (t) => {
  // Mutation caught: omitting any external-state input from the canonical digest.
  const { sourceFile, root, input } = await createFingerprintWorkspace(t);
  const fingerprint = new ModuleFingerprintService(undefined, () => new Date('2026-08-09T00:00:00.000Z'));
  const baseline = await fingerprint.calculate(input);

  const later = new Date(Date.now() + 5_000);
  await utimes(sourceFile, later, later);
  assert.notEqual((await fingerprint.calculate(input)).sha256, baseline.sha256);

  await utimes(join(root, 'pom.xml'), new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  assert.notEqual((await fingerprint.calculate(input)).sha256, baseline.sha256);
  assert.notEqual((await fingerprint.calculate({ ...input, watcherVersion: 2 })).sha256, baseline.sha256);
  assert.notEqual((await fingerprint.calculate({
    ...input,
    toolchain: { ...input.toolchain, javaVersion: '22.0.1' }
  })).sha256, baseline.sha256);
  assert.equal(baseline.calculatedAt, '2026-08-09T00:00:00.000Z');
});

test('matching task-owned generated files are excluded but user edits are not', async (t) => {
  // Mutation caught: blindly excluding a path after a user changes its contents.
  const { ownedFile, input } = await createFingerprintWorkspace(t);
  const fingerprint = new ModuleFingerprintService();
  const original = 'package com.example; class TaskServiceGeneratedTest {}';
  const ownedArtifact = { path: ownedFile, sha256: sha256(original) };
  const owned = await fingerprint.calculate({ ...input, ownedArtifacts: [ownedArtifact] });

  await writeFile(ownedFile, 'package com.example; class UserChangedTest {}');
  assert.notEqual(
    (await fingerprint.calculate({ ...input, ownedArtifacts: [ownedArtifact] })).sha256,
    owned.sha256
  );
});

test('fingerprint has deterministic metadata only', async (t) => {
  // Mutation caught: sorting file entries inconsistently or retaining source text in public state.
  const { input } = await createFingerprintWorkspace(t);
  const fingerprint = new ModuleFingerprintService(undefined, () => new Date('2026-08-09T00:00:00.000Z'));
  const first = await fingerprint.calculate(input);
  const second = await fingerprint.calculate(input);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes('TaskService'), false);
});

test('fingerprint rejects an ancestor pom resolving outside without reading external state', async (t) => {
  // Mutation caught: adding a canonical ancestor POM before checking workspace containment.
  const { root, input } = await createFingerprintWorkspace(t);
  const externalDirectory = await mkdtemp(join(tmpdir(), 'module-fingerprint-external-'));
  const externalPom = join(externalDirectory, 'pom.xml');
  const workspacePom = join(root, 'pom.xml');
  let externalAccesses = 0;
  t.after(() => rm(externalDirectory, { recursive: true, force: true }));
  await writeFile(externalPom, '<project><artifactId>external</artifactId></project>');
  const fileSystem = {
    realpath: async (value) => value === workspacePom
      ? externalPom
      : realFs.realpath(value),
    stat: async (value) => {
      if (value === externalPom) externalAccesses += 1;
      return realFs.stat(value);
    },
    readdir: (...args) => realFs.readdir(...args),
    readFile: async (...args) => {
      if (args[0] === externalPom) externalAccesses += 1;
      return realFs.readFile(...args);
    }
  };
  const fingerprint = new ModuleFingerprintService(
    undefined,
    () => new Date('2026-08-09T00:00:00.000Z'),
    fileSystem
  );

  await assert.rejects(fingerprint.calculate(input), /工作区|workspace/i);
  assert.equal(externalAccesses, 0);
});

test('class report fingerprint changes only for the target class, its direct tests, or build identity', async (t) => {
  // Mutation caught: reusing the module-wide file walk would invalidate this class for unrelated sources.
  const { moduleRoot, sourceFile, input } = await createFingerprintWorkspace(t);
  const directTest = join(
    moduleRoot,
    'src',
    'test',
    'java',
    'com',
    'example',
    'TaskServiceTest.java'
  );
  const unrelatedSource = join(
    moduleRoot,
    'src',
    'main',
    'java',
    'com',
    'example',
    'UnrelatedService.java'
  );
  await writeFile(directTest, 'package com.example; class TaskServiceTest {}');
  await writeFile(unrelatedSource, 'package com.example; class UnrelatedService {}');
  const service = new ModuleFingerprintService();
  const classInput = {
    ...input,
    qualifiedClassName: 'com.example.TaskService',
    directTestFilePaths: [directTest]
  };
  const baseline = await service.calculateClass(classInput);

  await writeFile(unrelatedSource, 'package com.example; class UnrelatedService { int value; }');
  assert.equal((await service.calculateClass(classInput)).sha256, baseline.sha256);
  assert.equal(
    (await service.calculateClass({ ...classInput, watcherVersion: 99 })).sha256,
    baseline.sha256
  );

  await writeFile(sourceFile, 'package com.example; class TaskService { int value; }');
  assert.notEqual((await service.calculateClass(classInput)).sha256, baseline.sha256);

  await writeFile(sourceFile, 'package com.example; class TaskService {}');
  await writeFile(directTest, 'package com.example; class TaskServiceTest { int value; }');
  assert.notEqual((await service.calculateClass(classInput)).sha256, baseline.sha256);

  await writeFile(directTest, 'package com.example; class TaskServiceTest {}');
  assert.notEqual((await service.calculateClass({
    ...classInput,
    toolchain: { ...classInput.toolchain, javaVersion: '22.0.1' }
  })).sha256, baseline.sha256);
});

test('removing a generated direct test from the project changes the terminal class fingerprint', async (t) => {
  const { moduleRoot, input } = await createFingerprintWorkspace(t);
  const generatedTest = join(
    moduleRoot,
    'src',
    'test',
    'java',
    'com',
    'example',
    'TaskService1Test.java'
  );
  await writeFile(generatedTest, 'package com.example; class TaskService1Test {}');
  const service = new ModuleFingerprintService();
  const terminalFingerprint = await service.calculateClass({
    ...input,
    qualifiedClassName: 'com.example.TaskService',
    directTestFilePaths: [generatedTest]
  });

  await rm(generatedTest);

  const revokedFingerprint = await service.calculateClass({
    ...input,
    qualifiedClassName: 'com.example.TaskService',
    directTestFilePaths: []
  });
  assert.notEqual(revokedFingerprint.sha256, terminalFingerprint.sha256);
});

test('class report fingerprint includes its report schema version', async () => {
  // A schema bump must invalidate reports generated from stale production class files.
  const workspaceRoot = resolve('C:\\fingerprint-workspace');
  const moduleRoot = join(workspaceRoot, 'nested-module');
  const sourceFilePath = join(
    moduleRoot,
    'src',
    'main',
    'java',
    'com',
    'example',
    'TaskService.java'
  );
  const directTestFilePath = join(
    moduleRoot,
    'src',
    'test',
    'java',
    'com',
    'example',
    'TaskServiceTest.java'
  );
  const contents = new Map([
    [join(workspaceRoot, 'pom.xml'), '<project><artifactId>parent</artifactId></project>'],
    [join(moduleRoot, 'pom.xml'), '<project><artifactId>module</artifactId></project>'],
    [sourceFilePath, 'package com.example; class TaskService {}'],
    [directTestFilePath, 'package com.example; class TaskServiceTest {}']
  ]);
  const comparisonKey = (value) => value.replaceAll('\\', '/').toLowerCase();
  const fileSystem = {
    async realpath(value) {
      const canonical = resolve(value);
      if (contents.has(canonical)) return canonical;
      const error = new Error(`missing: ${canonical}`);
      error.code = 'ENOENT';
      throw error;
    },
    async stat(value) {
      if (!contents.has(resolve(value))) throw new Error(`missing: ${value}`);
      return { isFile: () => true };
    },
    async readdir() {
      return [];
    },
    async readFile(value) {
      return Buffer.from(contents.get(resolve(value)), 'utf8');
    }
  };
  const identityService = {
    comparisonKey,
    async resolve() {
      return {
        moduleKey: comparisonKey(join(moduleRoot, 'pom.xml')),
        moduleDisplayPath: moduleRoot,
        pomPath: join(moduleRoot, 'pom.xml'),
        workspaceRoot,
        sourceFilePath
      };
    }
  };
  const service = new ModuleFingerprintService(
    identityService,
    () => new Date('2026-08-17T00:00:00.000Z'),
    fileSystem
  );
  const input = {
    workspaceRoot,
    sourceFilePath,
    buildSettings: {},
    toolchain: { mavenVersion: '3.9.9', javaVersion: '21.0.7' },
    watcherVersion: 1,
    qualifiedClassName: 'com.example.TaskService',
    directTestFilePaths: [directTestFilePath]
  };
  const files = [...contents.entries()].map(([path, content]) => ({
    path: comparisonKey(relative(workspaceRoot, path)),
    sha256: sha256(content)
  })).sort((left, right) => left.path.localeCompare(right.path));
  const configuration = ['mavenHome', 'javaHome', 'settingsPath', 'localRepository']
    .map((label) => ({ label, path: null, size: null, mtimeMs: null }));
  const toolchainIdentity = sha256(JSON.stringify({
    configuration,
    javaVersion: input.toolchain.javaVersion,
    mavenVersion: input.toolchain.mavenVersion,
    extraIdentity: ''
  }));
  const expected = sha256(JSON.stringify({
    classReportSchemaVersion: 2,
    qualifiedClassName: input.qualifiedClassName,
    files,
    toolchainIdentity
  }));

  assert.equal((await service.calculateClass(input)).sha256, expected);
});

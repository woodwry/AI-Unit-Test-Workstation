import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MavenAnalysisContextService
} from '../src/main/services/maven-analysis-context.service.ts';

async function harness(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maven-analysis-pair-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const moduleRoot = join(workspaceRoot, 'module');
  const sourceRoot = join(moduleRoot, 'src', 'main', 'java');
  const targetSourcePath = join(sourceRoot, 'com', 'example', 'Target.java');
  const reportPath = join(moduleRoot, 'target', 'site', 'jacoco', 'jacoco.xml');
  const branchSnapshotPath = join(
    moduleRoot,
    'target',
    'site',
    'jacoco',
    'jacoco.branches.json'
  );
  const javaHome = join(workspaceRoot, 'jdk');
  await mkdir(join(targetSourcePath, '..'), { recursive: true });
  await mkdir(join(reportPath, '..'), { recursive: true });
  await mkdir(javaHome, { recursive: true });
  await writeFile(targetSourcePath, 'package com.example; class Target {}');
  await writeFile(reportPath, '<report/>');
  await writeFile(branchSnapshotPath, '{}');
  return {
    workspaceRoot,
    moduleRoot,
    targetSourcePath,
    reportPath,
    branchSnapshotPath,
    javaHome
  };
}

test('collects both coverage artifact paths and the pair identity', async (t) => {
  const fixture = await harness(t);
  const service = new MavenAnalysisContextService({
    collectMavenClasspath: async () => ({ exitCode: 1 })
  });
  const pairId = 'c'.repeat(64);

  const context = await service.collect({
    ...fixture,
    targetClass: 'com.example.Target',
    plannedTestClassName: 'TargetTest',
    plannedRelativeTestPath: 'src/test/java/com/example/TargetTest.java',
    reportPairId: pairId,
    buildSettings: {
      javaHome: fixture.javaHome,
      mavenHome: fixture.workspaceRoot
    },
    buildToolchain: {
      javaVersion: '21.0.8',
      mavenVersion: '3.9.9'
    }
  });

  assert.equal(context.reportPath, fixture.reportPath);
  assert.equal(context.branchSnapshotPath, fixture.branchSnapshotPath);
  assert.equal(context.reportPairId, pairId);
});

test('rejects analysis input when the paired branch snapshot is missing', async (t) => {
  const fixture = await harness(t);
  await rm(fixture.branchSnapshotPath);
  const service = new MavenAnalysisContextService({
    collectMavenClasspath: async () => ({ exitCode: 1 })
  });

  await assert.rejects(
    service.collect({
      ...fixture,
      targetClass: 'com.example.Target',
      plannedTestClassName: 'TargetTest',
      plannedRelativeTestPath: 'src/test/java/com/example/TargetTest.java',
      reportPairId: 'd'.repeat(64),
      buildSettings: {
        javaHome: fixture.javaHome,
        mavenHome: fixture.workspaceRoot
      },
      buildToolchain: {
        javaVersion: '21.0.8',
        mavenVersion: '3.9.9'
      }
    }),
    /分支快照/
  );
});

test('exposes declared Maven module roots for production classpath snapshot collection', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maven-analysis-modules-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const firstModule = join(workspaceRoot, 'first-module');
  const nestedModule = join(firstModule, 'nested-module');
  await mkdir(nestedModule, { recursive: true });
  await writeFile(
    join(workspaceRoot, 'pom.xml'),
    '<project><modules><module>first-module</module></modules></project>'
  );
  await writeFile(
    join(firstModule, 'pom.xml'),
    '<project><modules><module>nested-module</module></modules></project>'
  );
  await writeFile(join(nestedModule, 'pom.xml'), '<project/>');
  const service = new MavenAnalysisContextService({
    collectMavenClasspath: async () => ({ exitCode: 0 })
  });

  const roots = await service.discoverDeclaredModuleRoots(workspaceRoot, firstModule);

  assert.deepEqual(roots, [firstModule, nestedModule, workspaceRoot].sort());
});

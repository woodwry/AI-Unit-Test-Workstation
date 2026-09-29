import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ShellService } from '../src/main/services/shell.service.ts';
import { createFakeMavenHome } from './e2e/support/fake-maven.mjs';

test('temporary fake Maven home satisfies the real ShellService boundary', async (t) => {
  const fixture = await createFakeMavenHome();
  const moduleRoot = await mkdtemp(join(tmpdir(), 'fake-maven-module-'));
  t.after(async () => {
    await fixture.close();
    await rm(moduleRoot, { recursive: true, force: true });
  });
  await writeFile(join(moduleRoot, 'pom.xml'), '<project/>\n', 'utf8');

  const settings = {
    mavenHome: fixture.mavenHome,
    javaHome: fixture.javaHome
  };
  const shell = new ShellService();
  const validation = await shell.validateBuildSettings(settings, moduleRoot);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.equal(validation.mavenVersion, '3.9.9');
  assert.equal(validation.javaVersion, '21.0.11');

  const classpathPath = join(moduleRoot, 'target', 'fixture-classpath.txt');
  await mkdir(dirname(classpathPath), { recursive: true });
  const classpath = await shell.collectMavenClasspath(
    moduleRoot,
    settings,
    classpathPath
  );
  assert.equal(classpath.exitCode, 0);
  assert.equal((await readFile(classpathPath, 'utf8')).trim(), moduleRoot);

  const executionDataPath = join(moduleRoot, 'target', 'fixture', 'jacoco.exec');
  const preloadReports = join(moduleRoot, 'target', 'fixture', 'preload-reports');
  const preload = await shell.runMavenModuleTestsWithJacoco(
    moduleRoot,
    settings,
    executionDataPath,
    preloadReports
  );
  assert.equal(preload.exitCode, 0);
  assert.ok((await stat(executionDataPath)).size > 0);

  const generatedReports = join(moduleRoot, 'target', 'fixture', 'generated-reports');
  const compile = await shell.runMavenGeneratedTestCompile(
    moduleRoot,
    settings,
    'FixtureGeneratedTest'
  );
  assert.equal(compile.exitCode, 0);
  const generated = await shell.runMavenGeneratedSurefireTest(
    moduleRoot,
    settings,
    'FixtureGeneratedTest',
    generatedReports
  );
  assert.equal(generated.exitCode, 0);
  assert.match(
    await readFile(join(generatedReports, 'TEST-FixtureGeneratedTest.xml'), 'utf8'),
    /tests="1" failures="0" errors="0"/
  );

  const appended = await shell.runMavenDirectTestsWithJacocoAppend(
    moduleRoot,
    settings,
    ['com.example.FixtureGeneratedTest'],
    executionDataPath,
    generatedReports
  );
  assert.equal(appended.exitCode, 0);
  assert.match(await readFile(executionDataPath, 'utf8'), /fixture-generated/);

  const metrics = await fixture.readMetrics();
  assert.equal(metrics.modulePreloadMavenCalls, 1);
  assert.equal(metrics.sameModuleConcurrencyViolations, 0);
  assert.ok(metrics.invocations.length >= 6);
});

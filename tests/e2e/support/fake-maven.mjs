import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const FIXED_NOW = '2026-08-09T00:00:00.000Z';

function commandResult(cwd, command) {
  return {
    command,
    cwd,
    exitCode: 0,
    stdout: '',
    stderr: ''
  };
}

function throwIfAborted(options) {
  if (!options?.signal?.aborted) return;
  throw options.signal.reason instanceof Error
    ? options.signal.reason
    : new Error('Fake Maven operation was aborted.');
}

/**
 * Deterministic Maven/Surefire boundary for class-task integration tests.
 * It writes only the artifacts that the real production services consume.
 */
export function createFakeMaven(fixtureOptions = {}) {
  const activeByModule = new Map();
  const testClassByReportDirectory = new Map();
  const testCountByReportDirectory = new Map();
  const artifactsByReportDirectory = new Map();
  const generatedCompileCallsByClass = new Map();
  let modulePreloadMavenCalls = 0;
  let classPreloadMavenCalls = 0;
  let taskJacocoAppendCalls = 0;
  let maxConcurrentSameModuleMavenCalls = 0;

  async function tracked(moduleRoot, operation) {
    const active = (activeByModule.get(moduleRoot) ?? 0) + 1;
    activeByModule.set(moduleRoot, active);
    maxConcurrentSameModuleMavenCalls = Math.max(
      maxConcurrentSameModuleMavenCalls,
      active
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await operation();
    } finally {
      const remaining = (activeByModule.get(moduleRoot) ?? 1) - 1;
      if (remaining === 0) activeByModule.delete(moduleRoot);
      else activeByModule.set(moduleRoot, remaining);
    }
  }

  const shellService = {
    async validateBuildSettings() {
      return {
        valid: true,
        command: 'fake-mvn --version',
        mavenVersion: '3.9.16',
        javaVersion: '21.0.8',
        javaRuntime: 'fake-jdk',
        checkedAt: FIXED_NOW
      };
    },

    async runMavenModuleTestsWithJacoco(
      moduleRoot,
      _settings,
      executionDataPath,
      surefireReportsDirectory,
      options
    ) {
      return tracked(moduleRoot, async () => {
        throwIfAborted(options);
        modulePreloadMavenCalls += 1;
        await Promise.all([
          mkdir(dirname(executionDataPath), { recursive: true }),
          mkdir(surefireReportsDirectory, { recursive: true })
        ]);
        await writeFile(executionDataPath, 'fixture-baseline-exec', 'utf8');
        return commandResult(moduleRoot, 'fake-mvn preload-with-jacoco');
      });
    },

    async runMavenDirectTestsWithJacoco(
      moduleRoot,
      _settings,
      testClassNames,
      executionDataPath,
      surefireReportsDirectory,
      options
    ) {
      return tracked(moduleRoot, async () => {
        throwIfAborted(options);
        classPreloadMavenCalls += 1;
        await mkdir(dirname(executionDataPath), { recursive: true });
        if (surefireReportsDirectory) {
          await mkdir(surefireReportsDirectory, { recursive: true });
        }
        await writeFile(
          executionDataPath,
          `fixture-class-baseline-exec:${testClassNames.join(',')}`,
          'utf8'
        );
        return commandResult(
          moduleRoot,
          `fake-mvn class-preload-with-jacoco -Dtest=${testClassNames.join(',')}`
        );
      });
    },

    async runMavenGeneratedTestCompile(moduleRoot, _settings, testClassName, options) {
      return tracked(moduleRoot, async () => {
        throwIfAborted(options);
        const testClassNames = normalizeTestClassNames(testClassName);
        const failures = [];
        for (const qualifiedTestClassName of testClassNames) {
          const call = (generatedCompileCallsByClass.get(qualifiedTestClassName) ?? 0) + 1;
          generatedCompileCallsByClass.set(qualifiedTestClassName, call);
          if (await fixtureOptions.failGeneratedCompile?.({
            moduleRoot,
            testClassName: qualifiedTestClassName,
            call
          })) {
            failures.push(qualifiedTestClassName);
          }
        }
        const selector = testClassNames.join(',');
        if (failures.length > 0) {
          return {
            ...commandResult(moduleRoot, `fake-mvn test-compile -Dtest=${selector}`),
            exitCode: 1,
            stderr: failures.map((qualifiedTestClassName) => (
              `[ERROR] ${generatedTestSourcePath(moduleRoot, qualifiedTestClassName)}:`
              + `[7,9] simulated compile failure for ${qualifiedTestClassName}`
            )).join('\n')
          };
        }
        return commandResult(moduleRoot, `fake-mvn test-compile -Dtest=${selector}`);
      });
    },

    async runMavenGeneratedSurefireTest(
      moduleRoot,
      _settings,
      testClassName,
      reportDirectory,
      options
    ) {
      return tracked(moduleRoot, async () => {
        throwIfAborted(options);
        const testClassNames = normalizeTestClassNames(testClassName);
        testClassByReportDirectory.set(reportDirectory, [...testClassNames]);
        const artifacts = [];
        for (const qualifiedTestClassName of testClassNames) {
          const generatedTests = await generatedTestMethodCount(
            moduleRoot,
            qualifiedTestClassName
          );
          testCountByReportDirectory.set(
            `${reportDirectory}\0${qualifiedTestClassName}`,
            generatedTests
          );
          artifacts.push({
            fileName: `TEST-${qualifiedTestClassName}.xml`,
            content: passingSurefireXml(qualifiedTestClassName, generatedTests)
          });
        }
        artifactsByReportDirectory.set(reportDirectory, artifacts);
        return commandResult(
          moduleRoot,
          `fake-mvn surefire:test -Dtest=${testClassNames.join(',')}`
        );
      });
    },

    async runMavenDirectTestsWithJacocoAppend(
      moduleRoot,
      _settings,
      testClassNames,
      executionDataPath,
      surefireReportsDirectory,
      options
    ) {
      return tracked(moduleRoot, async () => {
        throwIfAborted(options);
        taskJacocoAppendCalls += 1;
        await mkdir(surefireReportsDirectory, { recursive: true });
        await appendFile(
          executionDataPath,
          `|fixture-generated:${testClassNames.join(',')}`,
          'utf8'
        );
        return commandResult(moduleRoot, 'fake-mvn direct-tests-with-jacoco');
      });
    }
  };

  const surefireReportService = {
    async prepareAttempt(moduleRoot, attemptId) {
      const reportDirectory = join(
        moduleRoot,
        'target',
        'ai-unit-test',
        'fake-surefire',
        attemptId
      );
      await mkdir(reportDirectory, { recursive: true });
      return reportDirectory;
    },

    async readAttemptArtifacts(reportDirectory) {
      return structuredClone(artifactsByReportDirectory.get(reportDirectory) ?? []);
    },

    async parseAttempt(reportDirectory, qualifiedTestClassName) {
      const generatedTestClassName = qualifiedTestClassName
        ?? testClassByReportDirectory.get(reportDirectory)?.[0]
        ?? 'FixtureGeneratedTest';
      const generatedTests = testCountByReportDirectory.get(
        `${reportDirectory}\0${generatedTestClassName}`
      ) ?? 1;
      return {
        reportCount: 1,
        tests: generatedTests,
        failures: 0,
        errors: 0,
        skipped: 0,
        generatedTestClassName,
        generatedTests,
        generatedSkipped: 0,
        failureDetails: []
      };
    }
  };

  return {
    shellService,
    surefireReportService,
    metrics() {
      return {
        modulePreloadMavenCalls,
        classPreloadMavenCalls,
        taskJacocoAppendCalls,
        generatedCompileCalls: [...generatedCompileCallsByClass.values()]
          .reduce((sum, count) => sum + count, 0),
        maxConcurrentSameModuleMavenCalls
      };
    }
  };
}

function normalizeTestClassNames(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function generatedTestSourcePath(moduleRoot, qualifiedTestClassName) {
  return join(
    moduleRoot,
    'src',
    'test',
    'java',
    ...qualifiedTestClassName.split('.')
  ) + '.java';
}

function passingSurefireXml(qualifiedTestClassName, testCount) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${qualifiedTestClassName}" tests="${testCount}" failures="0" errors="0" skipped="0">`,
    ...Array.from({ length: testCount }, (_, index) => (
      `  <testcase classname="${qualifiedTestClassName}" name="fixture${index + 1}"/>`
    )),
    '</testsuite>',
    ''
  ].join('\n');
}

async function generatedTestMethodCount(moduleRoot, testClassName) {
  const testRoot = join(moduleRoot, 'src', 'test', 'java');
  const entries = await readdir(testRoot, { recursive: true, withFileTypes: true });
  const expectedFileName = `${testClassName.split('.').at(-1)}.java`;
  const entry = entries.find((candidate) => (
    candidate.isFile() && candidate.name === expectedFileName
  ));
  if (!entry) return 1;
  const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
  return Math.max(1, [...source.matchAll(/@Test\b/g)].length);
}

const FAKE_MAVEN_RUNNER = String.raw`
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const metricsDirectory = process.argv[2];
const configurationPath = process.argv[3];
const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
const args = process.argv.slice(4);
const moduleRoot = process.cwd();
const moduleHash = createHash('sha256').update(moduleRoot).digest('hex');
const activePath = join(metricsDirectory, 'active-' + moduleHash);
const invocationPath = join(metricsDirectory, 'invocations.jsonl');
const violationPath = join(metricsDirectory, 'concurrency-violations.jsonl');
const failedCompileMarker = join(metricsDirectory, 'first-generated-compile-failed');
const passedCandidateMarker = join(metricsDirectory, 'first-generated-candidate-passed');

async function recordEvent(event) {
  if (!configuration.eventLogPath) return;
  await appendFile(
    configuration.eventLogPath,
    JSON.stringify({ event }) + '\n',
    'utf8'
  );
}

function property(name) {
  const prefix = '-D' + name + '=';
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function safeTestClassName(value) {
  const simple = value.split('.').pop() || 'FixtureGeneratedTest';
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(simple)
    ? simple
    : 'FixtureGeneratedTest';
}

function activeTestMethodNames(source) {
  const names = [];
  const lines = source.split(/\r?\n/);
  let awaitingMethod = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (/^@Test\b/.test(trimmed)) {
      awaitingMethod = true;
      continue;
    }
    if (!awaitingMethod) continue;
    const method = /^(?:(?:public|protected|private|static|final|synchronized)\s+)*void\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(trimmed);
    if (method) names.push(method[1]);
    awaitingMethod = false;
  }
  return names;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function materializeCompiledMainClasses(
  sourceDirectory = join(moduleRoot, 'src', 'main', 'java'),
  relativeSegments = []
) {
  let entries;
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await materializeCompiledMainClasses(
        join(sourceDirectory, entry.name),
        [...relativeSegments, entry.name]
      );
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.java')) continue;
    const classFilePath = join(
      moduleRoot,
      'target',
      'classes',
      ...relativeSegments,
      entry.name.slice(0, -5) + '.class'
    );
    await mkdir(dirname(classFilePath), { recursive: true });
    await writeFile(classFilePath, 'fixture-compiled-class', 'utf8');
  }
}

async function writeSurefireReports(reportDirectory, selector) {
  const selected = (selector || 'BaselineTest').split(',').filter(Boolean);
  let hasFailure = false;
  await mkdir(reportDirectory, { recursive: true });
  for (const qualifiedName of selected) {
    const className = safeTestClassName(qualifiedName);
    const qualifiedSegments = qualifiedName.split('.');
    qualifiedSegments.pop();
    const sourcePath = join(
      moduleRoot,
      'src',
      'test',
      'java',
      ...qualifiedSegments,
      className + '.java'
    );
    let testMethodNames = ['coversGeneratedPath1'];
    try {
      const source = await readFile(sourcePath, 'utf8');
      const activeNames = activeTestMethodNames(source);
      if (activeNames.length > 0) testMethodNames = activeNames;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const failedTestMethod = typeof configuration.failGeneratedTestMethodName === 'string'
      && testMethodNames.includes(configuration.failGeneratedTestMethodName)
      ? configuration.failGeneratedTestMethodName
      : null;
    if (failedTestMethod) hasFailure = true;
    const testCount = testMethodNames.length;
    const source = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuite name="' + qualifiedName + '" tests="' + testCount
        + '" failures="' + (failedTestMethod ? 1 : 0) + '" errors="0" skipped="0">',
      ...testMethodNames.flatMap((testMethodName) => {
        if (testMethodName !== failedTestMethod) {
          return ['  <testcase classname="' + qualifiedName + '" name="'
            + xmlEscape(testMethodName) + '"/>'];
        }
        return [
          '  <testcase classname="' + qualifiedName + '" name="'
            + xmlEscape(testMethodName) + '">',
          '    <failure type="org.opentest4j.AssertionFailedError"'
            + ' message="simulated generated test failure">'
            + 'org.opentest4j.AssertionFailedError: simulated generated test failure\n'
            + '    at ' + qualifiedName + '.' + testMethodName + '(' + className + '.java:7)'
            + '</failure>',
          '  </testcase>'
        ];
      }),
      '</testsuite>',
      ''
    ].join('\n');
    await writeFile(join(reportDirectory, 'TEST-' + className + '.xml'), source, 'utf8');
  }
  return hasFailure;
}

let activeHandle;
let concurrencyViolation = false;
try {
  await mkdir(metricsDirectory, { recursive: true });
  try {
    activeHandle = await open(activePath, 'wx');
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    concurrencyViolation = true;
    await appendFile(
      violationPath,
      JSON.stringify({ moduleRoot, args, occurredAt: new Date().toISOString() }) + '\n',
      'utf8'
    );
  }

  await appendFile(
    invocationPath,
    JSON.stringify({ moduleRoot, args, concurrencyViolation }) + '\n',
    'utf8'
  );

  if (args.includes('--version')) {
    const javaHome = process.env.JAVA_HOME || '';
    process.stdout.write([
      'Apache Maven 3.9.9 (fake Electron E2E runtime)',
      'Maven home: ' + (process.env.MAVEN_HOME || ''),
      'Java version: 21.0.11, vendor: Eclipse Adoptium, runtime: ' + javaHome,
      'Default locale: en_US, platform encoding: UTF-8',
      'OS name: "windows 11", version: "10.0", arch: "amd64", family: "windows"',
      ''
    ].join('\n'));
  } else {
    // Keep the fake process alive briefly so an illegal same-module overlap is observable.
    await new Promise((resolve) => setTimeout(resolve, 35));

    if (args.includes('compile') || args.includes('test-compile')) {
      await materializeCompiledMainClasses();
    }

    const testSelector = property('test');
    const classPreload = args.includes('surefire:test')
      && property('jacoco.append') === 'false'
      && Boolean(testSelector);
    if (classPreload) await recordEvent('preload');

    const generatedCompile = args.includes('test-compile')
      && !args.includes('surefire:test')
      && Boolean(testSelector);
    let failGeneratedCompile = false;
    if (configuration.failFirstGeneratedCompile && generatedCompile) {
      try {
        const marker = await open(failedCompileMarker, 'wx');
        await marker.close();
        failGeneratedCompile = true;
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }
    }

    if (failGeneratedCompile) {
      await recordEvent('maven-failure');
      const simpleName = safeTestClassName(testSelector);
      process.stderr.write(
        '[ERROR] ' + moduleRoot + '/src/test/java/com/example/' + simpleName
        + '.java:[7,9] cannot find symbol\n'
        + '[ERROR]   symbol:   class MissingFixtureType\n'
      );
      process.exitCode = 1;
    } else {

    const classpathOutput = property('mdep.outputFile');
    if (classpathOutput) {
      await mkdir(dirname(classpathOutput), { recursive: true });
      await writeFile(classpathOutput, moduleRoot + '\n', 'utf8');
    }

    const executionDataPath = property('jacoco.destFile');
    if (executionDataPath) {
      await mkdir(dirname(executionDataPath), { recursive: true });
      const append = property('jacoco.append') === 'true';
      if (append) {
        let existing = '';
        try {
          existing = await readFile(executionDataPath, 'utf8');
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        await writeFile(
          executionDataPath,
          existing + '|fixture-generated:' + (property('test') || 'generated'),
          'utf8'
        );
      } else {
        await writeFile(executionDataPath, 'fixture-baseline-exec', 'utf8');
      }
    }

    const reportsDirectory = property('surefire.reportsDirectory');
    let generatedTestFailed = false;
    if (reportsDirectory && args.includes('surefire:test')) {
      generatedTestFailed = await writeSurefireReports(reportsDirectory, property('test'));
      if (generatedTestFailed) {
        await recordEvent('maven-failure');
        process.stderr.write(
          '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0\n'
          + '[ERROR] ' + configuration.failGeneratedTestMethodName
          + ' Time elapsed: 0.001 s <<< FAILURE!\n'
        );
        process.exitCode = 1;
      } else if (!property('jacoco.destFile') && testSelector) {
        try {
          const marker = await open(passedCandidateMarker, 'wx');
          await marker.close();
          await recordEvent('maven-pass');
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        }
      }
    }
    }
  }
} finally {
  await activeHandle?.close();
  if (activeHandle) await rm(activePath, { force: true });
}
`;

/**
 * Creates a process-level Maven/JDK boundary for Playwright. The real
 * ShellService launches mvn.cmd; only the Maven implementation is deterministic.
 */
export async function createFakeMavenHome(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workstation-e2e-toolchain-'));
  const mavenHome = join(root, 'apache-maven-3.9.9');
  const javaHome = join(root, 'jdk-21');
  const metricsDirectory = join(root, 'metrics');
  const runnerPath = join(mavenHome, 'bin', 'fake-maven-runner.mjs');
  const configurationPath = join(mavenHome, 'bin', 'fake-maven-config.json');
  const executablePath = join(mavenHome, 'bin', 'mvn.cmd');
  await Promise.all([
    mkdir(dirname(runnerPath), { recursive: true }),
    mkdir(join(javaHome, 'bin'), { recursive: true }),
    mkdir(metricsDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(runnerPath, FAKE_MAVEN_RUNNER.trimStart(), 'utf8'),
    writeFile(configurationPath, JSON.stringify({
      eventLogPath: options.eventLogPath ?? null,
      failFirstGeneratedCompile: options.failFirstGeneratedCompile === true,
      failGeneratedTestMethodName: typeof options.failGeneratedTestMethodName === 'string'
        ? options.failGeneratedTestMethodName
        : null
    }), 'utf8'),
    writeFile(join(javaHome, 'bin', 'java.exe'), 'fixture-java', 'utf8'),
    writeFile(
      executablePath,
      [
        '@echo off',
        `"${process.execPath}" "${runnerPath}" "${metricsDirectory}" "${configurationPath}" %*`,
        'exit /b %ERRORLEVEL%',
        ''
      ].join('\r\n'),
      'utf8'
    )
  ]);

  return {
    root,
    mavenHome,
    javaHome,
    metricsDirectory,
    async readMetrics() {
      const invocations = await readJsonLines(join(metricsDirectory, 'invocations.jsonl'));
      const violations = await readJsonLines(join(metricsDirectory, 'concurrency-violations.jsonl'));
      return {
        invocations,
        modulePreloadMavenCalls: invocations.filter((invocation) => (
          invocation.args.includes('-Djacoco.append=false')
            && invocation.args.includes('surefire:test')
            && !invocation.args.some((argument) => argument.startsWith('-Dtest='))
        )).length,
        classPreloadMavenCalls: invocations.filter((invocation) => (
          invocation.args.includes('-Djacoco.append=false')
            && invocation.args.includes('surefire:test')
            && invocation.args.some((argument) => argument.startsWith('-Dtest='))
        )).length,
        sameModuleConcurrencyViolations: violations.length
      };
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function readJsonLines(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

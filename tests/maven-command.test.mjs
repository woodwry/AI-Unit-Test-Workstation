import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildMavenClasspathArgs,
  buildMavenArgs,
  buildMavenEnvironment,
  extractPublicMavenDiagnostic,
  partitionMavenTestClassNames,
  parseMavenVersionOutput,
  resolveMavenExecutable
} from '../src/main/services/maven-command.ts';
import { ShellService } from '../src/main/services/shell.service.ts';

const settings = {
  workspaceRoot: 'D:\\work\\legacy',
  mavenHome: 'D:\\java\\apache-maven-3.5.4',
  javaHome: 'D:\\java\\jdk1.8',
  settingsPath: 'D:\\java\\apache-maven-3.5.4\\conf\\settings_AI.xml',
  localRepository: 'D:\\java\\apache-maven-3.5.4\\AI_REPO'
};

test('builds Maven command inputs from workspace settings', () => {
  assert.equal(
    resolveMavenExecutable(settings, 'win32'),
    'D:\\java\\apache-maven-3.5.4\\bin\\mvn.cmd'
  );
  assert.deepEqual(
    buildMavenArgs(
      settings,
      ['test-compile', 'jacoco:prepare-agent', 'surefire:test'],
      {
        testClassNames: ['com.example.LegacyTest', 'com.example.Legacy1Test'],
        properties: {
          'maven.test.skip': 'false',
          skipTests: 'false',
          'jacoco.destFile': 'D:\\work\\legacy\\target\\jacoco.exec',
          'jacoco.append': 'false',
          'surefire.reportsDirectory': 'D:\\work\\legacy\\target\\ai-unit-test\\surefire\\current\\11111111-1111-4111-8111-111111111111'
        }
      }
    ),
    [
      '-s',
      settings.settingsPath,
      `-Dmaven.repo.local=${settings.localRepository}`,
      '-Dtest=com.example.LegacyTest,com.example.Legacy1Test',
      '-Dmaven.test.skip=false',
      '-DskipTests=false',
      '-Djacoco.destFile=D:\\work\\legacy\\target\\jacoco.exec',
      '-Djacoco.append=false',
      '-Dsurefire.reportsDirectory=D:\\work\\legacy\\target\\ai-unit-test\\surefire\\current\\11111111-1111-4111-8111-111111111111',
      'test-compile',
      'jacoco:prepare-agent',
      'surefire:test'
    ]
  );
});

test('omits optional Maven arguments when no overrides are configured', () => {
  const minimal = {
    workspaceRoot: 'D:\\work\\minimal',
    mavenHome: 'D:\\maven',
    javaHome: 'D:\\jdk'
  };

  assert.deepEqual(buildMavenArgs(minimal, ['test']), ['test']);
});

test('builds Maven classpath scope arguments with test compatibility and production scopes', () => {
  const outputFile = 'D:\\work\\legacy\\target\\ai-unit-test\\classpath.txt';

  assert.ok(buildMavenClasspathArgs(settings, outputFile).includes('-DincludeScope=test'));
  assert.ok(!buildMavenClasspathArgs(settings, outputFile).includes('--non-recursive'));
  assert.ok(buildMavenClasspathArgs(settings, outputFile, 'compile', true).includes('--non-recursive'));
  assert.ok(
    buildMavenClasspathArgs(settings, outputFile, 'compile').includes('-DincludeScope=compile')
  );
  assert.ok(
    buildMavenClasspathArgs(settings, outputFile, 'runtime').includes('-DincludeScope=runtime')
  );
});

test('partitions a long direct-test selector without losing or duplicating tests', () => {
  const names = [
    'com.example.TaskServiceTest',
    'com.example.TaskService1Test',
    'com.example.TaskService2Test',
    'com.example.TaskService1Test',
    '  ',
    'com.example.TaskService3Test'
  ];

  const batches = partitionMavenTestClassNames(names, 55);

  assert.deepEqual(batches, [
    ['com.example.TaskServiceTest'],
    ['com.example.TaskService1Test'],
    ['com.example.TaskService2Test'],
    ['com.example.TaskService3Test']
  ]);
  assert.ok(batches.every((batch) => batch.join(',').length <= 55));
});

test('puts configured Java and Maven before inherited PATH', () => {
  const env = buildMavenEnvironment(settings, { Path: 'C:\\Windows\\System32' }, 'win32');
  assert.equal(env.JAVA_HOME, settings.javaHome);
  assert.equal(env.MAVEN_HOME, settings.mavenHome);
  assert.equal(env.M2_HOME, settings.mavenHome);
  assert.match(env.Path ?? '', /^D:\\java\\jdk1\.8\\bin;D:\\java\\apache-maven-3\.5\.4\\bin;/);
});

test('parses Maven and Java versions from mvn --version', () => {
  const result = parseMavenVersionOutput(
    'Apache Maven 3.5.4\nJava version: 1.8.0_451, vendor: Oracle Corporation, runtime: D:\\java\\jdk1.8\\jre'
  );

  assert.equal(result.mavenVersion, '3.5.4');
  assert.equal(result.javaVersion, '1.8.0_451');
  assert.equal(result.javaRuntime, 'D:\\java\\jdk1.8\\jre');
});

test('builds one module-wide JaCoCo command without clean or a test selector', async () => {
  const service = new ShellService();
  let captured;
  service.runMaven = async (workspaceRoot, actualSettings, args, options) => {
    captured = { workspaceRoot, actualSettings, args, options };
    return {
      command: `mvn.cmd ${args.join(' ')}`,
      cwd: workspaceRoot,
      exitCode: 0,
      stdout: '',
      stderr: ''
    };
  };
  const signal = new AbortController().signal;

  const result = await service.runMavenModuleTestsWithJacoco(
    'D:\\work\\legacy',
    settings,
    'D:\\work\\legacy\\target\\ai-unit-test\\jacoco\\preload\\fp-1\\jacoco.exec',
    'D:\\work\\legacy\\target\\ai-unit-test\\surefire\\preload\\fp-1',
    { signal }
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(captured.args.slice(-3), [
    'test-compile',
    'jacoco:prepare-agent',
    'surefire:test'
  ]);
  assert.ok(captured.args.includes('-Dmaven.test.skip=false'));
  assert.ok(captured.args.includes('-DskipTests=false'));
  assert.ok(captured.args.includes('-Djacoco.append=false'));
  assert.ok(captured.args.includes('-Djacoco.destFile=D:\\work\\legacy\\target\\ai-unit-test\\jacoco\\preload\\fp-1\\jacoco.exec'));
  assert.ok(captured.args.includes('-Dsurefire.reportsDirectory=D:\\work\\legacy\\target\\ai-unit-test\\surefire\\preload\\fp-1'));
  assert.equal(captured.args.some((argument) => /(?:^|:)clean$/.test(argument)), false);
  assert.equal(captured.args.some((argument) => argument.startsWith('-Dtest=')), false);
  assert.equal(captured.options.signal, signal);
});

test('generated-test compile and Surefire keep one ordered selector for multiple classes', async () => {
  const service = new ShellService();
  const calls = [];
  service.runMaven = async (workspaceRoot, actualSettings, args, options) => {
    calls.push({ workspaceRoot, actualSettings, args, options });
    return {
      command: `mvn.cmd ${args.join(' ')}`,
      cwd: workspaceRoot,
      exitCode: 0,
      stdout: '',
      stderr: ''
    };
  };
  const classNames = [
    'com.example.ATmp1Test',
    'com.example.BTmp1Test',
    'com.example.CTmp1Test'
  ];

  await service.runMavenGeneratedTestCompile(
    'D:\\work\\legacy',
    settings,
    classNames
  );
  await service.runMavenGeneratedSurefireTest(
    'D:\\work\\legacy',
    settings,
    classNames,
    'D:\\work\\legacy\\target\\ai-unit-test\\surefire\\current\\batch'
  );

  assert.deepEqual(calls.map((call) => (
    call.args.filter((argument) => argument.startsWith('-Dtest='))
  )), [
    ['-Dtest=com.example.ATmp1Test,com.example.BTmp1Test,com.example.CTmp1Test'],
    ['-Dtest=com.example.ATmp1Test,com.example.BTmp1Test,com.example.CTmp1Test']
  ]);
  assert.equal(calls[0].options.timeoutMilliseconds, undefined);
  assert.equal(calls[0].options.timeoutDiagnostic, undefined);
  assert.equal(calls[1].options.timeoutMilliseconds, 120_000);
  assert.match(calls[1].options.timeoutDiagnostic, /timed out after 120 seconds/i);
  assert.match(calls[1].options.timeoutDiagnostic, /Timed out tests:/);
  for (const className of classNames) {
    assert.match(calls[1].options.timeoutDiagnostic, new RegExp(className.replaceAll('.', '\\.')));
  }
});

test('returns a bounded failure and preserves output when a command times out', async () => {
  const service = new ShellService();
  const startedAt = Date.now();
  const diagnostic = [
    '[ERROR] Generated test validation timed out after 1 second.',
    '[ERROR] Timed out tests:',
    '[ERROR] com.example.HangingTest'
  ].join('\n');

  const result = await service.runCommand(
    process.execPath,
    ['-e', "process.stdout.write('child-started'); setInterval(() => {}, 1000);"],
    process.cwd(),
    { mavenHome: tmpdir(), javaHome: tmpdir() },
    { timeoutMilliseconds: 250, timeoutDiagnostic: diagnostic }
  );

  assert.equal(result.exitCode, 124);
  assert.match(result.stdout, /child-started/);
  assert.match(result.stderr, /Generated test validation timed out/);
  assert.match(result.stderr, /com\.example\.HangingTest/);
  assert.ok(Date.now() - startedAt < 5_000);
});

test('extracts a bounded public Maven diagnostic without bearer credentials', () => {
  const diagnostic = extractPublicMavenDiagnostic({
    command: 'mvn.cmd test-compile jacoco:prepare-agent surefire:test',
    cwd: 'D:\\work\\legacy',
    exitCode: 1,
    stdout: '[INFO] compiling',
    stderr: `[ERROR] compilation failed\nAuthorization: Bearer top-secret-token\n${'x'.repeat(20_000)}`
  });

  assert.equal(diagnostic.exitCode, 1);
  assert.match(diagnostic.summary, /compilation failed/);
  assert.doesNotMatch(diagnostic.summary, /top-secret-token/);
  assert.ok(diagnostic.summary.length <= 4_096);
});

test('runs a Windows command file with spaces and shell metacharacters as literal argv', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows cmd quoting regression');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'maven args & literal '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const commandPath = join(directory, 'echo argument & safely.cmd');
  await writeFile(commandPath, [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "value=%~1"',
    '<nul set /p "=%value%"',
    'exit /b 0'
  ].join('\r\n'), 'utf8');
  const literalPath = join(directory, 'module path & no-shell-command');
  const service = new ShellService();

  const result = await service.runCommand(
    commandPath,
    [literalPath],
    directory,
    { mavenHome: directory, javaHome: directory }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, literalPath);
  assert.equal(result.stderr, '');
});

test('redacts complete authorization schemes and common credential keys from diagnostics', () => {
  const secrets = {
    basic: 'dXNlcjpwYXNzd29yZA==',
    apiKey: 'api-key-private-value',
    clientSecret: 'client-secret-private-value',
    xApiKey: 'x-api-key-private-value',
    jsonApiKey: 'json-private-value',
    jsonAuthorization: 'json-basic-private-value',
    jsonProxyAuthorization: 'json-digest-private-value',
    secretAccessKey: 'aws-private-value',
    environmentSecret: 'env-private-value'
  };
  const diagnostic = extractPublicMavenDiagnostic({
    command: [
      `mvn.cmd -DapiKey=${secrets.apiKey}`,
      `-DclientSecret="alpha-private beta-private tail-private"`
    ].join(' '),
    cwd: 'D:\\work\\legacy',
    exitCode: 1,
    stdout: [
      `X-API-Key: ${secrets.xApiKey}`,
      `{"apiKey":"${secrets.jsonApiKey}"}`,
      `{"Authorization":"Basic ${secrets.jsonAuthorization}"}`,
      `{"proxyAuthorization":"Digest ${secrets.jsonProxyAuthorization}"}`,
      `secretAccessKey=${secrets.secretAccessKey}`,
      `AWS_SECRET_ACCESS_KEY=${secrets.environmentSecret}`
    ].join('\n'),
    stderr: `Authorization: Basic ${secrets.basic}`
  });
  const persisted = JSON.stringify(diagnostic);

  for (const secret of [
    ...Object.values(secrets),
    'alpha-private',
    'beta-private',
    'tail-private'
  ]) {
    assert.doesNotMatch(persisted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(persisted, /\[REDACTED\]/);
});

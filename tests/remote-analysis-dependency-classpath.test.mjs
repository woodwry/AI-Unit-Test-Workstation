import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AiClient } from '../src/main/services/ai-client.ts';
import { readKnowledgeArchive } from '../src/main/services/global-knowledge-files.ts';

function repeatedMemberJar(members) {
  const local = [], central = []; let offset = 0;
  for (const [name, data] of members) {
    const n = Buffer.from(name), l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(l, n, data); central.push(c, n); offset += l.length + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

test('remote analysis transfers inherited dependency enums as bytecode without JAR resources', async (t) => {
  const javaHome = process.env.TEST_JAVA_HOME ?? 'D:/java/jdk1.8';
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const javac = join(javaHome, 'bin', `javac${suffix}`);
  try { await access(javac); } catch { t.skip('A JDK is required for the real dependency-bytecode fixture.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'remote-analysis-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  const module = join(workspace, 'module');
  const sourceRoot = join(module, 'src/main/java');
  const classes = join(module, 'target/classes');
  const dependency = join(root, 'library');
  const dependencyClasses = join(dependency, 'classes');
  await mkdir(join(sourceRoot, 'demo'), { recursive: true });
  await mkdir(classes, { recursive: true });
  await mkdir(join(dependency, 'src/dep'), { recursive: true });
  await mkdir(dependencyClasses, { recursive: true });
  await writeFile(join(dependency, 'src/dep/ReportUnitType.java'),
    'package dep; public enum ReportUnitType { BASIC, SUM; }');
  await writeFile(join(dependency, 'src/dep/BaseUnit.java'),
    'package dep; public class BaseUnit { public ReportUnitType getReportUnitType(){return ReportUnitType.BASIC;} }');
  await writeFile(join(dependency, 'src/dep/ReportUnit.java'),
    'package dep; public class ReportUnit extends BaseUnit {}');
  const compile = spawnSync(javac, ['-d', dependencyClasses,
    ...['ReportUnitType', 'BaseUnit', 'ReportUnit'].map(name => join(dependency, `src/dep/${name}.java`))]);
  assert.equal(compile.status, 0, compile.stderr?.toString());
  await writeFile(join(dependencyClasses, 'private-config.properties'), 'password=must-not-upload');
  const dependencyJar = join(dependency, 'api.jar');
  const jar = spawnSync(join(javaHome, 'bin', `jar${suffix}`), ['cf', dependencyJar, '-C', dependencyClasses, '.']);
  assert.equal(jar.status, 0, jar.stderr?.toString());
  const source = join(sourceRoot, 'demo/Target.java');
  await writeFile(source, 'package demo; public class Target { public Object value(dep.ReportUnit unit){return unit.getReportUnitType();} }');
  const targetCompile = spawnSync(javac, ['-cp', dependencyJar, '-d', classes, source]);
  assert.equal(targetCompile.status, 0, targetCompile.stderr?.toString());
  // Real Maven JARs may contain duplicate entries. Transfer one copy and ignore unrelated resources/types.
  const members = await Promise.all(['ReportUnitType', 'BaseUnit', 'ReportUnit'].map(async name =>
    [`dep/${name}.class`, await readFile(join(dependencyClasses, `dep/${name}.class`))]));
  await writeFile(dependencyJar, repeatedMemberJar([...members, members[2],
    ['dep/Unrelated.class', members[0][1]], ['private-config.properties', Buffer.from('must-not-upload')]]));
  const report = join(module, 'report.xml');
  const snapshot = join(module, 'branches.json');
  await writeFile(report, '<report />');
  await writeFile(snapshot, '{}');
  const session = '123e4567-e89b-42d3-a456-426614174000';
  let manifest, bundle;
  const client = new AiClient(async (_url, init) => {
    manifest = JSON.parse(await init.body.get('request').text());
    bundle = Buffer.from(await init.body.get('bundle').arrayBuffer());
    return new Response(JSON.stringify({ analysisSessionId: session, reportPairId: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64), dependencyContextSha256: 'c'.repeat(64), packageName: 'demo',
      testClassName: 'demo.TargetTest', suggestedRelativeTestPath: 'module/src/test/java/demo/TargetTest.java', warnings: [] }),
      { status: 201, headers: { 'Content-Type': 'application/json' } });
  });
  client.setBackendSettings({ agentServiceUrl: 'https://woodwry.cn', javaAnalyzerUrl: 'https://woodwry.cn/java-analyzer' });
  await client.createMethodAnalysisSession({ analysisSessionId: session, workspaceRoot: workspace,
    moduleRoot: module, targetSourcePath: source, targetClass: 'demo.Target', plannedTestClassName: 'TargetTest',
    plannedRelativeTestPath: 'module/src/test/java/demo/TargetTest.java', reportPath: report,
    branchSnapshotPath: snapshot, reportPairId: 'a'.repeat(64), sourceRoots: [sourceRoot],
    classpathEntries: [classes, dependencyJar], javaHome, jdkMajorVersion: 8, buildContextFingerprint: 'fixture' });
  const relativeJar = '.ai-unit-test/analyzer-dependency-bytecode.jar';
  assert.ok(manifest.classpathEntryRelativePaths.includes(relativeJar), 'external dependency bytecode must reach Analyzer');
  const outerJar = join(root, 'uploaded.jar');
  await writeFile(outerJar, bundle);
  const [entry] = await readKnowledgeArchive(outerJar, [relativeJar]);
  const innerJar = join(root, 'uploaded-api.jar');
  await writeFile(innerJar, entry.content);
  const names = (await readKnowledgeArchive(innerJar)).map(item => item.name);
  assert.ok(names.includes('dep/ReportUnit.class'));
  assert.ok(names.includes('dep/BaseUnit.class'));
  assert.ok(names.includes('dep/ReportUnitType.class'));
  assert.ok(names.every(name => name.endsWith('.class')));
  assert.ok(!names.includes('private-config.properties'));
  assert.ok(!names.includes('dep/Unrelated.class'));
  assert.equal(new Set(names).size, names.length);
});

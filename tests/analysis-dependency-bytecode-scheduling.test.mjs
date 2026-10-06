import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

// Control subprocess completion to verify scheduling; the separate JDK fixture
// verifies the real bytecode extraction and inherited dependency signatures.
let invoke;
const original = childProcess.execFile;
const controlled = () => { throw new Error('Use the promise subprocess API.'); };
controlled[promisify.custom] = (...args) => invoke(...args);
childProcess.execFile = controlled;
syncBuiltinESMExports();
const { collectAnalysisDependencyBytecode } = await import('../src/main/services/analysis-dependency-bytecode.ts');
childProcess.execFile = original;
syncBuiltinESMExports();

async function fixture(t, count) {
  const root = await mkdtemp(join(tmpdir(), 'bytecode-scheduling-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  const classes = join(workspace, 'classes');
  const dependencies = join(root, 'dependencies');
  await mkdir(join(classes, 'demo'), { recursive: true });
  await mkdir(join(dependencies, 'dep'), { recursive: true });
  await writeFile(join(classes, 'demo/Target.class'), 'target');
  await Promise.all(Array.from({ length: count }, (_, index) =>
    writeFile(join(dependencies, `dep/C${index}.class`), `dependency-${index}`)));
  return { workspaceRoot: workspace, targetClass: 'demo.Target',
    classpathEntries: [classes, dependencies], javaHome: root };
}

function seed(count) {
  return { stdout: Array.from({ length: count }, (_, index) =>
    `   demo.Target -> dep.C${index} not found`).join('\n'), stderr: '' };
}

test('dependency analysis overlaps independent jdeps batches with a four-process bound', async (t) => {
  const request = await fixture(t, 401);
  let active = 0, peak = 0, calls = 0;
  invoke = async (_file, args) => {
    if (!args.includes('-apionly')) return seed(401);
    active++; calls++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { stdout: '', stderr: '' };
  };
  const entries = await collectAnalysisDependencyBytecode(request);
  assert.equal(peak, 4, 'Independent API batches must overlap without exceeding four subprocesses.');
  assert.equal(calls, 6);
  assert.equal(entries.length, 401);
  for (const entry of entries) {
    const index = Number(entry.relativePath.match(/C(\d+)\.class$/)[1]);
    assert.equal(entry.content.toString(), `dependency-${index}`);
  }
  assert.equal(active, 0);
});

test('a failed jdeps batch drains in-flight reads before deleting scratch files', async (t) => {
  const request = await fixture(t, 401);
  const failure = new Error('jdeps failed');
  let active = 0, calls = 0, lateReads = 0;
  invoke = async (_file, args) => {
    if (!args.includes('-apionly')) return seed(401);
    const call = calls++;
    active++;
    try {
      await new Promise(resolve => setTimeout(resolve, call === 0 ? 5 : 25));
      if (call === 0) throw failure;
      await readFile(args.at(-1));
      lateReads++;
      return { stdout: '', stderr: '' };
    } finally { active--; }
  };
  await assert.rejects(collectAnalysisDependencyBytecode(request), error => error === failure);
  assert.equal(calls, 4, 'No new batches should start after failure.');
  assert.equal(lateReads, 3, 'Scratch files must remain until all active subprocesses settle.');
  assert.equal(active, 0);
});

test('pausing aborts all active dependency batches without scheduling more work', async (t) => {
  const request = await fixture(t, 401);
  const controller = new AbortController();
  const cancellation = new Error('pause requested');
  let active = 0, calls = 0;
  invoke = async (_file, args, options) => {
    if (!args.includes('-apionly')) return seed(401);
    active++; calls++;
    try {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        if (calls === 4) queueMicrotask(() => controller.abort(cancellation));
      });
    } finally { active--; }
  };
  await assert.rejects(collectAnalysisDependencyBytecode(request, controller.signal), error => error === cancellation);
  assert.equal(calls, 4);
  assert.equal(active, 0);
});

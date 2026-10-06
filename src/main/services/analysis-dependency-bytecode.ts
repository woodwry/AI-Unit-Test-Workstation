import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import * as yauzl from 'yauzl';
import { readKnowledgeArchive } from './global-knowledge-files.ts';

const runFile = promisify(execFile);
const MAX_CLASSES = 12_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROUNDS = 60;
const JDEPS_BATCH_SIZE = 80;
const JDEPS_CONCURRENCY = 4;
export const ANALYSIS_DEPENDENCY_JAR_PATH = '.ai-unit-test/analyzer-dependency-bytecode.jar';

export type DependencyClassEntry = { relativePath: string; content: Buffer };

function readClassMembers(path: string, selected: string[]): Promise<DependencyClassEntry[]> {
  const wanted = new Set(selected);
  return new Promise((resolveResult, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? new Error('无法打开分析依赖 JAR。')); return; }
      const result: DependencyClassEntry[] = [];
      let bytes = 0;
      let failed = false;
      const fail = (error: unknown) => { if (!failed) { failed = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!failed) {
          if (wanted.size) reject(new Error('分析依赖 JAR 中缺少已索引的类。'));
          else resolveResult(result);
        }
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        // Some Maven JARs (e.g. xmlbeans 2.6) repeat class entries.
        if (!wanted.has(entry.fileName)) { zip.readEntry(); return; }
        if (entry.uncompressedSize > 12_000_000 || bytes + entry.uncompressedSize > MAX_BYTES) {
          fail(new Error('分析依赖字节码超过大小限制。')); return;
        }
        wanted.delete(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(error ?? new Error('无法读取分析依赖类。')); return; }
          const chunks: Buffer[] = [];
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) { stream.destroy(); fail(new Error('分析依赖字节码超过大小限制。')); return; }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (failed) return;
            result.push({ relativePath: entry.fileName, content: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// jdeps reads real bytecode signatures. Only class members are transferred, never JAR resources.
export async function collectAnalysisDependencyBytecode(request: {
  workspaceRoot: string;
  targetClass: string;
  classpathEntries: string[];
  javaHome: string;
}, signal?: AbortSignal): Promise<DependencyClassEntry[]> {
  const roots: Array<{ path: string; directory: boolean; external: boolean; names?: Set<string> }> = [];
  for (const path of request.classpathEntries) {
    let metadata;
    try { metadata = await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const local = relative(request.workspaceRoot, path);
    const external = local === '..' || local.startsWith(`..${sep}`) || resolve(request.workspaceRoot, local) !== resolve(path);
    if (metadata.isDirectory()) roots.push({ path, directory: true, external });
    else if (metadata.isFile() && extname(path).toLowerCase() === '.jar') roots.push({ path, directory: false, external });
  }
  if (!roots.some(root => root.external)) return [];
  signal?.throwIfAborted();
  // Preserve classpath ordering when more than one JAR defines a type.
  let nextRoot = 0;
  await Promise.all(Array.from({ length: Math.min(8, roots.length) }, async () => {
    for (;;) {
      const root = roots[nextRoot++];
      if (!root) break;
      signal?.throwIfAborted();
      if (!root.directory) root.names = new Set((await readKnowledgeArchive(root.path))
        .map(entry => entry.name).filter(name => name.endsWith('.class')));
    }
  }));
  const findClass = async (name: string) => {
    const member = `${name.replace(/\./g, '/')}.class`;
    for (const root of roots) {
      if (!root.directory) {
        if (root.names!.has(member)) return { root, member, path: null };
      } else {
        const path = join(root.path, ...member.split('/'));
        try { if ((await stat(path)).isFile()) return { root, member, path }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    return null;
  };
  const target = await findClass(request.targetClass);
  if (!target) throw new Error(`远程分析缺少目标类字节码：${request.targetClass}，请先编译项目。`);
  const temp = await mkdtemp(join(tmpdir(), 'aiut-analysis-bytecode-'));
  const jdeps = join(request.javaHome, 'bin', process.platform === 'win32' ? 'jdeps.exe' : 'jdeps');
  const readDependencies = async (paths: string[], apiOnly: boolean): Promise<Set<string>> => {
    const names = new Set<string>();
    const batches = Math.ceil(paths.length / JDEPS_BATCH_SIZE);
    const results: Array<Set<string>> = [];
    let nextBatch = 0;
    let failed = false;
    let failure: unknown;
    await Promise.all(Array.from({ length: Math.min(JDEPS_CONCURRENCY, batches) }, async () => {
      try {
        while (!failed) {
          const batch = nextBatch++;
          if (batch >= batches) return;
          signal?.throwIfAborted();
          const start = batch * JDEPS_BATCH_SIZE;
          const { stdout } = await runFile(jdeps, [
            ...(apiOnly ? ['-apionly'] : []), '-verbose:class', '-filter:none',
            ...paths.slice(start, start + JDEPS_BATCH_SIZE)
          ], { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, signal });
          const dependencies = new Set<string>();
          for (const line of stdout.split(/\r?\n/)) {
            const name = line.match(/^\s+(?:[\w.$]+\s+)?->\s+([\w.$]+)(?:\s|$)/)?.[1];
            if (name && !/^(?:java\.|jdk\.|sun\.|com\.sun\.)/.test(name)) dependencies.add(name);
          }
          results[batch] = dependencies;
        }
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }));
    // Wait for active subprocesses before the outer finally removes their inputs.
    if (failed) throw failure;
    // Preserve discovery order regardless of subprocess completion order.
    for (const dependencies of results) {
      for (const name of dependencies) names.add(name);
    }
    return names;
  };
  const materialize = async (entries: DependencyClassEntry[]): Promise<string[]> => {
    const paths: string[] = [];
    for (const entry of entries) {
      const path = join(temp, ...entry.relativePath.split('/'));
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, entry.content);
      paths.push(path);
    }
    return paths;
  };
  try {
    const seedEntries: DependencyClassEntry[] = [];
    if (target.path) {
      // Anonymous/nested classes can reference dependencies absent from the outer class.
      const prefix = request.targetClass.split('.').at(-1)!;
      for (const name of await readdir(join(target.path, '..'))) {
        if (name === `${prefix}.class` || name.startsWith(`${prefix}$`) && name.endsWith('.class')) {
          seedEntries.push({ relativePath: target.member.replace(/[^/]+$/, name), content: await readFile(join(target.path, '..', name)) });
        }
      }
    } else {
      const prefix = target.member.slice(0, -6);
      const names = [...target.root.names!].filter(name => name === target.member || name.startsWith(`${prefix}$`));
      for (let start = 0; start < names.length; start += 500) {
        seedEntries.push(...await readClassMembers(target.root.path, names.slice(start, start + 500)));
      }
    }
    let pending = await readDependencies(await materialize(seedEntries), false);
    const visited = new Set<string>([request.targetClass]);
    const result: DependencyClassEntry[] = [];
    let bytes = 0;
    for (let round = 0; pending.size > 0; round++) {
      if (round >= MAX_ROUNDS) throw new Error('远程分析依赖 API 类型层级超过限制。');
      const current: DependencyClassEntry[] = [];
      const byJar = new Map<string, Array<{ member: string; external: boolean }>>();
      for (const name of pending) {
        if (visited.has(name)) continue;
        visited.add(name);
        if (visited.size > MAX_CLASSES) throw new Error('远程分析所需依赖类型超过 12000 个。');
        const found = await findClass(name);
        if (!found) continue; // JDK/optional types not present in the user's classpath cannot be transferred.
        if (found.path) {
          const entry = { relativePath: found.member, content: await readFile(found.path) };
          current.push(entry);
          if (found.root.external) result.push(entry);
        } else {
          const list = byJar.get(found.root.path) ?? [];
          list.push({ member: found.member, external: found.root.external });
          byJar.set(found.root.path, list);
        }
      }
      for (const [jarPath, members] of byJar) {
        const external = new Set(members.filter(item => item.external).map(item => item.member));
        for (let start = 0; start < members.length; start += 500) {
          const selected = members.slice(start, start + 500).map(item => item.member);
          let items;
          try { items = await readClassMembers(jarPath, selected); }
          catch (error) { throw new Error(`读取分析依赖字节码失败：${jarPath}`, { cause: error }); }
          for (const item of items) {
            const entry = item;
            current.push(entry);
            if (external.has(item.relativePath)) result.push(entry);
          }
        }
      }
      for (const entry of current) bytes += entry.content.length;
      if (bytes > MAX_BYTES) throw new Error('远程分析所需依赖字节码超过 64MB。');
      pending = await readDependencies(await materialize(current), true);
    }
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

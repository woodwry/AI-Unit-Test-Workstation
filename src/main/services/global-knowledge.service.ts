import { readKnowledgeArchive, matchesKnowledgeFile } from './global-knowledge-files.ts';
import { promises as fs } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { AiClient } from './ai-client';
import {
  resolveRagEmbeddingModelFingerprint,
  type RagSourceSnapshotPage
} from './rag-index-contract.ts';
import type { GlobalKnowledgeRequest } from '../../shared/rag-knowledge-contracts';
import type { RagEmbeddingInterfacesService } from './rag-embedding-interfaces.service';

export async function executeGlobalKnowledge(raw: unknown, options: {
  aiClient: Pick<AiClient, 'globalKnowledge'>;
  embeddings: Pick<RagEmbeddingInterfacesService, 'getView' | 'resolveRuntime'>;
  operationId?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid knowledge request');
  const request = raw as GlobalKnowledgeRequest;
  const actions = ['modules','add-poms','import','entries','methods','source','delete'];
  if (!actions.includes(request.action)) throw new TypeError('Invalid knowledge action');
  const allowed = new Set(['action','paths','moduleId','entryId','methodId','entryIds','methodIds','query','cursor','archiveEntries']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw new TypeError('Invalid knowledge field');
  for (const key of ['moduleId','entryId','methodId','query','cursor'] as const) {
    if (request[key] != null && (typeof request[key] !== 'string' || request[key]!.length > 8192)) throw new TypeError('Invalid knowledge value');
  }
  for (const key of ['paths','entryIds','methodIds','archiveEntries'] as const) {
    if (request[key] !== undefined && (!Array.isArray(request[key]) || request[key]!.length > 1000 || request[key]!.some(value => typeof value !== 'string' || value.length > 32767))) throw new TypeError('Invalid knowledge list');
  }
  const { paths, archiveEntries, ...body } = request;
  const files: { name: string; content: string }[] = [];
  let total = 0;
  if (request.action === 'add-poms' || request.action === 'import') {
    if (!paths?.length || paths.length > 500) throw new TypeError('请添加文件');
    if(archiveEntries){
      if(paths.length!==1 || archiveEntries.some(name=>!matchesKnowledgeFile(name,request.action==='add-poms'?'pom':'class')))throw new TypeError('文件类型不支持');
      const members=await readKnowledgeArchive(paths[0],archiveEntries);
      for(const member of members)files.push({name:member.name.split('/').pop()!,content:request.action==='add-poms' ? member.content!.toString('utf8').replace(/^\uFEFF/,'') : member.content!.toString('base64')});
    } else for (const path of [...new Set(paths)]) {
      if (!isAbsolute(path)) throw new TypeError('文件路径必须是绝对路径');
      const name = basename(path);
      const valid = request.action === 'add-poms' ? name.toLowerCase() === 'pom.xml' || extname(name).toLowerCase() === '.pom' : ['.java','.class'].includes(extname(name).toLowerCase());
      if (!valid) throw new TypeError('文件类型不支持');
      const stat = await fs.stat(path);
      if (!stat.isFile() || stat.size > 12_000_000) throw new TypeError('文件不存在或超过 12 MB');
      total += stat.size;
      if (total > 128_000_000) throw new TypeError('单批文件超过 128 MB');
      const content = await fs.readFile(path);
      files.push({ name, content: request.action === 'add-poms' ? content.toString('utf8').replace(/^\uFEFF/, '') : content.toString('base64') });
    }
  }
  const runtime = request.action === 'import' ? await options.embeddings.resolveRuntime() : null;
  if (request.action === 'import' && !runtime) throw new Error('请先配置向量模型');
  let embeddingModelFingerprint: string | null = runtime
    ? resolveRagEmbeddingModelFingerprint(runtime.embeddingConfig)
    : null;
  if (!embeddingModelFingerprint && !['modules', 'add-poms'].includes(request.action)) {
    const view = await options.embeddings.getView();
    const selected = view.interfaces.find(item => item.id === view.activeInterfaceId);
    if (!selected) throw new Error('请先配置向量模型');
    embeddingModelFingerprint = resolveRagEmbeddingModelFingerprint({
      baseUrl: selected.baseUrl,
      model: selected.embeddingModel
    });
  }
  return options.aiClient.globalKnowledge({
    ...body,
    files,
    ...(embeddingModelFingerprint ? { embeddingModelFingerprint } : {}),
    ...(options.operationId ? { operationId: options.operationId } : {})
  }, runtime?.embeddingConfig, options.signal);
}

export async function cancelGlobalKnowledgeImport(operationId: string, options: {
  aiClient: Pick<AiClient, 'globalKnowledge'>;
}): Promise<boolean> {
  const result = await options.aiClient.globalKnowledge({
    action: 'cancel-import',
    operationId
  });
  return Boolean(result && typeof result === 'object' && 'cancelled' in result && result.cancelled);
}


export type EnsureGlobalTaskKnowledgeInput = {
  workspaceRoot: string;
  moduleRoot: string;
  targetSourcePath: string;
  targetClass: string;
  embeddingConfig: NonNullable<Parameters<AiClient['globalKnowledge']>[1]>;
  signal?: AbortSignal;
};

export type EnsureGlobalTaskKnowledgeResult = {
  status: string;
  entryId: string;
  classFqn: string;
  addedMethodCount: number;
  reusedMethodCount: number;
  indexGeneration: number;
};

/** Trusted generation path: read only the task module POM and its validated Java source. */
export async function ensureGlobalTaskKnowledge(
  input: EnsureGlobalTaskKnowledgeInput,
  aiClient: Pick<AiClient, 'globalKnowledge'>
): Promise<EnsureGlobalTaskKnowledgeResult> {
  const [workspaceRoot, moduleRoot, targetSourcePath] = await Promise.all([
    fs.realpath(input.workspaceRoot),
    fs.realpath(input.moduleRoot),
    fs.realpath(input.targetSourcePath)
  ]);
  if (!isInside(workspaceRoot, moduleRoot) || !isInside(moduleRoot, targetSourcePath)) {
    throw new TypeError('RAG 任务源码必须位于当前 Maven 模块内。');
  }
  if (extname(targetSourcePath).toLowerCase() !== '.java') {
    throw new TypeError('RAG 任务源码必须是 Java 文件。');
  }
  const pomPath = await fs.realpath(join(moduleRoot, 'pom.xml'));
  if (!isInside(moduleRoot, pomPath)) throw new TypeError('Maven POM 路径无效。');
  const [pomStat, sourceStat] = await Promise.all([fs.stat(pomPath), fs.stat(targetSourcePath)]);
  if (!pomStat.isFile() || pomStat.size > 2_000_000) throw new TypeError('Maven POM 不存在或超过 2 MB。');
  if (!sourceStat.isFile() || sourceStat.size > 12_000_000) throw new TypeError('任务源码不存在或超过 12 MB。');
  const [modulePom, source] = await Promise.all([
    fs.readFile(pomPath, 'utf8'),
    fs.readFile(targetSourcePath)
  ]);
  const result = await aiClient.globalKnowledge({
    action: 'ensure',
    embeddingModelFingerprint: resolveRagEmbeddingModelFingerprint(input.embeddingConfig),
    modulePom: modulePom.replace(/^\uFEFF/, ''),
    targetClass: input.targetClass,
    files: [{ name: basename(targetSourcePath), content: source.toString('base64') }]
  }, input.embeddingConfig, input.signal);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('全局知识库增量构建返回无效。');
  }
  const value = result as Record<string, unknown>;
  if ((value.status !== 'published' && value.status !== 'reused')
      || typeof value.entryId !== 'string' || typeof value.classFqn !== 'string'
      || typeof value.addedMethodCount !== 'number' || !Number.isSafeInteger(value.addedMethodCount)
      || typeof value.reusedMethodCount !== 'number' || !Number.isSafeInteger(value.reusedMethodCount)
      || typeof value.indexGeneration !== 'number' || !Number.isSafeInteger(value.indexGeneration)) {
    throw new TypeError('全局知识库增量构建返回无效。');
  }
  return {
    status: value.status,
    entryId: value.entryId,
    classFqn: value.classFqn,
    addedMethodCount: value.addedMethodCount,
    reusedMethodCount: value.reusedMethodCount,
    indexGeneration: value.indexGeneration
  };
}

export type EnsureGlobalSnapshotPageInput = {
  moduleRoot: string;
  page: RagSourceSnapshotPage;
  embeddingConfig: NonNullable<Parameters<AiClient['globalKnowledge']>[1]>;
  signal?: AbortSignal;
};

export async function ensureGlobalSnapshotPage(
  input: EnsureGlobalSnapshotPageInput,
  aiClient: Pick<AiClient, 'globalKnowledge'>
): Promise<{ status: 'published' | 'reused'; addedMethodCount: number; reusedMethodCount: number }> {
  const projectPom = await fs.readFile(join(input.moduleRoot, 'pom.xml'), 'utf8');
  let addedMethodCount = 0;
  let reusedMethodCount = 0;
  for (const file of input.page.upserts) {
    const source = Buffer.from(file.decommentedSource, 'utf8');
    if (source.byteLength > 12_000_000) throw new TypeError('RAG 增量源码超过 12 MB。');
    const modulePom = file.mavenCoordinate
      ? pomForCoordinate(file.mavenCoordinate)
      : projectPom.replace(/^\uFEFF/, '');
    const owners = [...new Set(file.methods.map((method) => method.ownerFqn))];
    for (const ownerFqn of owners) {
      const result = await aiClient.globalKnowledge({
        action: 'ensure',
        embeddingModelFingerprint: resolveRagEmbeddingModelFingerprint(input.embeddingConfig),
        modulePom,
        targetClass: ownerFqn,
        files: [{ name: `${ownerFqn.split('.').at(-1) ?? 'Knowledge'}.java`, content: source.toString('base64') }]
      }, input.embeddingConfig, input.signal);
      const value = decodeEnsureResult(result);
      addedMethodCount += value.addedMethodCount;
      reusedMethodCount += value.reusedMethodCount;
    }
  }
  return {
    status: addedMethodCount > 0 ? 'published' : 'reused',
    addedMethodCount,
    reusedMethodCount
  };
}

function decodeEnsureResult(value: unknown): EnsureGlobalTaskKnowledgeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('全局知识库增量构建返回无效。');
  }
  const result = value as Record<string, unknown>;
  if ((result.status !== 'published' && result.status !== 'reused')
      || typeof result.entryId !== 'string' || typeof result.classFqn !== 'string'
      || typeof result.addedMethodCount !== 'number' || !Number.isSafeInteger(result.addedMethodCount)
      || typeof result.reusedMethodCount !== 'number' || !Number.isSafeInteger(result.reusedMethodCount)
      || typeof result.indexGeneration !== 'number' || !Number.isSafeInteger(result.indexGeneration)) {
    throw new TypeError('全局知识库增量构建返回无效。');
  }
  return {
    status: result.status,
    entryId: result.entryId,
    classFqn: result.classFqn,
    addedMethodCount: result.addedMethodCount,
    reusedMethodCount: result.reusedMethodCount,
    indexGeneration: result.indexGeneration
  };
}

function pomForCoordinate(coordinate: string): string {
  const parts = coordinate.split(':');
  if (parts.length !== 3 || parts.some((part) => !part.trim())) {
    throw new TypeError('RAG 依赖 Maven 坐标无效。');
  }
  const [groupId, artifactId, version] = parts.map(xmlEscape);
  return `<project><modelVersion>4.0.0</modelVersion><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`;
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character] as string);
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

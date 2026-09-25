import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { BackendLlmConfig } from '../../shared/types.ts';

const CONTRACT_ERROR = 'RAG 索引契约响应无效。';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEGRADATION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/;

export type RagScopeInput = {
  workspaceRoot: string;
  moduleRoot: string;
  productionSourceRoots: string[];
  classpathEntries: string[];
  localRepository: string;
  jdkMajorVersion: number;
  buildFingerprint: string;
};

export type RagActiveIndexIdentity = {
  workspaceId: string;
  scopeId: string;
  indexVersion: number;
  sourceSetId: string;
  requestedSourceSetFingerprint: string;
  allowedFqns: string[];
};

export type RagRepairContext = {
  enabled: true;
  scope: RagScopeInput;
  activeIndex: RagActiveIndexIdentity | null;
  taskRunId: string;
  revokedFqns: string[];
};

export type RagEmbeddingModelContext = {
  embeddingConfig: BackendLlmConfig;
};

export type ModelToolCallingProbeOutcome =
  | 'supported'
  | 'missing_tool_call'
  | 'invalid_tool_call'
  | 'invalid_final_confirmation'
  | 'provider_rejected_tools';

export type ModelToolCallingProbeTrace = {
  request: {
    systemPrompt: string;
    userPrompt: string;
    toolName: 'rag_tool_probe';
    toolChoice: 'auto';
  };
  toolExchange: {
    toolCallId: string;
    toolName: 'rag_tool_probe';
    arguments: { token: string };
    toolMessage: { toolCallId: string; content: string };
  } | null;
  finalConfirmation: { content: string; matchesNonce: boolean } | null;
  outcome: ModelToolCallingProbeOutcome;
};

export type ModelToolCallingProbeResponse = {
  supported: boolean;
  cacheHit: boolean;
  cacheKeyDigest: string;
  trace: ModelToolCallingProbeTrace | null;
};

export type PrepareRagRepairResponse = {
  requestedMethods?: RagMethodSelector[];
  status: 'attributable' | 'not_attributable' | 'passed';
  diagnosticFingerprint: string;
  requestedFqns: string[];
  originalDiagnosticText: string;
  targetMethodKey: string | null;
  degradationCode: string | null;
};

export type RagKnownFile = { fileId: string; rawSha256: string };
export type RagMethodSelector = {
  ownerFqn: string;
  methodName: string;
  descriptor: string | null;
  sourceLine: number | null;
};
export type RagSourceLineBasis = 'ORIGINAL_SOURCE' | 'VINEFLOWER_OUTPUT';
export type ResolveRagSourceSetRequest = RagScopeInput & {
  requestedMethods?: RagMethodSelector[];
  reportPairId: string;
  methodIds: string[];
  requestedFqns: string[];
};
export type ResolveRagSourceSetResponse = {
  targetClassFqn: string;
  allowedFqns: string[];
  unresolvedFqns: string[];
  requestedSourceSetFingerprint: string;
};
export type RagSourceParameter = { typeFqn: string; arrayDimensions: number; varArgs: boolean };
export type RagMethodIdentity = {
  ownerFqn: string;
  modifiers: string[];
  typeParameters: string[];
  returnTypeFqn: string;
  methodName: string;
  parameters: RagSourceParameter[];
  declaredThrowsFqns: string[];
  jvmDescriptor: string;
  canonicalSignature: string;
  methodKey: string;
};
export type RagTypeIdentity = {
  fqn: string;
  simpleName: string;
  modifiers: string[];
  firstLine: number;
  lastLine: number;
};
export type RagSourceChunk = {
  chunkId: string;
  sourceLineBasis: RagSourceLineBasis;
  packageName: string;
  classDeclaration: string;
  relevantImports: string[];
  classContextSource: string;
  embeddingContextSource: string;
  ownerFqn: string;
  methodKey: string | null;
  canonicalSignature: string | null;
  declaredThrowsFqns: string[];
  methodFirstLine: number;
  methodLastLine: number;
  firstLine: number;
  lastLine: number;
  estimatedTokens: number;
  contentSha256: string;
  sourceText: string;
};
export type RagSourceFile = {
  fileId: string;
  origin: 'PROJECT_PRODUCTION' | 'DEPENDENCY_SOURCE';
  projectRelativePath: string | null;
  mavenCoordinate: string | null;
  dependencyFingerprint: RagDependencyFingerprint | null;
  sourceLineBasis: RagSourceLineBasis;
  classpathOrder: number;
  rawSha256: string;
  normalizedSha256: string;
  decommentedSource: string;
  parseStatus: 'RESOLVED' | 'PARTIAL';
  types: RagTypeIdentity[];
  methods: RagMethodIdentity[];
  chunks: RagSourceChunk[];
};

export type RagDependencyFingerprint = {
  mavenCoordinate: string;
  binaryJarSha256: string;
  binaryClassEntry: string;
  binaryClassEntrySha256: string;
  sourcesJarPath: string | null;
  sourcesJarSha256: string | null;
  sourceEntry: string | null;
  sourceEntrySha256: string | null;
  vineflowerVersion: string | null;
  vineflowerConfigFingerprint: string | null;
  decompiledOutputSha256: string | null;
  sourceLineBasis: RagSourceLineBasis;
};

export type RagSourceSnapshotPage = {
  sessionId: string;
  pageIndex: number;
  pageSize: number;
  upserts: RagSourceFile[];
  unchangedFileIds: string[];
  deletedFileIds: string[];
  hasMore: boolean;
  diagnostics: string[];
};

export type CreateRagSourceSnapshotSessionRequest = RagScopeInput & {
  requestedMethods?: RagMethodSelector[];
  analysisSessionId: string;
  reportPairId: string;
  methodIds: string[];
  requestedFqns: string[];
  requestedSourceSetFingerprint: string;
  knownFiles: RagKnownFile[];
  priorScopeFileIds: string[];
};
export type CreateRagSourceSnapshotSessionResponse = {
  sessionId: string;
  requestedSourceSetFingerprint: string;
  allowedFqns: string[];
  unresolvedFqns: string[];
  upsertCount: number;
  unchangedCount: number;
  deletedCount: number;
};
export type RagIndexPreparationResult = {
  status: 'reused' | 'published' | 'degraded' | 'failed';
  vectorStatus: 'disabled' | 'ready' | 'degraded';
  workspaceId: string | null;
  scopeId: string | null;
  buildFingerprint: string;
  pageCount: number;
  addedCount: number;
  updatedCount: number;
  deletedCount: number;
  skippedDependencyCount: number;
  degradationCode: string | null;
};

export function decodeModelToolCallingProbeResponse(
  value: unknown,
  captureModelCalls: boolean
): ModelToolCallingProbeResponse {
  const record = exactRecord(value, ['supported', 'cacheHit', 'cacheKeyDigest', 'trace']);
  const supported = bool(record.supported);
  const cacheHit = bool(record.cacheHit);
  const trace = record.trace === null ? null : decodeModelToolCallingProbeTrace(record.trace);
  if (
    (cacheHit && trace !== null)
    || (!captureModelCalls && trace !== null)
    || (captureModelCalls && !cacheHit && trace === null)
    || (trace !== null && supported !== (trace.outcome === 'supported'))
  ) invalid();
  return {
    supported,
    cacheHit,
    cacheKeyDigest: sha256(record.cacheKeyDigest),
    trace
  };
}

export function decodePrepareRagRepairResponse(
  value: unknown
): PrepareRagRepairResponse {
  const record = recordWithOptional(value, [
    'status', 'diagnosticFingerprint', 'requestedFqns',
    'originalDiagnosticText', 'targetMethodKey', 'degradationCode'
  ], ['requestedMethods']);
  if (
    record.status !== 'attributable'
    && record.status !== 'not_attributable'
    && record.status !== 'passed'
  ) invalid();
  const requestedFqns = array(record.requestedFqns, 128).map(fqn);
  unique(requestedFqns);
  if (requestedFqns.some((item, index) => item !== [...requestedFqns].sort()[index])) {
    invalid();
  }
  const originalDiagnosticText = diagnosticText(record.originalDiagnosticText);
  const targetMethodKey = nullableText(record.targetMethodKey, 65_536);
  const degradationCode = record.degradationCode === null
    ? null
    : text(record.degradationCode, 128);
  if (degradationCode !== null && !DEGRADATION_CODE_PATTERN.test(degradationCode)) {
    invalid();
  }
  if (record.status === 'attributable') {
    if (
      requestedFqns.length === 0
      || !originalDiagnosticText
      || targetMethodKey === null
      || degradationCode !== null
    ) invalid();
  } else {
    if (requestedFqns.length || originalDiagnosticText || targetMethodKey !== null) invalid();
    if (
      record.status === 'passed'
        ? degradationCode !== null
        : degradationCode === null
    ) invalid();
  }
  return {
    status: record.status,
    diagnosticFingerprint: sha256(record.diagnosticFingerprint),
    ...(record.requestedMethods === undefined ? {} : {
      requestedMethods: array(record.requestedMethods, 256).map(decodeRagMethodSelector)
    }),
    requestedFqns,
    originalDiagnosticText,
    targetMethodKey,
    degradationCode
  };
}

export function validateRagScopeInput(value: unknown): RagScopeInput {
  const record = exactRecord(value, [
    'workspaceRoot', 'moduleRoot', 'productionSourceRoots', 'classpathEntries',
    'localRepository', 'jdkMajorVersion', 'buildFingerprint'
  ]);
  const productionSourceRoots = pathArray(record.productionSourceRoots, 10_000);
  const classpathEntries = pathArray(record.classpathEntries, 50_000);
  return {
    workspaceRoot: absolutePath(record.workspaceRoot),
    moduleRoot: absolutePath(record.moduleRoot),
    productionSourceRoots,
    classpathEntries,
    localRepository: absolutePath(record.localRepository),
    jdkMajorVersion: integer(record.jdkMajorVersion, 8, 99),
    buildFingerprint: sha256(record.buildFingerprint)
  };
}

export function validateRagRepairContext(value: unknown): RagRepairContext {
  const record = exactRecord(value, [
    'enabled', 'scope', 'activeIndex', 'taskRunId', 'revokedFqns'
  ]);
  if (record.enabled !== true) invalid();
  return {
    enabled: true,
    scope: validateRagScopeInput(record.scope),
    activeIndex: record.activeIndex === null
      ? null
      : validateRagActiveIndexIdentity(record.activeIndex),
    taskRunId: uuid(record.taskRunId),
    revokedFqns: orderedFqns(record.revokedFqns, false)
  };
}

export function validateRagActiveIndexIdentity(value: unknown): RagActiveIndexIdentity {
  const record = exactRecord(value, [
    'workspaceId', 'scopeId', 'indexVersion', 'sourceSetId',
    'requestedSourceSetFingerprint', 'allowedFqns'
  ]);
  const allowedFqns = orderedFqns(record.allowedFqns, true);
  const requestedSourceSetFingerprint = sha256(record.requestedSourceSetFingerprint);
  if (requestedSourceSetFingerprint !== resolveRagSourceSetFingerprint(allowedFqns)) invalid();
  return {
    workspaceId: sha256(record.workspaceId),
    scopeId: sha256(record.scopeId),
    indexVersion: integer(record.indexVersion, 1),
    sourceSetId: sha256(record.sourceSetId),
    requestedSourceSetFingerprint,
    allowedFqns
  };
}

export function validateResolveRagSourceSetRequest(
  value: unknown
): ResolveRagSourceSetRequest {
  const record = recordWithOptional(value, [
    'reportPairId', 'methodIds', 'requestedFqns', 'workspaceRoot', 'moduleRoot',
    'productionSourceRoots', 'classpathEntries', 'localRepository',
    'jdkMajorVersion', 'buildFingerprint'
  ], ['requestedMethods']);
  const scope = validateRagScopeInput({
    workspaceRoot: record.workspaceRoot,
    moduleRoot: record.moduleRoot,
    productionSourceRoots: record.productionSourceRoots,
    classpathEntries: record.classpathEntries,
    localRepository: record.localRepository,
    jdkMajorVersion: record.jdkMajorVersion,
    buildFingerprint: record.buildFingerprint
  });
  const methodIds = boundedStringArray(record.methodIds, 100_000, 65_536);
  unique(methodIds);
  const requestedFqns = orderedFqns(record.requestedFqns, false);
  return {
    reportPairId: sha256(record.reportPairId),
    ...(record.requestedMethods === undefined ? {} : {
      requestedMethods: array(record.requestedMethods, 256).map(decodeRagMethodSelector)
    }),
    methodIds,
    requestedFqns,
    ...scope
  };
}

export function decodeResolveRagSourceSetResponse(
  value: unknown
): ResolveRagSourceSetResponse {
  const record = exactRecord(value, [
    'targetClassFqn', 'allowedFqns', 'unresolvedFqns',
    'requestedSourceSetFingerprint'
  ]);
  const targetClassFqn = fqn(record.targetClassFqn);
  const allowedFqns = orderedFqns(record.allowedFqns, true);
  const unresolvedFqns = orderedFqns(record.unresolvedFqns, false);
  if (!allowedFqns.includes(targetClassFqn)) invalid();
  if (unresolvedFqns.some((item) => allowedFqns.includes(item))) invalid();
  const requestedSourceSetFingerprint = sha256(record.requestedSourceSetFingerprint);
  if (requestedSourceSetFingerprint !== resolveRagSourceSetFingerprint(allowedFqns)) invalid();
  return {
    targetClassFqn,
    allowedFqns,
    unresolvedFqns,
    requestedSourceSetFingerprint
  };
}

export function validateCreateRagSourceSnapshotSessionRequest(
  value: unknown
): CreateRagSourceSnapshotSessionRequest {
  const record = recordWithOptional(value, [
    'analysisSessionId', 'reportPairId', 'methodIds', 'requestedFqns',
    'requestedSourceSetFingerprint', 'workspaceRoot', 'moduleRoot',
    'productionSourceRoots', 'classpathEntries', 'localRepository',
    'jdkMajorVersion', 'buildFingerprint', 'knownFiles', 'priorScopeFileIds'
  ], ['requestedMethods']);
  const scope = validateRagScopeInput({
    workspaceRoot: record.workspaceRoot,
    moduleRoot: record.moduleRoot,
    productionSourceRoots: record.productionSourceRoots,
    classpathEntries: record.classpathEntries,
    localRepository: record.localRepository,
    jdkMajorVersion: record.jdkMajorVersion,
    buildFingerprint: record.buildFingerprint
  });
  const knownFiles = array(record.knownFiles, 1_000_000).map(decodeKnownFile);
  unique(knownFiles.map((item) => item.fileId));
  const priorScopeFileIds = boundedStringArray(record.priorScopeFileIds, 1_000_000, 16_384);
  unique(priorScopeFileIds);
  const methodIds = boundedStringArray(record.methodIds, 100_000, 65_536);
  unique(methodIds);
  return {
    analysisSessionId: uuid(record.analysisSessionId),
    ...(record.requestedMethods === undefined ? {} : {
      requestedMethods: array(record.requestedMethods, 256).map(decodeRagMethodSelector)
    }),
    reportPairId: sha256(record.reportPairId),
    methodIds,
    requestedFqns: orderedFqns(record.requestedFqns, false),
    requestedSourceSetFingerprint: sha256(record.requestedSourceSetFingerprint),
    ...scope,
    knownFiles,
    priorScopeFileIds
  };
}

export function resolveRagEmbeddingModelFingerprint(
  config: Pick<BackendLlmConfig, 'baseUrl' | 'model'>
): string {
  return lengthPrefixedHash([
    String(config.baseUrl ?? '').replace(/\/+$/u, ''),
    String(config.model ?? '').trim(),
    // 与 Agent 的 embedding_document.EMBEDDING_DOCUMENT_FORMAT_VERSION 保持一致。
    'java-composite-v2'
  ]);
}

export function resolveRagSourceSetFingerprint(fqnsValue: unknown): string {
  const fqns = orderedFqns(fqnsValue, true);
  const digest = createHash('sha256');
  for (const value of fqns) {
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.byteLength);
    digest.update(length);
    digest.update(encoded);
  }
  return digest.digest('hex');
}

export function decodeCreateRagSourceSnapshotSessionResponse(
  value: unknown,
  expected: {
    requestedSourceSetFingerprint: string;
  }
): CreateRagSourceSnapshotSessionResponse {
  const record = exactRecord(value, [
    'sessionId', 'requestedSourceSetFingerprint', 'allowedFqns', 'unresolvedFqns',
    'upsertCount', 'unchangedCount', 'deletedCount'
  ]);
  const requestedSourceSetFingerprint = sha256(record.requestedSourceSetFingerprint);
  const allowedFqns = orderedFqns(record.allowedFqns, true);
  const unresolvedFqns = orderedFqns(record.unresolvedFqns, false);
  if (
    requestedSourceSetFingerprint !== expected.requestedSourceSetFingerprint
    || requestedSourceSetFingerprint !== resolveRagSourceSetFingerprint(allowedFqns)
    || unresolvedFqns.some((item) => allowedFqns.includes(item))
  ) invalid();
  return {
    sessionId: uuid(record.sessionId),
    requestedSourceSetFingerprint,
    allowedFqns,
    unresolvedFqns,
    upsertCount: integer(record.upsertCount, 0, 10_000_000),
    unchangedCount: integer(record.unchangedCount, 0, 10_000_000),
    deletedCount: integer(record.deletedCount, 0, 10_000_000)
  };
}

export function decodeRagSourceSnapshotPageResponse(
  value: unknown,
  expected: { sessionId: string; pageIndex: number; pageSize: number }
): RagSourceSnapshotPage {
  const record = exactRecord(value, [
    'sessionId', 'pageIndex', 'pageSize', 'upserts', 'unchangedFileIds',
    'deletedFileIds', 'hasMore', 'diagnostics'
  ]);
  const sessionId = uuid(record.sessionId);
  const pageIndex = integer(record.pageIndex, 0, 1_000_000_000);
  const pageSize = integer(record.pageSize, 1, 200);
  if (sessionId !== expected.sessionId || pageIndex !== expected.pageIndex || pageSize !== expected.pageSize) {
    invalid();
  }
  const upserts = array(record.upserts, 200).map(decodeSourceFile);
  if (upserts.length > pageSize) invalid();
  const unchangedFileIds = boundedStringArray(record.unchangedFileIds, 1_000_000, 16_384);
  const deletedFileIds = boundedStringArray(record.deletedFileIds, 1_000_000, 16_384);
  const diagnostics = boundedStringArray(record.diagnostics, 10_000, 1_000, true);
  if (pageIndex > 0 && (unchangedFileIds.length || deletedFileIds.length || diagnostics.length)) invalid();
  unique([
    ...upserts.map((item) => item.fileId),
    ...unchangedFileIds,
    ...deletedFileIds
  ]);
  return {
    sessionId,
    pageIndex,
    pageSize,
    upserts,
    unchangedFileIds,
    deletedFileIds,
    hasMore: bool(record.hasMore),
    diagnostics
  };
}

function decodeKnownFile(value: unknown): RagKnownFile {
  const record = exactRecord(value, ['fileId', 'rawSha256']);
  return { fileId: text(record.fileId, 16_384), rawSha256: sha256(record.rawSha256) };
}

function decodeSourceParameter(value: unknown): RagSourceParameter {
  const record = exactRecord(value, ['typeFqn', 'arrayDimensions', 'varArgs']);
  return {
    typeFqn: text(record.typeFqn, 8_192),
    arrayDimensions: integer(record.arrayDimensions, 0, 255),
    varArgs: bool(record.varArgs)
  };
}

function decodeMethodIdentity(value: unknown): RagMethodIdentity {
  const record = exactRecord(value, [
    'ownerFqn', 'modifiers', 'typeParameters', 'returnTypeFqn', 'methodName',
    'parameters', 'declaredThrowsFqns', 'jvmDescriptor', 'canonicalSignature', 'methodKey'
  ]);
  const parameters = array(record.parameters, 1_024).map(decodeSourceParameter);
  if (parameters.some((parameter, index) => parameter.varArgs && index !== parameters.length - 1)) {
    invalid();
  }
  const result: RagMethodIdentity = {
    ownerFqn: text(record.ownerFqn, 8_192),
    modifiers: boundedStringArray(record.modifiers, 64, 8_192),
    typeParameters: boundedStringArray(record.typeParameters, 256, 8_192),
    returnTypeFqn: text(record.returnTypeFqn, 8_192),
    methodName: text(record.methodName, 1_024),
    parameters,
    declaredThrowsFqns: boundedStringArray(record.declaredThrowsFqns, 1_024, 8_192),
    jvmDescriptor: text(record.jvmDescriptor, 65_536),
    canonicalSignature: text(record.canonicalSignature, 131_072),
    methodKey: text(record.methodKey, 131_072)
  };
  if (
    !result.jvmDescriptor.startsWith('(')
    || !result.jvmDescriptor.includes(')')
    || result.methodKey !== `${result.ownerFqn}#${result.methodName}${result.jvmDescriptor}`
  ) invalid();
  return result;
}

function decodeTypeIdentity(value: unknown): RagTypeIdentity {
  const record = exactRecord(value, ['fqn', 'simpleName', 'modifiers', 'firstLine', 'lastLine']);
  const result = {
    fqn: text(record.fqn, 8_192),
    simpleName: text(record.simpleName, 1_024),
    modifiers: boundedStringArray(record.modifiers, 64, 8_192),
    firstLine: integer(record.firstLine, 1, 10_000_000),
    lastLine: integer(record.lastLine, 1, 10_000_000)
  };
  if (result.lastLine < result.firstLine) invalid();
  return result;
}

function decodeSourceChunk(value: unknown): RagSourceChunk {
  const record = exactRecord(value, [
    'chunkId', 'sourceLineBasis', 'packageName', 'classDeclaration', 'relevantImports',
    'classContextSource', 'embeddingContextSource', 'ownerFqn', 'methodKey',
    'canonicalSignature', 'declaredThrowsFqns', 'methodFirstLine',
    'methodLastLine', 'firstLine', 'lastLine', 'estimatedTokens', 'contentSha256',
    'sourceText'
  ]);
  const methodKey = nullableText(record.methodKey, 131_072);
  const canonicalSignature = nullableText(record.canonicalSignature, 131_072);
  if ((methodKey === null) !== (canonicalSignature === null)) invalid();
  const methodFirstLine = integer(record.methodFirstLine, 1, 10_000_000);
  const methodLastLine = integer(record.methodLastLine, 1, 10_000_000);
  const firstLine = integer(record.firstLine, 1, 10_000_000);
  const lastLine = integer(record.lastLine, 1, 10_000_000);
  if (
    methodLastLine < methodFirstLine
    || lastLine < firstLine
    || firstLine < methodFirstLine
    || lastLine > methodLastLine
    || lastLine - firstLine + 1 > 300
  ) invalid();
  return {
    chunkId: text(record.chunkId, 16_384),
    sourceLineBasis: lineBasis(record.sourceLineBasis),
    packageName: text(record.packageName, 8_192, true),
    classDeclaration: sourceBody(record.classDeclaration, 131_072),
    relevantImports: boundedStringArray(record.relevantImports, 10_000, 65_536),
    classContextSource: sourceBody(record.classContextSource, 65_536),
    embeddingContextSource: sourceBody(record.embeddingContextSource, 1_024),
    ownerFqn: text(record.ownerFqn, 8_192),
    methodKey,
    canonicalSignature,
    declaredThrowsFqns: boundedStringArray(record.declaredThrowsFqns, 1_024, 8_192),
    methodFirstLine,
    methodLastLine,
    firstLine,
    lastLine,
    estimatedTokens: integer(record.estimatedTokens, 1, 3_000),
    contentSha256: sha256(record.contentSha256),
    sourceText: sourceBody(record.sourceText, 12_000)
  };
}

function decodeSourceFile(value: unknown): RagSourceFile {
  const record = exactRecord(value, [
    'fileId', 'origin', 'projectRelativePath', 'mavenCoordinate',
    'dependencyFingerprint', 'sourceLineBasis', 'classpathOrder', 'rawSha256', 'normalizedSha256',
    'decommentedSource', 'parseStatus', 'types', 'methods', 'chunks'
  ]);
  if (record.origin !== 'PROJECT_PRODUCTION' && record.origin !== 'DEPENDENCY_SOURCE') invalid();
  const projectRelativePath = optionalNullableText(record.projectRelativePath, 32_767);
  const mavenCoordinate = optionalNullableText(record.mavenCoordinate, 32_767);
  const dependencyFingerprint = record.dependencyFingerprint === null
    ? null
    : decodeDependencyFingerprint(record.dependencyFingerprint);
  const rawSha256 = sha256(record.rawSha256);
  const sourceLineBasis = lineBasis(record.sourceLineBasis);
  if ((projectRelativePath === null) === (mavenCoordinate === null)) invalid();
  if (record.origin === 'PROJECT_PRODUCTION') {
    if (
      projectRelativePath === null
      || mavenCoordinate !== null
      || dependencyFingerprint !== null
      || sourceLineBasis !== 'ORIGINAL_SOURCE'
    ) invalid();
    const normalizedPath = projectRelativePath.replace(/\\/g, '/').toLowerCase();
    if (!normalizedPath.endsWith('.java') || `/${normalizedPath.replace(/^\/+/, '')}`.includes('/src/test/')) {
      invalid();
    }
  } else if (
    mavenCoordinate === null
    || projectRelativePath !== null
    || dependencyFingerprint === null
    || !mavenCoordinate.startsWith(`${dependencyFingerprint.mavenCoordinate}!/`)
    || dependencyFingerprint.sourceLineBasis !== sourceLineBasis
  ) invalid();
  const types = array(record.types, 100_000).map(decodeTypeIdentity);
  const methods = array(record.methods, 100_000).map(decodeMethodIdentity);
  const chunks = array(record.chunks, 100_000).map(decodeSourceChunk);
  unique(types.map((item) => item.fqn));
  unique(methods.map((item) => item.methodKey));
  unique(chunks.map((item) => item.chunkId));
  const methodsByKey = new Map(methods.map((item) => [item.methodKey, item]));
  for (const chunk of chunks) {
    if (chunk.methodKey === null) continue;
    const method = methodsByKey.get(chunk.methodKey);
    if (
      chunk.sourceLineBasis !== sourceLineBasis
      || !method
      || method.ownerFqn !== chunk.ownerFqn
      || method.canonicalSignature !== chunk.canonicalSignature
      || method.declaredThrowsFqns.join('\0') !== chunk.declaredThrowsFqns.join('\0')
    ) invalid();
  }
  return {
    fileId: text(record.fileId, 16_384),
    origin: record.origin,
    projectRelativePath,
    mavenCoordinate,
    dependencyFingerprint,
    sourceLineBasis,
    classpathOrder: integer(record.classpathOrder, 0, 1_000_000),
    rawSha256,
    normalizedSha256: sha256(record.normalizedSha256),
    decommentedSource: sourceBody(record.decommentedSource, 10_000_000),
    parseStatus: parseStatus(record.parseStatus),
    types,
    methods,
    chunks
  };
}

function decodeDependencyFingerprint(value: unknown): RagDependencyFingerprint {
  const record = exactRecord(value, [
    'mavenCoordinate', 'binaryJarSha256', 'binaryClassEntry',
    'binaryClassEntrySha256', 'sourcesJarPath', 'sourcesJarSha256',
    'sourceEntry', 'sourceEntrySha256', 'vineflowerVersion',
    'vineflowerConfigFingerprint', 'decompiledOutputSha256', 'sourceLineBasis'
  ]);
  const mavenCoordinate = text(record.mavenCoordinate, 32_767);
  const coordinateParts = mavenCoordinate.split(':');
  if (coordinateParts.length !== 3 || coordinateParts.some((part) => !part)) invalid();
  const result: RagDependencyFingerprint = {
    mavenCoordinate,
    binaryJarSha256: sha256(record.binaryJarSha256),
    binaryClassEntry: archiveEntry(record.binaryClassEntry),
    binaryClassEntrySha256: sha256(record.binaryClassEntrySha256),
    sourcesJarPath: nullableAbsolutePath(record.sourcesJarPath),
    sourcesJarSha256: nullableSha256(record.sourcesJarSha256),
    sourceEntry: nullableArchiveEntry(record.sourceEntry),
    sourceEntrySha256: nullableSha256(record.sourceEntrySha256),
    vineflowerVersion: nullableText(record.vineflowerVersion, 256),
    vineflowerConfigFingerprint: nullableSha256(record.vineflowerConfigFingerprint),
    decompiledOutputSha256: nullableSha256(record.decompiledOutputSha256),
    sourceLineBasis: lineBasis(record.sourceLineBasis)
  };
  const matchedSources = [
    result.sourcesJarPath,
    result.sourcesJarSha256,
    result.sourceEntry,
    result.sourceEntrySha256
  ];
  const vineflower = [
    result.vineflowerVersion,
    result.vineflowerConfigFingerprint,
    result.decompiledOutputSha256
  ];
  if (result.sourceLineBasis === 'ORIGINAL_SOURCE') {
    if (matchedSources.some((item) => item === null) || vineflower.some((item) => item !== null)) invalid();
  } else if (matchedSources.some((item) => item !== null) || vineflower.some((item) => item === null)) {
    invalid();
  }
  return result;
}

function decodeModelToolCallingProbeTrace(value: unknown): ModelToolCallingProbeTrace {
  const record = exactRecord(value, [
    'request', 'toolExchange', 'finalConfirmation', 'outcome'
  ]);
  const requestRecord = exactRecord(record.request, [
    'systemPrompt', 'userPrompt', 'toolName', 'toolChoice'
  ]);
  if (requestRecord.toolName !== 'rag_tool_probe'
    || requestRecord.toolChoice !== 'auto') {
    invalid();
  }
  const request = {
    systemPrompt: probeText(requestRecord.systemPrompt, 2_048),
    userPrompt: probeText(requestRecord.userPrompt, 256),
    toolName: 'rag_tool_probe' as const,
    toolChoice: 'auto' as const
  };
  const toolExchange = record.toolExchange === null
    ? null
    : decodeModelToolCallingProbeExchange(record.toolExchange);
  const finalConfirmation = record.finalConfirmation === null
    ? null
    : decodeModelToolCallingProbeConfirmation(record.finalConfirmation);
  const outcome = modelToolCallingProbeOutcome(record.outcome);
  if (
    outcome === 'supported'
      ? (
          toolExchange === null
          || finalConfirmation === null
          || !finalConfirmation.matchesNonce
          || finalConfirmation.content !== toolExchange.arguments.token
        )
      : outcome === 'invalid_final_confirmation'
        ? toolExchange === null || finalConfirmation === null || finalConfirmation.matchesNonce
        : finalConfirmation !== null
  ) invalid();
  return { request, toolExchange, finalConfirmation, outcome };
}

function decodeModelToolCallingProbeExchange(
  value: unknown
): NonNullable<ModelToolCallingProbeTrace['toolExchange']> {
  const record = exactRecord(value, [
    'toolCallId', 'toolName', 'arguments', 'toolMessage'
  ]);
  if (record.toolName !== 'rag_tool_probe') invalid();
  const toolCallId = probeText(record.toolCallId, 256);
  const argumentRecord = exactRecord(record.arguments, ['token']);
  const token = probeText(argumentRecord.token, 256);
  const messageRecord = exactRecord(record.toolMessage, ['toolCallId', 'content']);
  const messageToolCallId = probeText(messageRecord.toolCallId, 256);
  const content = probeText(messageRecord.content, 256);
  if (
    toolCallId !== messageToolCallId
    || content !== token
  ) invalid();
  return {
    toolCallId,
    toolName: 'rag_tool_probe',
    arguments: { token },
    toolMessage: { toolCallId: messageToolCallId, content }
  };
}

function decodeModelToolCallingProbeConfirmation(
  value: unknown
): NonNullable<ModelToolCallingProbeTrace['finalConfirmation']> {
  const record = exactRecord(value, ['content', 'matchesNonce']);
  return {
    content: probeText(record.content, 4_096, true),
    matchesNonce: bool(record.matchesNonce)
  };
}

function modelToolCallingProbeOutcome(value: unknown): ModelToolCallingProbeOutcome {
  if (
    value !== 'supported'
    && value !== 'missing_tool_call'
    && value !== 'invalid_tool_call'
    && value !== 'invalid_final_confirmation'
    && value !== 'provider_rejected_tools'
  ) invalid();
  return value;
}

function probeText(value: unknown, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || value.includes('\u0000')
    || (!allowEmpty && value.length === 0)
  ) invalid();
  return value;
}

function lengthPrefixedHash(values: readonly string[]): string {
  const digest = createHash('sha256');
  for (const value of values) {
    const encoded = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(encoded.byteLength));
    digest.update(length);
    digest.update(encoded);
  }
  return digest.digest('hex');
}

function decodeRagMethodSelector(value: unknown): RagMethodSelector {
  const record = exactRecord(value, ['ownerFqn', 'methodName', 'descriptor', 'sourceLine']);
  const descriptor = nullableText(record.descriptor, 65_536);
  if (descriptor !== null && (!descriptor.startsWith('(') || !descriptor.includes(')'))) invalid();
  return {
    ownerFqn: fqn(record.ownerFqn),
    methodName: text(record.methodName, 1_024),
    descriptor,
    sourceLine: record.sourceLine === null ? null : integer(record.sourceLine, 1, 2 ** 31 - 1)
  };
}

function recordWithOptional(value: unknown, fields: readonly string[], optional: readonly string[]) {
  return exactRecord(value, [...fields, ...optional.filter((field) =>
    value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(value, field))]);
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== fields.length || fields.some((field) => !(field in record))
    || actual.some((field) => !fields.includes(field))) invalid();
  return record;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) invalid();
  }
  return value;
}

function pathArray(value: unknown, maximum: number): string[] {
  return array(value, maximum).map(absolutePath);
}

function boundedStringArray(
  value: unknown,
  maximumCount: number,
  maximumLength: number,
  allowEmpty = false
): string[] {
  return array(value, maximumCount).map((item) => text(item, maximumLength, allowEmpty));
}

function orderedFqns(value: unknown, requireNonEmpty: boolean): string[] {
  const result = array(value, 100_000).map(fqn);
  if (requireNonEmpty && result.length === 0) invalid();
  unique(result);
  const ordered = [...result].sort();
  if (ordered.some((item, index) => item !== result[index])) invalid();
  return result;
}

function fqn(value: unknown): string {
  const result = text(value, 8_192);
  if (
    !result.includes('.')
    || /\s/u.test(result)
    || result.split('.').some((segment) => !segment || /^\d/u.test(segment))
  ) invalid();
  return result;
}

function text(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || CONTROL_PATTERN.test(value)) invalid();
  const normalized = value.trim();
  if (!allowEmpty && !normalized) invalid();
  return allowEmpty ? value : normalized;
}

function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}

function optionalNullableText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  const result = text(value, maximum, true).trim();
  return result ? result : null;
}
function nullableSha256(value: unknown): string | null {
  return value === null ? null : sha256(value);
}

function nullableAbsolutePath(value: unknown): string | null {
  return value === null ? null : absolutePath(value);
}

function archiveEntry(value: unknown): string {
  const entry = text(value, 32_767);
  if (entry.startsWith('/') || entry.includes('\\')) invalid();
  const segments = entry.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) invalid();
  return entry;
}

function nullableArchiveEntry(value: unknown): string | null {
  return value === null ? null : archiveEntry(value);
}

function lineBasis(value: unknown): RagSourceLineBasis {
  if (value !== 'ORIGINAL_SOURCE' && value !== 'VINEFLOWER_OUTPUT') invalid();
  return value;
}
function sourceBody(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\u0000')) {
    invalid();
  }
  return value;
}

function diagnosticText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 24_000 || value.includes('\u0000')) {
    invalid();
  }
  return value;
}

function absolutePath(value: unknown): string {
  const result = text(value, 32_767);
  if (!isAbsolute(result)) invalid();
  return normalize(result);
}

function uuid(value: unknown): string {
  const result = text(value, 36).toLowerCase();
  if (!UUID_PATTERN.test(result)) invalid();
  return result;
}

function sha256(value: unknown): string {
  const result = text(value, 64).toLowerCase();
  if (!SHA256_PATTERN.test(result)) invalid();
  return result;
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function parseStatus(value: unknown): 'RESOLVED' | 'PARTIAL' {
  if (value !== 'RESOLVED' && value !== 'PARTIAL') invalid();
  return value;
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function invalid(): never {
  throw new TypeError(CONTRACT_ERROR);
}

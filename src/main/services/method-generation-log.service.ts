import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ModelCallLogSettings } from '../../shared/types.ts';
import type {
  MethodGenerationModelCall,
  MethodGenerationSessionEvent
} from './method-generation-contract.ts';
import type { ModelToolCallingProbeResponse } from './rag-index-contract.ts';
import { sanitizePublicText } from './maven-command.ts';

export type MethodGenerationLogRecord = {
  taskId: string;
  className: string;
  qualifiedClassName: string;
  methodId: string;
  methodName: string;
  descriptor: string;
  displaySignature: string;
  modifiers: readonly string[];
  batchId: string;
  batchIndex: number;
  waveIndex?: number;
  partIndex?: number;
  partBatchId?: string;
  scenarioIds?: readonly string[];
  event: MethodGenerationSessionEvent;
};

export type MethodGenerationWaveSummaryLogRecord = {
  taskId: string;
  className: string;
  qualifiedClassName: string;
  methodId: string;
  methodName: string;
  descriptor: string;
  waveId: string;
  waveIndex: number;
  selectedScenarioIds: readonly string[];
  skippedScenarioIds: readonly string[];
  parts: readonly {
    partIndex: number;
    partBatchId: string;
    scenarioIds: readonly string[];
    status: 'succeeded' | 'failed';
    candidateId: string | null;
  }[];
  mergedCandidateId: string | null;
  occurredAt: string;
};

export type MavenBatchExecutionTraceLog = {
  mavenBatchId: string;
  moduleRoot: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  candidates: readonly unknown[];
  steps: readonly unknown[];
  results: readonly unknown[];
};

export type MavenBatchLogRecord = {
  taskId: string;
  className: string;
  qualifiedClassName: string;
  methodId: string;
  methodName: string;
  descriptor: string;
  waveIndex: number;
  candidateId: string;
  trace: MavenBatchExecutionTraceLog;
};

export type MethodRepairTelemetryRecord = {
  taskId: string;
  className: string;
  qualifiedClassName: string;
  methodId: string;
  methodName: string;
  descriptor: string;
  batchId: string;
  batchIndex: number;
  candidateId: string;
  candidateVersion: number;
  repairAttempt: number;
  candidateSha256: string;
  feedbackKind: 'execution' | 'candidate_rejected';
  executionStatus: 'compile_failed' | 'test_failed';
  compilerErrorCount: number;
  compilerCategories: readonly string[];
  affectedTestCount: number;
  exceptionCount: number;
  generatedTestFrameCount: number;
  productionFrameCount: number;
  missingSymbolCount: number;
  relatedTypeCount: number;
  diagnosticTruncated: boolean;
  droppedItemCount: number;
  analyzerStatus: 'available' | 'fallback';
  analyzerWarningCount: number;
  scopeRejectionCodes: readonly string[];
  mavenDurationMs: number | null;
  analyzerDurationMs: number | null;
  occurredAt: string;
};

export type RagToolCallingProbeLogRecord = {
  taskId: string;
  className: string;
  qualifiedClassName: string;
  modelName: string;
  occurredAt: string;
  probe: ModelToolCallingProbeResponse;
};

export class MethodGenerationLogService {
  private settings: ModelCallLogSettings = { enabled: false };
  private readonly callDirectories = new Map<string, string>();
  private readonly callLabels = new Map<string, string>();
  private readonly generationCallCounts = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private firstError: string | null = null;

  async begin(settings: ModelCallLogSettings): Promise<void> {
    await this.finish();
    this.firstError = null;
    this.settings = { ...settings };
    if (!settings.enabled) return;
    if (!settings.directory) {
      throw new Error('A writable directory is required for method-generation logs.');
    }
    const stat = await fs.stat(settings.directory);
    if (!stat.isDirectory()) {
      throw new Error('The method-generation log path is not a directory.');
    }
    await fs.access(settings.directory, constants.W_OK);
  }

  record(record: MethodGenerationLogRecord): Promise<void> {
    const modelCall = record.event.modelCall;
    if (!this.settings.enabled || !this.settings.directory || !modelCall) {
      return Promise.resolve();
    }
    validateIdentity(record, modelCall);
    const write = this.queue.then(() => this.write(record, modelCall));
    this.queue = write.catch(() => {
      this.firstError ??= 'Method-generation log write failed.';
    });
    return this.queue;
  }

  recordRepairTelemetry(record: MethodRepairTelemetryRecord): Promise<void> {
    if (!this.settings.enabled || !this.settings.directory) return Promise.resolve();
    const persisted = boundedTelemetry(record);
    const write = this.queue.then(async () => {
      const occurredAt = new Date(persisted.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) {
        throw new Error('Method-repair telemetry timestamp is invalid.');
      }
      const directory = join(this.settings.directory as string, formatDate(occurredAt));
      await fs.mkdir(directory, { recursive: true });
      await fs.appendFile(
        join(directory, 'repair-telemetry.jsonl'),
        `${JSON.stringify(persisted)}\n`,
        'utf8'
      );
    });
    this.queue = write.catch(() => {
      this.firstError ??= 'Method-generation log write failed.';
    });
    return this.queue;
  }

  recordRagToolCallingProbe(record: RagToolCallingProbeLogRecord): Promise<void> {
    if (!this.settings.enabled || !this.settings.directory) return Promise.resolve();
    const write = this.queue.then(() => this.writeRagToolCallingProbe(record));
    this.queue = write.catch(() => {
      this.firstError ??= 'Method-generation log write failed.';
    });
    return this.queue;
  }

  recordWaveSummary(record: MethodGenerationWaveSummaryLogRecord): Promise<void> {
    if (!this.settings.enabled || !this.settings.directory) return Promise.resolve();
    const write = this.queue.then(() => this.writeWaveSummary(record));
    this.queue = write.catch(() => {
      this.firstError ??= 'Method-generation log write failed.';
    });
    return this.queue;
  }

  recordMavenBatch(record: MavenBatchLogRecord): Promise<void> {
    if (!this.settings.enabled || !this.settings.directory) return Promise.resolve();
    const write = this.queue.then(() => this.writeMavenBatch(record));
    this.queue = write.catch(() => {
      this.firstError ??= 'Method-generation log write failed.';
    });
    return this.queue;
  }

  async finish(): Promise<string | null> {
    await this.queue;
    this.queue = Promise.resolve();
    this.callDirectories.clear();
    this.callLabels.clear();
    this.generationCallCounts.clear();
    this.settings = { enabled: false };
    const error = this.firstError;
    this.firstError = null;
    return error;
  }

  private async write(
    record: MethodGenerationLogRecord,
    modelCall: MethodGenerationModelCall
  ): Promise<void> {
    const callLabel = this.callLabel(record, modelCall);
    const directory = await this.callDirectory(record, modelCall, callLabel);
    const filePrefix = [
      formatFileTimestamp(new Date(modelCall.startedAt)),
      callLabel,
      accessCategoryLabel(record.modifiers)
    ].join('_');
    if (modelCall.phase === 'started') {
      await Promise.all([
        fs.writeFile(
          join(directory, `${filePrefix}_01-系统提示词.md`),
          redact(modelCall.systemPrompt ?? ''),
          'utf8'
        ),
        fs.writeFile(
          join(directory, `${filePrefix}_02-完整方法与必要分析信息.md`),
          redact(modelCall.userPrompt ?? ''),
          'utf8'
        )
      ]);
    } else if (modelCall.phase === 'completed'
      || modelCall.phase === 'failed'
      || modelCall.phase === 'stopped') {
      let sequence = 3;
      for (const [index, trace] of (modelCall.requestTraces ?? []).entries()) {
        await fs.writeFile(
          join(
            directory,
            `${filePrefix}_${twoDigits(sequence)}-模型请求-${twoDigits(index + 1)}.json`
          ),
          redact(trace),
          'utf8'
        );
        sequence += 1;
      }
      for (const exchange of modelCall.toolExchanges ?? []) {
        const identity = toolExchangeIdentity(record, modelCall, exchange);
        await fs.writeFile(
          join(
            directory,
            `${filePrefix}_${twoDigits(sequence)}-工具调用-${twoDigits(exchange.sequence)}-输入.json`
          ),
          redactedJson({
            ...identity,
            toolName: exchange.toolName,
            modelRequestSequence: exchange.modelRequestSequence,
            rawArguments: exchange.rawArguments,
            validatedInput: exchange.validatedInput,
            startedAt: exchange.startedAt
          }),
          'utf8'
        );
        sequence += 1;
        await fs.writeFile(
          join(
            directory,
            `${filePrefix}_${twoDigits(sequence)}-工具调用-${twoDigits(exchange.sequence)}-输出.json`
          ),
          redactedJson({
            ...identity,
            includedInModelRequestSequence: exchange.includedInModelRequestSequence,
            status: exchange.status,
            toolMessage: exchange.toolMessage,
            completedAt: exchange.completedAt,
            durationMs: exchange.durationMs,
            cacheHit: exchange.cacheHit,
            physicalAttempts: exchange.physicalAttempts,
            evidenceStatus: exchange.evidenceStatus,
            consecutiveNoNewEvidence: exchange.consecutiveNoNewEvidence,
            forcedFinalOutput: exchange.forcedFinalOutput
          }),
          'utf8'
        );
        sequence += 1;
      }
      await fs.writeFile(
        join(directory, `${filePrefix}_${twoDigits(sequence)}-模型原始输出.java`),
        redact(modelCall.rawOutput ?? ''),
        'utf8'
      );
      sequence += 1;
      if (modelCall.processedOutput !== null) {
        await fs.writeFile(
          join(directory, `${filePrefix}_${twoDigits(sequence)}-Maven候选代码.java`),
          redact(modelCall.processedOutput),
          'utf8'
        );
      }
    }
    await fs.writeFile(
      join(directory, `${filePrefix}_调用信息.json`),
      JSON.stringify(metadata(record, modelCall), null, 2),
      'utf8'
    );
  }

  private async writeWaveSummary(
    record: MethodGenerationWaveSummaryLogRecord
  ): Promise<void> {
    const root = this.settings.directory;
    if (!root) throw new Error('Method-generation logging is not configured.');
    const occurredAt = parseLogTimestamp(record.occurredAt, 'Wave summary');
    const dateDirectory = join(root, formatDate(occurredAt));
    await fs.mkdir(dateDirectory, { recursive: true });
    const fileName = [
      formatTime(occurredAt),
      safePathSegment(record.className),
      safePathSegment(record.methodName),
      `Wave${record.waveIndex}`,
      '汇总',
      record.waveId.slice(0, 8)
    ].join('_') + '.json';
    await fs.writeFile(
      join(dateDirectory, fileName),
      redactedJson({
        ...record,
        selectedScenarioIds: [...record.selectedScenarioIds],
        skippedScenarioIds: [...record.skippedScenarioIds],
        parts: [...record.parts]
          .sort((left, right) => left.partIndex - right.partIndex)
          .map((part) => ({ ...part, scenarioIds: [...part.scenarioIds] }))
      }),
      'utf8'
    );
  }

  private async writeMavenBatch(record: MavenBatchLogRecord): Promise<void> {
    const root = this.settings.directory;
    if (!root) throw new Error('Method-generation logging is not configured.');
    const startedAt = parseLogTimestamp(record.trace.startedAt, 'Maven batch');
    const dateDirectory = join(root, formatDate(startedAt));
    await fs.mkdir(dateDirectory, { recursive: true });
    const fileName = [
      formatTime(startedAt),
      safePathSegment(record.className),
      safePathSegment(record.methodName),
      `Wave${record.waveIndex}`,
      'Maven批次',
      record.trace.mavenBatchId.slice(0, 8)
    ].join('_') + '.json';
    await fs.writeFile(join(dateDirectory, fileName), redactedJson(record), 'utf8');
  }

  private async writeRagToolCallingProbe(
    record: RagToolCallingProbeLogRecord
  ): Promise<void> {
    const root = this.settings.directory;
    if (!root) throw new Error('Method-generation logging is not configured.');
    const occurredAt = new Date(record.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error('RAG tool probe log timestamp is invalid.');
    }
    const directory = join(
      root,
      formatDate(occurredAt),
      [
        formatTime(occurredAt),
        safePathSegment(record.className),
        'RAG工具能力检测',
        record.probe.cacheHit ? '缓存' : '实时',
        record.probe.cacheKeyDigest.slice(0, 8)
      ].join('_')
    );
    await fs.mkdir(directory, { recursive: true });
    const trace = record.probe.trace;
    if (trace) {
      await fs.writeFile(
        join(directory, '01-探针请求.json'),
        redactedJson(trace.request),
        'utf8'
      );
      if (trace.toolExchange) {
        await fs.writeFile(
          join(directory, '02-工具调用-输入.json'),
          redactedJson({
            toolCallId: trace.toolExchange.toolCallId,
            toolName: trace.toolExchange.toolName,
            arguments: trace.toolExchange.arguments
          }),
          'utf8'
        );
        await fs.writeFile(
          join(directory, '03-工具调用-输出.json'),
          redactedJson(trace.toolExchange.toolMessage),
          'utf8'
        );
      }
      if (trace.finalConfirmation) {
        await fs.writeFile(
          join(directory, '04-最终确认.json'),
          redactedJson(trace.finalConfirmation),
          'utf8'
        );
      }
    }
    await fs.writeFile(
      join(directory, '调用信息.json'),
      redactedJson({
        taskId: record.taskId,
        className: record.className,
        classFqn: record.qualifiedClassName,
        modelName: record.modelName,
        occurredAt: record.occurredAt,
        supported: record.probe.supported,
        cacheHit: record.probe.cacheHit,
        cacheKeyDigest: record.probe.cacheKeyDigest,
        outcome: trace?.outcome ?? null
      }),
      'utf8'
    );
  }

  private async callDirectory(
    record: MethodGenerationLogRecord,
    modelCall: MethodGenerationModelCall,
    callLabel: string
  ): Promise<string> {
    const existing = this.callDirectories.get(modelCall.callId);
    if (existing) return existing;
    const root = this.settings.directory;
    if (!root) throw new Error('Method-generation logging is not configured.');
    const startedAt = new Date(modelCall.startedAt);
    if (Number.isNaN(startedAt.getTime())) {
      throw new Error('Method-generation log timestamp is invalid.');
    }
    const dateDirectory = join(root, formatDate(startedAt));
    const directoryName = [
      formatTime(startedAt),
      safePathSegment(record.className),
      safePathSegment(record.methodName),
      callLabel,
      `候选v${modelCall.candidateVersion}`,
      modelCall.callId.slice(0, 8)
    ].join('_');
    const directory = join(
      dateDirectory,
      directoryName
    );
    await fs.mkdir(directory, { recursive: true });
    this.callDirectories.set(modelCall.callId, directory);
    return directory;
  }

  private callLabel(
    record: MethodGenerationLogRecord,
    modelCall: MethodGenerationModelCall
  ): string {
    const existing = this.callLabels.get(modelCall.callId);
    if (existing) return existing;
    let label: string;
    if (modelCall.callKind === 'repair') {
      label = `第${record.batchIndex}批第${modelCall.repairAttempt}次修复`;
    } else if (
      record.waveIndex !== undefined
      && record.partIndex !== undefined
      && record.partBatchId !== undefined
    ) {
      const identity = [
        record.taskId,
        record.methodId,
        record.waveIndex,
        record.partIndex,
        record.partBatchId
      ].join('\u0000');
      const retry = this.generationCallCounts.get(identity) ?? 0;
      this.generationCallCounts.set(identity, retry + 1);
      label = retry === 0
        ? `Wave${record.waveIndex}_Part${record.partIndex}_首次生成`
        : `Wave${record.waveIndex}_Part${record.partIndex}_第${retry}次生成重试`;
    } else {
      const identity = [
        modelCall.sessionId,
        modelCall.methodId,
        modelCall.batchId
      ].join('\u0000');
      const retry = this.generationCallCounts.get(identity) ?? 0;
      this.generationCallCounts.set(identity, retry + 1);
      label = retry === 0
        ? `第${record.batchIndex}批生成`
        : `第${record.batchIndex}批第${retry}次生成重试`;
    }
    this.callLabels.set(modelCall.callId, label);
    return label;
  }
}

function validateIdentity(
  record: MethodGenerationLogRecord,
  modelCall: MethodGenerationModelCall
): void {
  if (
    record.methodId !== modelCall.methodId
    || record.batchId !== modelCall.batchId
    || record.batchIndex !== modelCall.batchIndex
    || record.event.sessionId !== modelCall.sessionId
  ) {
    throw new Error('Method-generation log identity is inconsistent.');
  }
  const waveFields = [record.waveIndex, record.partIndex, record.partBatchId, record.scenarioIds];
  const presentWaveFields = waveFields.filter((value) => value !== undefined).length;
  if (presentWaveFields !== 0 && presentWaveFields !== waveFields.length) {
    throw new Error('Method-generation Wave Part log identity is incomplete.');
  }
  if (presentWaveFields > 0 && (
    !Number.isInteger(record.waveIndex)
    || (record.waveIndex ?? 0) < 1
    || !Number.isInteger(record.partIndex)
    || (record.partIndex ?? 0) < 1
    || record.partBatchId !== record.batchId
    || (record.scenarioIds?.length ?? 0) < 1
  )) {
    throw new Error('Method-generation Wave Part log identity is invalid.');
  }
}

function metadata(
  record: MethodGenerationLogRecord,
  modelCall: MethodGenerationModelCall
): Record<string, unknown> {
  return {
    taskId: record.taskId,
    className: record.className,
    qualifiedClassName: record.qualifiedClassName,
    methodName: record.methodName,
    descriptor: record.descriptor,
    displaySignature: record.displaySignature,
    modifiers: [...record.modifiers],
    sessionId: modelCall.sessionId,
    callId: modelCall.callId,
    parentCallId: modelCall.parentCallId,
    phase: modelCall.phase,
    callKind: modelCall.callKind,
    methodId: modelCall.methodId,
    batchId: modelCall.batchId,
    batchIndex: modelCall.batchIndex,
    ...(record.waveIndex === undefined ? {} : {
      waveIndex: record.waveIndex,
      partIndex: record.partIndex,
      partBatchId: record.partBatchId,
      scenarioIds: [...(record.scenarioIds ?? [])]
    }),
    repairAttempt: modelCall.repairAttempt,
    candidateVersion: modelCall.candidateVersion,
    modelName: modelCall.modelName,
    startedAt: modelCall.startedAt,
    occurredAt: modelCall.occurredAt,
    processingValid: modelCall.processingValid,
    processingError: modelCall.processingError ?? null,
    usage: modelCall.usage,
    errorCode: modelCall.errorCode,
    statusCode: modelCall.statusCode,
    errorType: modelCall.errorType,
    providerCode: modelCall.providerCode,
    truncated: modelCall.truncated,
    requestTraceCount: modelCall.requestTraces?.length ?? 0,
    toolExchangeCount: modelCall.toolExchanges?.length ?? 0,
    toolExchanges: (modelCall.toolExchanges ?? []).map((exchange) => ({
      sequence: exchange.sequence,
      toolCallId: exchange.toolCallId,
      toolName: exchange.toolName,
      modelRequestSequence: exchange.modelRequestSequence,
      includedInModelRequestSequence: exchange.includedInModelRequestSequence,
      status: exchange.status,
      startedAt: exchange.startedAt,
      completedAt: exchange.completedAt,
      durationMs: exchange.durationMs,
      cacheHit: exchange.cacheHit,
      physicalAttemptCount: exchange.physicalAttempts.length,
      evidenceStatus: exchange.evidenceStatus,
      consecutiveNoNewEvidence: exchange.consecutiveNoNewEvidence,
      forcedFinalOutput: exchange.forcedFinalOutput
    }))
  };
}

function toolExchangeIdentity(
  record: MethodGenerationLogRecord,
  modelCall: MethodGenerationModelCall,
  exchange: NonNullable<MethodGenerationModelCall['toolExchanges']>[number]
): Record<string, unknown> {
  return {
    classFqn: record.qualifiedClassName,
    methodKey: `${record.qualifiedClassName}#${record.methodName}${record.descriptor}`,
    repairAttempt: modelCall.repairAttempt,
    sequence: exchange.sequence,
    toolCallId: exchange.toolCallId
  };
}

function boundedTelemetry(
  record: MethodRepairTelemetryRecord
): MethodRepairTelemetryRecord {
  const boundedStrings = (
    values: readonly string[],
    maximum: number,
    itemMaximum: number
  ): string[] => [...new Set(values.map((value) => sanitizePublicText(value).trim())
    .filter(Boolean))].slice(0, maximum).map((value) => value.slice(0, itemMaximum));
  return {
    ...record,
    taskId: sanitizePublicText(record.taskId).slice(0, 128),
    className: sanitizePublicText(record.className).slice(0, 512),
    qualifiedClassName: sanitizePublicText(record.qualifiedClassName).slice(0, 2_000),
    methodId: sanitizePublicText(record.methodId).slice(0, 4_096),
    methodName: sanitizePublicText(record.methodName).slice(0, 1_024),
    descriptor: sanitizePublicText(record.descriptor).slice(0, 2_000),
    batchId: sanitizePublicText(record.batchId).slice(0, 4_096),
    candidateId: sanitizePublicText(record.candidateId).slice(0, 128),
    candidateSha256: sanitizePublicText(record.candidateSha256).slice(0, 64),
    compilerCategories: boundedStrings(record.compilerCategories, 32, 128),
    scopeRejectionCodes: boundedStrings(record.scopeRejectionCodes, 32, 128),
    occurredAt: sanitizePublicText(record.occurredAt).slice(0, 64)
  };
}

function redact(value: string): string {
  const sanitized = sanitizePublicText(value);
  if (!/(?:embedding|vector)/i.test(sanitized)) return sanitized;
  try {
    const parsed: unknown = JSON.parse(sanitized);
    if (containsEmbeddingVectorKey(parsed)) {
      return JSON.stringify(redactedJsonValue(parsed));
    }
  } catch {
    // Some tool payloads are fragments rather than complete JSON. Redact the
    // common inline numeric-array form without rewriting the surrounding text.
  }
  return sanitized.replace(
    /(["']?(?:embedding(?:[_-]?vector)?s?|(?:dense|sparse)[_-]?vector|vectors?)["']?\s*[:=]\s*)\[[^\]\r\n]*\]/gi,
    '$1[REDACTED]'
  );
}

function redactedJson(value: unknown): string {
  return JSON.stringify(redactedJsonValue(value), null, 2);
}

function redactedJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactedJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, isSecretJsonKey(key) || isEmbeddingVectorKey(key)
        ? '[REDACTED]'
        : redactedJsonValue(item)]
    )));
  }
  return value;
}

function parseLogTimestamp(value: string, label: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} log timestamp is invalid.`);
  }
  return parsed;
}

function isSecretJsonKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return [
    'authorization',
    'proxyauthorization',
    'password',
    'passwd',
    'accesstoken',
    'refreshtoken',
    'clientsecret',
    'secretaccesskey',
    'accesskey',
    'privatekey'
  ].includes(normalized)
    || normalized.endsWith('apikey');
}

function isEmbeddingVectorKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return [
    'embedding',
    'embeddings',
    'embeddingvector',
    'embeddingvectors',
    'vector',
    'vectors',
    'densevector',
    'sparsevector'
  ].includes(normalized);
}

function containsEmbeddingVectorKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEmbeddingVectorKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    isEmbeddingVectorKey(key) || containsEmbeddingVectorKey(item)
  ));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')
  ].join('-');
}

function formatTime(value: Date): string {
  return [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
    `${String(value.getSeconds()).padStart(2, '0')}.${String(
      value.getMilliseconds()
    ).padStart(3, '0')}`
  ].join('-');
}

function formatFileTimestamp(value: Date): string {
  return [
    String(value.getFullYear()).slice(-2),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')
  ].join('-') + '_' + [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
    String(value.getSeconds()).padStart(2, '0')
  ].join('-');
}

function accessCategoryLabel(modifiers: readonly string[]): string {
  if (modifiers.includes('public')) return '公开方法';
  if (modifiers.includes('protected')) return '受保护方法';
  if (modifiers.includes('private')) return '私有方法';
  return '包级私有方法';
}

function safePathSegment(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return (normalized || '未知').slice(0, 80);
}

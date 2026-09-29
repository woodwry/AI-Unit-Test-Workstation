import { AtomicJsonStore } from './atomic-json-store.ts';

const MAX_MODULES = 128;
const MAX_CLASSES_PER_MODULE = 512;
const MAX_KEY_LENGTH = 4_096;
const MAX_DIAGNOSTIC_LENGTH = 4_096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ModulePreloadState = 'IDLE' | 'RUNNING' | 'READY' | 'FAILED';

export type PublicMavenFailureDiagnostic = {
  command: string;
  exitCode: number | null;
  summary: string;
  repairInstruction: string;
};

export type ClassReportPair = {
  qualifiedClassName: string;
  fingerprint: string;
  executionDataPath: string;
  reportPairId: string;
  reportPath: string;
  branchSnapshotPath: string;
  generatedAt: string;
};

export type ClassPreloadFailure = {
  state: 'PRELOAD_FAILED';
  fingerprint: string;
  diagnostic: string;
  updatedAt: string;
};

export type ModulePreloadSnapshot = {
  moduleKey: string;
  moduleName: string;
  modulePath: string;
  state: ModulePreloadState;
  fingerprint: string | null;
  executionDataPath: string | null;
  classReportPairs: Record<string, ClassReportPair>;
  classPreloadFailures: Record<string, ClassPreloadFailure>;
  diagnostic: PublicMavenFailureDiagnostic | null;
  updatedAt: string;
};

type ModulePreloadCacheFile = {
  version: 1;
  modules: Record<string, ModulePreloadSnapshot>;
};

export class ModulePreloadCacheStore {
  private readonly store: AtomicJsonStore<ModulePreloadCacheFile>;

  constructor(storagePath: string) {
    this.store = new AtomicJsonStore(
      storagePath,
      validateCacheFile,
      () => ({ version: 1, modules: {} })
    );
  }

  async get(moduleKey: string): Promise<ModulePreloadSnapshot | null> {
    const cache = await this.store.read();
    return cache.modules[moduleKey] ?? null;
  }

  async set(snapshot: ModulePreloadSnapshot): Promise<ModulePreloadSnapshot> {
    const validated = validateSnapshot(snapshot);
    await this.store.update((cache) => {
      const modules = { ...cache.modules, [validated.moduleKey]: validated };
      const entries = Object.entries(modules);
      if (entries.length > MAX_MODULES) {
        entries.sort((left, right) => left[1].updatedAt.localeCompare(right[1].updatedAt));
        while (entries.length > MAX_MODULES) entries.shift();
      }
      return { version: 1, modules: Object.fromEntries(entries) };
    });
    return validated;
  }

  async remove(moduleKey: string): Promise<void> {
    await this.store.update((cache) => {
      const modules = { ...cache.modules };
      delete modules[moduleKey];
      return { version: 1, modules };
    });
  }

  async flush(): Promise<void> {
    await this.store.read();
  }
}

function validateCacheFile(value: unknown): ModulePreloadCacheFile {
  const record = requireRecord(value, '模块预加载缓存');
  requireExactFields(record, ['version', 'modules'], '模块预加载缓存');
  if (record.version !== 1) throw new TypeError('模块预加载缓存版本无效。');
  const modules = requireRecord(record.modules, '模块预加载缓存 modules');
  const entries = Object.entries(modules);
  if (entries.length > MAX_MODULES) throw new TypeError('模块预加载缓存超过数量上限。');
  return {
    version: 1,
    modules: Object.fromEntries(entries.map(([moduleKey, snapshot]) => {
      const validated = validateSnapshot(snapshot);
      if (moduleKey !== validated.moduleKey) throw new TypeError('模块预加载缓存键不匹配。');
      return [moduleKey, validated];
    }))
  };
}

function validateSnapshot(value: unknown): ModulePreloadSnapshot {
  const record = requireRecord(value, '模块预加载快照');
  requireExactFields(record, [
    'moduleKey', 'moduleName', 'modulePath', 'state', 'fingerprint',
    'executionDataPath', 'classReportPairs', 'classPreloadFailures',
    'diagnostic', 'updatedAt'
  ], '模块预加载快照');
  const moduleKey = boundedText(record.moduleKey, '模块键');
  const moduleName = boundedText(record.moduleName, '模块名称');
  const modulePath = boundedText(record.modulePath, '模块路径');
  const state = record.state;
  if (state !== 'IDLE' && state !== 'RUNNING' && state !== 'READY' && state !== 'FAILED') {
    throw new TypeError('模块预加载状态无效。');
  }
  const fingerprint = record.fingerprint === null
    ? null
    : sha256Text(record.fingerprint, '模块指纹');
  const executionDataPath = record.executionDataPath === null
    ? null
    : boundedText(record.executionDataPath, 'JaCoCo exec 路径');
  const classReportPairs = validateClassPairs(record.classReportPairs, executionDataPath);
  const classPreloadFailures = validateClassFailures(record.classPreloadFailures);
  const diagnostic = record.diagnostic === null
    ? null
    : validateDiagnostic(record.diagnostic);
  const updatedAt = timestamp(record.updatedAt, '模块更新时间');

  if (state === 'IDLE' && (executionDataPath !== null || diagnostic !== null)) {
    throw new TypeError('IDLE 模块快照包含运行产物。');
  }
  if (state === 'RUNNING' && (!fingerprint || executionDataPath !== null || diagnostic !== null)) {
    throw new TypeError('RUNNING 模块快照无效。');
  }
  if (state === 'READY' && (!fingerprint || !executionDataPath || diagnostic !== null)) {
    throw new TypeError('READY 模块快照缺少有效 exec。');
  }
  if (state === 'FAILED' && (!fingerprint || executionDataPath !== null || !diagnostic)) {
    throw new TypeError('FAILED 模块快照无效。');
  }
  if (state !== 'READY' && (Object.keys(classReportPairs).length > 0 || Object.keys(classPreloadFailures).length > 0)) {
    throw new TypeError('非 READY 模块不能保留类报告。');
  }
  return {
    moduleKey,
    moduleName,
    modulePath,
    state,
    fingerprint,
    executionDataPath,
    classReportPairs,
    classPreloadFailures,
    diagnostic,
    updatedAt
  };
}

function validateClassPairs(
  value: unknown,
  legacyExecutionDataPath: string | null
): Record<string, ClassReportPair> {
  const record = requireRecord(value, '类报告缓存');
  const entries = Object.entries(record);
  if (entries.length > MAX_CLASSES_PER_MODULE) throw new TypeError('类报告缓存超过数量上限。');
  return Object.fromEntries(entries.map(([key, value]) => {
    const pair = requireRecord(value, '类报告文件对');
    if (!Object.hasOwn(pair, 'executionDataPath') && legacyExecutionDataPath) {
      pair.executionDataPath = legacyExecutionDataPath;
    }
    requireExactFields(pair, [
      'qualifiedClassName', 'fingerprint', 'executionDataPath', 'reportPairId', 'reportPath',
      'branchSnapshotPath', 'generatedAt'
    ], '类报告文件对');
    const qualifiedClassName = boundedText(pair.qualifiedClassName, '限定类名');
    if (key !== qualifiedClassName) throw new TypeError('类报告缓存键不匹配。');
    return [key, {
      qualifiedClassName,
      fingerprint: sha256Text(pair.fingerprint, '类报告指纹'),
      executionDataPath: boundedText(pair.executionDataPath, '类报告 JaCoCo exec 路径'),
      reportPairId: sha256Text(pair.reportPairId, '类报告 pairId'),
      reportPath: boundedText(pair.reportPath, '类报告 XML 路径'),
      branchSnapshotPath: boundedText(pair.branchSnapshotPath, '类报告分支快照路径'),
      generatedAt: timestamp(pair.generatedAt, '类报告生成时间')
    }];
  }));
}

function validateClassFailures(value: unknown): Record<string, ClassPreloadFailure> {
  const record = requireRecord(value, '类预加载失败缓存');
  const entries = Object.entries(record);
  if (entries.length > MAX_CLASSES_PER_MODULE) throw new TypeError('类预加载失败缓存超过数量上限。');
  return Object.fromEntries(entries.map(([key, value]) => {
    boundedText(key, '限定类名');
    const failure = requireRecord(value, '类预加载失败');
    requireExactFields(failure, ['state', 'fingerprint', 'diagnostic', 'updatedAt'], '类预加载失败');
    if (failure.state !== 'PRELOAD_FAILED') throw new TypeError('类预加载失败状态无效。');
    return [key, {
      state: 'PRELOAD_FAILED' as const,
      fingerprint: sha256Text(failure.fingerprint, '类预加载失败指纹'),
      diagnostic: diagnosticText(failure.diagnostic, '类预加载失败诊断'),
      updatedAt: timestamp(failure.updatedAt, '类预加载失败时间')
    }];
  }));
}

function validateDiagnostic(value: unknown): PublicMavenFailureDiagnostic {
  const record = requireRecord(value, 'Maven 公开诊断');
  requireExactFields(record, ['command', 'exitCode', 'summary', 'repairInstruction'], 'Maven 公开诊断');
  if (record.exitCode !== null && (!Number.isInteger(record.exitCode) || Math.abs(record.exitCode as number) > 2_147_483_647)) {
    throw new TypeError('Maven 公开诊断退出码无效。');
  }
  return {
    command: diagnosticText(record.command, 'Maven 公开诊断命令'),
    exitCode: record.exitCode as number | null,
    summary: diagnosticText(record.summary, 'Maven 公开诊断摘要'),
    repairInstruction: diagnosticText(record.repairInstruction, 'Maven 公开诊断修复提示')
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new TypeError(`${label}包含不允许的字段：${unknown}`);
  const missing = fields.find((key) => !(key in record));
  if (missing) throw new TypeError(`${label}缺少字段：${missing}`);
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_KEY_LENGTH) {
    throw new TypeError(`${label}无效。`);
  }
  return value;
}

function diagnosticText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DIAGNOSTIC_LENGTH) {
    throw new TypeError(`${label}诊断无效。`);
  }
  return value;
}

function sha256Text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label}无效。`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label}无效。`);
  return text;
}

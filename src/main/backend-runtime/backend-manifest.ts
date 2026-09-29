export type BackendManifestFile = Readonly<{
  path: string;
  size: number;
  sha256: string;
}>;

export type BackendManifestEntrypoint = BackendManifestFile;

export type BackendManifestV1 = Readonly<{
  schemaVersion: 1;
  product: Readonly<{
    version: string;
    platform: 'win32';
    arch: 'x64';
  }>;
  javaRuntime: Readonly<{
    distribution: 'Eclipse Temurin';
    vendor: 'Eclipse Adoptium';
    version: '21.0.11+10';
    architecture: 'x86_64';
  }>;
  components: Readonly<{
    agentService: Readonly<{ version: string }>;
    javaAnalyzer: Readonly<{ version: string }>;
  }>;
  entrypoints: Readonly<{
    agentService: BackendManifestEntrypoint;
    javaAnalyzer: BackendManifestEntrypoint;
    javaRuntime: BackendManifestEntrypoint;
  }>;
  files: readonly BackendManifestFile[];
}>;

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENTRYPOINT_PATHS = Object.freeze({
  agentService: 'backend/agent-service/agent-service.exe',
  javaAnalyzer: 'backend/java-analyzer/java-analyzer.jar',
  javaRuntime: 'runtimes/java-21/bin/javaw.exe'
});

function manifestError(field: string): never {
  // 不把 manifest 原值拼入错误，避免损坏文件把意外内容带入产品日志。
  throw new TypeError(`后端资源清单无效：${field}`);
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return manifestError(field);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return manifestError(`${field} 字段集合`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)) {
    return manifestError(`${field} 字段描述符`);
  }
  return record;
}

function version(value: unknown, field: string): string {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) manifestError(field);
  return value;
}

function safeRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.startsWith('/') ||
    /^[a-z]:/i.test(value) ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    manifestError(field);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) manifestError(field);
  return value;
}

function fileSize(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) manifestError(field);
  return Number(value);
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) manifestError(field);
  return value;
}

function parseFile(value: unknown, field: string): BackendManifestFile {
  const record = exactRecord(value, ['path', 'size', 'sha256'], field);
  return Object.freeze({
    path: safeRelativePath(record.path, `${field}.path`),
    size: fileSize(record.size, `${field}.size`),
    sha256: sha256(record.sha256, `${field}.sha256`)
  });
}

function exactString<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) manifestError(field);
  return expected;
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseEntrypoint(
  value: unknown,
  key: keyof typeof ENTRYPOINT_PATHS
): BackendManifestEntrypoint {
  const entrypoint = parseFile(value, `entrypoints.${key}`);
  if (entrypoint.path !== ENTRYPOINT_PATHS[key] || entrypoint.size <= 0) {
    manifestError(`entrypoints.${key}`);
  }
  return entrypoint;
}

/**
 * 严格解析 staging 生成的 backend-manifest v1。文件列表必须按路径排序，且在
 * Windows 大小写不敏感语义下也不能重复；三个入口的 size/hash 必须与 files 一致。
 */
export function parseBackendManifest(value: unknown): BackendManifestV1 {
  const root = exactRecord(
    value,
    ['schemaVersion', 'product', 'javaRuntime', 'components', 'entrypoints', 'files'],
    'root'
  );
  if (root.schemaVersion !== 1) manifestError('schemaVersion');

  const product = exactRecord(root.product, ['version', 'platform', 'arch'], 'product');
  const javaRuntime = exactRecord(
    root.javaRuntime,
    ['distribution', 'vendor', 'version', 'architecture'],
    'javaRuntime'
  );
  const components = exactRecord(root.components, ['agentService', 'javaAnalyzer'], 'components');
  const agentComponent = exactRecord(components.agentService, ['version'], 'components.agentService');
  const analyzerComponent = exactRecord(components.javaAnalyzer, ['version'], 'components.javaAnalyzer');
  const entrypoints = exactRecord(
    root.entrypoints,
    ['agentService', 'javaAnalyzer', 'javaRuntime'],
    'entrypoints'
  );

  if (!Array.isArray(root.files) || root.files.length < 3) manifestError('files');
  const files = root.files.map((item, index) => parseFile(item, `files[${index}]`));
  const paths = files.map((file) => file.path);
  for (let index = 1; index < paths.length; index += 1) {
    if (comparePath(paths[index - 1], paths[index]) >= 0) manifestError('files 排序或重复');
  }
  const caseInsensitivePaths = new Set(paths.map((path) => path.toLowerCase()));
  if (caseInsensitivePaths.size !== paths.length) manifestError('files Windows 路径重复');
  if (caseInsensitivePaths.has('backend-manifest.json')) manifestError('files 自引用');

  const parsedEntrypoints = Object.freeze({
    agentService: parseEntrypoint(entrypoints.agentService, 'agentService'),
    javaAnalyzer: parseEntrypoint(entrypoints.javaAnalyzer, 'javaAnalyzer'),
    javaRuntime: parseEntrypoint(entrypoints.javaRuntime, 'javaRuntime')
  });
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  for (const entrypoint of Object.values(parsedEntrypoints)) {
    const listedFile = fileByPath.get(entrypoint.path);
    if (
      !listedFile ||
      listedFile.size !== entrypoint.size ||
      listedFile.sha256 !== entrypoint.sha256
    ) {
      manifestError('entrypoints 与 files 不一致');
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    product: Object.freeze({
      version: version(product.version, 'product.version'),
      platform: exactString(product.platform, 'win32', 'product.platform'),
      arch: exactString(product.arch, 'x64', 'product.arch')
    }),
    javaRuntime: Object.freeze({
      distribution: exactString(javaRuntime.distribution, 'Eclipse Temurin', 'javaRuntime.distribution'),
      vendor: exactString(javaRuntime.vendor, 'Eclipse Adoptium', 'javaRuntime.vendor'),
      version: exactString(javaRuntime.version, '21.0.11+10', 'javaRuntime.version'),
      architecture: exactString(javaRuntime.architecture, 'x86_64', 'javaRuntime.architecture')
    }),
    components: Object.freeze({
      agentService: Object.freeze({
        version: version(agentComponent.version, 'components.agentService.version')
      }),
      javaAnalyzer: Object.freeze({
        version: version(analyzerComponent.version, 'components.javaAnalyzer.version')
      })
    }),
    entrypoints: parsedEntrypoints,
    files: Object.freeze(files)
  });
}

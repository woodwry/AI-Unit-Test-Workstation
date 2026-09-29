export type RuntimeServiceId = 'java-analyzer' | 'agent-service';

export type RuntimeServiceReleaseDefinition = {
  id: RuntimeServiceId;
  version: string;
  host: '127.0.0.1';
  port: 0;
  executableRelativePath: string;
  arguments: readonly string[];
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
};

export type WindowsReleaseContractV1 = {
  schemaVersion: 1;
  product: {
    id: 'ai-unit-test-workstation';
    version: string;
    appId: string;
    productName: string;
    platform: 'win32';
    arch: 'x64';
    minimumWindowsVersion: string;
  };
  toolchain: Record<
    'node' | 'npm' | 'python' | 'pipTools' | 'pyinstaller' | 'maven' |
    'buildJdk' | 'javaRuntimeVendor' | 'javaRuntimeVersion',
    string
  >;
  runtime: {
    protocol: 1;
    mode: 'packaged';
    host: '127.0.0.1';
    port: 0;
    authorizationScheme: 'Bearer';
    paths: { live: '/api/internal/live'; ready: '/api/internal/ready' };
    environment: Record<
      'protocol' | 'mode' | 'service' | 'instanceId' | 'parentPid' |
      'accessToken' | 'analyzerBaseUrl' | 'analyzerAccessToken' |
      'serverHost' | 'serverPort' | 'serverReload',
      string
    >;
  };
  services: readonly RuntimeServiceReleaseDefinition[];
  resources: {
    backendManifestRelativePath: string;
    licensesRelativePath: string;
  };
  installer: {
    kind: 'nsis';
    artifactName: string;
    oneClick: false;
    perMachine: false;
    allowToChangeInstallationDirectory: true;
    createDesktopShortcut: true;
    createStartMenuShortcut: true;
  };
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, expected: string, name: string): string {
  if (value !== expected) throw new TypeError(`${name} must equal ${expected}`);
  return expected;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function exactBoolean<T extends boolean>(value: unknown, expected: T, name: string): T {
  if (value !== expected) throw new TypeError(`${name} must equal ${expected}`);
  return expected;
}

function relativeResourcePath(value: unknown, name: string): string {
  // 统一斜杠后再校验，避免 Windows 路径形式绕过相对路径约束。
  const path = stringValue(value, name).replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`${name} must be a safe relative path`);
  }
  return path;
}

function environmentVariable(value: unknown, name: string): string {
  const variable = stringValue(value, name);
  if (!/^[A-Z][A-Z0-9_]+$/.test(variable)) {
    throw new TypeError(`${name} must be an environment variable name`);
  }
  return variable;
}

function exactEnvironmentVariable(value: unknown, expected: string, name: string): string {
  const variable = environmentVariable(value, name);
  if (variable !== expected) throw new TypeError(`${name} must equal ${expected}`);
  return expected;
}

function parseService(value: unknown, index: number): RuntimeServiceReleaseDefinition {
  const item = record(value, `services[${index}]`);
  const id = exactString(
    item.id,
    index === 0 ? 'java-analyzer' : 'agent-service',
    `services[${index}].id`
  ) as RuntimeServiceId;
  if (item.port !== 0) throw new TypeError(`services[${index}].port must equal 0`);
  if (!Array.isArray(item.arguments) || !item.arguments.every((arg) => typeof arg === 'string')) {
    throw new TypeError(`services[${index}].arguments must be a string array`);
  }
  return {
    id,
    version: stringValue(item.version, `services[${index}].version`),
    host: exactString(item.host, '127.0.0.1', `services[${index}].host`) as '127.0.0.1',
    port: 0,
    executableRelativePath: relativeResourcePath(
      item.executableRelativePath,
      `services[${index}].executableRelativePath`
    ),
    arguments: item.arguments as string[],
    startupTimeoutMs: positiveInteger(item.startupTimeoutMs, `services[${index}].startupTimeoutMs`),
    shutdownTimeoutMs: positiveInteger(item.shutdownTimeoutMs, `services[${index}].shutdownTimeoutMs`)
  };
}

export function parseWindowsReleaseContract(value: unknown): WindowsReleaseContractV1 {
  const root = record(value, 'release contract');
  if (root.schemaVersion !== 1) throw new TypeError('schemaVersion must equal 1');
  const product = record(root.product, 'product');
  const toolchain = record(root.toolchain, 'toolchain');
  const runtime = record(root.runtime, 'runtime');
  const paths = record(runtime.paths, 'runtime.paths');
  const environment = record(runtime.environment, 'runtime.environment');
  const resources = record(root.resources, 'resources');
  const installer = record(root.installer, 'installer');
  if (!Array.isArray(root.services) || root.services.length !== 2) {
    throw new TypeError('services must contain exactly two entries');
  }

  const environmentNames: WindowsReleaseContractV1['runtime']['environment'] = {
    protocol: exactEnvironmentVariable(
      environment.protocol,
      'AI_UNIT_TEST_RUNTIME_PROTOCOL',
      'runtime.environment.protocol'
    ),
    mode: exactEnvironmentVariable(
      environment.mode,
      'AI_UNIT_TEST_RUNTIME_MODE',
      'runtime.environment.mode'
    ),
    service: exactEnvironmentVariable(
      environment.service,
      'AI_UNIT_TEST_SERVICE',
      'runtime.environment.service'
    ),
    instanceId: exactEnvironmentVariable(
      environment.instanceId,
      'AI_UNIT_TEST_INSTANCE_ID',
      'runtime.environment.instanceId'
    ),
    parentPid: exactEnvironmentVariable(
      environment.parentPid,
      'AI_UNIT_TEST_PARENT_PID',
      'runtime.environment.parentPid'
    ),
    accessToken: exactEnvironmentVariable(
      environment.accessToken,
      'AI_UNIT_TEST_ACCESS_TOKEN',
      'runtime.environment.accessToken'
    ),
    analyzerBaseUrl: exactEnvironmentVariable(
      environment.analyzerBaseUrl,
      'AGENT_JAVA_ANALYZER_BASE_URL',
      'runtime.environment.analyzerBaseUrl'
    ),
    analyzerAccessToken: exactEnvironmentVariable(
      environment.analyzerAccessToken,
      'AGENT_JAVA_ANALYZER_ACCESS_TOKEN',
      'runtime.environment.analyzerAccessToken'
    ),
    serverHost: exactEnvironmentVariable(
      environment.serverHost,
      'AGENT_SERVER_HOST',
      'runtime.environment.serverHost'
    ),
    serverPort: exactEnvironmentVariable(
      environment.serverPort,
      'AGENT_SERVER_PORT',
      'runtime.environment.serverPort'
    ),
    serverReload: exactEnvironmentVariable(
      environment.serverReload,
      'AGENT_SERVER_RELOAD',
      'runtime.environment.serverReload'
    )
  };

  const parsedToolchain: WindowsReleaseContractV1['toolchain'] = {
    node: exactString(toolchain.node, '22.14.0', 'toolchain.node'),
    npm: exactString(toolchain.npm, '11.17.0', 'toolchain.npm'),
    python: exactString(toolchain.python, '3.11.9', 'toolchain.python'),
    pipTools: exactString(toolchain.pipTools, '7.5.2', 'toolchain.pipTools'),
    pyinstaller: exactString(toolchain.pyinstaller, '6.16.0', 'toolchain.pyinstaller'),
    maven: exactString(toolchain.maven, '3.9.9', 'toolchain.maven'),
    buildJdk: exactString(toolchain.buildJdk, '21.0.11+9', 'toolchain.buildJdk'),
    javaRuntimeVendor: exactString(
      toolchain.javaRuntimeVendor,
      'Eclipse Temurin',
      'toolchain.javaRuntimeVendor'
    ),
    javaRuntimeVersion: exactString(
      toolchain.javaRuntimeVersion,
      '21.0.11+10',
      'toolchain.javaRuntimeVersion'
    )
  };

  if (runtime.protocol !== 1) throw new TypeError('runtime.protocol must equal 1');
  if (runtime.port !== 0) throw new TypeError('runtime.port must equal 0');

  const parsedInstaller: WindowsReleaseContractV1['installer'] = {
    kind: exactString(installer.kind, 'nsis', 'installer.kind') as 'nsis',
    artifactName: exactString(
      installer.artifactName,
      'AI-Unit-Test-Workstation-Setup-${version}-${arch}.${ext}',
      'installer.artifactName'
    ),
    oneClick: exactBoolean(installer.oneClick, false, 'installer.oneClick'),
    perMachine: exactBoolean(installer.perMachine, false, 'installer.perMachine'),
    allowToChangeInstallationDirectory: exactBoolean(
      installer.allowToChangeInstallationDirectory,
      true,
      'installer.allowToChangeInstallationDirectory'
    ),
    createDesktopShortcut: exactBoolean(
      installer.createDesktopShortcut,
      true,
      'installer.createDesktopShortcut'
    ),
    createStartMenuShortcut: exactBoolean(
      installer.createStartMenuShortcut,
      true,
      'installer.createStartMenuShortcut'
    )
  };

  return {
    schemaVersion: 1,
    product: {
      id: exactString(product.id, 'ai-unit-test-workstation', 'product.id') as 'ai-unit-test-workstation',
      version: stringValue(product.version, 'product.version'),
      appId: stringValue(product.appId, 'product.appId'),
      productName: stringValue(product.productName, 'product.productName'),
      platform: exactString(product.platform, 'win32', 'product.platform') as 'win32',
      arch: exactString(product.arch, 'x64', 'product.arch') as 'x64',
      minimumWindowsVersion: stringValue(product.minimumWindowsVersion, 'product.minimumWindowsVersion')
    },
    toolchain: parsedToolchain,
    runtime: {
      protocol: 1,
      mode: exactString(runtime.mode, 'packaged', 'runtime.mode') as 'packaged',
      host: exactString(runtime.host, '127.0.0.1', 'runtime.host') as '127.0.0.1',
      port: 0,
      authorizationScheme: exactString(runtime.authorizationScheme, 'Bearer', 'runtime.authorizationScheme') as 'Bearer',
      paths: {
        live: exactString(paths.live, '/api/internal/live', 'runtime.paths.live') as '/api/internal/live',
        ready: exactString(paths.ready, '/api/internal/ready', 'runtime.paths.ready') as '/api/internal/ready'
      },
      environment: environmentNames
    },
    services: root.services.map(parseService),
    resources: {
      backendManifestRelativePath: relativeResourcePath(
        resources.backendManifestRelativePath,
        'resources.backendManifestRelativePath'
      ),
      licensesRelativePath: relativeResourcePath(
        resources.licensesRelativePath,
        'resources.licensesRelativePath'
      )
    },
    installer: parsedInstaller
  };
}

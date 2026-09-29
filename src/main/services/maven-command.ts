import { delimiter, posix, win32 } from 'node:path';
import type { BuildToolchainSettings } from '../../shared/types';

export type MavenCommandOptions = {
  testClassNames?: string[];
  properties?: Record<string, string>;
};

export type CommandExecutionOptions = {
  signal?: AbortSignal;
  excludedEnvironmentVariables?: readonly string[];
  timeoutMilliseconds?: number;
  timeoutDiagnostic?: string;
};

export type MavenClasspathScope = 'test' | 'compile' | 'runtime';

export type PublicMavenDiagnostic = {
  command: string;
  exitCode: number | null;
  summary: string;
};

const MAX_PUBLIC_MAVEN_TEXT = 4_096;

/**
 * Windows cmd.exe rejects an overlong command line before Maven can start.
 * Keep the selector itself comfortably below that limit and run multiple
 * Maven invocations when a target class has many direct tests.
 */
export function partitionMavenTestClassNames(
  testClassNames: readonly string[],
  maxSelectorLength = 6_000
): string[][] {
  if (!Number.isInteger(maxSelectorLength) || maxSelectorLength < 1) {
    throw new Error('Maven test selector length must be a positive integer');
  }

  const normalized = [...new Set(
    testClassNames
      .map((item) => item.trim())
      .filter(Boolean)
  )];
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const testClassName of normalized) {
    if (testClassName.length > maxSelectorLength) {
      throw new Error('A Maven test class name exceeds the selector length limit');
    }
    const nextLength = current.length === 0
      ? testClassName.length
      : currentLength + 1 + testClassName.length;
    if (current.length > 0 && nextLength > maxSelectorLength) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(testClassName);
    currentLength = current.length === 1
      ? testClassName.length
      : currentLength + 1 + testClassName.length;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function pathApi(platform: NodeJS.Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function resolveMavenExecutable(
  settings: BuildToolchainSettings,
  platform: NodeJS.Platform = process.platform
): string {
  return pathApi(platform).join(settings.mavenHome, 'bin', platform === 'win32' ? 'mvn.cmd' : 'mvn');
}

export function buildMavenArgs(
  settings: BuildToolchainSettings,
  goals: string[],
  options: MavenCommandOptions | string = {}
): string[] {
  const normalizedOptions: MavenCommandOptions = typeof options === 'string'
    ? { testClassNames: [options] }
    : options;
  const args: string[] = [];
  if (settings.settingsPath) {
    args.push('-s', settings.settingsPath);
  }
  if (settings.localRepository) {
    args.push(`-Dmaven.repo.local=${settings.localRepository}`);
  }
  const testClassNames = [...new Set((normalizedOptions.testClassNames ?? []).map((item) => item.trim()).filter(Boolean))];
  if (testClassNames.length > 0) {
    args.push(`-Dtest=${testClassNames.join(',')}`);
  }
  for (const [name, value] of Object.entries(normalizedOptions.properties ?? {})) {
    const propertyName = name.trim();
    if (!propertyName || value == null) {
      continue;
    }
    args.push(`-D${propertyName}=${value}`);
  }
  args.push(...goals);
  return args;
}

/**
 * 只解析 Maven 已声明的测试 classpath，不触发源码编译、测试或打包。
 */
export function buildMavenClasspathArgs(
  settings: BuildToolchainSettings,
  outputFile: string,
  includeScope: MavenClasspathScope = 'test',
  nonRecursive = false
): string[] {
  if (!outputFile.trim()) {
    throw new Error('Maven classpath 输出文件不能为空。');
  }
  return buildMavenArgs(
    settings,
    [...(nonRecursive ? ['--non-recursive'] : []), 'dependency:build-classpath'],
    {
      properties: {
        includeScope,
        'mdep.outputFile': outputFile
      }
    }
  );
}

export function buildMavenEnvironment(
  settings: BuildToolchainSettings,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  excludedEnvironmentVariables: readonly string[] = []
): NodeJS.ProcessEnv {
  const path = pathApi(platform);
  const blocked = new Set(excludedEnvironmentVariables.map((key) => key.toUpperCase()));
  const sanitized = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => {
    const normalized = key.toUpperCase();
    return !normalized.startsWith('AI_UNIT_TEST_')
      && normalized !== 'AGENT_JAVA_ANALYZER_ACCESS_TOKEN'
      && !blocked.has(normalized);
  }));
  const inheritedPath = sanitized.Path ?? sanitized.PATH ?? '';
  const pathDelimiter = platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':';
  const runtimePath = [path.join(settings.javaHome, 'bin'), path.join(settings.mavenHome, 'bin'), inheritedPath]
    .filter(Boolean)
    .join(pathDelimiter);

  if (platform === 'win32') {
    return {
      ...sanitized,
      JAVA_HOME: settings.javaHome,
      MAVEN_HOME: settings.mavenHome,
      M2_HOME: settings.mavenHome,
      Path: runtimePath,
      PATH: runtimePath
    };
  }

  return {
    ...sanitized,
    JAVA_HOME: settings.javaHome,
    MAVEN_HOME: settings.mavenHome,
    M2_HOME: settings.mavenHome,
    PATH: runtimePath
  };
}

export function parseMavenVersionOutput(output: string): {
  mavenVersion?: string;
  javaVersion?: string;
  javaRuntime?: string;
} {
  const mavenVersion = output.match(/Apache Maven\s+([^\s]+)/i)?.[1];
  const javaLine = output.match(/^Java version:\s*([^\r\n]+)$/im)?.[1];
  const javaVersion = javaLine?.split(',')[0]?.trim();
  const javaRuntime = javaLine?.match(/(?:runtime|Java home):\s*(.+)$/i)?.[1]?.trim();
  return { mavenVersion, javaVersion, javaRuntime };
}

/** Keeps Maven evidence useful across IPC/persistence boundaries without retaining credentials. */
export function extractPublicMavenDiagnostic(result: {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): PublicMavenDiagnostic {
  const output = sanitizePublicText(`${result.stderr}\n${result.stdout}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-40)
    .join('\n');
  return {
    command: sanitizePublicText(result.command).slice(0, MAX_PUBLIC_MAVEN_TEXT) || 'Maven command unavailable',
    exitCode: result.exitCode,
    summary: output.slice(0, MAX_PUBLIC_MAVEN_TEXT) || `Maven exited with code ${result.exitCode ?? 'unknown'}`
  };
}

export function sanitizePublicText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(
      /(^|[^A-Za-z0-9_])(["']?)((?:proxy[-_ ]?)?authorization)\2\s*[:=]\s*[^\r\n]*/gi,
      '$1$2$3$2=[REDACTED]'
    )
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /(^|[^A-Za-z0-9_])(["']?)((?:-D)?(?:[A-Za-z0-9]+[-_.])*(?:password|passwd|token|secret|api[-_.]?key|x[-_.]?api[-_.]?key|client[-_.]?secret|secret[-_.]?access[-_.]?key|access[-_.]?key|access[-_.]?token|refresh[-_.]?token|private[-_.]?key))\2\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n]*)/gi,
      '$1$2$3$2=[REDACTED]'
    );
}

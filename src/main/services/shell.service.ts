import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type {
  BuildSettingsValidationResult,
  BuildToolchainSettings,
  CommandResult,
} from '../../shared/types';
import {
  buildMavenClasspathArgs,
  buildMavenArgs,
  buildMavenEnvironment,
  partitionMavenTestClassNames,
  parseMavenVersionOutput,
  resolveMavenExecutable,
  type CommandExecutionOptions,
  type MavenClasspathScope
} from './maven-command.ts';

const COMMAND_STDIO_DRAIN_GRACE_MS = 1_000;
const GENERATED_SUREFIRE_TIMEOUT_MS = 120_000;

/**
 * Maven 在中文 Windows 控制台下可能输出 GBK/GB18030 字节。
 * 先严格按 UTF-8 尝试，只有字节序列无效时才回退到 GB18030。
 */
export function decodeCommandOutput(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}

export class CommandCancelledError extends Error {
  constructor() {
    super('Maven 执行已停止。');
    this.name = 'CommandCancelledError';
  }
}

export class ShellService {
  async validateBuildSettings(
    settings: BuildToolchainSettings,
    workingDirectory: string = process.cwd(),
    options: CommandExecutionOptions = {}
  ): Promise<BuildSettingsValidationResult> {
    const command = resolveMavenExecutable(settings);
    const checkedAt = new Date().toISOString();

    try {
      await this.requireDirectory(settings.mavenHome, 'Maven Home');
      await this.requireFile(command, 'Maven 可执行文件');
      await this.requireDirectory(settings.javaHome, 'Java Home');
      await this.requireFile(
        join(settings.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
        'Java 可执行文件'
      );
      if (settings.settingsPath) {
        await this.requireFile(settings.settingsPath, 'Maven settings');
      }
      if (settings.localRepository) {
        await this.requireDirectory(settings.localRepository, 'Maven 本地仓库');
      }
    } catch (error) {
      return {
        valid: false,
        command,
        checkedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const args = settings.settingsPath ? ['-s', settings.settingsPath, '--version'] : ['--version'];
    const result = await this.runCommand(command, args, workingDirectory, settings, options);
    const output = `${result.stdout}\n${result.stderr}`;
    const parsed = parseMavenVersionOutput(output);
    const stdoutTail = tailLines(result.stdout, 20);
    const stderrTail = tailLines(result.stderr, 20);

    if (result.exitCode !== 0) {
      return {
        valid: false,
        command: result.command,
        checkedAt,
        error: `Maven 环境校验失败，退出码 ${result.exitCode ?? '未知'}`,
        stdoutTail,
        stderrTail
      };
    }
    if (!parsed.mavenVersion || !parsed.javaVersion) {
      return {
        valid: false,
        command: result.command,
        checkedAt,
        error: '未能从 mvn --version 输出中识别 Maven 或 Java 版本',
        stdoutTail,
        stderrTail
      };
    }
    if (parsed.javaRuntime && !this.isInside(settings.javaHome, parsed.javaRuntime)) {
      return {
        valid: false,
        command: result.command,
        checkedAt,
        mavenVersion: parsed.mavenVersion,
        javaVersion: parsed.javaVersion,
        javaRuntime: parsed.javaRuntime,
        error: `Maven 实际使用的 Java 不在配置的 Java Home 下：${parsed.javaRuntime}`,
        stdoutTail,
        stderrTail
      };
    }

    return {
      valid: true,
      command: result.command,
      checkedAt,
      mavenVersion: parsed.mavenVersion,
      javaVersion: parsed.javaVersion,
      javaRuntime: parsed.javaRuntime,
      stdoutTail,
      stderrTail
    };
  }

  runMavenTest(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testName?: string,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    return this.runMaven(workspaceRoot, settings, buildMavenArgs(settings, ['test'], testName), options);
  }

  runMavenCompile(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    return this.runMaven(
      workspaceRoot,
      settings,
      buildMavenArgs(settings, ['compile']),
      options
    );
  }

  collectMavenClasspath(
    moduleRoot: string,
    settings: BuildToolchainSettings,
    outputFile: string,
    options: CommandExecutionOptions & { nonRecursive?: boolean } = {},
    includeScope: MavenClasspathScope = 'test'
  ): Promise<CommandResult> {
    return this.runMaven(
      moduleRoot,
      settings,
      buildMavenClasspathArgs(settings, outputFile, includeScope, options.nonRecursive),
      options
    );
  }

  runMavenModuleTestsWithJacoco(
    moduleRoot: string,
    settings: BuildToolchainSettings,
    executionDataPath: string,
    surefireReportsDirectory: string,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    if (!executionDataPath.trim() || !surefireReportsDirectory.trim()) {
      throw new Error('模块预加载的 JaCoCo exec 和 Surefire 目录不能为空。');
    }
    return this.runMaven(
      moduleRoot,
      settings,
      buildMavenArgs(
        settings,
        ['test-compile', 'jacoco:prepare-agent', 'surefire:test'],
        {
          properties: {
            'maven.test.skip': 'false',
            skipTests: 'false',
            'jacoco.destFile': executionDataPath,
            'jacoco.append': 'false',
            'surefire.reportsDirectory': surefireReportsDirectory
          }
        }
      ),
      options
    );
  }

  async runMavenDirectTestsWithJacoco(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testClassNames: string[],
    executionDataPath: string,
    surefireReportsDirectory: string | undefined,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    if (testClassNames.length === 0) {
      throw new Error('鑷冲皯闇€瑕佷竴涓洰鏍囩被鐩存帴娴嬭瘯鎵嶈兘鎵ц瀹氬悜 JaCoCo 娴嬭瘯');
    }
    const batches = partitionMavenTestClassNames(testClassNames);
    const results: CommandResult[] = [];
    for (const [index, batch] of batches.entries()) {
      const result = await this.runMavenDirectTestsWithJacocoBatch(
        workspaceRoot,
        settings,
        batch,
        executionDataPath,
        surefireReportsDirectory,
        options,
        index > 0
      );
      results.push(result);
      if (result.exitCode !== 0) {
        break;
      }
    }
    return combineCommandResults(results);
  }

  async runMavenDirectTestsWithJacocoAppend(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testClassNames: string[],
    executionDataPath: string,
    surefireReportsDirectory: string | undefined,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    if (testClassNames.length === 0) {
      throw new Error('At least one generated test class is required for JaCoCo append.');
    }
    const batches = partitionMavenTestClassNames(testClassNames);
    const results: CommandResult[] = [];
    for (const batch of batches) {
      const result = await this.runMavenDirectTestsWithJacocoBatch(
        workspaceRoot,
        settings,
        batch,
        executionDataPath,
        surefireReportsDirectory,
        options,
        true
      );
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    return combineCommandResults(results);
  }

  private runMavenDirectTestsWithJacocoBatch(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testClassNames: string[],
    executionDataPath: string,
    surefireReportsDirectory: string | undefined,
    options: CommandExecutionOptions = {},
    jacocoAppend = false
  ): Promise<CommandResult> {
    if (testClassNames.length === 0) {
      throw new Error('至少需要一个目标类直接测试才能执行定向 JaCoCo 测试');
    }
    return this.runMaven(
      workspaceRoot,
      settings,
      buildMavenArgs(
        settings,
        ['test-compile', 'jacoco:prepare-agent', 'surefire:test'],
        {
          testClassNames,
          properties: {
            // 定向覆盖率任务必须真实执行测试，覆盖父 POM 中可能存在的 skip 配置。
            'maven.test.skip': 'false',
            skipTests: 'false',
            'jacoco.destFile': executionDataPath,
            'jacoco.append': jacocoAppend ? 'true' : 'false',
            // 多轮闭环使用 attempt 独立目录，避免读取默认目录中的旧 Surefire 报告。
            ...(surefireReportsDirectory
              ? { 'surefire.reportsDirectory': surefireReportsDirectory }
              : {})
          }
        }
      ),
      options
    );
  }

  /**
   * 分类片段只执行临时生成测试的编译和 Surefire，不生成或覆盖 JaCoCo 数据。
   */
  runMavenGeneratedTest(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testClassName: string,
    surefireReportsDirectory: string | undefined,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    if (!testClassName.trim()) {
      throw new Error('临时生成测试类名不能为空');
    }
    return this.runMaven(
      workspaceRoot,
      settings,
      buildMavenArgs(
        settings,
        ['test-compile', 'surefire:test'],
        {
          testClassNames: [testClassName],
          properties: {
            'maven.test.skip': 'false',
            skipTests: 'false',
            ...(surefireReportsDirectory
              ? { 'surefire.reportsDirectory': surefireReportsDirectory }
              : {})
          }
        }
      ),
      options
    );
  }

  /**
   * 候选写盘后的第一阶段只编译测试源码，先取得完整真实 javac 诊断。
   * 只有本阶段退出码为 0，MavenCandidateExecutorService 才会执行定向测试。
   */
  runMavenGeneratedTestCompile(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testClassName: string | readonly string[],
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    const testClassNames = normalizeGeneratedTestClassNames(testClassName);
    if (testClassNames.length === 0) {
      throw new Error('临时生成测试类名不能为空');
    }
    return this.runMaven(
      workspaceRoot,
      settings,
      buildMavenArgs(
        settings,
        ['test-compile'],
        {
          testClassNames,
          properties: {
            'maven.test.skip': 'false',
            skipTests: 'false'
          }
        }
      ),
      options
    );
  }

  runMavenGeneratedSurefireTest(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    testClassName: string | readonly string[],
    surefireReportsDirectory: string,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    const testClassNames = normalizeGeneratedTestClassNames(testClassName);
    if (testClassNames.length === 0) {
      throw new Error('临时生成测试类名不能为空');
    }
    if (!surefireReportsDirectory.trim()) {
      throw new Error('Surefire 报告目录不能为空');
    }
    const timeoutDiagnostic = [
      `[ERROR] Generated test validation timed out after ${GENERATED_SUREFIRE_TIMEOUT_MS / 1_000} seconds.`,
      '[ERROR] The generated test likely contains an infinite loop, unbounded recursion, deadlock, or blocking call.',
      '[ERROR] Timed out tests:',
      ...testClassNames.map((className) => `[ERROR] ${className}`)
    ].join('\n');
    return this.runMaven(
      workspaceRoot,
      settings,
      buildMavenArgs(
        settings,
        ['surefire:test'],
        {
          testClassNames,
          properties: {
            'maven.test.skip': 'false',
            skipTests: 'false',
            'surefire.reportsDirectory': surefireReportsDirectory
          }
        }
      ),
      {
        ...options,
        timeoutMilliseconds: GENERATED_SUREFIRE_TIMEOUT_MS,
        timeoutDiagnostic
      }
    );
  }

  private runMaven(
    workspaceRoot: string,
    settings: BuildToolchainSettings,
    args: string[],
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    return this.runCommand(resolveMavenExecutable(settings), args, workspaceRoot, settings, options);
  }

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    settings: BuildToolchainSettings,
    options: CommandExecutionOptions = {}
  ): Promise<CommandResult> {
    if (options.timeoutMilliseconds !== undefined
      && (!Number.isFinite(options.timeoutMilliseconds) || options.timeoutMilliseconds <= 0)) {
      return Promise.reject(new Error('Command timeout must be a positive number of milliseconds.'));
    }
    return new Promise((resolveResult, rejectResult) => {
      const invocation = commandInvocation(command, args);
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: buildMavenEnvironment(settings, process.env, process.platform, options.excludedEnvironmentVariables ?? [])
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let terminating = false;
      let terminationPromise: Promise<void> | null = null;
      let exitedProcessCode: number | null = null;
      let stdioDrainTimer: NodeJS.Timeout | null = null;
      let commandTimeoutTimer: NodeJS.Timeout | null = null;
      let resolveChildClosed: (() => void) | null = null;
      let onAbort = (): void => {};
      const childClosed = new Promise<void>((resolveClosed) => {
        resolveChildClosed = resolveClosed;
      });
      const terminate = (): Promise<void> => {
        if (terminationPromise) return terminationPromise;
        terminating = true;
        terminationPromise = (async () => {
          if (process.platform === 'win32' && child.pid) {
            // taskkill /T /F 返回只代表终止命令完成；还要等待受管 shell 的 close，
            // 才能向上层确认整个 Maven 进程树已经退出。
            await new Promise<void>((resolveKiller, rejectKiller) => {
              const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                shell: false
              });
              killer.once('error', (error) => {
                rejectKiller(new Error(`无法启动 Maven 进程树终止命令：${error.message}`));
              });
              killer.once('close', () => {
                resolveKiller();
              });
            });
          } else {
            child.kill('SIGTERM');
          }
          await childClosed;
        })();
        return terminationPromise;
      };
      const clearRuntimeHooks = (): void => {
        if (stdioDrainTimer) {
          clearTimeout(stdioDrainTimer);
          stdioDrainTimer = null;
        }
        if (commandTimeoutTimer) {
          clearTimeout(commandTimeoutTimer);
          commandTimeoutTimer = null;
        }
        options.signal?.removeEventListener('abort', onAbort);
      };
      const resolveOnce = (exitCode: number | null, appendedStderr = ''): void => {
        if (settled) return;
        settled = true;
        clearRuntimeHooks();
        resolveResult({
          command: [command, ...args].join(' '),
          cwd,
          exitCode,
          stdout: decodeCommandOutput(Buffer.concat(stdoutChunks)),
          stderr: appendCommandDiagnostic(
            decodeCommandOutput(Buffer.concat(stderrChunks)),
            appendedStderr
          )
        });
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearRuntimeHooks();
        rejectResult(error);
      };
      const finish = (exitCode: number | null): void => {
        if (settled || terminating) return;
        resolveOnce(exitCode);
      };
      onAbort = (): void => {
        if (settled || terminating) return;
        void terminate().then(
          () => rejectOnce(new CommandCancelledError()),
          (error) => {
            rejectOnce(error instanceof Error
              ? error
              : new Error('无法停止 Maven 进程树。'));
          }
        );
      };
      const onTimeout = (): void => {
        if (settled || terminating || options.timeoutMilliseconds === undefined) return;
        const timeoutDiagnostic = options.timeoutDiagnostic?.trim()
          || `[ERROR] Command timed out after ${options.timeoutMilliseconds} milliseconds.`;
        void terminate().then(
          () => resolveOnce(124, timeoutDiagnostic),
          (error) => {
            rejectOnce(error instanceof Error
              ? error
              : new Error('Unable to stop the timed-out command process tree.'));
          }
        );
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(Buffer.from(chunk));
      });
      child.on('error', (error) => {
        stderrChunks.push(Buffer.from(error.message, 'utf8'));
        finish(-1);
      });
      child.on('exit', (exitCode) => {
        if (settled || terminating) return;
        exitedProcessCode = exitCode;
        // Windows shell 的后台后代进程可能继续持有继承的 stdout/stderr 句柄。
        // 直接命令已经退出时只给缓冲输出一个有界排空窗口，不能无限等待 close。
        stdioDrainTimer = setTimeout(() => {
          stdioDrainTimer = null;
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitedProcessCode);
        }, COMMAND_STDIO_DRAIN_GRACE_MS);
      });
      child.on('close', (exitCode) => {
        resolveChildClosed?.();
        resolveChildClosed = null;
        finish(exitCode ?? exitedProcessCode);
      });
      if (options.timeoutMilliseconds !== undefined) {
        commandTimeoutTimer = setTimeout(onTimeout, options.timeoutMilliseconds);
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
      }
    });
  }

  private async requireDirectory(path: string, label: string): Promise<void> {
    try {
      const stat = await fs.stat(path);
      if (!stat.isDirectory()) {
        throw new Error(`${label} 不是目录：${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${label} `)) {
        throw error;
      }
      throw new Error(`${label} 不存在或无法访问：${path}`);
    }
  }

  private async requireFile(path: string, label: string): Promise<void> {
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile()) {
        throw new Error(`${label} 不是文件：${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${label} `)) {
        throw error;
      }
      throw new Error(`${label} 不存在或无法访问：${path}`);
    }
  }

  private isInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(resolve(parentPath), resolve(childPath));
    return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(':'));
  }
}

function combineCommandResults(results: readonly CommandResult[]): CommandResult {
  const last = results[results.length - 1];
  if (!last) {
    throw new Error('Maven results cannot be empty');
  }
  return {
    command: results
      .map((result, index) => `[batch ${index + 1}/${results.length}] ${result.command}`)
      .join('\n'),
    cwd: last.cwd,
    exitCode: last.exitCode,
    stdout: results
      .map((result, index) => `--- batch ${index + 1}/${results.length} stdout ---\n${result.stdout}`)
      .join('\n'),
    stderr: results
      .map((result, index) => `--- batch ${index + 1}/${results.length} stderr ---\n${result.stderr}`)
      .join('\n')
  };
}

function normalizeGeneratedTestClassNames(
  value: string | readonly string[]
): string[] {
  const values = typeof value === 'string' ? [value] : value;
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function tailLines(value: string, lineCount: number): string {
  return value.split(/\r?\n/).filter(Boolean).slice(-lineCount).join('\n');
}

function appendCommandDiagnostic(output: string, diagnostic: string): string {
  if (!diagnostic) return output;
  if (!output) return diagnostic;
  return `${output}${/[\r\n]$/.test(output) ? '' : '\n'}${diagnostic}`;
}

type CommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
};

function commandInvocation(command: string, args: string[]): CommandInvocation {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(command)) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const commandLine = [command, ...args]
    .map(quoteWindowsCommandToken)
    .join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

function quoteWindowsCommandToken(value: string): string {
  if (/[\0\r\n"%]/.test(value)) {
    throw new Error('Windows 命令参数包含无法安全传递的字符。');
  }
  return `"${value}"`;
}

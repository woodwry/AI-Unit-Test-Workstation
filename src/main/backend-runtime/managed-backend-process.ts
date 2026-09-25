import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { BackendLogSink } from './backend-log-sink.ts';
import type { ResolvedBackendServiceCommand } from './backend-resource-resolver.ts';
import type { RuntimeServiceId } from './release-contract.ts';
import {
  parseRuntimeHandshakeLine,
  parseRuntimeStatusResponse,
  type RuntimeHandshake
} from './runtime-protocol.ts';

export type ManagedBackendProcessReady = Readonly<{
  service: RuntimeServiceId;
  pid: number;
  port: number;
  baseUrl: string;
}>;

export type ManagedBackendUnexpectedExit = Readonly<{
  service: RuntimeServiceId;
  pid: number;
  exitCode: number | null;
}>;

export type ManagedBackendProcessFailureReason =
  | 'spawn-failed'
  | 'invalid-handshake'
  | 'invalid-readiness'
  | 'exited-before-ready'
  | 'startup-timeout'
  | 'startup-cancelled';

export class ManagedBackendProcessError extends Error {
  readonly service: RuntimeServiceId;
  readonly reason: ManagedBackendProcessFailureReason;
  readonly retryable: boolean;

  constructor(service: RuntimeServiceId, reason: ManagedBackendProcessFailureReason) {
    super(productErrorMessage(service, reason));
    this.name = 'ManagedBackendProcessError';
    this.service = service;
    this.reason = reason;
    this.retryable = reason !== 'startup-cancelled';
  }
}

export type ManagedBackendSpawn = (
  executablePath: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export type ManagedBackendFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type ManagedBackendSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export type ManagedBackendProcessOptions = Readonly<{
  command: ResolvedBackendServiceCommand;
  instanceId: string;
  accessToken: string;
  environment: NodeJS.ProcessEnv;
  readyPath: string;
  logSink: BackendLogSink;
  spawn?: ManagedBackendSpawn;
  fetch?: ManagedBackendFetch;
  sleep?: ManagedBackendSleep;
  platform?: NodeJS.Platform;
  taskkillExecutablePath?: string;
  onUnexpectedExit?: (event: ManagedBackendUnexpectedExit) => void;
}>;

const MAX_OUTPUT_BUFFER_CHARACTERS = 65_536;
const MAX_READINESS_BODY_CHARACTERS = 4_096;
const INITIAL_READINESS_DELAY_MS = 250;
const MAX_READINESS_DELAY_MS = 1_000;
const FORCE_KILL_SETTLE_MS = 2_000;

const DEFAULT_SPAWN: ManagedBackendSpawn = (executablePath, arguments_, options) =>
  nodeSpawn(executablePath, [...arguments_], options);

const DEFAULT_FETCH: ManagedBackendFetch = (input, init) => fetch(input, init);

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function productServiceName(service: RuntimeServiceId): string {
  return service === 'java-analyzer' ? '本地代码分析服务' : '本地智能生成服务';
}

function productErrorMessage(
  service: RuntimeServiceId,
  reason: ManagedBackendProcessFailureReason
): string {
  const serviceName = productServiceName(service);
  if (reason === 'startup-timeout') return `${serviceName}启动超时，请重试。`;
  if (reason === 'startup-cancelled') return `${serviceName}启动已取消。`;
  return `${serviceName}启动失败，请重试。`;
}

function internalErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : '未知内部错误';
}

function defaultTaskkillPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

function exitedError(): Error {
  return new Error('托管子进程已经退出');
}

class ReadinessProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadinessProtocolError';
  }
}

class Utf8LineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';

  push(chunk: Buffer | string): readonly string[] {
    this.buffered += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (this.buffered.length > MAX_OUTPUT_BUFFER_CHARACTERS) {
      throw new Error('子进程输出行过长');
    }
    const lines: string[] = [];
    let newlineIndex = this.buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      let line = this.buffered.slice(0, newlineIndex);
      this.buffered = this.buffered.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
      newlineIndex = this.buffered.indexOf('\n');
    }
    return lines;
  }

  finish(): string {
    this.buffered += this.decoder.end();
    const remainder = this.buffered;
    this.buffered = '';
    return remainder;
  }
}

/**
 * 管理一个本地后端子进程的握手、readiness 和关闭。调用方只会得到回环 URL、
 * PID 与端口；访问令牌始终留在私有字段，并且每次写日志都会作为敏感值脱敏。
 */
export class ManagedBackendProcess {
  private readonly command: ResolvedBackendServiceCommand;
  private readonly instanceId: string;
  private readonly accessToken: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly readyPath: string;
  private readonly logSink: BackendLogSink;
  private readonly spawnProcess: ManagedBackendSpawn;
  private readonly fetchRequest: ManagedBackendFetch;
  private readonly sleep: ManagedBackendSleep;
  private readonly platform: NodeJS.Platform;
  private readonly taskkillExecutablePath: string;
  private readonly onUnexpectedExit?: (event: ManagedBackendUnexpectedExit) => void;
  private readonly lifecycleAbort = new AbortController();
  private readonly stdoutLines = new Utf8LineBuffer();
  private readonly stderrLines = new Utf8LineBuffer();

  private child: ChildProcess | null = null;
  private pid: number | null = null;
  private handshake: RuntimeHandshake | null = null;
  private startPromise: Promise<ManagedBackendProcessReady> | null = null;
  private resolveStart: ((ready: ManagedBackendProcessReady) => void) | null = null;
  private rejectStart: ((error: ManagedBackendProcessError) => void) | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private startSettled = false;
  private ready = false;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private exited = false;
  private unexpectedExitPublished = false;
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | null = null;

  constructor(options: ManagedBackendProcessOptions) {
    this.command = options.command;
    this.instanceId = options.instanceId;
    this.accessToken = options.accessToken;
    this.environment = { ...options.environment };
    this.readyPath = options.readyPath;
    this.logSink = options.logSink;
    this.spawnProcess = options.spawn ?? DEFAULT_SPAWN;
    this.fetchRequest = options.fetch ?? DEFAULT_FETCH;
    this.sleep = options.sleep ?? defaultSleep;
    this.platform = options.platform ?? process.platform;
    this.taskkillExecutablePath = options.taskkillExecutablePath ?? defaultTaskkillPath();
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  get service(): RuntimeServiceId {
    return this.command.id;
  }

  start(): Promise<ManagedBackendProcessReady> {
    if (this.startPromise) return this.startPromise;
    if (this.stopRequested) {
      return Promise.reject(new ManagedBackendProcessError(this.service, 'startup-cancelled'));
    }

    this.startPromise = new Promise<ManagedBackendProcessReady>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.startupTimer = setTimeout(
      () => this.failStartup('startup-timeout', new Error('等待握手或 readiness 超时')),
      this.command.startupTimeoutMs
    );

    try {
      // 令牌只存在于 env；命令和参数全部来自已校验的资源契约。
      const child = this.spawnProcess(this.command.executablePath, this.command.arguments, {
        cwd: this.command.workingDirectory,
        env: this.environment,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (
        !Number.isSafeInteger(child.pid) ||
        Number(child.pid) <= 0 ||
        !child.stdin ||
        !child.stdout ||
        !child.stderr
      ) {
        throw new Error('子进程未提供有效 PID 或标准管道');
      }
      this.child = child;
      this.pid = Number(child.pid);
      this.exitPromise = new Promise((resolve) => {
        this.resolveExit = resolve;
      });
      this.attachProcessListeners(child);
      this.writeEvent('process-spawned', 'info', { pid: this.pid });
    } catch (error) {
      this.failStartup('spawn-failed', error);
    }

    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    if (!this.startSettled) {
      this.failStartup('startup-cancelled', new Error('父进程请求停止启动中的服务'));
    }
    this.lifecycleAbort.abort(new Error('托管子进程正在关闭'));
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private attachProcessListeners(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      try {
        for (const line of this.stdoutLines.push(chunk)) this.handleStdoutLine(line);
      } catch (error) {
        this.failStartup('invalid-handshake', error);
      }
    });
    child.stdout?.once('end', () => {
      const remainder = this.stdoutLines.finish();
      if (remainder) {
        if (this.handshake) this.writeOutputLine(remainder);
        else this.failStartup('invalid-handshake', new Error('stdout 在完整握手行之前结束'));
      } else if (!this.handshake && !this.exited) {
        this.failStartup('invalid-handshake', new Error('stdout 在握手之前结束'));
      }
    });
    child.stdout?.once('error', (error) => {
      this.failStartup('invalid-handshake', error);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      try {
        for (const line of this.stderrLines.push(chunk)) this.writeOutputLine(line);
      } catch (error) {
        this.writeEvent('stderr-read-failed', 'warn', { message: internalErrorMessage(error) });
      }
    });
    child.stderr?.once('end', () => {
      const remainder = this.stderrLines.finish();
      if (remainder) this.writeOutputLine(remainder);
    });
    child.once('error', (error) => this.handleProcessError(error));
    child.once('exit', (code) => this.handleProcessExit(code));
  }

  private handleStdoutLine(line: string): void {
    if (this.handshake) {
      this.writeOutputLine(line);
      return;
    }

    // Spring 启动日志可能先于握手；普通文本仅写入脱敏日志，JSON 候选必须严格匹配协议。
    if (!line.startsWith('{')) {
      this.writeOutputLine(line);
      return;
    }
    if (line.includes('\ufffd')) {
      this.failStartup('invalid-handshake', new Error('握手不是有效 UTF-8'));
      return;
    }

    try {
      const handshake = parseRuntimeHandshakeLine(line, {
        service: this.service,
        instanceId: this.instanceId,
        pid: this.pid ?? 0
      });
      this.handshake = handshake;
      this.writeEvent('handshake-accepted', 'info', {
        pid: handshake.pid,
        port: handshake.port
      });
      void this.pollReadiness(handshake).then(
        () => this.completeStart(handshake),
        (error) => {
          if (!this.startSettled) this.failStartup('invalid-readiness', error);
        }
      );
    } catch (error) {
      this.failStartup('invalid-handshake', error);
    }
  }

  private async pollReadiness(handshake: RuntimeHandshake): Promise<void> {
    let delayMs = INITIAL_READINESS_DELAY_MS;
    while (!this.lifecycleAbort.signal.aborted) {
      const ready = await this.probeReadiness(handshake);
      if (ready) return;
      await this.sleep(delayMs, this.lifecycleAbort.signal);
      delayMs = Math.min(delayMs * 2, MAX_READINESS_DELAY_MS);
    }
    throw this.lifecycleAbort.signal.reason ?? new Error('readiness 轮询已取消');
  }

  private async probeReadiness(handshake: RuntimeHandshake): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchRequest(
        `http://127.0.0.1:${handshake.port}${this.readyPath}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.accessToken}`
          },
          redirect: 'error',
          cache: 'no-store',
          signal: this.lifecycleAbort.signal
        }
      );
    } catch (error) {
      if (this.lifecycleAbort.signal.aborted) throw error;
      this.writeEvent('readiness-request-failed', 'debug', {
        message: internalErrorMessage(error)
      });
      return false;
    }

    if (response.status !== 200 && response.status !== 503) {
      throw new ReadinessProtocolError(`readiness HTTP 状态无效：${response.status}`);
    }

    let value: unknown;
    try {
      const body = await response.text();
      if (!body || body.length > MAX_READINESS_BODY_CHARACTERS) {
        throw new Error('readiness 响应体长度无效');
      }
      value = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ReadinessProtocolError(internalErrorMessage(error));
    }

    let status: ReturnType<typeof parseRuntimeStatusResponse>;
    try {
      status = parseRuntimeStatusResponse(value, {
        service: this.service,
        instanceId: this.instanceId,
        endpoint: 'ready'
      });
    } catch (error) {
      throw new ReadinessProtocolError(internalErrorMessage(error));
    }

    if (response.status === 200 && status.status === 'ready') return true;
    if (response.status === 503 && status.status === 'not_ready') return false;
    throw new ReadinessProtocolError('readiness HTTP 状态与响应体不一致');
  }

  private completeStart(handshake: RuntimeHandshake): void {
    if (this.startSettled || this.exited || this.stopRequested) return;
    this.startSettled = true;
    this.ready = true;
    this.clearStartupTimer();
    const result = Object.freeze({
      service: this.service,
      pid: handshake.pid,
      port: handshake.port,
      baseUrl: `http://127.0.0.1:${handshake.port}`
    });
    this.writeEvent('service-ready', 'info', {
      pid: handshake.pid,
      port: handshake.port
    });
    this.resolveStart?.(result);
    this.resolveStart = null;
    this.rejectStart = null;
  }

  private failStartup(
    reason: ManagedBackendProcessFailureReason,
    internalError: unknown
  ): void {
    if (this.startSettled) return;
    this.startSettled = true;
    this.clearStartupTimer();
    this.lifecycleAbort.abort(internalError);
    this.writeEvent('service-start-failed', 'error', {
      message: internalErrorMessage(internalError),
      ...(this.pid === null ? {} : { pid: this.pid })
    });
    this.rejectStart?.(new ManagedBackendProcessError(this.service, reason));
    this.resolveStart = null;
    this.rejectStart = null;
  }

  private handleProcessError(error: Error): void {
    this.markExited();
    if (!this.ready) {
      this.failStartup('spawn-failed', error);
      return;
    }
    this.writeEvent('service-process-error', 'error', {
      message: internalErrorMessage(error),
      ...(this.pid === null ? {} : { pid: this.pid })
    });
    this.publishUnexpectedExit(null);
  }

  private handleProcessExit(exitCode: number | null): void {
    this.markExited();
    this.writeEvent(this.stopRequested ? 'service-stopped' : 'service-exited', this.stopRequested ? 'info' : 'error', {
      ...(this.pid === null ? {} : { pid: this.pid }),
      exitCode
    });
    if (!this.ready) {
      this.failStartup('exited-before-ready', new Error(`子进程在 readiness 前退出，exitCode=${String(exitCode)}`));
      return;
    }
    if (!this.stopRequested) this.publishUnexpectedExit(exitCode);
  }

  private publishUnexpectedExit(exitCode: number | null): void {
    if (this.unexpectedExitPublished || this.stopRequested || this.pid === null) return;
    this.unexpectedExitPublished = true;
    this.onUnexpectedExit?.(Object.freeze({
      service: this.service,
      pid: this.pid,
      exitCode
    }));
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.clearStartupTimer();
    this.lifecycleAbort.abort(exitedError());
    this.resolveExit?.();
    this.resolveExit = null;
  }

  private async stopInternal(): Promise<void> {
    const child = this.child;
    const pid = this.pid;
    if (!child || pid === null || this.exited) return;

    this.writeEvent('service-stop-requested', 'info', { pid });
    try {
      // shutdown 命令与 EOF 一并交给后端，触发其自身的优雅退出流程。
      child.stdin?.end('shutdown\n', 'utf8');
    } catch (error) {
      this.writeEvent('shutdown-pipe-failed', 'warn', {
        pid,
        message: internalErrorMessage(error)
      });
    }

    if (await this.waitForExit(this.command.shutdownTimeoutMs)) return;
    this.writeEvent('service-force-kill', 'warn', { pid });
    await this.forceKillTree(pid);
    await this.waitForExit(FORCE_KILL_SETTLE_MS);
  }

  private waitForExit(milliseconds: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private forceKillTree(pid: number): Promise<void> {
    if (this.platform !== 'win32') {
      try {
        this.child?.kill('SIGKILL');
      } catch (error) {
        this.writeEvent('force-kill-failed', 'error', {
          pid,
          message: internalErrorMessage(error)
        });
      }
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let killer: ChildProcess;
      try {
        killer = this.spawnProcess(
          this.taskkillExecutablePath,
          ['/PID', String(pid), '/T', '/F'],
          {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
          }
        );
      } catch (error) {
        this.writeEvent('taskkill-spawn-failed', 'error', {
          pid,
          message: internalErrorMessage(error)
        });
        resolve();
        return;
      }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      killer.once('error', (error) => {
        this.writeEvent('taskkill-failed', 'error', {
          pid,
          message: internalErrorMessage(error)
        });
        finish();
      });
      killer.once('exit', finish);
      setTimeout(finish, FORCE_KILL_SETTLE_MS);
    });
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private writeOutputLine(message: string): void {
    void this.logSink.writeLine(this.service, message, [this.accessToken]).catch(() => undefined);
  }

  private writeEvent(
    event: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    fields: Readonly<{
      message?: string;
      pid?: number;
      port?: number;
      exitCode?: number | null;
    }> = {}
  ): void {
    void this.logSink.writeEvent(
      this.service,
      {
        level,
        event,
        service: this.service,
        instanceId: this.instanceId,
        ...fields
      },
      [this.accessToken]
    ).catch(() => undefined);
  }
}

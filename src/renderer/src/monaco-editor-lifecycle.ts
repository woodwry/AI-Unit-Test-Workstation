export type MonacoEditorLifecycleDependencies = {
  initializeCoreRuntime(): Promise<void>;
  attach(): void;
  detach(): void;
  onError(error: unknown): void;
};

export type MonacoEditorLifecycleRun = {
  cancel(): void;
};

type MonacoEditorLifecycleSession = {
  generation: number;
  cancelled: boolean;
  attachAttempted: boolean;
  detached: boolean;
};

export class MonacoEditorLifecycle {
  private readonly dependencies: MonacoEditorLifecycleDependencies;
  private current: MonacoEditorLifecycleSession | undefined;
  private generation: number;
  private disposed: boolean;

  constructor(dependencies: MonacoEditorLifecycleDependencies) {
    this.dependencies = dependencies;
    this.current = undefined;
    this.generation = 0;
    this.disposed = false;
  }

  start(): MonacoEditorLifecycleRun {
    if (this.disposed) {
      throw new Error('MonacoEditorLifecycle is disposed');
    }

    const previous = this.current;
    const session: MonacoEditorLifecycleSession = {
      generation: this.generation + 1,
      cancelled: false,
      attachAttempted: false,
      detached: false,
    };
    this.generation = session.generation;
    this.current = session;

    const run: MonacoEditorLifecycleRun = {
      cancel: () => {
        this.cancelSession(session);
      },
    };

    // 先发布新 generation，再清理旧 session；外部 detach 的重入或异常都不能留下半发布状态。
    if (previous) {
      try {
        this.cancelSession(previous);
      } catch (error) {
        // 仅新 session 仍 current 时接收旧 cleanup 错误；若已被重入 start 取代，则直接忽略。
        this.reportError(session, error);
      }
    }

    if (!this.isCurrent(session)) {
      return run;
    }

    let initialization: Promise<void>;
    try {
      initialization = this.dependencies.initializeCoreRuntime();
    } catch (error) {
      this.reportError(session, error);
      return run;
    }

    void Promise.resolve(initialization).then(
      () => {
        this.attachCurrent(session);
      },
      (error: unknown) => {
        this.reportError(session, error);
      },
    );

    return run;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const session = this.current;
    this.current = undefined;
    if (session) {
      this.cancelSession(session);
    }
  }

  private isCurrent(session: MonacoEditorLifecycleSession): boolean {
    return !this.disposed && !session.cancelled && this.current === session;
  }

  private attachCurrent(session: MonacoEditorLifecycleSession): void {
    if (!this.isCurrent(session)) {
      return;
    }

    // attach 即使部分成功后抛错，后续 cancel/dispose 也必须执行一次安全 cleanup。
    session.attachAttempted = true;
    try {
      this.dependencies.attach();
    } catch (error) {
      this.reportError(session, error);
    }
  }

  private reportError(session: MonacoEditorLifecycleSession, error: unknown): void {
    if (this.isCurrent(session)) {
      this.dependencies.onError(error);
    }
  }

  private cancelSession(session: MonacoEditorLifecycleSession): void {
    if (session.cancelled) {
      return;
    }

    session.cancelled = true;
    if (this.current === session) {
      this.current = undefined;
    }

    if (!session.attachAttempted || session.detached) {
      return;
    }

    // 在调用外部 detach 前锁定幂等状态，避免重入 cleanup 误伤后续 generation。
    session.detached = true;
    this.dependencies.detach();
  }
}

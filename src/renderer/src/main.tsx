import React, { type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { BackendAvailabilityGate } from './BackendAvailabilityGate';
import { AuthGate } from './AuthGate';
import { getSafeRendererErrorFingerprint, getSafeRendererErrorType } from './renderer-safe-error';
import './styles.css';
import './model-interface-settings.css';

const REQUIRED_BRIDGE_METHODS = Object.freeze([
  'getWorkstationModelInterfaces',
  'createModelInterface',
  'updateModelInterface',
  'deleteModelInterface',
  'selectModelInterface',
  'testModelInterfaceConnection',
  'getManagedBackendRuntimeStatus',
  'retryManagedBackendRuntime',
  'probeBackendAvailability',
  'onManagedBackendRuntimeStatusChanged',
  'getAuthState',
  'login',
  'logout',
  'forgetAuthentication',
  'retryAuthentication',
  'onAuthStateChanged',
  'listUsers',
  'createUser',
  'updateUser',
  'deleteUser',
  'addClassTasks',
  'listClassTasks',
  'runClassTask',
  'runAllClassTasks',
  'onClassTaskSnapshotChanged',
  'getRagKnowledgeMethodSource',
  'globalKnowledge',
  'cancelGlobalKnowledgeImport',
  'onRagKnowledgeChanged',
  'getModelCallLogSettings',
  'saveModelCallLogSettings',
  'selectModelCallLogDirectory'
]);

type FatalStartupViewProps = Readonly<{
  code: string;
  message: string;
}>;

function StartupLoadingView(): JSX.Element {
  return (
    <main className="startup-state" role="status" aria-live="polite">
      <section className="startup-state-card">
        <div className="startup-state-spinner" aria-hidden="true" />
        <h1>正在启动 AI Unit Test Workstation</h1>
        <p>正在加载本地工作台组件，请稍候。</p>
      </section>
    </main>
  );
}

function FatalStartupView({ code, message }: FatalStartupViewProps): JSX.Element {
  return (
    <main className="startup-state startup-state-error" role="alert">
      <section className="startup-state-card">
        <div className="startup-state-error-mark" aria-hidden="true">!</div>
        <h1>工作站界面启动失败</h1>
        <p>{message}</p>
        <p className="startup-state-hint">请先重新加载；如果问题持续，请重新安装并把下方故障代码提供给维护人员。</p>
        <code>{code}</code>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </section>
    </main>
  );
}

class RendererErrorBoundary extends React.Component<
  Readonly<{ children: ReactNode }>,
  Readonly<{ failed: boolean }>
> {
  state: Readonly<{ failed: boolean }> = { failed: false };

  static getDerivedStateFromError(): Readonly<{ failed: boolean }> {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    // 只输出错误类型；主进程会将该安全诊断代码写入用户日志。
    console.error(
      '[renderer] REACT_RENDER_FAILURE',
      getSafeRendererErrorType(error),
      getSafeRendererErrorFingerprint(error)
    );
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <FatalStartupView
          code="REACT_RENDER_FAILURE"
          message="工作台组件发生异常，已停止继续加载，以免显示空白窗口。"
        />
      );
    }
    return this.props.children;
  }
}

function hasWorkstationBridge(): boolean {
  const bridge: unknown = Reflect.get(window, 'workstation');
  if (!bridge || typeof bridge !== 'object') return false;
  return REQUIRED_BRIDGE_METHODS.every((method) => typeof Reflect.get(bridge, method) === 'function');
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Renderer root element is unavailable');
const root = ReactDOM.createRoot(rootElement);
root.render(<StartupLoadingView />);

window.addEventListener('error', (event) => {
  console.error(
    '[renderer] UNHANDLED_WINDOW_ERROR',
    getSafeRendererErrorType(event.error),
    getSafeRendererErrorFingerprint(event.error)
  );
});
window.addEventListener('unhandledrejection', (event) => {
  console.error(
    '[renderer] UNHANDLED_PROMISE_REJECTION',
    getSafeRendererErrorType(event.reason),
    getSafeRendererErrorFingerprint(event.reason)
  );
});

async function bootstrapRenderer(): Promise<void> {
  if (!hasWorkstationBridge()) {
    console.error('[renderer] PRELOAD_BRIDGE_UNAVAILABLE');
    root.render(
      <FatalStartupView
        code="PRELOAD_BRIDGE_UNAVAILABLE"
        message="本地安全桥接组件未能加载，工作站无法访问本机功能。"
      />
    );
    return;
  }

  try {
    // 先显示可见的启动页，再延迟求值体积较大的 Monaco/VS Code 依赖。
    const [{ App }, { MonacoEditorSession }] = await Promise.all([
      import('./App'),
      import('./monaco-editor-session')
    ]);
    const editorSession = new MonacoEditorSession();
    const disposeEditorSession = (): void => editorSession.dispose();

    window.addEventListener('beforeunload', disposeEditorSession);
    import.meta.hot?.dispose(() => {
      window.removeEventListener('beforeunload', disposeEditorSession);
      disposeEditorSession();
    });

    root.render(
      <React.StrictMode>
        <RendererErrorBoundary>
          <AuthGate loading={<StartupLoadingView />}>
            <BackendAvailabilityGate loading={<StartupLoadingView />}>
              <App editorSession={editorSession} />
            </BackendAvailabilityGate>
          </AuthGate>
        </RendererErrorBoundary>
      </React.StrictMode>
    );
  } catch (error: unknown) {
    const errorType = getSafeRendererErrorType(error);
    console.error(
      '[renderer] WORKBENCH_MODULE_LOAD_FAILURE',
      errorType,
      getSafeRendererErrorFingerprint(error)
    );
    root.render(
      <FatalStartupView
        code={`WORKBENCH_MODULE_LOAD_FAILURE:${errorType}`}
        message="工作台核心界面组件加载失败，已保留当前窗口用于显示故障信息。"
      />
    );
  }
}

void bootstrapRenderer();

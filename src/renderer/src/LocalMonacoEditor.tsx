import * as monaco from 'monaco-editor';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MonacoEditorLifecycle } from './monaco-editor-lifecycle';
import { configureWorkstationMonaco } from './monaco-editor-appearance';
import { runMonacoStageAsync } from './monaco-initialization-diagnostics';
import type { MonacoEditorSession } from './monaco-editor-session';
import { initializeVsCodeCoreRuntime } from './vscode-runtime';

export type LocalMonacoEditorProps = {
  session: MonacoEditorSession;
  onError(error: unknown): void;
};

export function LocalMonacoEditor({ session, onError }: LocalMonacoEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  onErrorRef.current = onError;

  const lifecycle = useMemo(
    () =>
      new MonacoEditorLifecycle({
        initializeCoreRuntime: () =>
          runMonacoStageAsync('core-runtime', initializeVsCodeCoreRuntime),
        attach: () => {
          const host = hostRef.current;
          if (!host) throw new Error('Monaco editor host is unavailable');
          configureWorkstationMonaco(monaco);
          session.attachEditor(monaco, host);
          setState('ready');
        },
        detach: () => session.detachEditor(),
        onError: (error) => {
          setState('error');
          onErrorRef.current(error);
        }
      }),
    [session]
  );

  useEffect(() => {
    const run = lifecycle.start();
    return () => run.cancel();
  }, [lifecycle]);

  return (
    <div className="local-monaco-editor">
      {state !== 'ready' && (
        <div className={`local-monaco-editor-overlay ${state === 'error' ? 'error' : ''}`}>
          {state === 'error' ? '编辑器初始化失败，请重启工作站' : '编辑器正在初始化'}
        </div>
      )}
      <div ref={hostRef} className="local-monaco-editor-host" />
    </div>
  );
}

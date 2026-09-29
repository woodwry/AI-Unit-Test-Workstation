import { useLayoutEffect, useRef, useState } from 'react';
import { LocalMonacoEditor } from '../LocalMonacoEditor';
import { MonacoEditorSession } from '../monaco-editor-session';
import { applyJavaLocalSemanticDecorations } from '../java-local-semantic-decorations';
import { MonacoDecorationIdStore } from '../monaco-editor-document-state';
import type { MonacoEditor, MonacoEditorFacade } from '../monaco-editor-session';
import { DEFAULT_EDITOR_THEME } from '../monaco-editor-appearance';
import type { RagKnowledgeMethodSource } from '../../../shared/rag-knowledge-contracts';

export function RagMethodSourcePanel({ source, openSources, workspaceRoot }: {
  source: RagKnowledgeMethodSource; openSources: RagKnowledgeMethodSource[]; workspaceRoot: string;
}): JSX.Element {
  const [session, setSession] = useState<MonacoEditorSession | null>(null);
  const decorations = useRef(new MonacoDecorationIdStore());
  const attached = useRef<{ editor: MonacoEditor; monaco: MonacoEditorFacade } | null>(null);
  const ownedSession = useRef<MonacoEditorSession | null>(null);
  useLayoutEffect(() => {
    const owned = new MonacoEditorSession();
    ownedSession.current = owned;
    setSession(owned);
    return () => {
      ownedSession.current = null;
      owned.dispose();
      decorations.current.clear();
    };
  }, []);
  const [error, setError] = useState(false);
  const path = (item: RagKnowledgeMethodSource): string => `${workspaceRoot}/.rag-view/${item.entryId}/${item.method.methodId}.java`;
  useLayoutEffect(() => {
    // StrictMode can replay effects before the replacement session reaches React state.
    // Only the live effect-owned session may receive updates or attach an editor.
    if (!session || session !== ownedSession.current) return;
    session.updateDesiredState({
      activeDocument: { path: path(source), value: source.sourceText, language: 'java' },
      openFilePaths: openSources.map(path), theme: DEFAULT_EDITOR_THEME,
      options: { readOnly: true, domReadOnly: true, automaticLayout: true,
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13 },
      onError: () => setError(true), onDidChangeContent: () => undefined,
      onDidAttach: (editor, monaco) => { attached.current = { editor, monaco }; },
      onDidDetach: () => { attached.current = null; },
      onDidChangeModel: (event, monaco) => {
        if (event.kind === 'release') {
          const ids = decorations.current.release(event.model.key);
          if (!event.model.model.isDisposed()) event.model.model.deltaDecorations(ids, []);
        } else if (event.current) {
          const { key, model } = event.current;
          decorations.current.replace(key, applyJavaLocalSemanticDecorations(
            model, monaco, model.getValue(), decorations.current.replace(key, [])
          ));
        }
      },
    });
    const model = attached.current?.editor.getModel();
    const key = model && session.getCanonicalKeyForDocumentUri(model.uri.toString());
    if (model && key && attached.current && !model.isDisposed()) {
      decorations.current.replace(key, applyJavaLocalSemanticDecorations(
        model, attached.current.monaco, model.getValue(), decorations.current.replace(key, [])
      ));
    }
  }, [session, source, openSources, workspaceRoot]);
  return <div className="rag-source-panel" aria-label="知识库方法源码">
    <div className="rag-source-heading">知识库源码 · 只读 · 包含相关 import、类声明、字段及完整方法</div>
    {error ? <pre className="rag-source-fallback">{source.sourceText}</pre>
      : session && session === ownedSession.current
        && <LocalMonacoEditor session={session} onError={() => setError(true)} />}
  </div>;
}

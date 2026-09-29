import { collectJavaLocalSemanticTokens } from './java-local-semantic-tokens';
import type { MonacoApi, MonacoDecoration, MonacoModel } from './monaco-editor-session';
export function applyJavaLocalSemanticDecorations(
  model: MonacoModel,
  monaco: MonacoApi,
  content: string,
  previousDecorationIds: string[]
): string[] {
  const decorations: MonacoDecoration[] = collectJavaLocalSemanticTokens(content).map((token) => ({
    range: new monaco.Range(
      token.lineNumber,
      token.startColumn,
      token.lineNumber,
      token.endColumn
    ),
    options: {
      inlineClassName: `semantic-token-${token.token.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`
    }
  }));

  return model.deltaDecorations(previousDecorationIds, decorations);
}

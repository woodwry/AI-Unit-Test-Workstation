import { JAVA_KEYWORDS, JAVA_MODIFIERS, JAVA_TYPE_KEYWORDS } from './monaco-editor-appearance.ts';

export type JavaLocalSemanticToken = Readonly<{
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  token: string;
}>;

const JAVA_CONTROL_WORDS = new Set([...JAVA_KEYWORDS, 'false', 'null', 'true']);
const JAVA_MODIFIER_PATTERN = createJavaWordPattern(JAVA_MODIFIERS);
const JAVA_KEYWORD_PATTERN = createJavaWordPattern(JAVA_KEYWORDS);
const JAVA_TYPE_KEYWORD_PATTERN = createJavaWordPattern(JAVA_TYPE_KEYWORDS);
const JAVA_DECLARED_VARIABLE_PATTERN = new RegExp(
  String.raw`\b(?:${JAVA_TYPE_KEYWORDS.join('|')}|(?:(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Z_$][\w$]*)(?:\s*<[^;=(){}]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\b(?!\s*\()`,
  'g'
);

export function collectJavaLocalSemanticTokens(content: string): JavaLocalSemanticToken[] {
  const sourceLines = content.split(/\r?\n/);
  const codeLines = maskJavaNonCode(sourceLines);

  return codeLines.flatMap((line, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const tokens: JavaLocalSemanticToken[] = [];
    const addToken = (startIndex: number, length: number, token: string): void => {
      if (length <= 0) {
        return;
      }
      tokens.push({
        lineNumber,
        startColumn: startIndex + 1,
        endColumn: startIndex + length + 1,
        token
      });
    };

    for (const match of line.matchAll(JAVA_MODIFIER_PATTERN)) {
      addToken(match.index ?? 0, match[0].length, 'modifier');
    }

    for (const match of line.matchAll(JAVA_KEYWORD_PATTERN)) {
      addToken(match.index ?? 0, match[0].length, 'keyword');
    }

    for (const match of line.matchAll(/@[A-Za-z_$][\w$]*/g)) {
      addToken(match.index ?? 0, match[0].length, 'decorator');
    }

    const packageLineMatch = line.match(/^\s*(?:package|import)\s+([^;]+)/);
    if (packageLineMatch?.index !== undefined) {
      const packagePath = packageLineMatch[1];
      const packagePathStart = line.indexOf(packagePath, packageLineMatch.index);
      for (const match of packagePath.matchAll(/\b[a-z_][\w$]*(?=\.)/g)) {
        addToken(packagePathStart + (match.index ?? 0), match[0].length, 'namespace');
      }
    }

    for (const match of line.matchAll(/\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g)) {
      const token = match[1] === 'interface' ? 'interface' : match[1] === 'enum' ? 'enum' : 'class';
      const name = match[2];
      addToken((match.index ?? 0) + match[0].lastIndexOf(name), name.length, token);
    }

    for (const match of line.matchAll(JAVA_TYPE_KEYWORD_PATTERN)) {
      addToken(match.index ?? 0, match[0].length, 'type');
    }

    for (const match of line.matchAll(/\b[A-Z][A-Za-z0-9_$]*\b/g)) {
      addToken(match.index ?? 0, match[0].length, 'type');
    }

    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?=\()/g)) {
      const name = match[1];
      if (!JAVA_CONTROL_WORDS.has(name)) {
        addToken((match.index ?? 0) + match[0].indexOf(name), name.length, 'method');
      }
    }

    for (const match of line.matchAll(/\.([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) {
      const name = match[1];
      addToken((match.index ?? 0) + 1, name.length, 'property');
    }

    for (const match of line.matchAll(JAVA_DECLARED_VARIABLE_PATTERN)) {
      const name = match[1];
      addToken((match.index ?? 0) + match[0].lastIndexOf(name), name.length, 'variable');
    }

    return tokens;
  });
}

function createJavaWordPattern(words: readonly string[]): RegExp {
  const alternatives = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((left, right) => right.length - left.length)
    .join('|');
  return new RegExp(`\\b(?:${alternatives})\\b`, 'g');
}

type JavaMaskState = 'code' | 'block-comment' | 'text-block';

function maskJavaNonCode(lines: readonly string[]): string[] {
  let state: JavaMaskState = 'code';

  return lines.map((line) => {
    const visible = Array.from({ length: line.length }, () => ' ');
    let index = 0;

    while (index < line.length) {
      if (state === 'block-comment') {
        const closeIndex = line.indexOf('*/', index);
        if (closeIndex === -1) {
          break;
        }
        index = closeIndex + 2;
        state = 'code';
        continue;
      }

      if (state === 'text-block') {
        const closeIndex = findUnescapedSequence(line, '"""', index);
        if (closeIndex === -1) {
          break;
        }
        index = closeIndex + 3;
        state = 'code';
        continue;
      }

      if (line.startsWith('//', index)) {
        break;
      }
      if (line.startsWith('/*', index)) {
        state = 'block-comment';
        index += 2;
        continue;
      }
      if (line.startsWith('"""', index)) {
        state = 'text-block';
        index += 3;
        continue;
      }
      if (line[index] === '"' || line[index] === "'") {
        index = skipQuotedLiteral(line, index, line[index]);
        continue;
      }

      visible[index] = line[index];
      index += 1;
    }

    return visible.join('');
  });
}

function skipQuotedLiteral(line: string, startIndex: number, quote: string): number {
  let index = startIndex + 1;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return line.length;
}

function findUnescapedSequence(line: string, sequence: string, startIndex: number): number {
  let candidateIndex = line.indexOf(sequence, startIndex);
  while (candidateIndex !== -1) {
    let backslashCount = 0;
    for (let index = candidateIndex - 1; index >= 0 && line[index] === '\\'; index -= 1) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 0) {
      return candidateIndex;
    }
    candidateIndex = line.indexOf(sequence, candidateIndex + 1);
  }
  return -1;
}

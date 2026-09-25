export type JavaTestMethodSpan = {
  name: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
};

export type JavaMethodSpan = JavaTestMethodSpan & {
  bodyStartOffset: number;
  bodyEndOffset: number;
  isTestMethod: boolean;
  isLifecycleMethod: boolean;
};

export type JavaFieldSpan = {
  names: string[];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
};

const TEST_ANNOTATION_PATTERN =
  /@(?:[A-Za-z_$][\w$]*\.)*(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
const LIFECYCLE_ANNOTATION_PATTERN =
  /@(?:[A-Za-z_$][\w$]*\.)*(?:BeforeEach|AfterEach|BeforeAll|AfterAll)\b/;

/**
 * 只识别顶层 JUnit 测试方法的确定性结构扫描器。
 *
 * 扫描时保留换行与字符偏移，但屏蔽注释、字符串、字符字面量和 Java
 * text block，避免其中的花括号破坏方法边界。
 */
export class JavaTestStructureService {
  findTestMethods(code: string): JavaTestMethodSpan[] {
    return this.findMethods(code).filter((method) => method.isTestMethod);
  }

  findMethods(code: string): JavaMethodSpan[] {
    const sanitized = sanitizeJava(code);
    const rootOpen = this.rootTypeOpeningBrace(sanitized);
    if (rootOpen < 0) {
      return [];
    }
    const methods: JavaMethodSpan[] = [];
    let memberStart = rootOpen + 1;
    let index = rootOpen + 1;
    let parenthesisDepth = 0;
    let annotationArrayDepth = 0;
    while (index < sanitized.length) {
      const character = sanitized[index];
      if (character === '(') {
        parenthesisDepth += 1;
        index += 1;
        continue;
      }
      if (character === ')') {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        index += 1;
        continue;
      }
      if (
        character === '{'
        && (parenthesisDepth > 0 || annotationArrayDepth > 0)
      ) {
        annotationArrayDepth += 1;
        index += 1;
        continue;
      }
      if (character === '}' && annotationArrayDepth > 0) {
        annotationArrayDepth -= 1;
        index += 1;
        continue;
      }
      if (character === '}') {
        break;
      }
      if (character === ';') {
        memberStart = index + 1;
        index += 1;
        continue;
      }
      if (character !== '{') {
        index += 1;
        continue;
      }

      const close = matchingBrace(sanitized, index);
      if (close < 0) {
        return [];
      }
      const header = sanitized.slice(memberStart, index);
      if (isFieldInitializerHeader(header)) {
        index = close + 1;
        parenthesisDepth = 0;
        annotationArrayDepth = 0;
        continue;
      }
      const annotation = header.search(TEST_ANNOTATION_PATTERN);
      const lifecycleAnnotation = header.search(LIFECYCLE_ANNOTATION_PATTERN);
      const name = methodNameFromHeader(header);
      if (name && !looksLikeTypeDeclaration(header)) {
        const firstToken = firstNonWhitespaceOffset(header);
        const declarationOffset = memberStart + firstToken;
        const startOffset = Math.max(
          rootOpen + 1,
          memberStart,
          lineStart(code, declarationOffset)
        );
        const endOffset = includeTrailingLineBreak(code, close + 1);
        methods.push({
          name,
          startOffset,
          endOffset,
          startLine: lineNumberAt(code, startOffset),
          endLine: lineNumberAt(code, close),
          bodyStartOffset: index,
          bodyEndOffset: close + 1,
          isTestMethod: annotation >= 0,
          isLifecycleMethod: lifecycleAnnotation >= 0
        });
      }
      memberStart = close + 1;
      index = close + 1;
      parenthesisDepth = 0;
      annotationArrayDepth = 0;
    }
    return methods;
  }

  findFields(code: string): JavaFieldSpan[] {
    const sanitized = sanitizeJava(code);
    const rootOpen = this.rootTypeOpeningBrace(sanitized);
    if (rootOpen < 0) return [];
    const fields: JavaFieldSpan[] = [];
    let memberStart = rootOpen + 1;
    let index = rootOpen + 1;
    let parenthesisDepth = 0;
    let squareDepth = 0;
    while (index < sanitized.length) {
      const character = sanitized[index];
      if (character === '(') parenthesisDepth += 1;
      else if (character === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (character === '[') squareDepth += 1;
      else if (character === ']') squareDepth = Math.max(0, squareDepth - 1);
      else if (character === '}' && parenthesisDepth === 0 && squareDepth === 0) break;
      else if (character === '{' && parenthesisDepth === 0 && squareDepth === 0) {
        const close = matchingBrace(sanitized, index);
        if (close < 0) return [];
        const header = sanitized.slice(memberStart, index);
        if (!isFieldInitializerHeader(header)) {
          memberStart = close + 1;
        }
        index = close;
      } else if (character === ';' && parenthesisDepth === 0 && squareDepth === 0) {
        const declaration = sanitized.slice(memberStart, index + 1);
        const names = fieldNamesFromDeclaration(declaration);
        if (names.length > 0) {
          const firstToken = firstNonWhitespaceOffset(declaration);
          const startOffset = Math.max(
            rootOpen + 1,
            memberStart,
            lineStart(code, memberStart + firstToken)
          );
          const endOffset = includeTrailingLineBreak(code, index + 1);
          fields.push({
            names,
            startOffset,
            endOffset,
            startLine: lineNumberAt(code, startOffset),
            endLine: lineNumberAt(code, index)
          });
        }
        memberStart = index + 1;
      }
      index += 1;
    }
    return fields;
  }

  invokedMethods(code: string, method: JavaMethodSpan): string[] {
    const body = sanitizeJava(code).slice(
      method.bodyStartOffset + 1,
      method.bodyEndOffset - 1
    );
    const names = new Set<string>();
    for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      names.add(match[1]);
    }
    return [...names];
  }

  private rootTypeOpeningBrace(sanitized: string): number {
    const match = /\b(?:class|record|interface|enum)\s+[A-Za-z_$][\w$]*[^{};]*\{/
      .exec(sanitized);
    return match
      ? match.index + match[0].lastIndexOf('{')
      : -1;
  }
}

function looksLikeTypeDeclaration(header: string): boolean {
  return /\b(?:class|record|interface|enum)\s+[A-Za-z_$][\w$]*/.test(header);
}

function firstNonWhitespaceOffset(value: string): number {
  const index = value.search(/\S/);
  return index < 0 ? 0 : index;
}

function isFieldInitializerHeader(header: string): boolean {
  let parenthesisDepth = 0;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '(') parenthesisDepth += 1;
    else if (character === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    } else if (parenthesisDepth === 0 && character === '=') {
      return true;
    } else if (
      parenthesisDepth === 0
      && character === '-'
      && header[index + 1] === '>'
    ) {
      return true;
    }
  }
  return false;
}

function fieldNamesFromDeclaration(declaration: string): string[] {
  const withoutAnnotations = declaration.replace(
    /@(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*(?:\s*\([^)]*\))?/g,
    ' '
  );
  if (/\b(?:class|record|interface|enum)\b/.test(withoutAnnotations)) {
    return [];
  }
  const parts = splitTopLevel(withoutAnnotations.slice(0, -1), ',');
  const names: string[] = [];
  for (const part of parts) {
    const beforeInitializer = splitTopLevel(part, '=')[0]?.trim() ?? '';
    const name = /([A-Za-z_$][\w$]*)\s*(?:\[\s*\]\s*)*$/.exec(
      beforeInitializer
    )?.[1];
    if (name && !JAVA_NON_FIELD_WORDS.has(name)) names.push(name);
  }
  return names;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let angle = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') round += 1;
    else if (character === ')') round = Math.max(0, round - 1);
    else if (character === '[') square += 1;
    else if (character === ']') square = Math.max(0, square - 1);
    else if (character === '{') curly += 1;
    else if (character === '}') curly = Math.max(0, curly - 1);
    else if (character === '<') angle += 1;
    else if (character === '>') angle = Math.max(0, angle - 1);
    else if (
      character === separator
      && round === 0
      && square === 0
      && curly === 0
      && angle === 0
    ) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

const JAVA_NON_FIELD_WORDS = new Set([
  'return', 'throw', 'break', 'continue', 'package', 'import'
]);

export function sanitizeJava(code: string): string {
  const output = [...code];
  let index = 0;
  const blank = (position: number): void => {
    if (output[position] !== '\n' && output[position] !== '\r') {
      output[position] = ' ';
    }
  };
  while (index < code.length) {
    if (code.startsWith('//', index)) {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < code.length && code[index] !== '\n') {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (code.startsWith('/*', index)) {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < code.length && !code.startsWith('*/', index)) {
        blank(index);
        index += 1;
      }
      if (index < code.length) {
        blank(index);
        blank(index + 1);
        index += 2;
      }
      continue;
    }
    if (code.startsWith('"""', index)) {
      blank(index);
      blank(index + 1);
      blank(index + 2);
      index += 3;
      while (index < code.length && !code.startsWith('"""', index)) {
        blank(index);
        index += 1;
      }
      if (index < code.length) {
        blank(index);
        blank(index + 1);
        blank(index + 2);
        index += 3;
      }
      continue;
    }
    if (code[index] === '"' || code[index] === '\'') {
      const quote = code[index];
      blank(index);
      index += 1;
      while (index < code.length) {
        if (code[index] === '\\') {
          blank(index);
          if (index + 1 < code.length) {
            blank(index + 1);
          }
          index += 2;
          continue;
        }
        const current = code[index];
        blank(index);
        index += 1;
        if (current === quote || current === '\n' || current === '\r') {
          break;
        }
      }
      continue;
    }
    index += 1;
  }
  return output.join('');
}

/**
 * Canonical Java representation for behavioral comparison. Comments and
 * formatting are ignored, while string, character and text-block contents
 * remain byte-significant.
 */
export function normalizeJavaForComparison(code: string): string {
  const tokens: string[] = [];
  let index = 0;
  while (index < code.length) {
    if (code.startsWith('//', index)) {
      index += 2;
      while (index < code.length && code[index] !== '\n' && code[index] !== '\r') {
        index += 1;
      }
      continue;
    }
    if (code.startsWith('/*', index)) {
      index += 2;
      while (index < code.length && !code.startsWith('*/', index)) index += 1;
      index = Math.min(code.length, index + 2);
      continue;
    }
    if (code.startsWith('"""', index)) {
      const start = index;
      index += 3;
      while (index < code.length && !code.startsWith('"""', index)) index += 1;
      index = Math.min(code.length, index + 3);
      tokens.push(code.slice(start, index).replace(/\r\n?/g, '\n'));
      continue;
    }
    if (code[index] === '"' || code[index] === '\'') {
      const quote = code[index];
      const start = index;
      index += 1;
      while (index < code.length) {
        if (code[index] === '\\') {
          index = Math.min(code.length, index + 2);
          continue;
        }
        const current = code[index];
        index += 1;
        if (current === quote || current === '\n' || current === '\r') break;
      }
      tokens.push(code.slice(start, index));
      continue;
    }
    if (/\s/.test(code[index])) {
      index += 1;
      continue;
    }
    if (isJavaWordCharacter(code[index])) {
      const start = index;
      index += 1;
      while (index < code.length && isJavaWordCharacter(code[index])) {
        index += 1;
      }
      tokens.push(code.slice(start, index));
      continue;
    }
    const operator = JAVA_MULTI_CHARACTER_TOKENS.find((value) => (
      code.startsWith(value, index)
    ));
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    tokens.push(code[index]);
    index += 1;
  }
  return JSON.stringify(tokens);
}

const JAVA_MULTI_CHARACTER_TOKENS = [
  '>>>=', '<<=', '>>=', '...', '>>>', '::', '->', '==', '!=', '<=', '>=',
  '&&', '||', '++', '--', '<<', '>>', '+=', '-=', '*=', '/=', '&=', '|=',
  '^=', '%='
] as const;

function isJavaWordCharacter(value: string): boolean {
  return value === '$' || value === '_' || /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}\u200C\u200D]/u.test(value);
}

export function matchingBrace(code: string, opening: number): number {
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === '{') {
      depth += 1;
    } else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function methodNameFromHeader(header: string): string | null {
  const closeParenthesis = header.lastIndexOf(')');
  if (closeParenthesis < 0) {
    return null;
  }
  let depth = 0;
  let openParenthesis = -1;
  for (let index = closeParenthesis; index >= 0; index -= 1) {
    if (header[index] === ')') {
      depth += 1;
    } else if (header[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        openParenthesis = index;
        break;
      }
    }
  }
  if (openParenthesis < 0) {
    return null;
  }
  const prefix = header.slice(0, openParenthesis);
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix)?.[1];
  return name ?? null;
}

function lineStart(code: string, offset: number): number {
  const newline = code.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function includeTrailingLineBreak(code: string, offset: number): number {
  let end = offset;
  while (end < code.length && (code[end] === ' ' || code[end] === '\t')) {
    end += 1;
  }
  if (code[end] === '\r' && code[end + 1] === '\n') {
    return end + 2;
  }
  if (code[end] === '\n' || code[end] === '\r') {
    return end + 1;
  }
  return end;
}

function lineNumberAt(code: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (code[index] === '\n') {
      line += 1;
    }
  }
  return line;
}

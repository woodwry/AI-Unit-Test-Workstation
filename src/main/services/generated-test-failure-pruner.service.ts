import type {
  CandidateExecutionFeedback
} from './method-generation-contract.ts';
import {
  JavaTestStructureService,
  sanitizeJava,
  type JavaMethodSpan
} from './java-test-structure.service.ts';

type PruneFailedMethodsInput = {
  code: string;
  candidateFilePath: string;
  execution: CandidateExecutionFeedback;
  additionalMavenOutput?: string;
};

export type CommentFailingTestMethodsResult = PruneFailedMethodsResult & {
  commentedMemberIds: string[];
};

export type CommentNamedTestMethodsInput = {
  code: string;
  testMethodNames: readonly string[];
};

export type PruneFailedMethodsResult = {
  code: string;
  commentedMethods: string[];
};

export const FAILED_TEST_REPAIR_TODO_COMMENT = '// TODO 当前测试方法需要修复';

export class GeneratedTestFailurePrunerService {
  private readonly structureService: JavaTestStructureService;

  constructor(
    structureService = new JavaTestStructureService()
  ) {
    this.structureService = structureService;
  }

  prune(input: PruneFailedMethodsInput): PruneFailedMethodsResult {
    const allMethods = this.structureService.findMethods(input.code);
    const methods = allMethods.filter((method) => method.isTestMethod);
    if (methods.length === 0) {
      return { code: input.code, commentedMethods: [] };
    }
    const selected = new Set<JavaMethodSpan>();
    const statementComments = new Map<string, {
      method: JavaMethodSpan;
      startOffset: number;
      endOffset: number;
    }>();
    const importComments = new Map<string, {
      startOffset: number;
      endOffset: number;
    }>();
    for (const failure of input.execution.testReport?.failureDetails ?? []) {
      const match = this.uniqueMethodForSurefireName(
        methods,
        failure.testName
      );
      if (match && isUnnecessaryMockitoStubbing(failure)) {
        const statements = statementsForFailure(
          input.code,
          match,
          failure,
          input.candidateFilePath
        );
        let foundMockitoStubbing = false;
        for (const statement of statements) {
          if (!looksLikeMockitoStubbingStatement(
            input.code.slice(statement.startOffset, statement.endOffset)
          )) continue;
          statementComments.set(
            `${statement.startOffset}:${statement.endOffset}`,
            { method: match, ...statement }
          );
          foundMockitoStubbing = true;
        }
        if (foundMockitoStubbing) continue;
      }
      if (failure.kind === 'failure') {
        if (match) {
          const statement = assertionStatementForFailure(
            input.code,
            match,
            failure,
            input.candidateFilePath
          );
          if (statement) {
            statementComments.set(
              `${statement.startOffset}:${statement.endOffset}`,
              { method: match, ...statement }
            );
          }
        }
        continue;
      }
      if (match) {
        selected.add(match);
      }
    }

    const output = [
      ...input.execution.mavenExecutions.flatMap((execution) => [
        execution.stdout,
        execution.stderr
      ]),
      input.additionalMavenOutput ?? ''
    ].join('\n');
    for (const line of compilerLinesForFile(
      output,
      input.candidateFilePath
    )) {
      const matches = allMethods.filter(
        (method) => line >= method.startLine && line <= method.endLine
      );
      if (matches.length === 1) {
        const match = matches[0];
        if (match.isTestMethod) {
          selected.add(match);
        } else {
          const callers = this.callingTests(
            input.code,
            allMethods,
            methods,
            match
          );
          if (callers.length > 0) {
            callers.forEach((caller) => selected.add(caller));
          }
        }
        continue;
      }

      const importedType = explicitTypeImportAtLine(input.code, line);
      if (!importedType) continue;
      const referencingMethods = allMethods.filter((method) => (
        containsIdentifier(
          sanitizeJava(input.code.slice(method.startOffset, method.endOffset)),
          importedType.simpleName
        )
      ));
      const affectedTests = new Set<JavaMethodSpan>();
      for (const method of referencingMethods) {
        if (method.isTestMethod) {
          affectedTests.add(method);
          continue;
        }
        this.callingTests(input.code, allMethods, methods, method)
          .forEach((caller) => affectedTests.add(caller));
      }
      if (affectedTests.size === 0) continue;
      affectedTests.forEach((method) => selected.add(method));
      importComments.set(
        `${importedType.startOffset}:${importedType.endOffset}`,
        {
          startOffset: importedType.startOffset,
          endOffset: importedType.endOffset
        }
      );
    }

    const ordered = methods.filter((method) => selected.has(method));
    const activeStatementComments = [...statementComments.values()].filter(
      (comment) => !selected.has(comment.method)
    );
    if (
      ordered.length === 0
      && activeStatementComments.length === 0
    ) {
      return { code: input.code, commentedMethods: [] };
    }
    const code = replaceRanges(input.code, [
      ...ordered.map((method) => ({
        startOffset: method.startOffset,
        endOffset: method.endOffset,
        replacement: commentTestMethod(input.code, method)
      })),
      ...activeStatementComments.map((comment) => ({
        startOffset: comment.startOffset,
        endOffset: comment.endOffset,
        replacement: commentAssertionStatement(input.code, comment)
      })),
      ...[...importComments.values()].map((comment) => ({
        startOffset: comment.startOffset,
        endOffset: comment.endOffset,
        replacement: commentImport(input.code, comment)
      }))
    ]);
    return {
      code,
      commentedMethods: ordered.map((method) => method.name)
    };
  }

  /** Stable repair comments whole attributable tests, including assertion failures. */
  commentFailingTestMethods(
    input: PruneFailedMethodsInput
  ): CommentFailingTestMethodsResult {
    const allMethods = this.structureService.findMethods(input.code);
    const tests = allMethods.filter((method) => method.isTestMethod);
    const selected = new Set<JavaMethodSpan>();
    for (const failure of input.execution.testReport?.failureDetails ?? []) {
      const match = this.uniqueMethodForSurefireName(tests, failure.testName);
      if (match) selected.add(match);
    }
    const output = [
      ...input.execution.mavenExecutions.flatMap((execution) => [
        execution.stdout,
        execution.stderr
      ]),
      input.additionalMavenOutput ?? ''
    ].join('\n');
    for (const line of compilerLinesForFile(output, input.candidateFilePath)) {
      const matches = allMethods.filter((method) => (
        line >= method.startLine && line <= method.endLine
      ));
      if (matches.length !== 1) continue;
      const method = matches[0];
      if (method.isTestMethod) {
        selected.add(method);
      } else {
        this.callingTests(input.code, allMethods, tests, method)
          .forEach((test) => selected.add(test));
      }
    }
    const ordered = tests.filter((method) => selected.has(method));
    if (ordered.length === 0) {
      return {
        code: input.code,
        commentedMethods: [],
        commentedMemberIds: []
      };
    }
    return {
      code: replaceRanges(input.code, ordered.map((method) => ({
        startOffset: method.startOffset,
        endOffset: method.endOffset,
        replacement: commentTestMethod(input.code, method)
      }))),
      commentedMethods: ordered.map((method) => method.name),
      commentedMemberIds: ordered.map((method) => (
        `test:${method.name}:${method.startLine}`
      ))
    };
  }

  commentTestMethods(
    input: CommentNamedTestMethodsInput
  ): CommentFailingTestMethodsResult {
    const selectedNames = new Set(input.testMethodNames);
    const ordered = this.structureService.findMethods(input.code).filter(
      (method) => method.isTestMethod && selectedNames.has(method.name)
    );
    if (ordered.length === 0) {
      return {
        code: input.code,
        commentedMethods: [],
        commentedMemberIds: []
      };
    }
    return {
      code: replaceRanges(input.code, ordered.map((method) => ({
        startOffset: method.startOffset,
        endOffset: method.endOffset,
        replacement: commentTestMethod(input.code, method)
      }))),
      commentedMethods: ordered.map((method) => method.name),
      commentedMemberIds: ordered.map((method) => (
        `test:${method.name}:${method.startLine}`
      ))
    };
  }

  private callingTests(
    code: string,
    allMethods: JavaMethodSpan[],
    tests: JavaMethodSpan[],
    target: JavaMethodSpan
  ): JavaMethodSpan[] {
    const methodsByName = new Map<string, JavaMethodSpan[]>();
    for (const method of allMethods) {
      const entries = methodsByName.get(method.name) ?? [];
      entries.push(method);
      methodsByName.set(method.name, entries);
    }
    const calls = new Map<JavaMethodSpan, JavaMethodSpan[]>();
    for (const method of allMethods) {
      const invoked = this.structureService.invokedMethods(code, method)
        .flatMap((name) => {
          const candidates = methodsByName.get(name) ?? [];
          return candidates.length === 1 ? candidates : [];
        });
      calls.set(method, invoked);
    }
    return tests.filter((test) => reaches(test, target, calls));
  }

  private uniqueMethodForSurefireName(
    methods: JavaMethodSpan[],
    testName: string
  ): JavaMethodSpan | null {
    const exact = methods.filter((method) => method.name === testName);
    if (exact.length === 1) {
      return exact[0];
    }
    const normalized = testName.trim();
    const matches = methods.filter((method) => {
      const escaped = method.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped}(?:\\(|\\[|$)`).test(normalized);
    });
    return matches.length === 1 ? matches[0] : null;
  }
}

function explicitTypeImportAtLine(
  code: string,
  line: number
): {
  simpleName: string;
  startOffset: number;
  endOffset: number;
} | null {
  const range = lineRange(code, line);
  if (!range) return null;
  const source = code.slice(range.startOffset, range.endOffset);
  const match = /^\s*import\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*;\s*$/.exec(
    source
  );
  if (!match) return null;
  const simpleName = match[1].split('.').at(-1) ?? '';
  if (!simpleName || simpleName === '*') return null;
  return {
    simpleName,
    startOffset: range.startOffset,
    endOffset: range.endOffset
  };
}

function containsIdentifier(code: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(code);
}

function commentImport(
  code: string,
  range: { startOffset: number; endOffset: number }
): string {
  const source = code.slice(range.startOffset, range.endOffset);
  const indent = /^[\t ]*/.exec(source)?.[0] ?? '';
  return `${indent}// ${source.slice(indent.length)}`;
}

function reaches(
  start: JavaMethodSpan,
  target: JavaMethodSpan,
  calls: ReadonlyMap<JavaMethodSpan, JavaMethodSpan[]>
): boolean {
  const pending = [...(calls.get(start) ?? [])];
  const visited = new Set<JavaMethodSpan>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    pending.push(...(calls.get(current) ?? []));
  }
  return false;
}

function replaceRanges(
  code: string,
  replacements: Array<{
    startOffset: number;
    endOffset: number;
    replacement: string;
  }>
): string {
  let result = code;
  const ordered = [...replacements].sort((left, right) => (
    right.startOffset - left.startOffset
  ));
  for (const item of ordered) {
    result = result.slice(0, item.startOffset)
      + item.replacement
      + result.slice(item.endOffset);
  }
  return result;
}

function commentTestMethod(
  code: string,
  range: Pick<JavaMethodSpan, 'startOffset' | 'endOffset'>
): string {
  const source = code.slice(range.startOffset, range.endOffset);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = /(?:\r\n|\r|\n)$/.test(source);
  const lines = source.split(/\r\n|\r|\n/);
  if (hasTrailingNewline) lines.pop();
  const firstContent = lines.find((line) => line.trim()) ?? '';
  const indent = /^[\t ]*/.exec(firstContent)?.[0] ?? '';
  const commented = lines.map((line) => {
    const content = line.startsWith(indent) ? line.slice(indent.length) : line;
    return content.length > 0 ? `${indent}// ${content}` : `${indent}//`;
  });
  const result = [
    `${indent}${FAILED_TEST_REPAIR_TODO_COMMENT}`,
    ...commented
  ].join(newline);
  return hasTrailingNewline ? `${result}${newline}` : result;
}

function assertionStatementForFailure(
  code: string,
  method: JavaMethodSpan,
  failure: NonNullable<CandidateExecutionFeedback['testReport']>['failureDetails'][number],
  candidateFilePath: string
): { startOffset: number; endOffset: number } | null {
  const statement = statementForFailure(
    code,
    method,
    failure,
    candidateFilePath
  );
  return statement && looksLikeAssertionStatement(
    code.slice(statement.startOffset, statement.endOffset)
  )
    ? statement
    : null;
}

function statementForFailure(
  code: string,
  method: JavaMethodSpan,
  failure: NonNullable<CandidateExecutionFeedback['testReport']>['failureDetails'][number],
  candidateFilePath: string
): { startOffset: number; endOffset: number } | null {
  return statementsForFailure(
    code,
    method,
    failure,
    candidateFilePath
  )[0] ?? null;
}

function statementsForFailure(
  code: string,
  method: JavaMethodSpan,
  failure: NonNullable<CandidateExecutionFeedback['testReport']>['failureDetails'][number],
  candidateFilePath: string
): Array<{ startOffset: number; endOffset: number }> {
  const candidateFileName = normalizePath(candidateFilePath).split('/').at(-1);
  if (!candidateFileName || !failure.detail) return [];
  const statements = new Map<string, { startOffset: number; endOffset: number }>();
  const framePattern = /\bat\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.[A-Za-z_$][\w$]*\(([^()\r\n]+\.java):(\d+)\)/g;
  for (const frame of failure.detail.matchAll(framePattern)) {
    if (normalizePath(frame[1]).split('/').at(-1) !== candidateFileName) continue;
    const sourceLine = Number(frame[2]);
    if (!Number.isSafeInteger(sourceLine)
      || sourceLine < method.startLine
      || sourceLine > method.endLine) {
      continue;
    }
    const statement = statementRangeAtLine(code, method, sourceLine);
    if (statement) {
      statements.set(
        `${statement.startOffset}:${statement.endOffset}`,
        statement
      );
    }
  }
  return [...statements.values()];
}

function isUnnecessaryMockitoStubbing(
  failure: NonNullable<CandidateExecutionFeedback['testReport']>['failureDetails'][number]
): boolean {
  return failure.kind === 'error'
    && failure.type === 'org.mockito.exceptions.misusing.UnnecessaryStubbingException';
}

function looksLikeMockitoStubbingStatement(source: string): boolean {
  const sanitized = sanitizeJava(source);
  return /(?:^|[^\w$])(?:lenient\s*\(\s*\)\s*\.\s*)?when\s*\(/m.test(sanitized)
    || /(?:^|[^\w$])do(?:Return|Throw|Answer|Nothing|CallRealMethod)\s*\(/m.test(sanitized);
}

function statementRangeAtLine(
  code: string,
  method: JavaMethodSpan,
  sourceLine: number
): { startOffset: number; endOffset: number } | null {
  const sanitized = sanitizeJava(code);
  const sourceLineRange = lineRange(code, sourceLine);
  if (!sourceLineRange) return null;
  const lineSource = sanitized.slice(
    sourceLineRange.startOffset,
    sourceLineRange.endOffset
  );
  const firstToken = /\S/.exec(lineSource);
  if (!firstToken) return null;
  const anchor = sourceLineRange.startOffset + firstToken.index;
  const bodyStart = method.bodyStartOffset + 1;
  const bodyEnd = method.bodyEndOffset - 1;
  if (anchor < bodyStart || anchor >= bodyEnd) return null;

  let startOffset = bodyStart;
  let parenthesisDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  for (let index = anchor - 1; index >= bodyStart; index -= 1) {
    const character = sanitized[index];
    if (character === ')') parenthesisDepth += 1;
    else if (character === '(' && parenthesisDepth > 0) parenthesisDepth -= 1;
    else if (character === ']') squareDepth += 1;
    else if (character === '[' && squareDepth > 0) squareDepth -= 1;
    else if (character === '}') braceDepth += 1;
    else if (character === '{') {
      if (braceDepth > 0) braceDepth -= 1;
      else if (parenthesisDepth === 0 && squareDepth === 0) {
        startOffset = index + 1;
        break;
      }
    } else if (
      character === ';'
      && parenthesisDepth === 0
      && squareDepth === 0
      && braceDepth === 0
    ) {
      startOffset = index + 1;
      break;
    }
  }
  const firstStatementToken = /\S/.exec(
    sanitized.slice(startOffset, bodyEnd)
  );
  if (!firstStatementToken) return null;
  startOffset += firstStatementToken.index;

  parenthesisDepth = 0;
  squareDepth = 0;
  braceDepth = 0;
  let endOffset = -1;
  for (let index = startOffset; index < bodyEnd; index += 1) {
    const character = sanitized[index];
    if (character === '(') parenthesisDepth += 1;
    else if (character === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    else if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth = Math.max(0, squareDepth - 1);
    else if (character === '{') braceDepth += 1;
    else if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (
      character === ';'
      && parenthesisDepth === 0
      && squareDepth === 0
      && braceDepth === 0
    ) {
      endOffset = index + 1;
      break;
    }
  }
  if (endOffset < 0 || anchor < startOffset || anchor >= endOffset) return null;

  const statementLineStart = lineStartOffset(code, startOffset);
  if (/^[\t ]*$/.test(code.slice(statementLineStart, startOffset))) {
    startOffset = statementLineStart;
  }
  return { startOffset, endOffset };
}

function looksLikeAssertionStatement(source: string): boolean {
  const sanitized = sanitizeJava(source);
  return /(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\.)*(?:assert[A-Z][\w$]*|fail)\s*\(/m.test(sanitized)
    || /^\s*assert\b/m.test(sanitized)
    || /(?:^|[^\w$])verify(?:NoInteractions|NoMoreInteractions|ZeroInteractions)?\s*\(/m.test(sanitized)
    || /(?:^|[^\w$])assertSoftly\s*\(/m.test(sanitized)
    || /(?:^|[^\w$])then\s*\([\s\S]*?\)\s*\.\s*should\b/m.test(sanitized);
}

function commentAssertionStatement(
  code: string,
  range: { startOffset: number; endOffset: number }
): string {
  const source = code.slice(range.startOffset, range.endOffset);
  const sourceLineStart = lineStartOffset(code, range.startOffset);
  if (/\S/.test(code.slice(sourceLineStart, range.startOffset))) {
    return `/* ${source} */`;
  }
  return source.split(/(\r\n|\r|\n)/).map((part, index) => {
    if (index % 2 === 1) return part;
    if (!part) return part;
    const indent = /^[\t ]*/.exec(part)?.[0] ?? '';
    const content = part.slice(indent.length);
    return content ? `${indent}// ${content}` : `${indent}//`;
  }).join('');
}

function lineRange(
  code: string,
  line: number
): { startOffset: number; endOffset: number } | null {
  if (!Number.isSafeInteger(line) || line < 1) return null;
  let startOffset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = code.indexOf('\n', startOffset);
    if (newline < 0) return null;
    startOffset = newline + 1;
  }
  const newline = code.indexOf('\n', startOffset);
  let endOffset = newline < 0 ? code.length : newline;
  if (endOffset > startOffset && code[endOffset - 1] === '\r') endOffset -= 1;
  return { startOffset, endOffset };
}

function lineStartOffset(code: string, offset: number): number {
  return code.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function compilerLinesForFile(
  output: string,
  candidateFilePath: string
): number[] {
  const expected = normalizePath(candidateFilePath);
  const lines = new Set<number>();
  const patterns = [
    /((?:[A-Za-z]:[\\/]|\/)[^\r\n]*?\.java):\[(\d+),\d+\]/g,
    /((?:[A-Za-z]:[\\/]|\/)[^\r\n]*?\.java):(\d+):(?:\d+:)?/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      if (normalizePath(match[1]) !== expected) {
        continue;
      }
      const line = Number(match[2]);
      if (Number.isSafeInteger(line) && line > 0) {
        lines.add(line);
      }
    }
  }
  return [...lines];
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/^file:\/*/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/(?=[a-z]:\/)/i, '')
    .toLowerCase();
}

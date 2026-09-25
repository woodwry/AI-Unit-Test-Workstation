import { readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import type {
  CandidateExecutionFeedback
} from './method-generation-contract.ts';
import { sanitizePublicText } from './maven-command.ts';

export type MavenRepairCompilerError = {
  filePath: string;
  line: number;
  column: number;
  category: string;
  message: string;
};

export type MavenRepairStackFrame = {
  ownerFqn: string;
  methodName: string;
  sourceFile: string;
  sourceLine: number;
};

export type MavenRepairException = {
  testName: string | null;
  testLocation: MavenRepairStackFrame | null;
  type: string;
  message: string;
  failingLocation: MavenRepairStackFrame | null;
  failingStatement: string | null;
  stackFrames: MavenRepairStackFrame[];
};

export type MavenRepairDiagnostic = {
  status: 'compile_failed' | 'test_failed';
  compilerErrors: MavenRepairCompilerError[];
  affectedTestNames: string[];
  exceptions: MavenRepairException[];
  generatedTestFrames: MavenRepairStackFrame[];
  productionFrames: MavenRepairStackFrame[];
  missingSymbols: string[];
  relatedTypeFqns: string[];
  truncated: boolean;
  droppedItemCount: number;
};

export type MavenRepairDiagnosticInput = {
  execution: CandidateExecutionFeedback;
  generatedTestFilePath: string;
  generatedTestClassName: string;
  targetProductionClassName: string;
  targetProductionFilePath?: string;
};

const MAX_COMPILER_ERRORS = 32;
const MAX_AFFECTED_TESTS = 32;
const MAX_EXCEPTIONS = 20;
const MAX_FRAMES = 32;
const MAX_SYMBOLS = 64;
const MAX_RELATED_TYPES = 64;
const MAX_COMPILER_MESSAGE = 4_000;
const MAX_EXCEPTION_MESSAGE = 2_000;
const TRANSPARENT_EXCEPTION_WRAPPERS = new Set([
  'java.lang.reflect.InvocationTargetException',
  'java.lang.reflect.UndeclaredThrowableException',
  'java.util.concurrent.ExecutionException',
  'java.util.concurrent.CompletionException'
]);

/** Converts only the newest Maven/Surefire execution into bounded repair facts. */
export class MavenRepairDiagnosticService {
  normalize(input: MavenRepairDiagnosticInput): MavenRepairDiagnostic {
    if (input.execution.status === 'passed') {
      throw new Error('A passing Maven execution does not need repair diagnostics.');
    }
    const outputs = input.execution.mavenExecutions.flatMap((execution) => [
      execution.stdout,
      execution.stderr,
      ...execution.surefireReports
        .filter((artifact) => /\.(?:dump|dumpstream)$/i.test(artifact.fileName))
        .map((artifact) => artifact.content)
    ]).filter(Boolean);
    let droppedItemCount = 0;
    const markDropped = (count = 1): void => {
      droppedItemCount += count;
    };

    const compilerErrors = this.compilerErrors(
      outputs,
      input.generatedTestFilePath,
      markDropped
    );
    const affectedTestNames = this.affectedTestNames(
      input.execution,
      outputs,
      markDropped
    );
    const exceptions = this.exceptions(
      input.execution,
      outputs,
      input.generatedTestClassName,
      input.targetProductionClassName,
      input.targetProductionFilePath,
      markDropped
    );
    const exceptionFrames = exceptions.flatMap((error) => error.stackFrames);
    const generatedTestFrames = this.boundedUnique(
      exceptionFrames.filter((frame) => this.sameOwner(
        frame.ownerFqn,
        input.generatedTestClassName
      )),
      MAX_FRAMES,
      frameKey,
      markDropped
    );
    const productionFrames = this.boundedUnique(
      exceptionFrames.filter((frame) => this.sameOwner(
        frame.ownerFqn,
        input.targetProductionClassName
      )),
      MAX_FRAMES,
      frameKey,
      markDropped
    );
    const combinedOutput = outputs.join('\n');
    const missingSymbols = this.boundedStrings(
      this.missingSymbols(combinedOutput),
      MAX_SYMBOLS,
      markDropped
    );
    const relatedTypeFqns = this.boundedStrings(
      this.relatedTypes(
        combinedOutput,
        input.generatedTestClassName,
        input.targetProductionClassName
      ),
      MAX_RELATED_TYPES,
      markDropped
    );

    return {
      status: input.execution.status,
      compilerErrors,
      affectedTestNames,
      exceptions,
      generatedTestFrames,
      productionFrames,
      missingSymbols,
      relatedTypeFqns,
      truncated: droppedItemCount > 0,
      droppedItemCount
    };
  }

  private compilerErrors(
    outputs: readonly string[],
    expectedPath: string,
    onDrop: (count?: number) => void
  ): MavenRepairCompilerError[] {
    const expected = normalizePath(expectedPath);
    const ordered: MavenRepairCompilerError[] = [];
    const indexByKey = new Map<string, number>();
    for (const output of outputs) {
      for (const parsed of parseCompilerItems(output)) {
        if (normalizePath(parsed.filePath) !== expected) continue;
        const message = cleanText(parsed.message);
        if (!message || message.length > MAX_COMPILER_MESSAGE) {
          onDrop();
          continue;
        }
        const category = compilerCategory(message);
        const key = [
          expected,
          parsed.line,
          parsed.column,
          category,
          cleanText(parsed.primaryMessage).toLowerCase()
        ].join('|');
        const existing = indexByKey.get(key);
        if (existing !== undefined) {
          if (message.length > ordered[existing].message.length) {
            ordered[existing] = { ...ordered[existing], message };
          }
          continue;
        }
        if (ordered.length >= MAX_COMPILER_ERRORS) {
          onDrop();
          continue;
        }
        indexByKey.set(key, ordered.length);
        ordered.push({
          filePath: cleanText(parsed.filePath),
          line: parsed.line,
          column: parsed.column,
          category,
          message
        });
      }
    }
    return ordered;
  }

  private affectedTestNames(
    execution: CandidateExecutionFeedback,
    outputs: readonly string[],
    onDrop: (count?: number) => void
  ): string[] {
    const names = [
      ...(execution.testReport?.failureDetails.map((failure) =>
        failure.testName) ?? []),
      ...outputs.flatMap((output) => [...output.matchAll(
        /(?:^|\n)\s*\[ERROR\]\s+([A-Za-z_$][\w$]*(?:\([^\r\n]*\)|\[[^\r\n]*\])?)\s+Time elapsed\b/g
      )].map((match) => match[1]))
    ];
    return this.boundedStrings(names, MAX_AFFECTED_TESTS, onDrop);
  }

  private exceptions(
    execution: CandidateExecutionFeedback,
    outputs: readonly string[],
    generatedTestClassName: string,
    targetProductionClassName: string,
    targetProductionFilePath: string | undefined,
    onDrop: (count?: number) => void
  ): MavenRepairException[] {
    const candidates: MavenRepairException[] = [];
    for (const failure of execution.testReport?.failureDetails ?? []) {
      const detail = cleanTextPreservingLines(failure.detail ?? '');
      const parsedHeader = parseExceptionHeader(detail.split(/\r?\n/)[0] ?? '');
      const rootCauseHeader = parseDeepestCauseHeader(detail);
      const reportedType = cleanText(failure.type ?? parsedHeader?.type ?? (
        failure.kind === 'failure' ? 'assertion_failure' : 'test_error'
      ));
      const reportedMessage = cleanText(
        failure.message ?? parsedHeader?.message ?? ''
      );
      const unwrapRootCause = failure.kind === 'error'
        && TRANSPARENT_EXCEPTION_WRAPPERS.has(reportedType);
      const type = unwrapRootCause && rootCauseHeader?.type
        ? cleanText(rootCauseHeader.type)
        : reportedType;
      const message = unwrapRootCause && rootCauseHeader?.message
        ? cleanText(rootCauseHeader.message)
        : reportedMessage;
      const frames = relevantFrames(
        parseStackFramesRootCauseFirst(detail),
        generatedTestClassName,
        targetProductionClassName,
        normalizedSurefireTestName(failure.testName)
      );
      const testLocation = generatedTestLocation(
        frames,
        generatedTestClassName,
        failure.testName
      );
      const failingLocation = frames[0] ?? null;
      candidates.push({
        testName: cleanText(failure.testName) || testLocation?.methodName || null,
        testLocation,
        type,
        message,
        failingLocation,
        failingStatement: sourceStatementFromFrames(
          frames,
          targetProductionClassName,
          targetProductionFilePath
        ),
        stackFrames: frames
      });
    }
    const report = execution.testReport;
    const completeFailureDetails = report !== undefined && report !== null
      && report.failureDetails.length > 0
      && report.failureDetails.length >= report.failures + report.errors
      && report.failureDetails.every((failure) => Boolean(failure.detail?.trim()));
    // A complete Surefire failure list is authoritative: stdout also contains caught
    // exceptions from passing tests and must not turn them into repair targets.
    if (!completeFailureDetails) {
      outputs.forEach((output) => candidates.push(...parseConsoleExceptions(
        output,
        generatedTestClassName,
        targetProductionClassName,
        targetProductionFilePath
      )));
    }

    const result: MavenRepairException[] = [];
    const keys = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.type || candidate.message.length > MAX_EXCEPTION_MESSAGE) {
        onDrop();
        continue;
      }
      const location = candidate.failingLocation;
      const key = [
        candidate.testName?.toLowerCase() ?? '',
        candidate.testLocation?.ownerFqn.toLowerCase() ?? '',
        candidate.testLocation?.methodName ?? '',
        candidate.testLocation?.sourceLine ?? 0,
        candidate.type.toLowerCase(),
        candidate.message.toLowerCase(),
        location?.ownerFqn.toLowerCase() ?? '',
        location?.methodName ?? '',
        location?.sourceLine ?? 0
      ].join('|');
      if (keys.has(key)) continue;
      if (result.length >= MAX_EXCEPTIONS) {
        onDrop();
        continue;
      }
      keys.add(key);
      result.push(candidate);
    }
    return result;
  }

  private missingSymbols(output: string): string[] {
    const result: string[] = [];
    const pattern = /(?:cannot find symbol\s*:\s*)?symbol\s*:\s*(?:method|class|variable)\s+([A-Za-z_$][\w$]*)/gi;
    for (const match of sanitizePublicText(output).matchAll(pattern)) {
      result.push(match[1]);
    }
    const inline = /cannot find symbol\s*:\s*(?:method|class|variable)\s+([A-Za-z_$][\w$]*)/gi;
    for (const match of sanitizePublicText(output).matchAll(inline)) {
      result.push(match[1]);
    }
    const localized = /符号\s*:\s*(?:方法|类|变量)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of sanitizePublicText(output).matchAll(localized)) {
      result.push(match[1]);
    }
    return result;
  }

  private relatedTypes(
    output: string,
    generatedTestClassName: string,
    targetProductionClassName: string
  ): string[] {
    const ignored = new Set([
      generatedTestClassName,
      targetProductionClassName
    ].map((value) => value.replace(/\$/g, '.')));
    const result: string[] = [];
    const pattern = /(?<![\w$])(?:[a-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?![\w$])/g;
    for (const match of sanitizePublicText(output).matchAll(pattern)) {
      const value = match[0].replace(/\$/g, '.');
      const simple = value.slice(value.lastIndexOf('.') + 1);
      if (!/^[A-Z_$]/.test(simple) || ignored.has(value)) continue;
      result.push(value);
    }
    return result;
  }

  private boundedStrings(
    values: readonly string[],
    maximum: number,
    onDrop: (count?: number) => void
  ): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
      const value = cleanText(raw);
      if (!value || seen.has(value)) continue;
      if (result.length >= maximum) {
        onDrop();
        continue;
      }
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  private boundedUnique<T>(
    values: readonly T[],
    maximum: number,
    keyOf: (value: T) => string,
    onDrop: (count?: number) => void
  ): T[] {
    const result: T[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const key = keyOf(value);
      if (seen.has(key)) continue;
      if (result.length >= maximum) {
        onDrop();
        continue;
      }
      seen.add(key);
      result.push(value);
    }
    return result;
  }

  private sameOwner(actual: string, expected: string): boolean {
    return actual === expected || actual.startsWith(`${expected}$`);
  }
}

type ParsedCompilerItem = {
  filePath: string;
  line: number;
  column: number;
  primaryMessage: string;
  message: string;
};

function parseCompilerItems(output: string): ParsedCompilerItem[] {
  const result: ParsedCompilerItem[] = [];
  let current: ParsedCompilerItem | null = null;
  const flush = (): void => {
    if (current) result.push(current);
    current = null;
  };
  for (const rawLine of sanitizePublicText(output).split(/\r?\n/)) {
    const compilerPayload = rawLine.replace(/^\s*\[ERROR\]/, '');
    const indentedDetail = /^\s{2,}\S/.test(compilerPayload);
    const line = compilerPayload.trim();
    const bracket = /^(.+?\.java):\[(\d+),(\d+)\]\s*(.*)$/.exec(line);
    const plain = bracket ? null : /^(.+?\.java):(\d+):(?:(\d+):)?\s*(?:error:\s*)?(.*)$/.exec(line);
    const match = bracket ?? plain;
    if (match) {
      flush();
      const sourceLine = Number(match[2]);
      const column = Number(match[3] ?? 1);
      if (!Number.isSafeInteger(sourceLine) || sourceLine < 1
        || !Number.isSafeInteger(column) || column < 1) continue;
      const primaryMessage = cleanText(match[4]);
      current = {
        filePath: match[1],
        line: sourceLine,
        column,
        primaryMessage,
        message: primaryMessage
      };
      continue;
    }
    const labelledDetail = /^(?:symbol|location|required|found|reason|符号|位置)\s*:/i.test(
      line
    );
    const ambiguousDetail = current
      && indentedDetail
      && compilerCategory(current.primaryMessage) === 'ambiguous_reference';
    if (current && (labelledDetail || ambiguousDetail)) {
      current.message = `${current.message}; ${line}`;
      continue;
    }
    if (line && !/^\[?(?:INFO|WARNING)\]?\b/.test(line)) flush();
  }
  flush();
  return result;
}

function compilerCategory(message: string): string {
  const value = message.toLowerCase();
  if (value.includes('cannot find symbol') || value.includes('找不到符号')) {
    return 'cannot_find_symbol';
  }
  if (value.includes('unreported exception') || value.includes('未报告的异常')) {
    return 'unreported_exception';
  }
  if (value.includes('incompatible types')) return 'incompatible_types';
  if ((value.includes('reference to') && value.includes('ambiguous'))
    || value.includes('引用不明确')) {
    return 'ambiguous_reference';
  }
  return 'compilation_error';
}

function parseConsoleExceptions(
  output: string,
  generatedTestClassName: string,
  targetProductionClassName: string,
  targetProductionFilePath: string | undefined
): MavenRepairException[] {
  const lines = cleanTextPreservingLines(output).split(/\r?\n/);
  const result: MavenRepairException[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseExceptionHeader(lines[index]);
    if (!header) continue;
    const frameLines: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && /^\s*(?:\[ERROR\]\s*)?at\s+/.test(
      lines[cursor]
    )) {
      frameLines.push(lines[cursor]);
      cursor += 1;
    }
    const frames = relevantFrames(
      parseStackFrames(frameLines.join('\n')),
      generatedTestClassName,
      targetProductionClassName
    );
    const testLocation = generatedTestLocation(
      frames,
      generatedTestClassName,
      null
    );
    const failingLocation = frames[0] ?? null;
    result.push({
      testName: testLocation?.methodName ?? null,
      testLocation,
      type: header.type,
      message: header.message,
      failingLocation,
      failingStatement: sourceStatementFromFrames(
        frames,
        targetProductionClassName,
        targetProductionFilePath
      ),
      stackFrames: frames
    });
  }
  return result;
}

function parseExceptionHeader(
  line: string
): { type: string; message: string } | null {
  const normalized = line
    .replace(/^\s*\[ERROR\]\s*/, '')
    .replace(/^\s*Caused by:\s*/, '')
    .trim();
  const match = /^((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:Exception|Error|Failure))(?::\s*(.*))?$/.exec(
    normalized
  );
  return match ? { type: match[1], message: cleanText(match[2] ?? '') } : null;
}

function parseDeepestCauseHeader(
  value: string
): { type: string; message: string } | null {
  let deepest: { type: string; message: string } | null = null;
  for (const line of cleanTextPreservingLines(value).split(/\r?\n/)) {
    if (!/^\s*(?:\[ERROR\]\s*)?Caused by:\s*/.test(line)) continue;
    deepest = parseExceptionHeader(line) ?? deepest;
  }
  return deepest;
}

function parseStackFrames(value: string): MavenRepairStackFrame[] {
  const result: MavenRepairStackFrame[] = [];
  const normalized = cleanTextPreservingLines(value);
  const patterns = [
    // Preserve executable frames before diagnostic arrows. Mockito arrows can
    // identify a stub earlier in the same test method; they must not replace
    // the actual failing test call selected as testLocation.
    /(?:^|\n)\s*(?:\[ERROR\]\s*)?at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*|<init>|<clinit>)\(([^():\r\n]+\.java):(\d+)\)/g,
    /(?:^|\n)\s*(?:\[ERROR\]\s*)?->\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*|<init>|<clinit>)\(([^():\r\n]+\.java):(\d+)\)/g
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const sourceLine = Number(match[4]);
      if (!Number.isSafeInteger(sourceLine) || sourceLine < 1) continue;
      result.push({
        ownerFqn: match[1],
        methodName: match[2],
        sourceFile: basename(match[3]),
        sourceLine
      });
    }
  }
  return result;
}

function relevantFrames(
  frames: readonly MavenRepairStackFrame[],
  generatedTestClassName: string,
  targetProductionClassName: string,
  preferredTestMethodName?: string
): MavenRepairStackFrame[] {
  const eligible: MavenRepairStackFrame[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    const exact = matchesOwner(frame.ownerFqn, generatedTestClassName)
      || matchesOwner(frame.ownerFqn, targetProductionClassName);
    const framework = /^(?:java|javax|jdk|sun|org\.junit|org\.mockito|org\.apache\.maven\.surefire|org\.apache\.maven\.plugin|org\.codehaus\.plexus)\./.test(
      frame.ownerFqn
    );
    if (!exact && framework) continue;
    const key = frameKey(frame);
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(frame);
  }
  if (eligible.length <= 12) return eligible;

  const targetIndex = eligible.findIndex((frame) => matchesOwner(
    frame.ownerFqn,
    targetProductionClassName
  ));
  const firstTestIndex = eligible.findIndex((frame) => matchesOwner(
    frame.ownerFqn,
    generatedTestClassName
  ));
  const preferredTestIndex = preferredTestMethodName
    ? eligible.findIndex((frame) => (
      matchesOwner(frame.ownerFqn, generatedTestClassName)
      && frame.methodName === preferredTestMethodName
    ))
    : -1;
  let lastTestIndex = -1;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (matchesOwner(eligible[index].ownerFqn, generatedTestClassName)) {
      lastTestIndex = index;
      break;
    }
  }
  const requiredIndices = [...new Set([
    0,
    targetIndex,
    firstTestIndex,
    preferredTestIndex,
    lastTestIndex
  ].filter((index) => index >= 0))];
  const required = new Set(requiredIndices);
  const selected = new Set(Array.from({ length: 12 }, (_, index) => index));
  for (const requiredIndex of requiredIndices) {
    if (selected.has(requiredIndex)) continue;
    const replaceIndex = [...selected]
      .sort((left, right) => right - left)
      .find((index) => !required.has(index));
    if (replaceIndex === undefined) break;
    selected.delete(replaceIndex);
    selected.add(requiredIndex);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => eligible[index]);
}

function parseStackFramesRootCauseFirst(
  value: string
): MavenRepairStackFrame[] {
  const sections = cleanTextPreservingLines(value).split(
    /(?=^\s*(?:\[ERROR\]\s*)?Caused by:\s*)/gm
  );
  return sections.reverse().flatMap((section) => parseStackFrames(section));
}

function generatedTestLocation(
  frames: readonly MavenRepairStackFrame[],
  generatedTestClassName: string,
  surefireTestName: string | null | undefined
): MavenRepairStackFrame | null {
  const generatedFrames = frames.filter((frame) => matchesOwner(
    frame.ownerFqn,
    generatedTestClassName
  ));
  const methodName = normalizedSurefireTestName(surefireTestName ?? '');
  return generatedFrames.find((frame) => frame.methodName === methodName)
    ?? generatedFrames[0]
    ?? null;
}

function normalizedSurefireTestName(value: string): string {
  let normalized = cleanText(value);
  for (;;) {
    const stripped = normalized.replace(
      /\s*(?:\([^()]*\)|\[[^\[\]]*\])\s*$/,
      ''
    ).trim();
    if (stripped === normalized) return normalized;
    normalized = stripped;
  }
}

function matchesOwner(actual: string, expected: string): boolean {
  return actual === expected || actual.startsWith(`${expected}$`);
}

function frameKey(frame: MavenRepairStackFrame): string {
  return `${frame.ownerFqn}|${frame.methodName}|${frame.sourceLine}`;
}

function sourceStatementFromFrames(
  frames: readonly MavenRepairStackFrame[],
  targetProductionClassName: string,
  targetProductionFilePath: string | undefined
): string | null {
  const targetFrames = frames.filter((frame) => matchesOwner(
    frame.ownerFqn,
    targetProductionClassName
  ));
  const seen = new Set<string>();
  for (const frame of targetFrames) {
    const key = frameKey(frame);
    if (seen.has(key)) continue;
    seen.add(key);
    const statement = sourceStatement(
      frame,
      targetProductionClassName,
      targetProductionFilePath
    );
    if (statement) return statement;
  }
  return null;
}

function sourceStatement(
  location: MavenRepairStackFrame | null,
  targetProductionClassName: string,
  targetProductionFilePath: string | undefined
): string | null {
  if (!location || !targetProductionFilePath) return null;
  const sourceRoot = productionSourceRoot(
    targetProductionFilePath,
    targetProductionClassName
  );
  if (!sourceRoot) return null;
  const topLevelOwner = location.ownerFqn.split('$', 1)[0];
  const sourcePath = resolve(
    sourceRoot,
    ...topLevelOwner.split('.').slice(0, -1),
    `${topLevelOwner.split('.').at(-1)}.java`
  );
  const relativePath = relative(sourceRoot, sourcePath);
  if (!relativePath || relativePath.startsWith('..') || resolve(
    sourceRoot,
    relativePath
  ) !== sourcePath) return null;
  if (basename(sourcePath).toLowerCase() !== location.sourceFile.toLowerCase()) {
    return null;
  }
  try {
    const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/);
    const statement = sanitizePublicText(lines[location.sourceLine - 1] ?? '').trim();
    return statement && statement.length <= 4_000 ? statement : null;
  } catch {
    return null;
  }
}

function productionSourceRoot(
  targetProductionFilePath: string,
  targetProductionClassName: string
): string | null {
  const segments = targetProductionClassName.split('.');
  if (segments.length === 0) return null;
  segments[segments.length - 1] = `${segments.at(-1)}.java`;
  let cursor = resolve(targetProductionFilePath);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (basename(cursor).toLowerCase() !== segments[index].toLowerCase()) {
      return null;
    }
    cursor = dirname(cursor);
  }
  return cursor;
}

function normalizePath(value: string): string {
  return value.trim()
    .replace(/^file:\/*/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/([a-z]:\/)/i, '$1')
    .toLowerCase();
}

function cleanText(value: string): string {
  return sanitizePublicText(value).replace(/\s+/g, ' ').trim();
}

function cleanTextPreservingLines(value: string): string {
  return sanitizePublicText(value)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n');
}

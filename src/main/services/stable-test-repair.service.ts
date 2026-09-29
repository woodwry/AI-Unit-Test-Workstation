import type {
  CandidateExecutionFeedback
} from './method-generation-contract.ts';
import {
  GeneratedTestFailurePrunerService
} from './generated-test-failure-pruner.service.ts';
import {
  JavaTestStructureService,
  matchingBrace,
  sanitizeJava,
  type JavaFieldSpan,
  type JavaMethodSpan
} from './java-test-structure.service.ts';

export type StableRepairPhase =
  | 'TEST_METHODS'
  | 'SHARED_MEMBERS'
  | 'PASSED'
  | 'BLOCKED';

export type StableRepairCheckpoint = {
  phase: StableRepairPhase;
  iteration: number;
  annotatedMemberIds: string[];
};

export type StableTestRepairInput = {
  code: string;
  candidateFilePath: string;
  generatedTestClassName: string;
  initialExecution: CandidateExecutionFeedback;
  annotatedMemberIds: readonly string[];
  initialIteration?: number;
  replaceCandidate: (code: string) => Promise<void>;
  executeMaven: () => Promise<CandidateExecutionFeedback>;
  saveCheckpoint: (checkpoint: StableRepairCheckpoint) => Promise<void>;
  signal?: AbortSignal;
};

export type StableTestRepairResult = {
  status: 'passed' | 'retained_empty' | 'external_project_blocked';
  code: string;
  execution: CandidateExecutionFeedback;
  phase: 'PASSED' | 'BLOCKED';
  iteration: number;
  annotatedMemberIds: string[];
};

type SharedMember = {
  id: string;
  kind:
    | 'lifecycle'
    | 'helper'
    | 'field'
    | 'initializer'
    | 'nested_type'
    | 'class_annotation'
    | 'import';
  referenceNames: string[];
  startOffset: number;
  endOffset: number;
  methodStartOffset?: number;
};

/** Deterministic final repair: it never invokes a model or writes user logs. */
export class StableTestRepairService {
  private readonly pruner: GeneratedTestFailurePrunerService;
  private readonly structure: JavaTestStructureService;

  constructor(
    pruner = new GeneratedTestFailurePrunerService(),
    structure = new JavaTestStructureService()
  ) {
    this.pruner = pruner;
    this.structure = structure;
  }

  async repair(input: StableTestRepairInput): Promise<StableTestRepairResult> {
    let code = input.code;
    let execution = input.initialExecution;
    let iteration = input.initialIteration ?? 0;
    if (!Number.isSafeInteger(iteration) || iteration < 0) {
      throw new TypeError('Stable repair iteration must be a non-negative integer.');
    }
    const annotatedMemberIds = new Set(input.annotatedMemberIds);

    while (execution.status !== 'passed') {
      throwIfAborted(input.signal);
      if (
        this.structure.findTestMethods(code).length === 0
        && isCompilableEmptyCandidate(execution)
      ) {
        const checkpoint = {
          phase: 'PASSED' as const,
          iteration,
          annotatedMemberIds: [...annotatedMemberIds]
        };
        await input.saveCheckpoint(checkpoint);
        return {
          status: 'retained_empty',
          code,
          execution,
          ...checkpoint
        };
      }
      const tests = this.pruner.commentFailingTestMethods({
        code,
        candidateFilePath: input.candidateFilePath,
        execution
      });
      let nextCode = tests.code;
      let phase: StableRepairPhase = 'TEST_METHODS';
      let newMemberIds = tests.commentedMemberIds.filter((id) => (
        !annotatedMemberIds.has(id)
      ));

      if (newMemberIds.length === 0) {
        const shared = this.sharedMembersForExecution(
          code,
          input.candidateFilePath,
          execution
        ).find((member) => !annotatedMemberIds.has(member.id))
          ?? (
            executionMentionsCandidate(
              execution,
              input.candidateFilePath,
              input.generatedTestClassName
            )
              ? this.fallbackSharedMembers(code).find(
                  (member) => !annotatedMemberIds.has(member.id)
                ) ?? null
              : null
          );
        if (shared) {
          const dependentTestNames = this.dependentTestNames(code, shared);
          if (dependentTestNames.length > 0) {
            const dependentTests = this.pruner.commentTestMethods({
              code,
              testMethodNames: dependentTestNames
            });
            nextCode = dependentTests.code;
            phase = 'TEST_METHODS';
            newMemberIds = dependentTests.commentedMemberIds.filter((id) => (
              !annotatedMemberIds.has(id)
            ));
          } else {
            nextCode = commentRange(code, shared);
            phase = 'SHARED_MEMBERS';
            newMemberIds = [shared.id];
          }
        } else if (executionMentionsCandidate(
          execution,
          input.candidateFilePath,
          input.generatedTestClassName
        )) {
          const remainingTests = this.structure.findTestMethods(code);
          const commented = this.pruner.commentTestMethods({
            code,
            testMethodNames: remainingTests.map((method) => method.name)
          });
          nextCode = commented.code;
          phase = 'TEST_METHODS';
          newMemberIds = commented.commentedMemberIds.filter((id) => (
            !annotatedMemberIds.has(id)
          ));
        }
        if (newMemberIds.length === 0 && executionMentionsCandidate(
          execution,
          input.candidateFilePath,
          input.generatedTestClassName
        )) {
          const emptyClassId = `empty_class:${input.generatedTestClassName}`;
          if (!annotatedMemberIds.has(emptyClassId)) {
            const emptyClass = retainCompilableEmptyClass(
              code,
              input.generatedTestClassName
            );
            if (emptyClass !== code) {
              nextCode = emptyClass;
              phase = 'SHARED_MEMBERS';
              newMemberIds = [emptyClassId];
            }
          }
        }
        if (newMemberIds.length === 0) {
          const checkpoint = {
            phase: 'BLOCKED' as const,
            iteration,
            annotatedMemberIds: [...annotatedMemberIds]
          };
          await input.saveCheckpoint(checkpoint);
          return {
            status: 'external_project_blocked',
            code,
            execution,
            ...checkpoint
          };
        }
      }

      if (nextCode === code || newMemberIds.length === 0) {
        throw new Error('Stable repair must make a monotonic candidate-local change.');
      }
      newMemberIds.forEach((id) => annotatedMemberIds.add(id));
      iteration += 1;
      await input.replaceCandidate(nextCode);
      await input.saveCheckpoint({
        phase,
        iteration,
        annotatedMemberIds: [...annotatedMemberIds]
      });
      code = nextCode;
      execution = await input.executeMaven();
    }

    const checkpoint = {
      phase: 'PASSED' as const,
      iteration,
      annotatedMemberIds: [...annotatedMemberIds]
    };
    await input.saveCheckpoint(checkpoint);
    return {
      status: 'passed',
      code,
      execution,
      ...checkpoint
    };
  }

  private sharedMembersForExecution(
    code: string,
    candidateFilePath: string,
    execution: CandidateExecutionFeedback
  ): SharedMember[] {
    const lines = compilerLinesForFile(execution, candidateFilePath);
    if (lines.length === 0) return [];
    const methods = this.structure.findMethods(code)
      .filter((method) => !method.isTestMethod);
    const fields = this.structure.findFields(code);
    const blockSupport = blockSupportMembers(code);
    const candidates = new Map<string, SharedMember>();
    for (const line of lines) {
      const method = uniqueAtLine(methods, line);
      if (method) {
        const member: SharedMember = {
          id: `method:${method.name}:${method.startLine}`,
          kind: method.isLifecycleMethod ? 'lifecycle' : 'helper',
          referenceNames: [method.name],
          startOffset: method.startOffset,
          endOffset: method.endOffset,
          methodStartOffset: method.startOffset
        };
        candidates.set(member.id, member);
        continue;
      }
      const field = uniqueAtLine(fields, line);
      if (field) {
        const member: SharedMember = {
          id: `field:${field.names.join(',')}:${field.startLine}`,
          kind: 'field',
          referenceNames: [...field.names],
          startOffset: field.startOffset,
          endOffset: field.endOffset
        };
        candidates.set(member.id, member);
        continue;
      }
      const support = uniqueSharedMemberAtLine(code, blockSupport, line);
      if (support) {
        candidates.set(support.id, support);
        continue;
      }
      const sourceLine = lineRange(code, line);
      if (!sourceLine) continue;
      const source = code.slice(sourceLine.startOffset, sourceLine.endOffset);
      if (/^\s*import\b/u.test(source)) {
        const simpleName = /([A-Za-z_$][\w$]*|\*)\s*;?\s*$/u.exec(source)?.[1];
        const member: SharedMember = {
          id: `import:${line}`,
          kind: 'import',
          referenceNames: simpleName && simpleName !== '*' ? [simpleName] : [],
          ...sourceLine
        };
        candidates.set(member.id, member);
        continue;
      }
      if (/^\s*@/u.test(source)) {
        const member: SharedMember = {
          id: `annotation:${line}`,
          kind: 'class_annotation',
          referenceNames: [],
          ...sourceLine
        };
        candidates.set(member.id, member);
      }
    }
    return [...candidates.values()].sort(compareSharedMembers);
  }

  private fallbackSharedMembers(code: string): SharedMember[] {
    const methods = this.structure.findMethods(code)
      .filter((method) => !method.isTestMethod)
      .map((method): SharedMember => ({
        id: `method:${method.name}:${method.startLine}`,
        kind: method.isLifecycleMethod ? 'lifecycle' : 'helper',
        referenceNames: [method.name],
        startOffset: method.startOffset,
        endOffset: method.endOffset,
        methodStartOffset: method.startOffset
      }));
    const fields = this.structure.findFields(code).map((field): SharedMember => ({
      id: `field:${field.names.join(',')}:${field.startLine}`,
      kind: 'field',
      referenceNames: [...field.names],
      startOffset: field.startOffset,
      endOffset: field.endOffset
    }));
    return [
      ...methods,
      ...fields,
      ...blockSupportMembers(code),
      ...classAnnotationMembers(code),
      ...importMembers(code)
    ].sort(compareSharedMembers);
  }

  private dependentTestNames(code: string, member: SharedMember): string[] {
    const methods = this.structure.findMethods(code);
    const tests = methods.filter((method) => method.isTestMethod);
    if (member.kind === 'lifecycle' || member.kind === 'initializer') {
      return tests.map((test) => test.name);
    }

    const dependencies = new Set<JavaMethodSpan>();
    if (member.methodStartOffset !== undefined) {
      const method = methods.find((item) => (
        item.startOffset === member.methodStartOffset
      ));
      if (method) dependencies.add(method);
    }
    if (member.referenceNames.length > 0) {
      for (const method of methods) {
        const source = sanitizeJava(code.slice(method.startOffset, method.endOffset));
        if (member.referenceNames.some((name) => containsIdentifier(source, name))) {
          dependencies.add(method);
        }
      }
    }
    if (dependencies.size === 0) return [];

    const methodsByName = new Map<string, JavaMethodSpan[]>();
    for (const method of methods) {
      const values = methodsByName.get(method.name) ?? [];
      values.push(method);
      methodsByName.set(method.name, values);
    }
    const calls = new Map<JavaMethodSpan, JavaMethodSpan[]>();
    for (const method of methods) {
      calls.set(method, this.structure.invokedMethods(code, method).flatMap((name) => {
        const values = methodsByName.get(name) ?? [];
        return values.length === 1 ? values : [];
      }));
    }
    return tests.filter((test) => (
      dependencies.has(test)
      || [...dependencies].some((target) => reaches(test, target, calls))
    )).map((test) => test.name);
  }
}

const SHARED_MEMBER_PRIORITY: Readonly<Record<SharedMember['kind'], number>> = {
  lifecycle: 0,
  helper: 1,
  field: 2,
  initializer: 3,
  nested_type: 4,
  class_annotation: 5,
  import: 6
};

function compareSharedMembers(left: SharedMember, right: SharedMember): number {
  return SHARED_MEMBER_PRIORITY[left.kind] - SHARED_MEMBER_PRIORITY[right.kind]
    || left.startOffset - right.startOffset;
}

function classAnnotationMembers(code: string): SharedMember[] {
  const sanitized = sanitizeJava(code);
  const type = /\b(?:class|record|interface|enum)\s+[A-Za-z_$][\w$]*/u.exec(
    sanitized
  );
  if (!type) return [];
  const typeLine = lineNumberAt(code, type.index);
  const result: SharedMember[] = [];
  for (let line = 1; line < typeLine; line += 1) {
    const range = lineRange(code, line);
    if (!range) continue;
    const source = code.slice(range.startOffset, range.endOffset);
    if (!/^\s*@/u.test(source)) continue;
    result.push({
      id: `annotation:${line}`,
      kind: 'class_annotation',
      referenceNames: [],
      ...range
    });
  }
  return result;
}

function blockSupportMembers(code: string): SharedMember[] {
  const sanitized = sanitizeJava(code);
  const root = /\b(?:class|record|interface|enum)\s+[A-Za-z_$][\w$]*[^{};]*\{/u.exec(
    sanitized
  );
  if (!root) return [];
  const rootOpen = root.index + root[0].lastIndexOf('{');
  const rootClose = matchingBrace(sanitized, rootOpen);
  if (rootClose < 0) return [];

  const result: SharedMember[] = [];
  let memberStart = rootOpen + 1;
  let index = memberStart;
  let parenthesisDepth = 0;
  while (index < rootClose) {
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
    if (character === ';' && parenthesisDepth === 0) {
      memberStart = index + 1;
      index += 1;
      continue;
    }
    if (character !== '{' || parenthesisDepth > 0) {
      index += 1;
      continue;
    }

    const close = matchingBrace(sanitized, index);
    if (close < 0 || close > rootClose) return [];
    const header = sanitized.slice(memberStart, index);
    const trimmed = header.trim();
    if (trimmed === '' || trimmed === 'static') {
      const line = lineNumberAt(code, index);
      const lineStart = lineRange(code, line)?.startOffset ?? index;
      const tokenOffset = header.search(/\S/u);
      const startOffset = trimmed === '' || tokenOffset < 0
        ? lineStart
        : memberStart + tokenOffset;
      result.push({
        id: `initializer:${trimmed === 'static' ? 'static' : 'instance'}:${line}`,
        kind: 'initializer',
        referenceNames: [],
        startOffset,
        endOffset: includeTrailingLineBreak(code, close + 1)
      });
    } else {
      const nestedType = /\b(?:class|record|interface|enum)\s+([A-Za-z_$][\w$]*)/u.exec(
        trimmed
      );
      if (nestedType) {
        const tokenOffset = header.search(/\S/u);
        const startOffset = tokenOffset < 0 ? memberStart : memberStart + tokenOffset;
        const line = lineNumberAt(code, startOffset);
        result.push({
          id: `nested_type:${nestedType[1]}:${line}`,
          kind: 'nested_type',
          referenceNames: [nestedType[1]],
          startOffset,
          endOffset: includeTrailingLineBreak(code, close + 1)
        });
      }
    }
    memberStart = close + 1;
    index = close + 1;
    parenthesisDepth = 0;
  }
  return result;
}

function importMembers(code: string): SharedMember[] {
  const result: SharedMember[] = [];
  const lineCount = code.split(/\r\n|\r|\n/u).length;
  for (let line = 1; line <= lineCount; line += 1) {
    const range = lineRange(code, line);
    if (!range) continue;
    const source = code.slice(range.startOffset, range.endOffset);
    if (!/^\s*import\b/u.test(source)) continue;
    const simpleName = /([A-Za-z_$][\w$]*|\*)\s*;?\s*$/u.exec(source)?.[1];
    result.push({
      id: `import:${line}`,
      kind: 'import',
      referenceNames: simpleName && simpleName !== '*' ? [simpleName] : [],
      ...range
    });
  }
  return result;
}

function executionMentionsCandidate(
  execution: CandidateExecutionFeedback,
  candidateFilePath: string,
  generatedTestClassName: string
): boolean {
  if (execution.testReport?.generatedTestClassName === generatedTestClassName) {
    return true;
  }
  const expected = normalizePath(candidateFilePath);
  const fileName = expected.split('/').at(-1) ?? '';
  const output = execution.mavenExecutions.flatMap((item) => [
    item.stdout,
    item.stderr
  ]).join('\n').replace(/\\/gu, '/').toLowerCase();
  return output.includes(expected)
    || Boolean(fileName && output.includes(fileName));
}

function containsIdentifier(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'u').test(source);
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

function lineNumberAt(code: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (code[index] === '\n') line += 1;
  }
  return line;
}

function uniqueAtLine<T extends { startLine: number; endLine: number }>(
  values: readonly T[],
  line: number
): T | null {
  const matches = values.filter((value) => (
    line >= value.startLine && line <= value.endLine
  ));
  return matches.length === 1 ? matches[0] : null;
}

function uniqueSharedMemberAtLine(
  code: string,
  values: readonly SharedMember[],
  line: number
): SharedMember | null {
  const matches = values.filter((value) => (
    line >= lineNumberAt(code, value.startOffset)
    && line <= lineNumberAt(code, Math.max(value.startOffset, value.endOffset - 1))
  ));
  return matches.length === 1 ? matches[0] : null;
}

function compilerLinesForFile(
  execution: CandidateExecutionFeedback,
  candidateFilePath: string
): number[] {
  const expected = normalizePath(candidateFilePath);
  const result = new Set<number>();
  const output = execution.mavenExecutions.flatMap((item) => [
    item.stdout,
    item.stderr
  ]).join('\n');
  const patterns = [
    /((?:[A-Za-z]:[\\/]|\/)[^\r\n]*?\.java):\[(\d+),\d+\]/gu,
    /((?:[A-Za-z]:[\\/]|\/)[^\r\n]*?\.java):(\d+):(?:\d+:)?/gu
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      if (normalizePath(match[1]) !== expected) continue;
      const line = Number(match[2]);
      if (Number.isSafeInteger(line) && line > 0) result.add(line);
    }
  }
  return [...result];
}

function normalizePath(value: string): string {
  return value.trim()
    .replace(/^file:\/*/iu, '')
    .replace(/\\/gu, '/')
    .replace(/\/+/gu, '/')
    .replace(/^\/(?=[a-z]:\/)/iu, '')
    .toLowerCase();
}

function isCompilableEmptyCandidate(execution: CandidateExecutionFeedback): boolean {
  if (execution.testReport) return false;
  const compile = [...execution.mavenExecutions].reverse().find(
    (item) => item.phase === 'test_compile'
  );
  const test = [...execution.mavenExecutions].reverse().find(
    (item) => item.phase === 'test'
  );
  return compile?.exitCode === 0
    && test?.exitCode === 0
    && test.surefireReports.length === 0;
}

function retainCompilableEmptyClass(
  code: string,
  generatedTestClassName: string
): string {
  const simpleName = generatedTestClassName.split('.').at(-1) ?? '';
  if (!/^[A-Za-z_$][\w$]*$/u.test(simpleName)) return code;
  const newline = code.includes('\r\n') ? '\r\n' : '\n';
  const lines = code.split(/\r\n|\r|\n/u);
  let packagePreserved = false;
  const preserved = lines.map((line) => {
    if (!packagePreserved && /^\s*package\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*;\s*$/u.test(line)) {
      packagePreserved = true;
      return line;
    }
    if (!line.trim()) return line;
    const indent = /^[\t ]*/u.exec(line)?.[0] ?? '';
    return `${indent}// ${line.slice(indent.length)}`;
  });
  while (preserved.length > 0 && preserved.at(-1) === '') preserved.pop();
  return [
    ...preserved,
    '',
    `class ${simpleName} {`,
    '}',
    ''
  ].join(newline);
}

function lineRange(
  code: string,
  line: number
): { startOffset: number; endOffset: number } | null {
  if (!Number.isSafeInteger(line) || line < 1) return null;
  let startOffset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = code.indexOf('\n', startOffset);
    if (newline < 0) return null;
    startOffset = newline + 1;
  }
  const newline = code.indexOf('\n', startOffset);
  return {
    startOffset,
    endOffset: newline < 0 ? code.length : newline + 1
  };
}

function includeTrailingLineBreak(code: string, offset: number): number {
  let end = offset;
  while (end < code.length && (code[end] === ' ' || code[end] === '\t')) end += 1;
  if (code[end] === '\r' && code[end + 1] === '\n') return end + 2;
  if (code[end] === '\r' || code[end] === '\n') return end + 1;
  return end;
}

function commentRange(
  code: string,
  range: Pick<SharedMember, 'startOffset' | 'endOffset'>
): string {
  const source = code.slice(range.startOffset, range.endOffset);
  const replacement = source.split(/(\r\n|\r|\n)/u).map((part, index) => {
    if (index % 2 === 1 || !part) return part;
    const indent = /^[\t ]*/u.exec(part)?.[0] ?? '';
    const content = part.slice(indent.length);
    return content ? `${indent}// ${content}` : `${indent}//`;
  }).join('');
  return code.slice(0, range.startOffset)
    + replacement
    + code.slice(range.endOffset);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

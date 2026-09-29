import type {
  MavenRepairDiagnostic
} from './maven-repair-diagnostic.service.ts';
import {
  JavaTestStructureService,
  normalizeJavaForComparison,
  sanitizeJava,
  type JavaFieldSpan,
  type JavaMethodSpan
} from './java-test-structure.service.ts';

export type CandidateChangeValidationInput = {
  acceptedCode: string;
  candidateCode: string;
  diagnostic: MavenRepairDiagnostic;
  allowedImports?: readonly string[];
};

export type CandidateChangeRejection = {
  accepted: false;
  violationCodes: string[];
  memberNames: string[];
  message: string;
};

export type CandidateChangeValidationResult =
  | { accepted: true }
  | CandidateChangeRejection;

export type DeterministicUnreportedExceptionRepairInput = {
  code: string;
  candidateFilePath: string;
  diagnostic: MavenRepairDiagnostic;
  structure?: JavaTestStructureService;
};

export type DeterministicUnreportedExceptionRepairResult = {
  code: string;
  applied: boolean;
  repairedCompilerErrorCount: number;
};

/**
 * Applies only the mechanical javac fix for an exact checked-exception FQN.
 * The diagnostic line must identify one JUnit test or one private helper.
 */
export function applyDeterministicUnreportedExceptionRepair(
  input: DeterministicUnreportedExceptionRepairInput
): DeterministicUnreportedExceptionRepairResult {
  const structure = input.structure ?? new JavaTestStructureService();
  const methods = structure.findMethods(input.code);
  const candidatePath = normalizeComparablePath(input.candidateFilePath);
  const repairs = new Map<number, {
    method: JavaMethodSpan;
    exceptionCounts: Map<string, number>;
  }>();

  for (const error of input.diagnostic.compilerErrors) {
    if (
      error.category !== 'unreported_exception'
      || normalizeComparablePath(error.filePath) !== candidatePath
    ) continue;
    const exceptionFqn = exactUnreportedExceptionFqn(error.message);
    if (!exceptionFqn) continue;
    const matchingMethods = methods.filter((method) => (
      error.line >= method.startLine && error.line <= method.endLine
    ));
    if (matchingMethods.length !== 1) continue;
    const method = matchingMethods[0];
    const header = sanitizeJava(input.code.slice(
      method.startOffset,
      method.bodyStartOffset
    ));
    if (
      /@(?:[A-Za-z_$][\w$]*\.)*Override\b/.test(header)
      || (!method.isTestMethod && (
        method.isLifecycleMethod || !/\bprivate\b/.test(header)
      ))
    ) continue;
    const repair = repairs.get(method.startOffset) ?? {
      method,
      exceptionCounts: new Map<string, number>()
    };
    repair.exceptionCounts.set(
      exceptionFqn,
      (repair.exceptionCounts.get(exceptionFqn) ?? 0) + 1
    );
    repairs.set(method.startOffset, repair);
  }

  let code = input.code;
  let repairedCompilerErrorCount = 0;
  const orderedRepairs = [...repairs.values()].sort(
    (left, right) => right.method.startOffset - left.method.startOffset
  );
  for (const repair of orderedRepairs) {
    const header = code.slice(
      repair.method.startOffset,
      repair.method.bodyStartOffset
    );
    const result = appendDeclaredExceptions(
      header,
      [...repair.exceptionCounts.keys()]
    );
    if (result.added.length === 0) continue;
    code = code.slice(0, repair.method.startOffset)
      + result.header
      + code.slice(repair.method.bodyStartOffset);
    for (const exceptionFqn of result.added) {
      repairedCompilerErrorCount += repair.exceptionCounts.get(exceptionFqn) ?? 0;
    }
  }

  return {
    code,
    applied: code !== input.code,
    repairedCompilerErrorCount
  };
}

/** Only standalone Java line comments can authorize a named test deletion. */
function explicitTestDeletionNames(code: string): Set<string> {
  const names = new Set<string>();
  let index = 0;
  let lineStart = 0;
  while (index < code.length) {
    if (code.startsWith('//', index)) {
      const start = index;
      while (index < code.length && code[index] !== '\n' && code[index] !== '\r') {
        index += 1;
      }
      if (!code.slice(lineStart, start).trim()) {
        const marker = /^\/\/\s*\[删除无用测试\]\s+([A-Za-z_$][\w$]*)\s*$/
          .exec(code.slice(start, index));
        if (marker) names.add(marker[1]);
      }
      continue;
    }
    if (code.startsWith('/*', index)) {
      const end = code.indexOf('*/', index + 2);
      index = end < 0 ? code.length : end + 2;
      continue;
    }
    const delimiter = code.startsWith('"""', index) ? '"""'
      : code[index] === '"' || code[index] === "'" ? code[index] : null;
    if (delimiter) {
      index += delimiter.length;
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2;
        } else if (code.startsWith(delimiter, index)) {
          index += delimiter.length;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (code[index] === '\n' || code[index] === '\r') lineStart = index + 1;
    index += 1;
  }
  return names;
}

function exactUnreportedExceptionFqn(message: string): string | null {
  return /(?:unreported\s+exception|未报告的异常(?:错误)?)\s*[:：]?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/i
    .exec(message)?.[1] ?? null;
}

function appendDeclaredExceptions(
  header: string,
  exceptionFqns: readonly string[]
): { header: string; added: string[] } {
  const sanitized = sanitizeJava(header);
  const parametersEnd = sanitized.lastIndexOf(')');
  if (parametersEnd < 0) return { header, added: [] };
  const suffix = sanitized.slice(parametersEnd + 1);
  const throwsMatch = /\bthrows\b/.exec(suffix);
  const declared = throwsMatch
    ? sanitized.slice(
        parametersEnd + 1 + (throwsMatch.index ?? 0) + throwsMatch[0].length
      )
    : '';
  const declaredNames = new Set(
    declared.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? []
  );
  const added = exceptionFqns.filter((exceptionFqn) => {
    const simpleName = exceptionFqn.slice(exceptionFqn.lastIndexOf('.') + 1);
    return !declaredNames.has(exceptionFqn) && !declaredNames.has(simpleName);
  });
  if (added.length === 0) return { header, added: [] };

  if (!throwsMatch) {
    return {
      header: header.slice(0, parametersEnd + 1)
        + ` throws ${added.join(', ')}`
        + header.slice(parametersEnd + 1),
      added
    };
  }
  const trailingWhitespace = /\s*$/.exec(header)?.[0] ?? '';
  const declarationEnd = header.length - trailingWhitespace.length;
  return {
    header: header.slice(0, declarationEnd)
      + `, ${added.join(', ')}`
      + trailingWhitespace,
    added
  };
}

function normalizeComparablePath(value: string): string {
  return value.trim()
    .replaceAll('\\', '/')
    .replace(/^\/([A-Za-z]:\/)/, '$1')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * An accepted Maven baseline already owns its wildcard imports. Keep them when
 * a repair model removes them as incidental cleanup so the scope gate evaluates
 * only diagnostic-related Java member changes for compile and runtime repairs.
 */
export function preserveAcceptedWildcardImports(
  input: CandidateChangeValidationInput
): string {
  const acceptedImports = javaImports(input.acceptedCode);
  const acceptedWildcards = acceptedImports.filter((item) => item.simpleName === null);
  const originalCandidateImports = javaImports(input.candidateCode);
  const redundantExplicitImports = originalCandidateImports.filter((item) => (
    item.simpleName !== null
    && acceptedWildcards.some((wildcard) => wildcardCoversImport(wildcard, item))
  ));
  const candidateCode = removeImports(input.candidateCode, redundantExplicitImports);
  const candidateImports = javaImports(candidateCode);
  const candidateDeclarations = new Set(
    candidateImports.map((item) => item.declaration)
  );
  const missing = acceptedImports.filter((item) => (
    item.simpleName === null
    && !candidateDeclarations.has(item.declaration)
  ));
  if (missing.length === 0) return candidateCode;

  const eol = candidateCode.includes('\r\n') ? '\r\n' : '\n';
  const declarations = missing.map((item) => (
    `import ${item.isStatic ? 'static ' : ''}${item.importedName};`
  )).join(eol) + eol;
  const lastImport = candidateImports.at(-1);
  if (lastImport) {
    const before = candidateCode.slice(0, lastImport.endOffset);
    const separator = /(?:\r\n|\r|\n)$/.test(before) ? '' : eol;
    return before + separator + declarations
      + candidateCode.slice(lastImport.endOffset);
  }

  const sanitized = sanitizeJava(candidateCode);
  const packageMatch = /^[\t ]*package[\t ]+[^;\r\n]+;[\t ]*(?:\r?\n|\r)?/m
    .exec(sanitized);
  if (!packageMatch) return candidateCode;
  const insertAt = (packageMatch.index ?? 0) + packageMatch[0].length;
  return candidateCode.slice(0, insertAt)
    + declarations
    + candidateCode.slice(insertAt);
}

/**
 * Restore only an unambiguous Analyzer-approved type import that the candidate
 * actually references by simple name. This is deterministic evidence repair,
 * not package guessing.
 */
export function restoreReferencedAllowedTypeImports(input: {
  candidateCode: string;
  allowedImports: readonly string[];
}): string {
  const candidateImports = javaImports(input.candidateCode);
  const packageName = javaPackageName(input.candidateCode);
  const allowedBySimpleName = new Map<string, Set<string>>();
  for (const value of input.allowedImports) {
    const stripped = value.trim().replace(/;\s*$/, '');
    if (/^(?:import\s+)?static\s+/.test(stripped)) continue;
    const importedName = stripped.replace(/^import\s+/, '');
    if (
      !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(importedName)
      || importedName.endsWith('.*')
    ) continue;
    if (!/^import\s+/.test(stripped)) {
      const separator = importedName.lastIndexOf('.');
      const owner = importedName.slice(0, separator);
      const member = importedName.slice(separator + 1);
      const ownerSimpleName = owner.slice(owner.lastIndexOf('.') + 1);
      if (
        /^[A-Z]/.test(ownerSimpleName)
        && (/^[a-z]/.test(member) || member.toUpperCase() === member)
      ) continue;
    }
    const simpleName = importedName.split('.').at(-1);
    if (!simpleName) continue;
    const candidates = allowedBySimpleName.get(simpleName) ?? new Set<string>();
    candidates.add(importedName);
    allowedBySimpleName.set(simpleName, candidates);
  }

  const masked = [...sanitizeJava(input.candidateCode)];
  for (const item of candidateImports) {
    for (let index = item.startOffset; index < item.endOffset; index += 1) {
      if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
    }
  }
  const candidateBody = masked.join('');
  const missing: string[] = [];
  for (const [simpleName, candidates] of allowedBySimpleName) {
    if (candidates.size !== 1) continue;
    const importedName = [...candidates][0];
    const separator = importedName.lastIndexOf('.');
    if (separator < 1) continue;
    const owner = importedName.slice(0, separator);
    if (owner === packageName || owner === 'java.lang') continue;
    if (candidateImports.some((item) => (
      !item.isStatic
      && (
        item.importedName === importedName
        || item.simpleName === simpleName
        || item.importedName === `${owner}.*`
      )
    ))) continue;
    const escaped = simpleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(
      `(?<![A-Za-z0-9_$.])${escaped}(?![A-Za-z0-9_$])`
    ).test(candidateBody)) continue;
    missing.push(importedName);
  }
  if (missing.length === 0) return input.candidateCode;

  const eol = input.candidateCode.includes('\r\n') ? '\r\n' : '\n';
  const declarations = missing.map((item) => `import ${item};`).join(eol) + eol;
  const lastImport = candidateImports.at(-1);
  if (lastImport) {
    return input.candidateCode.slice(0, lastImport.endOffset)
      + declarations
      + input.candidateCode.slice(lastImport.endOffset);
  }
  const packageMatch = /^[\t ]*package[\t ]+[^;\r\n]+;[\t ]*(?:\r?\n|\r)?/m
    .exec(sanitizeJava(input.candidateCode));
  if (!packageMatch) return declarations + eol + input.candidateCode;
  const insertAt = (packageMatch.index ?? 0) + packageMatch[0].length;
  return input.candidateCode.slice(0, insertAt)
    + declarations
    + input.candidateCode.slice(insertAt);
}

type ParsedSource = {
  code: string;
  packageName: string | null;
  methods: JavaMethodSpan[];
  tests: JavaMethodSpan[];
  helpers: JavaMethodSpan[];
  lifecycle: JavaMethodSpan[];
  fields: JavaFieldSpan[];
  imports: JavaImport[];
};

type JavaImport = {
  declaration: string;
  importedName: string;
  simpleName: string | null;
  isStatic: boolean;
  startOffset: number;
  endOffset: number;
};

type ViolationCollector = {
  codes: string[];
  members: string[];
  add: (code: string, names?: readonly string[]) => void;
};

const DISABLED_ANNOTATION =
  /@(?:[A-Za-z_$][\w$]*\.)*Disabled\b/;
const INJECT_MOCKS_ANNOTATION =
  /@(?:[A-Za-z_$][\w$]*\.)*InjectMocks\b/;
const INJECTABLE_MOCK_ANNOTATION =
  /@(?:[A-Za-z_$][\w$]*\.)*(?:Mock|Spy)\b/;

/** Rejects model edits that are not attributable to the newest diagnostic. */
export class CandidateChangeValidator {
  private readonly structure: JavaTestStructureService;

  constructor(structure = new JavaTestStructureService()) {
    this.structure = structure;
  }

  validateTestIdentityChanges(input: Pick<
    CandidateChangeValidationInput,
    'acceptedCode' | 'candidateCode'
  >): CandidateChangeValidationResult {
    const accepted = parseSource(input.acceptedCode, this.structure);
    const candidate = parseSource(input.candidateCode, this.structure);
    const violations = violationCollector();
    this.validateTestIdentity(accepted, candidate, violations, false);
    return violations.codes.length === 0
      ? { accepted: true }
      : rejection(violations);
  }

  validate(input: CandidateChangeValidationInput): CandidateChangeValidationResult {
    if (input.acceptedCode === input.candidateCode) {
      return {
        accepted: false,
        violationCodes: ['NO_EFFECTIVE_CHANGE'],
        memberNames: [],
        message: 'The repair candidate is identical to the accepted Maven baseline.'
      };
    }
    const accepted = parseSource(input.acceptedCode, this.structure);
    const candidate = parseSource(input.candidateCode, this.structure);
    const violations = violationCollector();

    this.validateTestIdentity(accepted, candidate, violations);
    if (violations.codes.length > 0) return rejection(violations);

    const compilerHitFields = compilerHitFieldNames(
      accepted,
      input.diagnostic
    );
    const allowed = this.allowedMethods(
      accepted,
      candidate,
      input.diagnostic,
      compilerHitFields
    );
    this.validateTests(accepted, candidate, allowed, violations);
    this.validateHelpers(accepted, candidate, allowed, violations);

    const relatedFields = relatedFieldNames(
      accepted,
      candidate,
      allowed,
      compilerHitFields
    );
    this.validateFields(accepted, candidate, relatedFields, violations);
    this.validateLifecycle(
      accepted,
      candidate,
      relatedFields,
      violations
    );
    this.validateImports(
      accepted,
      candidate,
      allowed,
      relatedFields,
      input.diagnostic,
      input.allowedImports,
      violations
    );
    this.validateSkeleton(accepted, candidate, violations);

    return violations.codes.length === 0
      ? { accepted: true }
      : rejection(violations);
  }

  private validateTestIdentity(
    accepted: ParsedSource,
    candidate: ParsedSource,
    violations: ViolationCollector,
    allowExplicitDeletions = true
  ): void {
    const deletionMarkers = allowExplicitDeletions
      ? explicitTestDeletionNames(candidate.code)
      : new Set<string>();
    const retainedNames = new Set(candidate.methods.map((method) => method.name));
    const before = accepted.tests
      .filter((method) => (
        !deletionMarkers.has(method.name) || retainedNames.has(method.name)
      ))
      .map((method) => method.name);
    const after = candidate.tests.map((method) => method.name);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const missing = before.filter((name) => !afterSet.has(name));
    const added = after.filter((name) => !beforeSet.has(name));

    if (missing.length === 0 && added.length === 0) {
      if (!sameValues(before, after)) {
        violations.add('TEST_METHOD_REORDERED', before);
      }
    } else if (
      before.length === after.length
      && missing.length > 0
      && missing.length === added.length
    ) {
      violations.add('TEST_METHOD_RENAMED', [...missing, ...added]);
    } else {
      if (missing.length > 0) violations.add('TEST_METHOD_DELETED', missing);
      if (added.length > 0) violations.add('TEST_METHOD_ADDED', added);
    }

    for (const method of accepted.tests) {
      const key = methodKey(accepted.methods, method);
      const next = methodForKey(candidate.methods, key);
      if (!next) continue;
      if (!isDisabled(accepted.code, method) && isDisabled(candidate.code, next)) {
        violations.add('TEST_METHOD_DISABLED', [method.name]);
      }
    }
  }

  private validateTests(
    accepted: ParsedSource,
    candidate: ParsedSource,
    allowed: ReadonlySet<string>,
    violations: ViolationCollector
  ): void {
    for (const method of accepted.tests) {
      const key = methodKey(accepted.methods, method);
      const next = methodForKey(candidate.methods, key);
      if (!next || allowed.has(key)) continue;
      if (!sameMember(accepted.code, method, candidate.code, next)) {
        violations.add('UNRELATED_TEST_CHANGED', [method.name]);
      }
    }
  }

  private validateHelpers(
    accepted: ParsedSource,
    candidate: ParsedSource,
    allowed: ReadonlySet<string>,
    violations: ViolationCollector
  ): void {
    const beforeNames = accepted.helpers.map((method) => method.name);
    const beforeNameSet = new Set(beforeNames);
    const existingAfterNames = candidate.helpers
      .filter((method) => beforeNameSet.has(method.name))
      .map((method) => method.name);
    if (!sameValues(beforeNames, existingAfterNames)) {
      const changed = symmetricDifference(beforeNames, existingAfterNames);
      violations.add(
        'UNRELATED_METHOD_CHANGED',
        changed.length > 0 ? changed : beforeNames
      );
    }
    for (const method of candidate.helpers) {
      if (beforeNameSet.has(method.name)) continue;
      const key = methodKey(candidate.methods, method);
      if (!allowed.has(key)) {
        violations.add('UNRELATED_METHOD_CHANGED', [method.name]);
      }
    }
    for (const method of accepted.helpers) {
      const key = methodKey(accepted.methods, method);
      const next = methodForKey(candidate.methods, key);
      if (!next) {
        violations.add('UNRELATED_METHOD_CHANGED', [method.name]);
        continue;
      }
      if (allowed.has(key)) continue;
      if (!sameMember(accepted.code, method, candidate.code, next)) {
        violations.add('UNRELATED_METHOD_CHANGED', [method.name]);
      }
    }
  }

  private validateFields(
    accepted: ParsedSource,
    candidate: ParsedSource,
    relatedFields: ReadonlySet<string>,
    violations: ViolationCollector
  ): void {
    const before = fieldIndex(accepted.fields);
    const after = fieldIndex(candidate.fields);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(key);
      const right = after.get(key);
      if (left && right && sameMember(accepted.code, left, candidate.code, right)) {
        continue;
      }
      const names = left?.names ?? right?.names ?? [];
      if (!names.some((name) => relatedFields.has(name))) {
        violations.add('UNRELATED_FIELD_CHANGED', names);
      }
    }
  }

  private validateLifecycle(
    accepted: ParsedSource,
    candidate: ParsedSource,
    relatedFields: ReadonlySet<string>,
    violations: ViolationCollector
  ): void {
    const names = new Set([
      ...accepted.lifecycle.map((method) => method.name),
      ...candidate.lifecycle.map((method) => method.name)
    ]);
    for (const name of names) {
      const left = uniqueMethod(accepted.lifecycle, name);
      const right = uniqueMethod(candidate.lifecycle, name);
      if (left && right && sameMember(accepted.code, left, candidate.code, right)) {
        continue;
      }
      const content = [
        left ? memberContent(accepted.code, left) : '',
        right ? memberContent(candidate.code, right) : ''
      ].join('\n');
      if (
        ![...relatedFields].some((field) => containsIdentifier(content, field))
        || !lifecycleRemainderIsEqual(
          accepted.code,
          left,
          candidate.code,
          right,
          relatedFields
        )
      ) {
        violations.add('UNRELATED_LIFECYCLE_CHANGED', [name]);
      }
    }
  }

  private validateImports(
    accepted: ParsedSource,
    candidate: ParsedSource,
    allowed: ReadonlySet<string>,
    relatedFields: ReadonlySet<string>,
    diagnostic: MavenRepairDiagnostic,
    allowedImports: readonly string[] | undefined,
    violations: ViolationCollector
  ): void {
    const before = new Map(accepted.imports.map((item) => [item.declaration, item]));
    const after = new Map(candidate.imports.map((item) => [item.declaration, item]));
    const removed = accepted.imports.filter((item) => !after.has(item.declaration));
    const added = candidate.imports.filter((item) => !before.has(item.declaration));
    const changed = [...removed, ...added];
    if (changed.length === 0) return;

    const permittedContent = permittedMemberContent(
      accepted,
      candidate,
      allowed,
      relatedFields
    );
    const acceptedContent = sourceWithoutImports(accepted);
    const candidateContent = sourceWithoutImports(candidate);
    const removedDeclarations = new Set(removed.map((item) => item.declaration));
    const addedDeclarations = new Set(added.map((item) => item.declaration));
    const compilerErrorContent = compilerErrorLineContent(
      accepted,
      diagnostic
    );
    const allowedImportDeclarations = new Set(
      (allowedImports ?? []).map(canonicalAllowedImportDeclaration)
    );
    for (const item of changed) {
      if (
        removedDeclarations.has(item.declaration)
        && item.simpleName
        && !containsIdentifier(candidateContent, item.simpleName)
      ) {
        continue;
      }
      if (
        removedDeclarations.has(item.declaration)
        && removedImportRemainsResolvable(item, candidate)
      ) {
        continue;
      }
      if (
        addedDeclarations.has(item.declaration)
        && item.simpleName
        && containsIdentifier(compilerErrorContent, item.simpleName)
      ) {
        continue;
      }
      if (
        addedDeclarations.has(item.declaration)
        && item.simpleName
        && diagnostic.status === 'compile_failed'
        && containsIdentifier(acceptedContent, item.simpleName)
      ) {
        continue;
      }
      if (
        addedDeclarations.has(item.declaration)
        && item.simpleName === null
        && allowedImportDeclarations.has(item.declaration)
      ) {
        continue;
      }
      if (!item.simpleName || !containsIdentifier(permittedContent, item.simpleName)) {
        violations.add('IMPORT_OUT_OF_SCOPE', [item.importedName]);
      }
    }
  }

  private validateSkeleton(
    accepted: ParsedSource,
    candidate: ParsedSource,
    violations: ViolationCollector
  ): void {
    const left = sourceSkeleton(accepted);
    const right = sourceSkeleton(candidate);
    if (left !== right) violations.add('CLASS_SKELETON_CHANGED');
  }

  private allowedMethods(
    accepted: ParsedSource,
    candidate: ParsedSource,
    diagnostic: MavenRepairDiagnostic,
    compilerHitFields: ReadonlySet<string>
  ): Set<string> {
    const direct = new Set<JavaMethodSpan>();
    const affectedTests = new Set<JavaMethodSpan>();
    for (const rawName of diagnostic.affectedTestNames) {
      const test = uniqueMethod(accepted.tests, surefireMethodName(rawName));
      if (test) affectedTests.add(test);
    }
    for (const item of diagnostic.compilerErrors) {
      const match = uniqueMethodAtLine(accepted.methods, item.line);
      if (match) {
        direct.add(match);
        if (match.isTestMethod) affectedTests.add(match);
      }
    }
    for (const frame of diagnostic.generatedTestFrames) {
      const match = uniqueMethodForFrame(
        accepted.methods,
        frame.methodName,
        frame.sourceLine
      );
      if (match) {
        direct.add(match);
        if (match.isTestMethod) affectedTests.add(match);
      }
    }

    const graph = localCallGraph(accepted, this.structure);
    if (compilerHitFields.size > 0) {
      const fieldUsers = accepted.methods.filter((method) => (
        [...compilerHitFields].some((field) => (
          containsIdentifier(memberContent(accepted.code, method), field)
        ))
      ));
      for (const method of fieldUsers) {
        direct.add(method);
        if (method.isTestMethod) affectedTests.add(method);
      }
      for (const test of accepted.tests) {
        if (fieldUsers.some((method) => reaches(test, method, graph))) {
          affectedTests.add(test);
        }
      }
    }
    const allowed = new Set<JavaMethodSpan>([...direct, ...affectedTests]);
    for (const helper of accepted.helpers) {
      const reaching = accepted.tests.filter((test) => reaches(test, helper, graph));
      if (
        reaching.length > 0
        && reaching.some((test) => affectedTests.has(test))
        && affectedTests.size > 0
      ) {
        // A shared fixture/helper may be the root cause for both failing and
        // currently passing tests. Every accepted repair is followed by a full
        // Maven re-run, so regressions in the passing callers remain guarded.
        allowed.add(helper);
      }
    }
    const allowedKeys = new Set(
      [...allowed].map((method) => methodKey(accepted.methods, method))
    );
    const affectedTestKeys = new Set(
      [...affectedTests].map((method) => methodKey(accepted.methods, method))
    );
    const acceptedHelperNames = new Set(
      accepted.helpers.map((method) => method.name)
    );
    const candidateGraph = localCallGraph(candidate, this.structure);
    for (const helper of candidate.helpers) {
      if (acceptedHelperNames.has(helper.name)) continue;
      const reachingTests = candidate.tests.filter((test) => (
        reaches(test, helper, candidateGraph)
      ));
      const reachedFromLifecycle = candidate.lifecycle.some((method) => (
        reaches(method, helper, candidateGraph)
      ));
      if (
        reachingTests.length > 0
        && !reachedFromLifecycle
        && reachingTests.every((test) => (
          affectedTestKeys.has(methodKey(candidate.methods, test))
        ))
      ) {
        allowedKeys.add(methodKey(candidate.methods, helper));
      }
    }
    return allowedKeys;
  }
}

function parseSource(
  code: string,
  structure: JavaTestStructureService
): ParsedSource {
  const methods = structure.findMethods(code);
  return {
    code,
    packageName: javaPackageName(code),
    methods,
    tests: methods.filter((method) => method.isTestMethod),
    lifecycle: methods.filter((method) => method.isLifecycleMethod),
    helpers: methods.filter((method) => (
      !method.isTestMethod && !method.isLifecycleMethod
    )),
    fields: structure.findFields(code),
    imports: javaImports(code)
  };
}

function localCallGraph(
  source: ParsedSource,
  structure: JavaTestStructureService
): Map<JavaMethodSpan, JavaMethodSpan[]> {
  const byName = new Map<string, JavaMethodSpan[]>();
  for (const method of source.methods) {
    byName.set(method.name, [...(byName.get(method.name) ?? []), method]);
  }
  return new Map(source.methods.map((method) => [
    method,
    structure.invokedMethods(source.code, method).flatMap((name) => {
      const matches = byName.get(name) ?? [];
      return matches.length === 1 ? matches : [];
    })
  ]));
}

function reaches(
  start: JavaMethodSpan,
  target: JavaMethodSpan,
  graph: ReadonlyMap<JavaMethodSpan, JavaMethodSpan[]>
): boolean {
  const pending = [...(graph.get(start) ?? [])];
  const visited = new Set<JavaMethodSpan>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

function relatedFieldNames(
  accepted: ParsedSource,
  candidate: ParsedSource,
  allowed: ReadonlySet<string>,
  compilerHitFields: ReadonlySet<string>
): Set<string> {
  const permitted = [accepted, candidate].flatMap((source) => (
    source.methods
      .filter((method) => allowed.has(methodKey(source.methods, method)))
      .map((method) => memberContent(source.code, method))
  )).join('\n');
  const names = new Set<string>(compilerHitFields);
  for (const field of [...accepted.fields, ...candidate.fields]) {
    for (const name of field.names) {
      if (containsIdentifier(permitted, name)) names.add(name);
    }
  }
  const hasAffectedTest = accepted.tests.some((method) => (
    allowed.has(methodKey(accepted.methods, method))
  ));
  const hasInjectMocksTarget = candidate.fields.some((field) => (
    INJECT_MOCKS_ANNOTATION.test(sanitizeJava(memberContent(candidate.code, field)))
  ));
  if (hasAffectedTest && hasInjectMocksTarget) {
    const acceptedFieldNames = new Set(
      accepted.fields.flatMap((field) => field.names)
    );
    const acceptedInjectableMockFieldNames = new Set(
      accepted.fields.flatMap((field) => (
        INJECTABLE_MOCK_ANNOTATION.test(
          sanitizeJava(memberContent(accepted.code, field))
        )
          ? field.names
          : []
      ))
    );
    for (const field of candidate.fields) {
      const content = sanitizeJava(memberContent(candidate.code, field));
      if (!INJECTABLE_MOCK_ANNOTATION.test(content)) continue;
      for (const name of field.names) {
        if (
          !acceptedFieldNames.has(name)
          || acceptedInjectableMockFieldNames.has(name)
        ) {
          names.add(name);
        }
      }
    }
  }
  return names;
}

function compilerHitFieldNames(
  source: ParsedSource,
  diagnostic: MavenRepairDiagnostic
): Set<string> {
  const names = new Set<string>();
  for (const error of diagnostic.compilerErrors) {
    const field = uniqueFieldAtLine(source.fields, error.line);
    if (!field) continue;
    for (const name of field.names) names.add(name);
  }
  return names;
}

function permittedMemberContent(
  accepted: ParsedSource,
  candidate: ParsedSource,
  allowed: ReadonlySet<string>,
  relatedFields: ReadonlySet<string>
): string {
  const contents: string[] = [];
  for (const source of [accepted, candidate]) {
    for (const method of source.methods) {
      if (allowed.has(methodKey(source.methods, method))) {
        contents.push(memberContent(source.code, method));
      } else if (
        method.isLifecycleMethod
        && [...relatedFields].some((field) => (
          containsIdentifier(memberContent(source.code, method), field)
        ))
      ) {
        contents.push(memberContent(source.code, method));
      }
    }
    for (const field of source.fields) {
      if (field.names.some((name) => relatedFields.has(name))) {
        contents.push(memberContent(source.code, field));
      }
    }
  }
  return contents.join('\n');
}

function javaImports(code: string): JavaImport[] {
  return [...code.matchAll(
    /^[\t ]*import[\t ]+(?:static[\t ]+)?([^;\r\n]+);[\t ]*(?:\r?\n|\r)?/gm
  )].map((match) => {
    const importedName = match[1].trim();
    const wildcard = importedName.endsWith('.*');
    return {
      declaration: normalizeJavaForComparison(match[0]),
      importedName,
      simpleName: wildcard ? null : importedName.split('.').at(-1) ?? null,
      isStatic: /^\s*import\s+static\b/.test(match[0]),
      startOffset: match.index ?? 0,
      endOffset: (match.index ?? 0) + match[0].length
    };
  });
}

function canonicalAllowedImportDeclaration(value: string): string {
  const stripped = value.trim().replace(/;\s*$/, '');
  if (/^import\s+/.test(stripped)) {
    return normalizeJavaForComparison(`${stripped};`);
  }
  if (/^static\s+/.test(stripped)) {
    return normalizeJavaForComparison(`import ${stripped};`);
  }
  const importedName = stripped;
  const owner = importedName.endsWith('.*')
    ? importedName.slice(0, -2)
    : importedName.slice(0, importedName.lastIndexOf('.'));
  const member = importedName.endsWith('.*')
    ? '*'
    : importedName.slice(importedName.lastIndexOf('.') + 1);
  const ownerSimpleName = owner.slice(owner.lastIndexOf('.') + 1);
  const isStatic = ownerSimpleName.length > 0
    && /^[A-Z]/.test(ownerSimpleName)
    && (member === '*' || /^[a-z]/.test(member) || member.toUpperCase() === member);
  return normalizeJavaForComparison(
    `import ${isStatic ? 'static ' : ''}${importedName};`
  );
}

function wildcardCoversImport(wildcard: JavaImport, candidate: JavaImport): boolean {
  if (wildcard.isStatic !== candidate.isStatic) return false;
  const separator = candidate.importedName.lastIndexOf('.');
  if (separator < 1) return false;
  return wildcard.importedName === `${candidate.importedName.slice(0, separator)}.*`;
}

function removeImports(code: string, imports: readonly JavaImport[]): string {
  let result = code;
  for (const item of [...imports].sort((left, right) => right.startOffset - left.startOffset)) {
    result = result.slice(0, item.startOffset) + result.slice(item.endOffset);
  }
  return result;
}

function javaPackageName(code: string): string | null {
  const match = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m
    .exec(sanitizeJava(code));
  return match?.[1] ?? null;
}

function removedImportRemainsResolvable(
  removed: JavaImport,
  candidate: ParsedSource
): boolean {
  if (!removed.simpleName) return false;
  const separator = removed.importedName.lastIndexOf('.');
  if (separator < 1) return false;
  const owner = removed.importedName.slice(0, separator);
  if (!removed.isStatic && candidate.packageName === owner) return true;
  return candidate.imports.some((item) => (
    item.isStatic === removed.isStatic
    && item.importedName === `${owner}.*`
  ));
}

function sourceWithoutImports(source: ParsedSource): string {
  const output = [...source.code];
  for (const item of source.imports) {
    for (let index = item.startOffset; index < item.endOffset; index += 1) {
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    }
  }
  return output.join('');
}

function compilerErrorLineContent(
  source: ParsedSource,
  diagnostic: MavenRepairDiagnostic
): string {
  const lines = sanitizeJava(source.code).split(/\r?\n|\r/);
  return diagnostic.compilerErrors
    .map(({ line }) => lines[line - 1] ?? '')
    .join('\n');
}

function sourceSkeleton(source: ParsedSource): string {
  const ranges = [
    ...source.methods,
    ...source.fields,
    ...source.imports
  ];
  const output = [...source.code];
  for (const range of ranges) {
    for (let index = range.startOffset; index < range.endOffset; index += 1) {
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    }
  }
  return normalizeJavaForComparison(output.join(''));
}

function methodKey(methods: readonly JavaMethodSpan[], target: JavaMethodSpan): string {
  const sameName = methods.filter((method) => method.name === target.name);
  return `${target.name}#${Math.max(0, sameName.indexOf(target))}`;
}

function methodForKey(
  methods: readonly JavaMethodSpan[],
  key: string
): JavaMethodSpan | null {
  return methods.find((method) => methodKey(methods, method) === key) ?? null;
}

function fieldIndex(fields: readonly JavaFieldSpan[]): Map<string, JavaFieldSpan> {
  return new Map(fields.map((field) => [field.names.join(','), field]));
}

function uniqueMethod(
  methods: readonly JavaMethodSpan[],
  name: string
): JavaMethodSpan | null {
  const matches = methods.filter((method) => method.name === name);
  return matches.length === 1 ? matches[0] : null;
}

function uniqueMethodAtLine(
  methods: readonly JavaMethodSpan[],
  line: number
): JavaMethodSpan | null {
  const matches = methods.filter((method) => (
    line >= method.startLine && line <= method.endLine
  ));
  return matches.length === 1 ? matches[0] : null;
}

function uniqueFieldAtLine(
  fields: readonly JavaFieldSpan[],
  line: number
): JavaFieldSpan | null {
  const matches = fields.filter((field) => (
    line >= field.startLine && line <= field.endLine
  ));
  return matches.length === 1 ? matches[0] : null;
}

function uniqueMethodForFrame(
  methods: readonly JavaMethodSpan[],
  name: string,
  line: number
): JavaMethodSpan | null {
  const byLine = methods.filter((method) => (
    method.name === name
    && line >= method.startLine
    && line <= method.endLine
  ));
  if (byLine.length === 1) return byLine[0];
  return uniqueMethod(methods, name);
}

function surefireMethodName(value: string): string {
  return value.trim().replace(/[\[(].*$/, '');
}

function isDisabled(code: string, method: JavaMethodSpan): boolean {
  return DISABLED_ANNOTATION.test(code.slice(
    method.startOffset,
    method.bodyStartOffset
  ));
}

function sameMember(
  leftCode: string,
  left: { startOffset: number; endOffset: number },
  rightCode: string,
  right: { startOffset: number; endOffset: number }
): boolean {
  return normalizeJavaForComparison(memberContent(leftCode, left))
    === normalizeJavaForComparison(memberContent(rightCode, right));
}

function memberContent(
  code: string,
  span: { startOffset: number; endOffset: number }
): string {
  return code.slice(span.startOffset, span.endOffset);
}

function lifecycleRemainderIsEqual(
  leftCode: string,
  left: JavaMethodSpan | null,
  rightCode: string,
  right: JavaMethodSpan | null,
  relatedFields: ReadonlySet<string>
): boolean {
  if (!left || !right) return false;
  return normalizeJavaForComparison(
    lifecycleWithoutRelatedStatements(leftCode, left, relatedFields)
  ) === normalizeJavaForComparison(
    lifecycleWithoutRelatedStatements(rightCode, right, relatedFields)
  );
}

function lifecycleWithoutRelatedStatements(
  code: string,
  method: JavaMethodSpan,
  relatedFields: ReadonlySet<string>
): string {
  const content = memberContent(code, method);
  const sanitized = sanitizeJava(content);
  const output = [...content];
  const bodyStart = method.bodyStartOffset - method.startOffset;
  const bodyEnd = method.bodyEndOffset - method.startOffset;
  let statementStart = bodyStart + 1;
  for (let index = statementStart; index < bodyEnd - 1; index += 1) {
    if (sanitized[index] !== ';') continue;
    const statement = sanitized.slice(statementStart, index + 1);
    if ([...relatedFields].some((field) => containsIdentifier(statement, field))) {
      for (let offset = statementStart; offset <= index; offset += 1) {
        if (output[offset] !== '\n' && output[offset] !== '\r') output[offset] = ' ';
      }
    }
    statementStart = index + 1;
  }
  return output.join('');
}

function containsIdentifier(code: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(sanitizeJava(code));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function symmetricDifference(
  left: readonly string[],
  right: readonly string[]
): string[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [
    ...left.filter((value) => !rightSet.has(value)),
    ...right.filter((value) => !leftSet.has(value))
  ];
}

function violationCollector(): ViolationCollector {
  const codes: string[] = [];
  const members: string[] = [];
  return {
    codes,
    members,
    add(code, names = []) {
      if (!codes.includes(code)) codes.push(code);
      for (const name of names) {
        if (name && !members.includes(name)) members.push(name);
      }
    }
  };
}

function rejection(violations: ViolationCollector): CandidateChangeRejection {
  return {
    accepted: false,
    violationCodes: violations.codes,
    memberNames: violations.members,
    message: 'The repair candidate changed Java members outside the newest Maven diagnostic.'
  };
}

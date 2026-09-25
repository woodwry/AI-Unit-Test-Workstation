import { createHash } from 'node:crypto';
import type { MethodTestBundle } from './class-task-runner.service.ts';
import {
  FAILED_TEST_REPAIR_TODO_COMMENT
} from './generated-test-failure-pruner.service.ts';
import {
  JavaTestStructureService,
  matchingBrace,
  sanitizeJava,
  type JavaFieldSpan,
  type JavaMethodSpan
} from './java-test-structure.service.ts';

export type VerifiedMethodBatch = {
  batchId: string;
  filePath: string;
  sha256: string;
  code: string;
  ordinaryTestMethodCount: number;
  passedTestMethods: string[];
};

type ParsedMember = {
  kind: 'test' | 'method' | 'field' | 'other' | 'retained-failure';
  content: string;
  name: string | null;
  names: string[];
};

type ParsedClass = {
  packageDeclaration: string | null;
  imports: string[];
  classHeader: string;
  className: string;
  members: ParsedMember[];
  testMethodNames: string[];
};

type MergedMember = {
  content: string;
  kind: ParsedMember['kind'] | 'lifecycle';
};

type SelectedSupportMember = {
  normalized: string;
  retainedOnly: boolean;
  unusedField: boolean;
  memberIndex: number;
};

type LifecycleStage = 'BEFORE_EACH' | 'AFTER_EACH' | 'BEFORE_ALL' | 'AFTER_ALL';

type LifecycleAggregate = {
  outputIndex: number;
  template: string;
  isStatic: boolean;
  statements: string[];
  statementKeys: Set<string>;
};

export class MethodTestBundleCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MethodTestBundleCompatibilityError';
  }
}

export class MethodTestBundleMergerService {
  private readonly structure: JavaTestStructureService;

  constructor(structure = new JavaTestStructureService()) {
    this.structure = structure;
  }

  merge(methodId: string, batches: readonly VerifiedMethodBatch[]): MethodTestBundle {
    if (batches.length === 0) {
      throw new Error('At least one verified TMP batch is required.');
    }
    const parsed = batches.map((batch) => this.parseVerifiedBatch(batch));
    const first = parsed[0];
    const imports: string[] = [];
    const importSet = new Set<string>();
    const explicitImportBySimpleName = new Map<string, string>();
    const members: MergedMember[] = [];
    const supportByIdentity = new Map<string, SelectedSupportMember>();
    const supportNames = new Map<string, string>();
    const usedTestNames = new Set<string>();
    const passedTestMethods: string[] = [];
    const lifecycleByStage = new Map<LifecycleStage, LifecycleAggregate>();
    const firstClassHeader = normalizedClassHeader(first);

    for (let batchIndex = 0; batchIndex < parsed.length; batchIndex += 1) {
      const current = parsed[batchIndex];
      const retainedOnly = batches[batchIndex].ordinaryTestMethodCount === 0
        && current.members.some((member) => member.kind === 'retained-failure');
      if (current.packageDeclaration !== first.packageDeclaration) {
        throw new MethodTestBundleCompatibilityError(
          'Verified TMP batches use different package declarations.'
        );
      }
      if (normalizedClassHeader(current) !== firstClassHeader) {
        throw new MethodTestBundleCompatibilityError(
          'Verified TMP batches use incompatible top-level test declarations.'
        );
      }
      for (const item of current.imports) {
        registerExplicitImport(item, explicitImportBySimpleName);
        const normalized = canonical(item);
        if (importSet.has(normalized)) continue;
        importSet.add(normalized);
        imports.push(item.trim());
      }
      for (const member of current.members) {
        if (member.kind === 'test' && member.name) {
          const finalName = uniqueTestName(
            member.name,
            batchIndex + 1,
            usedTestNames
          );
          usedTestNames.add(finalName);
          passedTestMethods.push(finalName);
          members.push({
            content: formatMember(finalName === member.name
              ? member.content
              : renameMethod(member.content, member.name, finalName)),
            kind: 'test'
          });
          continue;
        }
        const lifecycle = lifecycleStage(member);
        if (lifecycle) {
          const isStatic = lifecycleMethodIsStatic(member.content);
          let aggregate = lifecycleByStage.get(lifecycle);
          if (!aggregate) {
            aggregate = {
              outputIndex: members.length,
              template: member.content,
              isStatic,
              statements: [],
              statementKeys: new Set<string>()
            };
            lifecycleByStage.set(lifecycle, aggregate);
            members.push({ content: formatMember(member.content), kind: 'lifecycle' });
          } else if (aggregate.isStatic !== isStatic) {
            throw new MethodTestBundleCompatibilityError(
              `Conflicting lifecycle static form in verified TMP batches: ${lifecycle}`
            );
          }
          for (const statement of lifecycleStatements(member.content)) {
            const key = canonical(statement);
            if (!key || aggregate.statementKeys.has(key)) continue;
            aggregate.statementKeys.add(key);
            aggregate.statements.push(statement.trim());
          }
          continue;
        }
        const identity = supportIdentity(member);
        const normalized = member.kind === 'retained-failure'
          ? normalizedRetainedFailure(member.content)
          : member.kind === 'field'
            ? canonicalField(
                member.content,
                current.imports,
                current.packageDeclaration
              )
            : canonical(member.content);
        const unusedField = member.kind === 'field'
          && fieldIsUnused(current, member);
        const existing = supportByIdentity.get(identity);
        if (existing?.normalized === normalized) {
          if (existing.retainedOnly && !retainedOnly) {
            existing.retainedOnly = false;
          }
          if (!unusedField) existing.unusedField = false;
          continue;
        }
        if (existing !== undefined) {
          if (retainedOnly) continue;
          if (existing.retainedOnly) {
            members[existing.memberIndex] = {
              content: formatMember(member.content),
              kind: member.kind
            };
            supportByIdentity.set(identity, {
              normalized,
              retainedOnly: false,
              unusedField,
              memberIndex: existing.memberIndex
            });
            continue;
          }
          if (unusedField) continue;
          if (existing.unusedField) {
            members[existing.memberIndex] = {
              content: formatMember(member.content),
              kind: member.kind
            };
            supportByIdentity.set(identity, {
              normalized,
              retainedOnly: false,
              unusedField: false,
              memberIndex: existing.memberIndex
            });
            continue;
          }
          throw new MethodTestBundleCompatibilityError(
            `Conflicting support member in verified TMP batches: ${identity}`
          );
        }
        if (member.kind === 'field') {
          for (const name of member.names) {
            const priorIdentity = supportNames.get(name);
            if (priorIdentity && priorIdentity !== identity) {
              throw new MethodTestBundleCompatibilityError(
                `Conflicting support member name in verified TMP batches: ${name}`
              );
            }
            supportNames.set(name, identity);
          }
        }
        supportByIdentity.set(identity, {
          normalized,
          retainedOnly,
          unusedField,
          memberIndex: members.length
        });
        members.push({ content: formatMember(member.content), kind: member.kind });
      }
    }

    for (const aggregate of lifecycleByStage.values()) {
      members[aggregate.outputIndex].content = formatMember(renderLifecycleMethod(
        aggregate.template,
        aggregate.statements
      ));
    }

    const orderedMembers = orderMergedMembers(members);
    const code = renderClass(
      first,
      imports,
      orderedMembers.map((member) => member.content)
    );
    const actualTestMethods = this.structure.findTestMethods(code);
    if (
      actualTestMethods.length !== passedTestMethods.length
      || actualTestMethods.some((method, index) => (
        method.name !== passedTestMethods[index]
      ))
    ) {
      throw new Error('Merged ordinary test method count is inconsistent.');
    }
    return {
      methodId,
      code,
      ordinaryTestMethodCount: actualTestMethods.length,
      passedTestMethods,
      sourceBatchIds: batches.map((batch) => batch.batchId)
    };
  }

  private parseVerifiedBatch(batch: VerifiedMethodBatch): ParsedClass {
    const actualDigest = createHash('sha256')
      .update(batch.code, 'utf8')
      .digest('hex');
    if (actualDigest !== batch.sha256.toLowerCase()) {
      throw new Error(`Verified TMP batch digest mismatch: ${batch.filePath}`);
    }
    const parsed = parseClass(batch.code, this.structure);
    if (parsed.testMethodNames.length !== batch.ordinaryTestMethodCount) {
      throw new Error(`Verified TMP batch test method count mismatch: ${batch.filePath}`);
    }
    if (
      batch.passedTestMethods.length !== parsed.testMethodNames.length
      || batch.passedTestMethods.some((name, index) => (
        name !== parsed.testMethodNames[index]
      ))
    ) {
      throw new Error(`Verified TMP batch passed-test list mismatch: ${batch.filePath}`);
    }
    return parsed;
  }
}

function orderMergedMembers(members: readonly MergedMember[]): MergedMember[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((left, right) => (
      mergedMemberOrder(left.member.kind) - mergedMemberOrder(right.member.kind)
        || left.index - right.index
    ))
    .map(({ member }) => member);
}

function mergedMemberOrder(kind: MergedMember['kind']): number {
  if (kind === 'field') return 0;
  if (kind === 'test') return 2;
  if (kind === 'retained-failure') return 3;
  return 1;
}

function fieldIsUnused(parsed: ParsedClass, field: ParsedMember): boolean {
  return !parsed.members.some((member) => (
    member !== field
    && member.kind !== 'retained-failure'
    && field.names.some((name) => containsIdentifier(
      sanitizeJava(member.content),
      name
    ))
  ));
}

function containsIdentifier(value: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(value);
}

function normalizedClassHeader(parsed: ParsedClass): string {
  const escaped = parsed.className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return canonical(parsed.classHeader.replace(
    new RegExp(`(\\b(?:class|record|interface|enum)\\s+)${escaped}\\b`),
    '$1__MergedTestClass__'
  ));
}

function registerExplicitImport(
  declaration: string,
  explicitImportBySimpleName: Map<string, string>
): void {
  const match = /^import\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+);$/
    .exec(declaration.trim());
  if (!match) return;
  const qualifiedName = match[1];
  const simpleName = qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
  const existing = explicitImportBySimpleName.get(simpleName);
  if (existing && existing !== qualifiedName) {
    throw new MethodTestBundleCompatibilityError(
      `Conflicting import in verified TMP batches: ${simpleName}`
    );
  }
  explicitImportBySimpleName.set(simpleName, qualifiedName);
}

function lifecycleStage(member: ParsedMember): LifecycleStage | null {
  if (member.kind !== 'method') return null;
  const sanitized = sanitizeJava(member.content);
  if (/@(?:[A-Za-z_$][\w$]*\.)*BeforeEach\b/.test(sanitized)) return 'BEFORE_EACH';
  if (/@(?:[A-Za-z_$][\w$]*\.)*AfterEach\b/.test(sanitized)) return 'AFTER_EACH';
  if (/@(?:[A-Za-z_$][\w$]*\.)*BeforeAll\b/.test(sanitized)) return 'BEFORE_ALL';
  if (/@(?:[A-Za-z_$][\w$]*\.)*AfterAll\b/.test(sanitized)) return 'AFTER_ALL';
  return null;
}

function lifecycleMethodIsStatic(content: string): boolean {
  const sanitized = sanitizeJava(content);
  const opening = sanitized.indexOf('{');
  return /\bstatic\b/.test(opening < 0 ? sanitized : sanitized.slice(0, opening));
}

function lifecycleStatements(content: string): string[] {
  const sanitized = sanitizeJava(content);
  const opening = sanitized.indexOf('{');
  const closing = opening < 0 ? -1 : matchingBrace(sanitized, opening);
  if (opening < 0 || closing < 0) {
    throw new Error('Verified TMP lifecycle method is structurally invalid.');
  }
  return splitJavaStatements(content.slice(opening + 1, closing));
}

function renderLifecycleMethod(
  template: string,
  statements: readonly string[]
): string {
  const sanitized = sanitizeJava(template);
  const opening = sanitized.indexOf('{');
  const closing = opening < 0 ? -1 : matchingBrace(sanitized, opening);
  if (opening < 0 || closing < 0) {
    throw new Error('Verified TMP lifecycle method is structurally invalid.');
  }
  const lineStartOffset = template.lastIndexOf('\n', opening) + 1;
  const methodIndent = /^[\t ]*/.exec(template.slice(lineStartOffset))?.[0] ?? '    ';
  const statementIndent = `${methodIndent}    `;
  const body = statements.map((statement) => (
    statement.split(/\r?\n/).map((line) => (
      line.trim() ? `${statementIndent}${line.trim()}` : ''
    )).join('\n')
  )).join('\n');
  return `${template.slice(0, opening + 1).trimEnd()}\n${body}\n${methodIndent}}`;
}

function splitJavaStatements(body: string): string[] {
  const sanitized = sanitizeJava(body);
  const statements: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < sanitized.length; index += 1) {
    const character = sanitized[index];
    if (character === '(') round += 1;
    else if (character === ')') round = Math.max(0, round - 1);
    else if (character === '[') square += 1;
    else if (character === ']') square = Math.max(0, square - 1);
    else if (character === '{') curly += 1;
    else if (character === '}') curly = Math.max(0, curly - 1);
    if (character === ';' && round === 0 && square === 0 && curly === 0) {
      const statement = body.slice(start, index + 1).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

export function countRetainedFailureTestMethods(
  code: string,
  structure = new JavaTestStructureService()
): number {
  return parseClass(code, structure).members.filter((member) => (
    member.kind === 'retained-failure'
  )).length;
}

function parseClass(
  code: string,
  structure: JavaTestStructureService
): ParsedClass {
  const sanitized = sanitizeJava(code);
  const type = /\b(?:class|record|interface|enum)\s+([A-Za-z_$][\w$]*)[^{};]*\{/
    .exec(sanitized);
  if (!type) throw new Error('Verified TMP batch has no top-level Java type.');
  const classOpen = type.index + type[0].lastIndexOf('{');
  const classClose = matchingBrace(sanitized, classOpen);
  if (classClose < 0) throw new Error('Verified TMP batch Java type is truncated.');
  if (sanitized.slice(classClose + 1).trim()) {
    throw new Error('Verified TMP batch contains content after its Java type.');
  }
  const prefix = code.slice(0, classOpen);
  const packageMatch = /^[\t ]*package[\t ]+[^;\r\n]+;/m.exec(prefix);
  const imports = [...prefix.matchAll(
    /^[\t ]*import[\t ]+(?:static[\t ]+)?[^;\r\n]+;/gm
  )].map((match) => match[0].trim());
  const headerStart = Math.max(
    packageMatch ? (packageMatch.index ?? 0) + packageMatch[0].length : 0,
    ...[...prefix.matchAll(
      /^[\t ]*import[\t ]+(?:static[\t ]+)?[^;\r\n]+;/gm
    )].map((match) => (match.index ?? 0) + match[0].length)
  );
  const classHeader = prefix.slice(headerStart).trim();
  if (!classHeader) throw new Error('Verified TMP batch Java type header is invalid.');

  const methods = structure.findMethods(code);
  const fields = structure.findFields(code);
  const ordinarySpans = topLevelMemberSpans(sanitized, classOpen, classClose);
  const retainedFailureSpans = repairTodoCommentSpans(
    code,
    classOpen,
    classClose
  ).filter((candidate) => !ordinarySpans.some((span) => (
    candidate.startOffset < span.endOffset
      && candidate.endOffset > span.startOffset
  )));
  const retainedFailureKeys = new Set(retainedFailureSpans.map((span) => (
    `${span.startOffset}:${span.endOffset}`
  )));
  const spans = [...ordinarySpans, ...retainedFailureSpans]
    .sort((left, right) => left.startOffset - right.startOffset);
  const members = spans.map(({ startOffset, endOffset }) => {
    const content = code.slice(startOffset, endOffset);
    if (retainedFailureKeys.has(`${startOffset}:${endOffset}`)) {
      return {
        kind: 'retained-failure' as const,
        content,
        name: null,
        names: []
      };
    }
    const method = methods.find((item) => (
      item.startOffset >= startOffset && item.endOffset <= endOffset + 2
    ));
    const field = fields.find((item) => (
      item.startOffset >= startOffset && item.endOffset <= endOffset + 2
    ));
    if (method) return memberForMethod(content, method);
    if (field) return memberForField(content, field);
    return {
      kind: 'other' as const,
      content,
      name: null,
      names: []
    };
  });
  return {
    packageDeclaration: packageMatch?.[0].trim() ?? null,
    imports,
    classHeader,
    className: type[1],
    members,
    testMethodNames: methods
      .filter((method) => method.isTestMethod)
      .map((method) => method.name)
  };
}

function repairTodoCommentSpans(
  code: string,
  classOpen: number,
  classClose: number
): Array<{ startOffset: number; endOffset: number }> {
  const marker = FAILED_TEST_REPAIR_TODO_COMMENT
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^[\\t ]*${marker}[\\t ]*(?:\\r?\\n|\\r|$)`,
    'gm'
  );
  const spans: Array<{ startOffset: number; endOffset: number }> = [];
  for (const match of code.matchAll(pattern)) {
    const startOffset = match.index ?? -1;
    if (startOffset <= classOpen || startOffset >= classClose) continue;
    let endOffset = startOffset + match[0].length;
    while (endOffset < classClose) {
      const next = /^[\t ]*\/\/[^\r\n]*(?:\r?\n|\r|$)/
        .exec(code.slice(endOffset, classClose));
      if (!next) break;
      endOffset += next[0].length;
    }
    spans.push({ startOffset, endOffset });
  }
  return spans;
}

function memberForMethod(content: string, method: JavaMethodSpan): ParsedMember {
  return {
    kind: method.isTestMethod ? 'test' : 'method',
    content,
    name: method.name,
    names: [method.name]
  };
}

function memberForField(content: string, field: JavaFieldSpan): ParsedMember {
  return {
    kind: 'field',
    content,
    name: field.names[0] ?? null,
    names: field.names
  };
}

function topLevelMemberSpans(
  sanitized: string,
  classOpen: number,
  classClose: number
): Array<{ startOffset: number; endOffset: number }> {
  const spans: Array<{ startOffset: number; endOffset: number }> = [];
  let cursor = classOpen + 1;
  let previousEnd = classOpen + 1;
  while (cursor < classClose) {
    while (cursor < classClose && /\s/.test(sanitized[cursor])) cursor += 1;
    if (cursor >= classClose) break;
    const candidateLineStart = lineStart(sanitized, cursor);
    const startOffset = candidateLineStart >= classOpen + 1
      && candidateLineStart >= previousEnd
      ? candidateLineStart
      : previousEnd;
    let index = cursor;
    let round = 0;
    let square = 0;
    let endOffset = -1;
    while (index < classClose) {
      const character = sanitized[index];
      if (character === '(') round += 1;
      else if (character === ')') round = Math.max(0, round - 1);
      else if (character === '[') square += 1;
      else if (character === ']') square = Math.max(0, square - 1);
      else if (character === ';' && round === 0 && square === 0) {
        endOffset = includeTrailingLineBreak(sanitized, index + 1);
        break;
      } else if (character === '{' && round === 0 && square === 0) {
        const header = sanitized.slice(cursor, index);
        const close = matchingBrace(sanitized, index);
        if (close < 0 || close > classClose) {
          throw new Error('Verified TMP batch contains an unbalanced member.');
        }
        if (isFieldInitializerHeader(header)) {
          index = close;
        } else {
          let memberEnd = close + 1;
          while (memberEnd < classClose && /[\t ]/.test(sanitized[memberEnd])) {
            memberEnd += 1;
          }
          if (sanitized[memberEnd] === ';') memberEnd += 1;
          endOffset = includeTrailingLineBreak(sanitized, memberEnd);
          break;
        }
      }
      index += 1;
    }
    if (endOffset < 0) throw new Error('Verified TMP batch member is truncated.');
    spans.push({ startOffset, endOffset });
    previousEnd = endOffset;
    cursor = endOffset;
  }
  return spans;
}

function isFieldInitializerHeader(header: string): boolean {
  let round = 0;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '(') round += 1;
    else if (character === ')') round = Math.max(0, round - 1);
    else if (round === 0 && character === '=') return true;
    else if (round === 0 && character === '-' && header[index + 1] === '>') return true;
  }
  return false;
}

function renderClass(
  parsed: ParsedClass,
  imports: readonly string[],
  members: readonly string[]
): string {
  const sections: string[] = [];
  if (parsed.packageDeclaration) sections.push(parsed.packageDeclaration);
  if (imports.length > 0) sections.push(imports.join('\n'));
  sections.push(`${parsed.classHeader} {`);
  const prefix = sections.join('\n\n');
  const body = members
    .filter((member) => member.trim())
    .map((member) => member.trimEnd())
    .join('\n\n');
  return `${prefix}\n${body ? `\n${body}\n` : ''}}\n`;
}

function uniqueTestName(
  original: string,
  batchNumber: number,
  used: ReadonlySet<string>
): string {
  if (!used.has(original)) return original;
  const base = `${original}Batch${batchNumber}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function renameMethod(content: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...content.matchAll(new RegExp(`\\b${escaped}\\s*(?=\\()`, 'g'))];
  const match = matches.at(0);
  if (!match || match.index === undefined) {
    throw new Error(`Cannot rename duplicate test method ${from}.`);
  }
  return content.slice(0, match.index) + to
    + content.slice(match.index + match[0].trimEnd().length);
}

function supportIdentity(member: ParsedMember): string {
  if (member.kind === 'retained-failure') {
    return `retained-failure:${createHash('sha256')
      .update(normalizedRetainedFailure(member.content), 'utf8')
      .digest('hex')}`;
  }
  if (member.kind === 'method') {
    return `method:${methodSignature(member.content, member.name)}`;
  }
  if (member.kind === 'field') return `field:${member.names.join(',')}`;
  return `other:${canonical(member.content)}`;
}

function normalizedRetainedFailure(content: string): string {
  return content.replace(/\r\n?/g, '\n').trim();
}

function methodSignature(content: string, name: string | null): string {
  if (!name) return canonical(content);
  const sanitized = sanitizeJava(content);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of sanitized.matchAll(new RegExp(`\\b${escaped}\\s*\\(`, 'g'))) {
    const opening = sanitized.indexOf('(', match.index ?? 0);
    const closing = matchingParenthesis(sanitized, opening);
    if (closing < 0) continue;
    const tail = sanitized.slice(closing + 1);
    const body = tail.indexOf('{');
    const terminator = tail.search(/[;=]/);
    if (body >= 0 && (terminator < 0 || body < terminator)) {
      const parameters = sanitized.slice(opening + 1, closing);
      return `${name}(${parameterTypeSignature(parameters)})`;
    }
  }
  return `${name}:${canonical(content)}`;
}

function parameterTypeSignature(parameters: string): string {
  if (!parameters.trim()) return '';
  return splitParameters(parameters)
    .map((parameter) => {
      const withoutAnnotations = stripParameterAnnotations(parameter)
        .replace(/\bfinal\b/g, ' ')
        .trim();
      const variable = /([A-Za-z_$][\w$]*)\s*((?:\[\s*\]\s*)*)$/
        .exec(withoutAnnotations);
      if (!variable || variable.index === undefined) {
        return eraseJavaParameterType(
          canonical(withoutAnnotations).replace(/\s+/g, '')
        );
      }
      const type = withoutAnnotations.slice(0, variable.index)
        + (variable[2] ?? '');
      return eraseJavaParameterType(canonical(type).replace(/\s+/g, ''));
    })
    .join(',');
}

function eraseJavaParameterType(value: string): string {
  let erased = '';
  let genericDepth = 0;
  for (const character of value) {
    if (character === '<') {
      genericDepth += 1;
    } else if (character === '>') {
      genericDepth = Math.max(0, genericDepth - 1);
    } else if (genericDepth === 0) {
      erased += character;
    }
  }
  return erased.replace(/\.\.\./g, '[]');
}

function splitParameters(value: string): string[] {
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
      character === ','
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

function stripParameterAnnotations(value: string): string {
  const output = [...value];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '@') continue;
    const start = index;
    index += 1;
    while (index < value.length && /[A-Za-z0-9_$.]/.test(value[index])) {
      index += 1;
    }
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (value[index] === '(') {
      const closing = matchingParenthesis(value, index);
      index = closing < 0 ? value.length : closing + 1;
    }
    for (let cursor = start; cursor < index; cursor += 1) {
      output[cursor] = ' ';
    }
    index -= 1;
  }
  return output.join('');
}

function matchingParenthesis(value: string, opening: number): number {
  if (opening < 0 || value[opening] !== '(') return -1;
  let depth = 0;
  for (let index = opening; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function formatMember(content: string): string {
  const lines = content
    .replace(/\r\n?/g, '\n')
    .split('\n');
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  const nonEmpty = lines.filter((line) => line.trim());
  const minimumIndent = nonEmpty.length === 0
    ? 0
    : Math.min(...nonEmpty.map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
  return lines.map((line) => (
    line.trim() ? `    ${line.slice(minimumIndent).trimEnd()}` : ''
  )).join('\n');
}

function canonical(value: string): string {
  return sanitizeJava(value).replace(/\s+/g, ' ').trim();
}

function canonicalField(
  value: string,
  imports: readonly string[],
  packageDeclaration: string | null
): string {
  let normalized = sanitizeJava(value);
  const explicitTypes = new Map<string, string | null>();
  for (const declaration of imports) {
    const match = /^import\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+);$/
      .exec(declaration.trim());
    if (!match) continue;
    const fqn = match[1];
    const simpleName = fqn.slice(fqn.lastIndexOf('.') + 1);
    const previous = explicitTypes.get(simpleName);
    explicitTypes.set(
      simpleName,
      previous === undefined || previous === fqn ? fqn : null
    );
  }
  for (const [simpleName, fqn] of explicitTypes) {
    if (!fqn) continue;
    const escaped = simpleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized.replace(
      new RegExp(`(?<![A-Za-z0-9_$.])${escaped}(?![A-Za-z0-9_$])`, 'g'),
      fqn
    );
  }
  const packageName = packageDeclaration === null
    ? null
    : /^package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;$/
      .exec(packageDeclaration)?.[1] ?? null;
  if (packageName) {
    const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized.replace(
      new RegExp(`(?<![A-Za-z0-9_$.])${escapedPackage}\\.`, 'g'),
      ''
    );
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function lineStart(code: string, offset: number): number {
  const newline = code.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function includeTrailingLineBreak(code: string, offset: number): number {
  let end = offset;
  while (end < code.length && (code[end] === ' ' || code[end] === '\t')) end += 1;
  if (code[end] === '\r' && code[end + 1] === '\n') return end + 2;
  if (code[end] === '\n' || code[end] === '\r') return end + 1;
  return end;
}

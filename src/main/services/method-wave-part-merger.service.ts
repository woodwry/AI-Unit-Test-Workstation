import { createHash } from 'node:crypto';
import {
  JavaTestStructureService,
  matchingBrace,
  normalizeJavaForComparison,
  sanitizeJava,
  type JavaFieldSpan,
  type JavaMethodSpan
} from './java-test-structure.service.ts';

type LifecycleStage = 'BEFORE_EACH' | 'AFTER_EACH' | 'BEFORE_ALL' | 'AFTER_ALL';
type WaveMemberKind = 'test' | 'lifecycle' | 'method' | 'field' | 'other';

export type MethodWaveMergePart = {
  partIndex: number;
  partBatchId: string;
  scenarioIds: string[];
  candidateId: string;
  testClassName: string;
  code: string;
};

export type MethodWavePartMergeInput = {
  methodId: string;
  waveId: string;
  waveIndex: number;
  outputTestClassName: string;
  parts: MethodWaveMergePart[];
};

export type MethodWaveMemberProvenance = {
  memberId: string;
  kind: WaveMemberKind;
  name: string | null;
  partIndexes: number[];
  sourceRanges: Array<{
    partIndex: number;
    startLine: number;
    endLine: number;
  }>;
};

export type MethodWavePartMergeResult = {
  methodId: string;
  waveId: string;
  waveIndex: number;
  outputTestClassName: string;
  code: string;
  sha256: string;
  ordinaryTestMethodCount: number;
  passedTestMethods: string[];
  acceptedPartIndexes: number[];
  skippedPartIndexes: number[];
  skippedParts: Array<{ partIndex: number; reason: string }>;
  sourcePartBatchIds: string[];
  provenance: {
    members: Record<string, MethodWaveMemberProvenance>;
    lifecycleStaticForms: Array<{
      stage: LifecycleStage;
      partIndex: number;
      isStatic: boolean;
    }>;
  };
};

type ParsedWaveMember = {
  kind: WaveMemberKind;
  identity: string;
  name: string | null;
  names: string[];
  supportSignature: string | null;
  content: string;
  normalized: string;
  startLine: number;
  endLine: number;
  lifecycleStage: LifecycleStage | null;
  lifecycleBody: string | null;
  isStatic: boolean;
};

type ParsedWavePart = {
  part: MethodWaveMergePart;
  packageDeclaration: string | null;
  imports: string[];
  classHeader: string;
  className: string;
  members: ParsedWaveMember[];
};

type SelectedMember = {
  content: string;
  provenance: MethodWaveMemberProvenance;
};

type LifecycleAggregate = {
  stage: LifecycleStage;
  outputIndex: number;
  template: ParsedWaveMember;
  statements: string[];
  statementKeys: Set<string>;
  sources: Array<{ partIndex: number; member: ParsedWaveMember }>;
};

export class MethodWavePartMergerService {
  private readonly structure: JavaTestStructureService;

  constructor(structure = new JavaTestStructureService()) {
    this.structure = structure;
  }

  merge(input: MethodWavePartMergeInput): MethodWavePartMergeResult {
    validateMergeInput(input);
    const orderedParts = [...input.parts].sort((left, right) => (
      left.partIndex - right.partIndex
    ));
    const accepted: ParsedWavePart[] = [];
    const skippedParts: Array<{ partIndex: number; reason: string }> = [];
    let expectedPackage: string | null | undefined;
    for (const part of orderedParts) {
      try {
        const parsed = parseWavePart(part, this.structure);
        if (parsed.className !== part.testClassName) {
          throw new Error('declared test class does not match Part identity');
        }
        if (expectedPackage === undefined) expectedPackage = parsed.packageDeclaration;
        if (parsed.packageDeclaration !== expectedPackage) {
          throw new Error('package declaration differs from the accepted Wave Parts');
        }
        accepted.push(parsed);
      } catch (error) {
        skippedParts.push({
          partIndex: part.partIndex,
          reason: error instanceof Error ? error.message : 'invalid Java Part'
        });
      }
    }
    if (accepted.length === 0) {
      throw new Error('No structurally valid Wave Part can be merged.');
    }

    const imports: string[] = [];
    const importKeys = new Set<string>();
    const output: SelectedMember[] = [];
    const selectedByExactIdentity = new Map<string, SelectedMember>();
    const reservedMemberNames = new Set(accepted.flatMap((parsed) => (
      parsed.members.flatMap((member) => member.name ? [member.name] : [])
    )));
    const priorFieldsByName = new Map<string, Set<string>>();
    const fieldPreparedParts = accepted.map((parsed) => preparePartFields(
      parsed,
      priorFieldsByName,
      reservedMemberNames
    ));
    const supportBodiesBySignature = new Map<string, Set<string>>();
    const preparedParts = fieldPreparedParts.map((parsed) => preparePartSupportMethods(
      parsed,
      supportBodiesBySignature,
      reservedMemberNames
    ));
    const reservedTestNames = new Set(accepted.flatMap((parsed) => (
      parsed.members.flatMap((member) => (
        member.kind === 'test' && member.name ? [member.name] : []
      ))
    )));
    const usedTestNames = new Set<string>();
    const lifecycles = new Map<LifecycleStage, LifecycleAggregate>();
    const lifecycleStaticForms: MethodWavePartMergeResult['provenance']['lifecycleStaticForms'] = [];

    for (const parsed of preparedParts) {
      for (const item of parsed.imports) {
        const key = normalizeJavaForComparison(item);
        if (importKeys.has(key)) continue;
        importKeys.add(key);
        imports.push(item.trim());
      }
      for (const member of parsed.members) {
        const source = {
          partIndex: parsed.part.partIndex,
          startLine: member.startLine,
          endLine: member.endLine
        };
        if (member.kind === 'lifecycle' && member.lifecycleStage) {
          if (member.lifecycleStage === 'BEFORE_ALL'
            || member.lifecycleStage === 'AFTER_ALL') {
            lifecycleStaticForms.push({
              stage: member.lifecycleStage,
              partIndex: parsed.part.partIndex,
              isStatic: member.isStatic
            });
          }
          let aggregate = lifecycles.get(member.lifecycleStage);
          if (!aggregate) {
            const provenance = provenanceFor(member, parsed.part.partIndex);
            aggregate = {
              stage: member.lifecycleStage,
              outputIndex: output.length,
              template: member,
              statements: [],
              statementKeys: new Set<string>(),
              sources: []
            };
            output.push({ content: member.content, provenance });
            lifecycles.set(member.lifecycleStage, aggregate);
          } else {
            mergeSource(aggregateSource(output[aggregate.outputIndex]), source);
          }
          aggregate.sources.push({ partIndex: parsed.part.partIndex, member });
          for (const statement of splitLifecycleStatements(member.lifecycleBody ?? '')) {
            const key = normalizeJavaForComparison(statement);
            if (!key || aggregate.statementKeys.has(key)) continue;
            aggregate.statementKeys.add(key);
            aggregate.statements.push(statement.trim());
          }
          continue;
        }

        const exactKey = `${member.identity}\0${member.normalized}`;
        const existing = selectedByExactIdentity.get(exactKey);
        if (existing) {
          mergeSource(existing.provenance, source);
          continue;
        }
        let content = member.content;
        const provenance = provenanceFor(member, parsed.part.partIndex);
        if (member.kind === 'test' && member.name) {
          const finalName = uniqueWaveTestName(
            member.name,
            usedTestNames,
            reservedTestNames
          );
          usedTestNames.add(finalName);
          if (finalName !== member.name) {
            content = renameTestDeclaration(content, member.name, finalName);
            provenance.name = finalName;
            provenance.memberId = memberId(
              `test:${finalName}`,
              normalizeJavaForComparison(content)
            );
          }
        }
        const selected = { content, provenance };
        selectedByExactIdentity.set(exactKey, selected);
        output.push(selected);
      }
    }

    for (const aggregate of lifecycles.values()) {
      const selected = output[aggregate.outputIndex];
      selected.content = renderLifecycleMethod(
        aggregate.template.content,
        aggregate.statements
      );
      selected.provenance.memberId = memberId(
        `lifecycle:${aggregate.stage}`,
        normalizeJavaForComparison(selected.content)
      );
    }
    const orderedOutput = orderWaveMembers(output);

    const first = accepted[0];
    const classHeader = renameTopLevelType(
      mergeWaveClassAnnotations(accepted),
      first.className,
      input.outputTestClassName
    );
    const code = renderWaveClass(
      first.packageDeclaration,
      imports,
      classHeader,
      orderedOutput.map((member) => member.content)
    );
    const testMethods = this.structure.findTestMethods(code);
    const passedTestMethods = orderedOutput.flatMap((member) => (
      member.provenance.kind === 'test' && member.provenance.name
        ? [member.provenance.name]
        : []
    ));
    if (testMethods.length !== passedTestMethods.length
      || testMethods.some((method, index) => method.name !== passedTestMethods[index])) {
      throw new Error('Merged Wave test-method metadata is inconsistent.');
    }
    const members = Object.fromEntries(orderedOutput.map(({ provenance }) => (
      [provenance.memberId, provenance]
    )));
    return {
      methodId: input.methodId,
      waveId: input.waveId,
      waveIndex: input.waveIndex,
      outputTestClassName: input.outputTestClassName,
      code,
      sha256: createHash('sha256').update(code, 'utf8').digest('hex'),
      ordinaryTestMethodCount: testMethods.length,
      passedTestMethods,
      acceptedPartIndexes: accepted.map(({ part }) => part.partIndex),
      skippedPartIndexes: skippedParts.map(({ partIndex }) => partIndex),
      skippedParts,
      sourcePartBatchIds: accepted.map(({ part }) => part.partBatchId),
      provenance: {
        members,
        lifecycleStaticForms
      }
    };
  }
}

function mergeWaveClassAnnotations(parts: readonly ParsedWavePart[]): string {
  const seen = new Set<string>();
  const additional: string[] = [];
  for (const [partIndex, part] of parts.entries()) {
    const sanitized = sanitizeJava(part.classHeader);
    const declaration = /\b(?:class|record|interface|enum)\s+[A-Za-z_$]/u.exec(sanitized);
    const prefix = sanitized.slice(0, declaration?.index ?? sanitized.length);
    const pattern = /@[A-Za-z_$][\w$.]*/gu;
    for (let match = pattern.exec(prefix); match; match = pattern.exec(prefix)) {
      let end = pattern.lastIndex;
      let cursor = end;
      while (cursor < prefix.length && /\s/u.test(prefix[cursor])) cursor += 1;
      if (prefix[cursor] === '(') {
        const closing = matchingParenthesis(prefix, cursor);
        if (closing < 0) throw new Error('Wave Part class annotation is truncated.');
        end = closing + 1;
      }
      pattern.lastIndex = end;
      const annotation = part.classHeader.slice(match.index, end);
      const key = normalizeJavaForComparison(annotation);
      if (seen.has(key)) continue;
      seen.add(key);
      if (partIndex > 0) additional.push(annotation);
    }
  }
  return [...additional, parts[0].classHeader].join('\n');
}

function orderWaveMembers(members: readonly SelectedMember[]): SelectedMember[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((left, right) => (
      waveMemberOrder(left.member.provenance.kind)
        - waveMemberOrder(right.member.provenance.kind)
      || left.index - right.index
    ))
    .map(({ member }) => member);
}

function waveMemberOrder(kind: WaveMemberKind): number {
  if (kind === 'field') return 0;
  if (kind === 'lifecycle') return 1;
  if (kind === 'test') return 3;
  return 2;
}

function preparePartFields(
  parsed: ParsedWavePart,
  priorBodiesByName: Map<string, Set<string>>,
  reservedMemberNames: Set<string>
): ParsedWavePart {
  const renames = new Map<string, string>();
  for (const member of parsed.members) {
    if (member.kind !== 'field') continue;
    for (const name of member.names) {
      const priorBodies = priorBodiesByName.get(name);
      if (!priorBodies || priorBodies.has(member.normalized)) continue;
      renames.set(name, uniqueWaveFieldName(
        name,
        parsed.part.partIndex,
        reservedMemberNames
      ));
    }
  }

  const prepared = rewritePartFields(parsed, renames);
  for (const member of prepared.members) {
    if (member.kind !== 'field') continue;
    for (const name of member.names) {
      let bodies = priorBodiesByName.get(name);
      if (!bodies) {
        bodies = new Set<string>();
        priorBodiesByName.set(name, bodies);
      }
      bodies.add(member.normalized);
    }
  }
  return prepared;
}

function rewritePartFields(
  parsed: ParsedWavePart,
  renames: ReadonlyMap<string, string>
): ParsedWavePart {
  if (renames.size === 0) return parsed;
  return {
    ...parsed,
    members: parsed.members.map((member) => rewriteMemberFieldReferences(member, renames))
  };
}

function rewriteMemberFieldReferences(
  member: ParsedWaveMember,
  renames: ReadonlyMap<string, string>
): ParsedWaveMember {
  const content = renameJavaFieldIdentifiers(member.content, renames);
  const normalized = normalizeJavaForComparison(content);
  const names = member.kind === 'field'
    ? member.names.map((name) => renames.get(name) ?? name)
    : member.names;
  const declaration = member.name ? findMethodDeclaration(content, member.name) : null;
  return {
    ...member,
    identity: member.kind === 'field'
      ? `field:${[...names].sort().join(',')}`
      : member.kind === 'other'
        ? `other:${normalized}`
        : member.identity,
    name: member.kind === 'field' ? (names[0] ?? null) : member.name,
    names,
    supportSignature: member.kind === 'method' && member.name
      ? methodSignature(content, member.name)
      : member.supportSignature,
    content,
    normalized,
    lifecycleBody: member.lifecycleStage && declaration
      ? content.slice(declaration.bodyOpen + 1, declaration.bodyClose)
      : member.lifecycleBody
  };
}

function uniqueWaveFieldName(
  original: string,
  partIndex: number,
  reserved: Set<string>
): string {
  const base = `${original}Part${partIndex}`;
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function renameJavaFieldIdentifiers(
  content: string,
  renames: ReadonlyMap<string, string>
): string {
  const sanitized = sanitizeJava(content);
  const replacements: Array<{ offset: number; from: string; to: string }> = [];
  for (const match of sanitized.matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
    if (match.index === undefined) continue;
    const from = match[0];
    const to = renames.get(from);
    if (!to) continue;
    let cursor = match.index + from.length;
    while (cursor < sanitized.length && /\s/u.test(sanitized[cursor])) cursor += 1;
    if (sanitized[cursor] === '(') continue;
    replacements.push({ offset: match.index, from, to });
  }
  let rewritten = content;
  for (const replacement of replacements.reverse()) {
    rewritten = rewritten.slice(0, replacement.offset) + replacement.to
      + rewritten.slice(replacement.offset + replacement.from.length);
  }
  return rewritten;
}

function preparePartSupportMethods(
  parsed: ParsedWavePart,
  priorBodiesBySignature: Map<string, Set<string>>,
  reservedMethodNames: Set<string>
): ParsedWavePart {
  const renames = new Map<string, string>();
  let prepared = parsed;
  while (true) {
    prepared = rewritePartSupportMethods(parsed, renames);
    const collisionIndex = prepared.members.findIndex((member, index) => {
      const original = parsed.members[index];
      if (member.kind !== 'method'
        || !member.supportSignature
        || !original?.name
        || renames.has(original.name)) {
        return false;
      }
      const priorBodies = priorBodiesBySignature.get(member.supportSignature);
      return priorBodies !== undefined && !priorBodies.has(member.normalized);
    });
    if (collisionIndex < 0) break;
    const originalName = parsed.members[collisionIndex].name;
    if (!originalName) break;
    renames.set(originalName, uniqueWaveSupportName(
      originalName,
      parsed.part.partIndex,
      reservedMethodNames
    ));
  }

  for (const member of prepared.members) {
    if (member.kind !== 'method' || !member.supportSignature) continue;
    let bodies = priorBodiesBySignature.get(member.supportSignature);
    if (!bodies) {
      bodies = new Set<string>();
      priorBodiesBySignature.set(member.supportSignature, bodies);
    }
    bodies.add(member.normalized);
  }
  return prepared;
}

function rewritePartSupportMethods(
  parsed: ParsedWavePart,
  renames: ReadonlyMap<string, string>
): ParsedWavePart {
  if (renames.size === 0) return parsed;
  return {
    ...parsed,
    members: parsed.members.map((member) => rewriteMemberSupportCalls(member, renames))
  };
}

function rewriteMemberSupportCalls(
  member: ParsedWaveMember,
  renames: ReadonlyMap<string, string>
): ParsedWaveMember {
  let content = member.content;
  let finalName = member.name;
  if (member.kind === 'method' && finalName) {
    const renamed = renames.get(finalName);
    if (renamed) {
      content = renameMethodDeclaration(content, finalName, renamed);
      finalName = renamed;
    }
  }
  for (const [from, to] of renames) {
    const declaration = finalName ? findMethodDeclaration(content, finalName) : null;
    const scanStart = member.kind === 'test'
      || member.kind === 'method'
      || member.kind === 'lifecycle'
      ? (declaration?.bodyOpen ?? -1) + 1
      : 0;
    content = renameLocalMethodCalls(content, from, to, scanStart);
  }
  const normalized = normalizeJavaForComparison(content);
  const declaration = finalName ? findMethodDeclaration(content, finalName) : null;
  return {
    ...member,
    identity: member.kind === 'method' && finalName
      ? `method:${finalName}`
      : member.kind === 'other'
        ? `other:${normalized}`
        : member.identity,
    name: finalName,
    names: member.kind === 'method' && finalName ? [finalName] : member.names,
    supportSignature: member.kind === 'method' && finalName
      ? methodSignature(content, finalName)
      : null,
    content,
    normalized,
    lifecycleBody: member.lifecycleStage && declaration
      ? content.slice(declaration.bodyOpen + 1, declaration.bodyClose)
      : member.lifecycleBody
  };
}

function uniqueWaveSupportName(
  original: string,
  partIndex: number,
  reserved: Set<string>
): string {
  const base = `${original}Part${partIndex}`;
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function renameMethodDeclaration(content: string, from: string, to: string): string {
  const declaration = findMethodDeclaration(content, from);
  if (!declaration) {
    throw new Error(`Cannot rename conflicting Wave support method ${from}.`);
  }
  return content.slice(0, declaration.nameOffset) + to
    + content.slice(declaration.nameOffset + from.length);
}

function renameLocalMethodCalls(
  content: string,
  from: string,
  to: string,
  scanStart: number
): string {
  const sanitized = sanitizeJava(content);
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const offsets = [...sanitized.matchAll(
    new RegExp(`\\b${escaped}\\b(?=\\s*\\()`, 'gu')
  )].flatMap((match) => (
    match.index !== undefined
      && match.index >= scanStart
      && isLocalMethodCall(sanitized, match.index)
      ? [match.index]
      : []
  ));
  let rewritten = content;
  for (const offset of offsets.reverse()) {
    rewritten = rewritten.slice(0, offset) + to
      + rewritten.slice(offset + from.length);
  }
  return rewritten;
}

function isLocalMethodCall(value: string, nameOffset: number): boolean {
  let cursor = nameOffset - 1;
  while (cursor >= 0 && /\s/u.test(value[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if (value[cursor] !== '.') return true;
  cursor -= 1;
  while (cursor >= 0 && /\s/u.test(value[cursor])) cursor -= 1;
  const end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/u.test(value[cursor])) cursor -= 1;
  return value.slice(cursor + 1, end) === 'this';
}

type MethodDeclaration = {
  nameOffset: number;
  openingParenthesis: number;
  closingParenthesis: number;
  bodyOpen: number;
  bodyClose: number;
};

function findMethodDeclaration(content: string, name: string): MethodDeclaration | null {
  const sanitized = sanitizeJava(content);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  for (const match of sanitized.matchAll(new RegExp(`\\b${escaped}\\s*\\(`, 'gu'))) {
    if (match.index === undefined) continue;
    const openingParenthesis = sanitized.indexOf('(', match.index);
    const closingParenthesis = matchingParenthesis(sanitized, openingParenthesis);
    if (closingParenthesis < 0) continue;
    const tail = sanitized.slice(closingParenthesis + 1);
    const relativeBodyOpen = tail.indexOf('{');
    const relativeTerminator = tail.search(/[;=]/u);
    if (relativeBodyOpen < 0
      || (relativeTerminator >= 0 && relativeTerminator < relativeBodyOpen)) {
      continue;
    }
    const bodyOpen = closingParenthesis + 1 + relativeBodyOpen;
    const bodyClose = matchingBrace(sanitized, bodyOpen);
    if (bodyClose < 0) continue;
    return {
      nameOffset: match.index,
      openingParenthesis,
      closingParenthesis,
      bodyOpen,
      bodyClose
    };
  }
  return null;
}

function methodSignature(content: string, name: string): string {
  const declaration = findMethodDeclaration(content, name);
  if (!declaration) return `${name}:${normalizeJavaForComparison(content)}`;
  const parameters = sanitizeJava(content).slice(
    declaration.openingParenthesis + 1,
    declaration.closingParenthesis
  );
  return `${name}(${parameterTypeSignature(parameters)})`;
}

function parameterTypeSignature(parameters: string): string {
  if (!parameters.trim()) return '';
  return splitParameters(parameters).map((parameter) => {
    const withoutAnnotations = stripParameterAnnotations(parameter)
      .replace(/\bfinal\b/gu, ' ')
      .trim();
    const variable = /([A-Za-z_$][\w$]*)\s*((?:\[\s*\]\s*)*)$/u
      .exec(withoutAnnotations);
    if (!variable || variable.index === undefined) {
      return eraseJavaParameterType(
        normalizeJavaForComparison(withoutAnnotations).replace(/\s+/gu, '')
      );
    }
    const type = withoutAnnotations.slice(0, variable.index) + (variable[2] ?? '');
    return eraseJavaParameterType(
      normalizeJavaForComparison(type).replace(/\s+/gu, '')
    );
  }).join(',');
}

function eraseJavaParameterType(value: string): string {
  let erased = '';
  let genericDepth = 0;
  for (const character of value) {
    if (character === '<') genericDepth += 1;
    else if (character === '>') genericDepth = Math.max(0, genericDepth - 1);
    else if (genericDepth === 0) erased += character;
  }
  return erased.replace(/\.\.\./gu, '[]');
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
    else if (character === ','
      && round === 0
      && square === 0
      && curly === 0
      && angle === 0) {
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
    while (index < value.length && /[A-Za-z0-9_$.]/u.test(value[index])) index += 1;
    while (index < value.length && /\s/u.test(value[index])) index += 1;
    if (value[index] === '(') {
      const closing = matchingParenthesis(value, index);
      index = closing < 0 ? value.length : closing + 1;
    }
    for (let cursor = start; cursor < index; cursor += 1) output[cursor] = ' ';
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

function validateMergeInput(input: MethodWavePartMergeInput): void {
  if (!input.methodId.trim() || !/^[0-9a-f]{64}$/iu.test(input.waveId)) {
    throw new TypeError('Wave merge identity is invalid.');
  }
  if (!Number.isSafeInteger(input.waveIndex) || input.waveIndex < 1) {
    throw new TypeError('Wave merge index is invalid.');
  }
  if (!/^[A-Za-z_$][\w$]*$/u.test(input.outputTestClassName)) {
    throw new TypeError('Wave output test class name is invalid.');
  }
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 5) {
    throw new TypeError('Wave merge requires between 1 and 5 Parts.');
  }
  const indexes = input.parts.map((part) => part.partIndex);
  if (new Set(indexes).size !== indexes.length
    || indexes.some((index) => !Number.isSafeInteger(index) || index < 1 || index > 5)) {
    throw new TypeError('Wave merge Part indices are invalid.');
  }
}

function parseWavePart(
  part: MethodWaveMergePart,
  structure: JavaTestStructureService
): ParsedWavePart {
  const sanitized = sanitizeJava(part.code);
  const type = /\b(?:class|record|interface|enum)\s+([A-Za-z_$][\w$]*)[^{};]*\{/
    .exec(sanitized);
  if (!type) throw new Error('Part has no top-level Java type');
  const classOpen = type.index + type[0].lastIndexOf('{');
  const classClose = matchingBrace(sanitized, classOpen);
  if (classClose < 0) throw new Error('Part Java type is truncated');
  if (sanitized.slice(classClose + 1).trim()) {
    throw new Error('Part contains content after its Java type');
  }
  const prefix = part.code.slice(0, classOpen);
  const packageMatch = /^[\t ]*package[\t ]+[^;\r\n]+;/m.exec(prefix);
  const importMatches = [...prefix.matchAll(
    /^[\t ]*import[\t ]+(?:static[\t ]+)?[^;\r\n]+;/gm
  )];
  const imports = importMatches.map((match) => match[0].trim());
  const headerStart = Math.max(
    packageMatch ? (packageMatch.index ?? 0) + packageMatch[0].length : 0,
    ...importMatches.map((match) => (match.index ?? 0) + match[0].length)
  );
  const classHeader = prefix.slice(headerStart).trim();
  if (!classHeader) throw new Error('Part Java type header is invalid');

  const methods = structure.findMethods(part.code);
  const fields = structure.findFields(part.code);
  const spans = topLevelMemberSpans(sanitized, classOpen, classClose);
  const members = spans.map(({ startOffset, endOffset }) => {
    const content = part.code.slice(startOffset, endOffset);
    const method = methods.find((item) => (
      item.startOffset >= startOffset && item.endOffset <= endOffset + 2
    ));
    if (method) return parsedMethod(part.code, content, method);
    const field = fields.find((item) => (
      item.startOffset >= startOffset && item.endOffset <= endOffset + 2
    ));
    if (field) return parsedField(content, field);
    return {
      kind: 'other' as const,
      identity: `other:${normalizeJavaForComparison(content)}`,
      name: null,
      names: [],
      supportSignature: null,
      content,
      normalized: normalizeJavaForComparison(content),
      startLine: lineNumberAt(part.code, startOffset),
      endLine: lineNumberAt(part.code, Math.max(startOffset, endOffset - 1)),
      lifecycleStage: null,
      lifecycleBody: null,
      isStatic: false
    };
  });
  return {
    part,
    packageDeclaration: packageMatch?.[0].trim() ?? null,
    imports,
    classHeader,
    className: type[1],
    members
  };
}

function parsedMethod(
  code: string,
  content: string,
  method: JavaMethodSpan
): ParsedWaveMember {
  const stage = method.isLifecycleMethod ? lifecycleStage(content) : null;
  const kind: WaveMemberKind = method.isTestMethod
    ? 'test'
    : stage
      ? 'lifecycle'
      : 'method';
  const identity = stage ? `lifecycle:${stage}` : `${kind}:${method.name}`;
  const header = code.slice(method.startOffset, method.bodyStartOffset);
  return {
    kind,
    identity,
    name: method.name,
    names: [method.name],
    supportSignature: kind === 'method'
      ? methodSignature(content, method.name)
      : null,
    content,
    normalized: normalizeJavaForComparison(content),
    startLine: method.startLine,
    endLine: method.endLine,
    lifecycleStage: stage,
    lifecycleBody: stage
      ? code.slice(method.bodyStartOffset + 1, method.bodyEndOffset - 1)
      : null,
    isStatic: /\bstatic\b/u.test(sanitizeJava(header))
  };
}

function parsedField(content: string, field: JavaFieldSpan): ParsedWaveMember {
  return {
    kind: 'field',
    identity: `field:${[...field.names].sort().join(',')}`,
    name: field.names[0] ?? null,
    names: [...field.names],
    supportSignature: null,
    content,
    normalized: normalizeJavaForComparison(content),
    startLine: field.startLine,
    endLine: field.endLine,
    lifecycleStage: null,
    lifecycleBody: null,
    isStatic: /\bstatic\b/u.test(sanitizeJava(content))
  };
}

function lifecycleStage(content: string): LifecycleStage | null {
  const sanitized = sanitizeJava(content);
  if (/@(?:[A-Za-z_$][\w$]*\.)*BeforeEach\b/u.test(sanitized)) return 'BEFORE_EACH';
  if (/@(?:[A-Za-z_$][\w$]*\.)*AfterEach\b/u.test(sanitized)) return 'AFTER_EACH';
  if (/@(?:[A-Za-z_$][\w$]*\.)*BeforeAll\b/u.test(sanitized)) return 'BEFORE_ALL';
  if (/@(?:[A-Za-z_$][\w$]*\.)*AfterAll\b/u.test(sanitized)) return 'AFTER_ALL';
  return null;
}

function provenanceFor(
  member: ParsedWaveMember,
  partIndex: number
): MethodWaveMemberProvenance {
  return {
    memberId: memberId(member.identity, member.normalized),
    kind: member.kind,
    name: member.name,
    partIndexes: [partIndex],
    sourceRanges: [{
      partIndex,
      startLine: member.startLine,
      endLine: member.endLine
    }]
  };
}

function aggregateSource(
  selected: SelectedMember
): MethodWaveMemberProvenance {
  return selected.provenance;
}

function mergeSource(
  provenance: MethodWaveMemberProvenance,
  source: { partIndex: number; startLine: number; endLine: number }
): void {
  if (!provenance.partIndexes.includes(source.partIndex)) {
    provenance.partIndexes.push(source.partIndex);
  }
  provenance.sourceRanges.push(source);
}

function memberId(identity: string, normalized: string): string {
  return createHash('sha256').update(`${identity}\0${normalized}`, 'utf8').digest('hex');
}

function renderLifecycleMethod(template: string, statements: readonly string[]): string {
  const sanitized = sanitizeJava(template);
  const opening = sanitized.indexOf('{');
  const closing = opening < 0 ? -1 : matchingBrace(sanitized, opening);
  if (opening < 0 || closing < 0) {
    throw new Error('Lifecycle method is structurally invalid.');
  }
  const lineStart = template.lastIndexOf('\n', opening) + 1;
  const methodIndent = /^[\t ]*/u.exec(template.slice(lineStart))?.[0] ?? '  ';
  const statementIndent = `${methodIndent}  `;
  const body = statements.map((statement) => (
    statement.split(/\r?\n/u).map((line) => (
      line.trim() ? `${statementIndent}${line.trim()}` : ''
    )).join('\n')
  )).join('\n');
  return `${template.slice(0, opening + 1).trimEnd()}\n${body}\n${methodIndent}}`;
}

function splitLifecycleStatements(body: string): string[] {
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

function renameTopLevelType(header: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(\\b(?:class|record|interface|enum)\\s+)${escaped}\\b`, 'u');
  const renamed = header.replace(pattern, `$1${to}`);
  if (renamed === header && from !== to) {
    throw new Error('Cannot rename merged Wave test class.');
  }
  return renamed;
}

function uniqueWaveTestName(
  original: string,
  used: ReadonlySet<string>,
  reserved: ReadonlySet<string>
): string {
  if (!used.has(original)) return original;
  let suffix = 2;
  while (used.has(`${original}_${suffix}`) || reserved.has(`${original}_${suffix}`)) {
    suffix += 1;
  }
  return `${original}_${suffix}`;
}

function renameTestDeclaration(content: string, from: string, to: string): string {
  const sanitized = sanitizeJava(content);
  const openingBrace = sanitized.indexOf('{');
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const declaration = [...sanitized.matchAll(
    new RegExp(`\\b${escaped}\\s*(?=\\()`, 'gu')
  )].filter((match) => (
    match.index !== undefined && (openingBrace < 0 || match.index < openingBrace)
  )).at(-1);
  if (!declaration || declaration.index === undefined) {
    throw new Error(`Cannot rename duplicate Wave test method ${from}.`);
  }
  return content.slice(0, declaration.index) + to
    + content.slice(declaration.index + from.length);
}

function renderWaveClass(
  packageDeclaration: string | null,
  imports: readonly string[],
  classHeader: string,
  members: readonly string[]
): string {
  const sections: string[] = [];
  if (packageDeclaration) sections.push(packageDeclaration);
  if (imports.length > 0) sections.push(imports.join('\n'));
  sections.push(`${classHeader} {`);
  const body = members
    .filter((member) => member.trim())
    .map((member) => member.trimEnd())
    .join('\n\n');
  return `${sections.join('\n\n')}\n${body ? `\n${body}\n` : ''}}\n`;
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
    while (cursor < classClose && /\s/u.test(sanitized[cursor])) cursor += 1;
    if (cursor >= classClose) break;
    const candidateLineStart = lineStartOffset(sanitized, cursor);
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
          throw new Error('Part contains an unbalanced member');
        }
        if (isFieldInitializerHeader(header)) {
          index = close;
        } else {
          let memberEnd = close + 1;
          while (memberEnd < classClose && /[\t ]/u.test(sanitized[memberEnd])) {
            memberEnd += 1;
          }
          if (sanitized[memberEnd] === ';') memberEnd += 1;
          endOffset = includeTrailingLineBreak(sanitized, memberEnd);
          break;
        }
      }
      index += 1;
    }
    if (endOffset < 0) throw new Error('Part member is truncated');
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

function lineStartOffset(code: string, offset: number): number {
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

function lineNumberAt(code: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (code[index] === '\n') line += 1;
  }
  return line;
}

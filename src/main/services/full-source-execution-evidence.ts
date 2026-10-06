import { JavaTestStructureService, sanitizeJava } from './java-test-structure.service.ts';
import type { FullSourceClassFacts } from './full-source-generation-contract.ts';

const structure = new JavaTestStructureService();
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function typePattern(value: string): string {
  const compact = value.replace(/\s/g, '');
  const simple = compact.replace(/(?:\w+\.)+/g, '');
  return `(?:${[...new Set([compact, simple])].map(v => [...v].map(escape).join('\\s*')).join('|')})`;
}

function targetSubclasses(source: string, type: string): { name: string; code: string }[] {
  const masked = sanitizeJava(source), result: { name: string; code: string }[] = [];
  for (const match of masked.matchAll(new RegExp(`\\bclass\\s+(\\w+)\\s+extends\\s+${type}\\s*\\{`, 'g'))) {
    const open = match.index! + match[0].length - 1;
    let depth = 1, end = open + 1;
    while (depth && end < masked.length) {
      if (masked[end] === '{') depth++; else if (masked[end] === '}') depth--;
      end++;
    }
    if (!depth) result.push({ name: match[1], code: source.slice(match.index, end) });
  }
  return result;
}

function argumentsAt(code: string, open: number, original = code): { values: string[]; end: number } | null {
  const values: string[] = []; let start = open + 1; let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === ')' && depth === 0) {
      if (original.slice(start, i).trim() || values.length) values.push(code.slice(start, i).trim() || '?');
      return { values, end: i + 1 };
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { values.push(code.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

function reflectionFactoryHandles(source: string, rawBody: string, type: string,
  target: FullSourceClassFacts['methods'][number]): { handle: string; initializedAt: number }[] {
  let shared = source;
  for (const member of structure.findMethods(source).filter(m => m.isTestMethod).reverse()) {
    shared = shared.slice(0, member.startOffset) + ' '.repeat(member.endOffset - member.startOffset) + shared.slice(member.endOffset);
  }
  const maskedShared = sanitizeJava(shared), maskedBody = sanitizeJava(rawBody);
  const helpers = new Map<string, RegExpMatchArray[]>(), result: { handle: string; initializedAt: number }[] = [];
  const declarations = /\b(?:java\.lang\.reflect\.)?Method\s+(\w+)\s*\(([^()]*)\)\s*(?:throws\s+[^{};]+)?\s*\{([^{}]*)\}/g;
  for (const helper of shared.matchAll(declarations)) {
    if (!/^(?:java\.lang\.reflect\.)?Method\s+\w+\s*\(/.test(maskedShared.slice(helper.index))) continue;
    helpers.set(helper[1], [...(helpers.get(helper[1]) ?? []), helper]);
  }
  const expected = target.invocationPlan.parameterClassLiterals.map(v => v.replace(/\s/g, ''));
  for (const [name, definitions] of helpers) {
    if (definitions.length !== 1) continue;
    const helper = definitions[0];
    // Prove only lookup -> setAccessible -> return, without arbitrary helper control flow.
    const chain = new RegExp(`^\\s*(?:final\\s+)?(?:java\\.lang\\.reflect\\.)?Method\\s+(\\w+)\\s*=\\s*${type}`
      + '\\s*\\.class\\s*\\.getDeclaredMethod\\s*(\\([^;]*\\))\\s*;'
      + '\\s*\\1\\s*\\.setAccessible\\s*\\(\\s*true\\s*\\)\\s*;\\s*return\\s+\\1\\s*;\\s*$').exec(helper[3]);
    if (!chain) continue;
    const lookup = argumentsAt(chain[2], 0), formal = argumentsAt(`(${helper[2]})`, 0);
    if (!lookup || !formal) continue;
    const parsed = formal.values.map(p => /^(?:final\s+)?(?:java\.lang\.)?(String|Class\s*(?:<\s*\?\s*>)?)(\s*\.\.\.)?\s+(\w+)$/.exec(p));
    if (parsed.some(p => p === null)) continue;
    const parameters = parsed as RegExpExecArray[];
    if (parameters.slice(0, -1).some(p => p[2])) continue;
    const callPattern = `\\b(?:java\\.lang\\.reflect\\.)?Method\\s+(\\w+)\\s*=\\s*(?:this\\s*\\.\\s*)?${escape(name)}\\s*\\(`;
    for (const call of rawBody.matchAll(new RegExp(callPattern, 'g'))) {
      if (!new RegExp(`^${callPattern}`).test(maskedBody.slice(call.index))) continue;
      const args = argumentsAt(rawBody, call.index! + call[0].length - 1);
      if (!args) continue;
      const variadic = Boolean(parameters.at(-1)?.[2]);
      if (args.values.length < parameters.length - Number(variadic) || (!variadic && args.values.length !== parameters.length)) continue;
      const bindings = new Map(parameters.map((p, i) => [p[3], p[2] ? args.values.slice(i) : [args.values[i]]]));
      const resolved = lookup.values.flatMap(arg => bindings.get(arg.trim()) ?? [arg]);
      if (resolved.length !== expected.length + 1 || /^"([^"\\]+)"$/.exec(resolved[0])?.[1] !== target.methodName) continue;
      if (resolved.slice(1).some((v, i) => ![expected[i], expected[i].split('.').slice(-2).join('.')].includes(v.replace(/\s/g, '')))) continue;
      const handle = call[1];
      if ([...maskedBody.matchAll(new RegExp(`\\b${escape(handle)}\\s*=(?!=)`, 'g'))].length !== 1) continue;
      result.push({ handle, initializedAt: args.end });
    }
  }
  return result;
}

/** Conservative visible execution evidence, not a proof of assertion or branch semantics. */
export function hasFullSourceTargetExecution(facts: FullSourceClassFacts, target: FullSourceClassFacts['methods'][number],
  source: string, rawBody: string): boolean {
  const body = sanitizeJava(rawBody);
  const members = structure.findMethods(source);
  const setup = members.filter(m => m.isLifecycleMethod).map(m => source.slice(m.startOffset, m.endOffset)).join('\n');
  const fields = structure.findFields(source).map(f => source.slice(f.startOffset, f.endOffset)).join('\n');
  const context = sanitizeJava(fields + '\n' + setup + '\n' + rawBody);
  const typeName = facts.declaringType.split('.').at(-1)!.replaceAll('$', '.');
  const type = `(?:${escape(facts.declaringType.replaceAll('$', '.'))}|${escape(typeName)})`;
  if (target.invocationPlan.staticMethod
    && new RegExp(`\\b(?:Mockito\\.)?mockStatic\\s*\\(\\s*${type}\\s*\\.class\\b`).test(context)) return false;
  const subclasses = targetSubclasses(source, type).filter(child =>
    !structure.findMethods(child.code).some(method => method.name === target.methodName));
  const receiverType = `(?:${type}|${subclasses.map(child => escape(child.name)).join('|') || '(?!)'})`;
  const receivers = new Set<string>();
  for (const declaration of context.matchAll(new RegExp(`\\b${receiverType}\\s+(\\w+)\\s*(?:=|;)`, 'g'))) {
    const name = declaration[1];
    const realNew = new RegExp(`\\b${escape(name)}\\s*=\\s*new\\s+${receiverType}\\s*\\(`).test(context);
    const injected = new RegExp(`@(?:[\\w.]+\\.)?InjectMocks\\s+(?:private\\s+|public\\s+|protected\\s+|final\\s+)*${receiverType}\\s+${escape(name)}\\s*;`).test(context);
    const realMock = facts.targetFixturePlan.constructionMode === 'MOCK_CALLS_REAL_METHODS'
      && new RegExp(`\\b${escape(name)}\\s*=\\s*(?:Mockito\\.)?mock\\s*\\(\\s*${type}\\.class\\s*,\\s*(?:Mockito\\.)?CALLS_REAL_METHODS\\s*\\)`).test(context);
    const assignments = [...context.matchAll(new RegExp(`\\b${escape(name)}\\s*=\\s*([^;]+)`, 'g'))];
    const unsafe = assignments.some(a => !new RegExp(`^new\\s+${receiverType}\\s*\\(`).test(a[1])
      && !(realMock && /\bCALLS_REAL_METHODS\b/.test(a[1])));
    if ((realNew || injected || realMock) && !unsafe) receivers.add(name);
  }
  if (target.invocationPlan.staticMethod) receivers.add(typeName), receivers.add(facts.declaringType.replaceAll('$', '.'));
  if (!receivers.size) return false;
  const owner = `(?:${[...receivers].map(escape).join('|')})`;
  const call = `\\b${owner}\\s*\\.\\s*${escape(target.methodName)}\\s*\\(`;
  // A selected target configured as a stub or verified on a mock is not execution evidence.
  if (new RegExp(`\\b(?:when|given)\\s*\\(\\s*${call}`).test(context)
    || new RegExp(`\\b(?:when|verify)\\s*\\(\\s*${owner}\\s*(?:,[^)]*)?\\)\\s*\\.\\s*${escape(target.methodName)}\\s*\\(`).test(context)) return false;
  if (target.invocationPlan.strategy !== 'CONTROLLED_REFLECTION') {
    for (const match of body.matchAll(new RegExp(call, 'g'))) {
      const args = argumentsAt(body, match.index! + match[0].length - 1, rawBody);
      if (args?.values.length === target.parameterTypes.length) return true;
    }
    if (target.invocationPlan.strategy === 'TEST_SUBCLASS_BRIDGE') {
      // Accept only a straight bridge to the selected superclass implementation.
      for (const child of subclasses) for (const bridge of structure.findMethods(child.code)) {
        const signature = sanitizeJava(child.code.slice(bridge.startOffset, bridge.bodyStartOffset));
        const parameterPattern = target.parameterTypes.map(t => `${typePattern(t)}\\s+(\\w+)`).join('\\s*,\\s*');
        const parameters = new RegExp(`\\b${escape(bridge.name)}\\s*\\(\\s*${parameterPattern}\\s*\\)`).exec(signature);
        if (!parameters) continue;
        const actual = sanitizeJava(child.code.slice(bridge.bodyStartOffset + 1, bridge.bodyEndOffset - 1)).replace(/\s/g, '');
        const expected = `super.${target.methodName}(${parameters.slice(1).join(',')});`;
        if (actual !== expected && actual !== `return${expected}`) continue;
        const bridgeCall = `\\b${owner}\\s*\\.\\s*${escape(bridge.name)}\\s*\\(`;
        if (new RegExp(`\\b(?:when|given)\\s*\\(\\s*${bridgeCall}`).test(context)
          || new RegExp(`\\b(?:when|verify)\\s*\\(\\s*${owner}\\s*(?:,[^)]*)?\\)\\s*\\.\\s*${escape(bridge.name)}\\s*\\(`).test(context)) continue;
        for (const match of body.matchAll(new RegExp(bridgeCall, 'g'))) {
          const args = argumentsAt(body, match.index! + match[0].length - 1, rawBody);
          if (args?.values.length === target.parameterTypes.length) return true;
        }
      }
    }
    return false;
  }
  const lookups = new RegExp(`\\b(\\w+)\\s*=\\s*${type}\\s*\\.class\\s*\\.getDeclaredMethod\\s*\\(`, 'g');
  for (const lookup of body.matchAll(lookups)) {
    const open = lookup.index! + lookup[0].length - 1;
    const args = argumentsAt(rawBody, open);
    if (!args) continue;
    const rawArgs = rawBody.slice(open + 1, args.end - 1);
    const name = rawArgs.match(/^\s*"([^"\\]+)"/);
    if (name?.[1] !== target.methodName || args.values.length !== target.parameterTypes.length + 1) continue;
    const literals = args.values.slice(1).map(v => v.replace(/\s/g, ''));
    const expected = target.invocationPlan.parameterClassLiterals.map(v => v.replace(/\s/g, ''));
    if (literals.some((v, i) => v !== expected[i] && v !== expected[i]?.split('.').slice(-2).join('.'))) continue;
    const handle = escape(lookup[1]);
    if (!new RegExp(`\\b${handle}\\.setAccessible\\s*\\(\\s*true\\s*\\)`).test(body)) continue;
    for (const invoke of body.matchAll(new RegExp(`\\b${handle}\\.invoke\\s*\\(`, 'g'))) {
      const args = argumentsAt(body, invoke.index! + invoke[0].length - 1);
      if (args && args.values.length === target.parameterTypes.length + 1
        && (receivers.has(args.values[0]) || target.invocationPlan.staticMethod && args.values[0] === 'null')) return true;
    }
  }
  for (const { handle, initializedAt } of reflectionFactoryHandles(source, rawBody, type, target)) {
    for (const invoke of body.matchAll(new RegExp(`\\b${escape(handle)}\\s*\\.invoke\\s*\\(`, 'g'))) {
      if (invoke.index! < initializedAt) continue;
      const access = [...body.slice(initializedAt, invoke.index).matchAll(new RegExp(`\\b${escape(handle)}\\s*\\.setAccessible\\s*\\(([^)]*)\\)`, 'g'))];
      if (access.some(change => change[1].trim() !== 'true')) continue;
      const args = argumentsAt(body, invoke.index! + invoke[0].length - 1, rawBody);
      if (args?.values.length === target.parameterTypes.length + 1
        && (receivers.has(args.values[0]) || target.invocationPlan.staticMethod && args.values[0] === 'null')) return true;
    }
  }
  return false;
}

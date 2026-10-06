import { DOMParser } from '@xmldom/xmldom';
import { JavaTestStructureService, sanitizeJava } from './java-test-structure.service.ts';
import type { CandidateExecutionFeedback } from './method-generation-contract.ts';
import type { FullSourceClassFacts, FullSourceMethodOutcome } from './full-source-generation-contract.ts';
import { hasFullSourceTargetExecution } from './full-source-execution-evidence.ts';

const structure = new JavaTestStructureService();
const fail = (): never => { throw new Error('完整源码测试来源、活跃成员与实际通过 XML 不一致。'); };

/** Full-source finalization retains incomplete tests as comments, never as passing records. */
export function nonValidatingFullSourceTestNames(facts: FullSourceClassFacts, source: string): string[] {
  return structure.findMethods(source).filter(method => method.isTestMethod).filter(method => {
    const target = facts.methods.find(m => method.name.startsWith(m.testMethodNamePrefix));
    if (!target) return true;
    const raw = source.slice(method.bodyStartOffset, method.bodyEndOffset);
    return !hasFullSourceValidation(facts, target, source, raw);
  }).map(method => method.name);
}

function hasFullSourceValidation(facts: FullSourceClassFacts, target: FullSourceClassFacts['methods'][number],
  source: string, raw: string): boolean {
  return /\b(?:assert\w+|verify(?:NoInteractions|NoMoreInteractions)?)\s*\(/.test(sanitizeJava(raw))
    && hasFullSourceTargetExecution(facts, target, source, raw);
}

/** Uses the executor's fresh attempt artifacts; console messages never count as passing tests. */
export function passedFullSourceTestNames(execution: CandidateExecutionFeedback): string[] {
  const report = execution.testReport;
  if (!report) return fail();
  if (execution.status !== 'passed' || report.failures || report.errors || report.skipped
    || report.generatedSkipped || report.generatedTests < 1) fail();
  const names: string[] = [];
  let suites = 0;
  for (const artifact of execution.mavenExecutions.at(-1)?.surefireReports ?? []) {
    if (!artifact.fileName.endsWith('.xml')) continue;
    let malformed = false;
    const doc = new DOMParser({ onError: () => { malformed = true; } }).parseFromString(artifact.content, 'application/xml');
    if (malformed) fail();
    const allSuites = Array.from(doc.getElementsByTagName('testsuite'));
    for (const suite of allSuites) {
      if (suite.getAttribute('name') !== report.generatedTestClassName) continue;
      suites++;
      if (['failures','errors','skipped'].some(k => Number(suite.getAttribute(k) ?? '0') !== 0)) fail();
      const cases = Array.from(suite.getElementsByTagName('testcase'));
      if (Number(suite.getAttribute('tests')) !== cases.length) fail();
      for (const c of cases) {
        if (c.getAttribute('classname') !== report.generatedTestClassName
          || c.getElementsByTagName('failure').length || c.getElementsByTagName('error').length
          || c.getElementsByTagName('skipped').length) fail();
        const name = c.getAttribute('name'); if (!name) fail(); names.push(name!);
      }
    }
  }
  if (suites !== 1 || names.length !== report.generatedTests || new Set(names).size !== names.length) fail();
  return names;
}

export function attributeFullSourceResults(facts: FullSourceClassFacts, retainedSource: string,
  candidateReport: CandidateExecutionFeedback, formalReport: CandidateExecutionFeedback,
  repairEvidence: { retainedFailureMembers: readonly string[]; deletedTests: FullSourceMethodOutcome['deletedTests'] }): FullSourceMethodOutcome[] {
  const candidateNames = passedFullSourceTestNames(candidateReport).sort();
  const formalNames = passedFullSourceTestNames(formalReport).sort();
  const methods = structure.findMethods(retainedSource).filter(m => m.isTestMethod);
  const activeNames = methods.map(m => m.name).sort();
  if (JSON.stringify(candidateNames) !== JSON.stringify(formalNames)
    || JSON.stringify(candidateNames) !== JSON.stringify(activeNames)) fail();
  const attributed = new Set<string>();
  const outcomes = facts.methods.map(target => {
    const own = methods.filter(m => m.name.startsWith(target.testMethodNamePrefix));
    own.forEach(m => attributed.add(m.name));
    const passedTestNames = own.filter(m => {
      const raw = retainedSource.slice(m.bodyStartOffset, m.bodyEndOffset);
      return hasFullSourceValidation(facts, target, retainedSource, raw);
    }).map(m => m.name);
    const retainedFailureMembers = repairEvidence.retainedFailureMembers.filter(id => (
      id.startsWith(`test:${target.testMethodNamePrefix}`) || id.startsWith(`removed-test:${target.testMethodNamePrefix}`)
    ));
    const deletedTests = repairEvidence.deletedTests.filter(d => d.testName.startsWith(target.testMethodNamePrefix));
    return { methodId: target.methodId, passedTestNames, retainedFailureMembers: [...retainedFailureMembers], deletedTests,
      status: passedTestNames.length ? 'PASSED' as const : retainedFailureMembers.length || deletedTests.length
        ? 'RETAINED_FAILURE' as const : 'NO_VALID_TEST' as const };
  });
  if (attributed.size !== activeNames.length) fail();
  return outcomes;
}

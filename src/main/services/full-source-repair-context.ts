import { readFile } from 'node:fs/promises';
import type { AiClient } from './ai-client.ts';
import { sourceSha256, type FullSourceClassFacts, type FullSourceMethodFacts } from './full-source-generation-contract.ts';
import { MavenRepairDiagnosticService } from './maven-repair-diagnostic.service.ts';
import { MAX_METHOD_REPAIR_CONTEXT_METHODS, type CandidateExecutionFeedback,
  type MethodGenerationRepairContext } from './method-generation-contract.ts';
import type { RepairMethodSource, MethodRepairContextResponse } from './method-analysis-contract.ts';
import { DOMParser } from '@xmldom/xmldom';

export async function resolveFullSourceRepairContext(input: {
  facts: FullSourceClassFacts; analysisSessionId: string; sourceFilePath: string;
  generatedTestFilePath: string; generatedTestClassName: string; effectiveTestCode: string;
  execution: CandidateExecutionFeedback; analyzer: Partial<Pick<AiClient, 'getMethodRepairContext'>>; signal: AbortSignal;
}): Promise<MethodGenerationRepairContext> {
  const { facts, signal } = input;
  const production = await readFile(input.sourceFilePath, 'utf8');
  if (sourceSha256(production) !== facts.sourceSha256) throw new Error('冻结的生产源码已变化，不能伪造修复行号。');
  const diagnostic = new MavenRepairDiagnosticService().normalize({ execution: input.execution,
    generatedTestFilePath: input.generatedTestFilePath, generatedTestClassName: input.generatedTestClassName,
    targetProductionClassName: facts.declaringType, targetProductionFilePath: input.sourceFilePath });
  // The summary retains at most 20 exception details. Use this execution's
  // named XML to retain the other failed tests; passing cases never become
  // editable merely because the detail list was bounded.
  const xmlNames = new Set<string>();
  for (const execution of input.execution.mavenExecutions) for (const artifact of execution.surefireReports) {
    if (!artifact.fileName.endsWith('.xml')) continue;
    try {
      const document = new DOMParser().parseFromString(artifact.content,'application/xml');
      const cases = document.getElementsByTagName('testcase');
      for (let i=0;i<cases.length;i++) {
        const c=cases.item(i)!;
        if (c.getAttribute('classname') !== input.generatedTestClassName) continue;
        if (c.getElementsByTagName('failure').length || c.getElementsByTagName('error').length) {
          const name=c.getAttribute('name'); if(name) xmlNames.add(name);
        }
      }
    } catch { /* Keep bounded diagnostics and the incomplete-evidence flag below. */ }
  }
  const names=[...new Set([...diagnostic.affectedTestNames,...xmlNames])];
  const detailNames=new Set(diagnostic.exceptions.map(e=>e.testName).filter(Boolean));
  const missingDetails=names.filter(n=>!detailNames.has(n)).length;
  const report=input.execution.testReport;
  const reportedFailures=report ? report.failures+report.errors : 0;
  const missingNames=Math.max(0,reportedFailures-names.length);
  diagnostic.affectedTestNames=names.slice(0,32);
  diagnostic.droppedItemCount += Math.max(0,names.length-32)+missingDetails+missingNames;
  diagnostic.truncated=diagnostic.droppedItemCount>0;
  const affected = diagnostic.affectedTestNames;
  const owners = facts.methods.filter(m => affected.some(n => n.startsWith(m.testMethodNamePrefix)));
  const selected = owners.length && affected.every(n => owners.some(m => n.startsWith(m.testMethodNamePrefix)))
    ? owners : facts.methods;
  const warnings: string[] = [];
  const sources = new Map<string, RepairMethodSource>();
  const results: MethodRepairContextResponse[] = [];
  let fallback = false;
  const frozenSource = async (): Promise<string> => {
    if (sourceSha256(production) !== facts.sourceSha256) throw new Error('冻结的生产源码已变化，不能伪造修复行号。');
    return production;
  };
  // Sequential AST requests retain the existing analyzer memory bound.
  for (const m of selected.slice(0, MAX_METHOD_REPAIR_CONTEXT_METHODS)) {
    signal.throwIfAborted();
    let response: MethodRepairContextResponse | undefined;
    try {
      if (input.analyzer.getMethodRepairContext) response = await input.analyzer.getMethodRepairContext(input.analysisSessionId,
        { reportPairId: facts.reportPairId, methodId: m.methodId,
          currentClassFrames: diagnostic.productionFrames.map(f => ({ ownerFqn:f.ownerFqn, methodName:f.methodName,
            descriptor:null, sourceLine:f.sourceLine })), relatedTypeFqns:diagnostic.relatedTypeFqns,
          missingSymbols:diagnostic.missingSymbols }, signal);
    } catch { signal.throwIfAborted(); }
    if (response?.reportPairId === facts.reportPairId && response.sourceSha256 === facts.sourceSha256
      && response.targetMethod.methodId === m.methodId) {
      sources.set(m.methodId,response.targetMethod); results.push(response);
    } else {
      fallback = true;
      warnings.push(`Analyzer 修复上下文不可用或身份不匹配：${m.methodName}；保留冻结源码事实。`);
      sources.set(m.methodId, locateFrozenMethod(await frozenSource(), m, diagnostic.productionFrames));
    }
  }
  for (const result of results) {
    warnings.push(...result.warnings.map(w=>`${w.code}: ${w.message}`));
    if (result.truncated) warnings.push('Analyzer 修复源码片段已截断。');
    for (const m of result.stackMethods) if (!sources.has(m.methodId)) sources.set(m.methodId,m);
  }
  if (selected.length > MAX_METHOD_REPAIR_CONTEXT_METHODS || sources.size > MAX_METHOD_REPAIR_CONTEXT_METHODS)
    warnings.push(`修复方法事实最多保留 ${MAX_METHOD_REPAIR_CONTEXT_METHODS} 个；其余完整目标源码仍在冻结事实中。`);
  const ordered = [...sources.values()].slice(0,MAX_METHOD_REPAIR_CONTEXT_METHODS);
  const types = new Map(facts.referencedTypes.map(t=>[t.qualifiedName,t]));
  for (const result of results) for (const t of result.referencedTypes) types.set(t.qualifiedName,t);
  if (types.size > 64) warnings.push('修复类型事实最多保留 64 个。');
  return { ...diagnostic, analyzerStatus:fallback?'fallback':'available', analyzerWarnings:[...new Set(warnings)].slice(0,64),
    sourceSha256:facts.sourceSha256, targetMethod:ordered[0], stackMethods:ordered.slice(1),
    referencedTypes:[...types.values()].slice(0,64) };
}

function locateFrozenMethod(source: string, m: FullSourceMethodFacts,
  frames: readonly {sourceLine:number}[]): RepairMethodSource {
  const normalized = source.replaceAll('\r\n','\n');
  const methodSource = m.completeMethodSource.replaceAll('\r\n','\n');
  const offset = normalized.indexOf(methodSource);
  if (offset < 0 || normalized.indexOf(methodSource,offset+1) >= 0)
    throw new Error(`冻结源码中无法唯一定位 ${m.methodName}，不能伪造修复行号。`);
  const firstLine = normalized.slice(0,offset).split('\n').length;
  const lines = methodSource.split('\n');
  const lastLine = firstLine + lines.length - 1;
  const preferred = frames.find(f=>f.sourceLine >= firstLine && f.sourceLine <= lastLine)?.sourceLine ?? firstLine;
  const start = lines.length > 300 ? Math.max(0,Math.min(lines.length-300,preferred-firstLine-100)) : 0;
  const chunk = lines.slice(start,start+300);
  return { methodId:m.methodId, declaringType:m.declaringType, methodName:m.methodName, descriptor:m.descriptor,
    modifiers:m.modifiers, firstLine,lastLine, sourceFirstLine:firstLine+start,sourceLastLine:firstLine+start+chunk.length-1,
    sourceText:chunk.join('\n'),sourceComplete:lines.length<=300, parameterTypes:m.parameterTypes,
    returnType:m.returnType,declaredExceptions:m.declaredExceptions };
}

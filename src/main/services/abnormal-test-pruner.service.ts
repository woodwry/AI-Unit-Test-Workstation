import type { CandidateExecutionFeedback } from './method-generation-contract.ts';
import { JavaTestStructureService } from './java-test-structure.service.ts';
import { DOMParser } from '@xmldom/xmldom';

export type RemovedAbnormalTest = { name: string; startLine: number; code: string };
export type AbnormalTestPruneResult = { code: string; removedMethods: RemovedAbnormalTest[] };

const TIMEOUT_TYPE = /(?:^|\.)TimeoutException$/u;

/** Delete only a named active @Test with current XML evidence of a 120 second test timeout. */
export class AbnormalTestPrunerService {
  private readonly structure = new JavaTestStructureService();

  remove(input: {
    code: string;
    generatedTestClassName: string;
    execution: CandidateExecutionFeedback;
  }): AbnormalTestPruneResult {
    if (input.execution.status !== 'test_failed') return { code: input.code, removedMethods: [] };
    const tests = this.structure.findTestMethods(input.code);
    const selected = new Set<string>();
    const select = (name: string) => {
      const normalized = name.trim().replace(/\(.*$/u, '').replace(/\[.*$/u, '');
      if (tests.filter(test => test.name === normalized).length === 1) selected.add(normalized);
    };
    const latest = [...input.execution.mavenExecutions].reverse().find(item => item.phase === 'test');
    if (latest && latest.exitCode !== 0) {
      for (const report of latest.surefireReports) {
        if (!/^TEST-.+\.xml$/iu.test(report.fileName) || /<!DOCTYPE|<!ENTITY/iu.test(report.content)) continue;
        try {
          const errors: string[] = [];
          const document = new DOMParser({ onError: (_level, message) => errors.push(String(message)) })
            .parseFromString(report.content, 'application/xml');
          if (errors.length > 0 || !['testsuite', 'testsuites'].includes(document.documentElement?.tagName ?? '')) continue;
          for (const testcase of Array.from(document.getElementsByTagName('testcase'))) {
            if (testcase.getAttribute('classname') !== input.generatedTestClassName) continue;
            const name = testcase.getAttribute('name') ?? '';
            for (const failure of Array.from(testcase.childNodes)) {
              if (failure.nodeType !== 1 || !['error', 'failure'].includes(failure.nodeName)) continue;
              const element = failure as import('@xmldom/xmldom').Element;
              if (!TIMEOUT_TYPE.test(element.getAttribute('type') ?? '')) continue;
              const diagnostic = [element.getAttribute('message'), element.textContent].join('\n');
              const normalized = name.trim().replace(/\(.*$/u, '').replace(/\[.*$/u, '');
              if ((diagnostic.includes('Test method exceeded 120 seconds')
                && diagnostic.includes('(method watchdog)'))
                || diagnostic.includes(`${normalized}() timed out after 120 seconds`)) select(name);
            }
          }
        } catch {
          // Invalid or absent XML cannot authorize deleting a generated test.
        }
      }
    }
    const removed = tests.filter(test => selected.has(test.name));
    let code = input.code;
    for (const method of [...removed].reverse()) {
      code = code.slice(0, method.startOffset) + code.slice(method.endOffset);
    }
    return { code, removedMethods: removed.map(method => ({
      name: method.name, startLine: method.startLine,
      code: input.code.slice(method.startOffset, method.endOffset)
    })) };
  }
}

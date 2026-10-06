import assert from 'node:assert/strict';
import test from 'node:test';
import { AbnormalTestPrunerService } from '../src/main/services/abnormal-test-pruner.service.ts';

const code = 'package demo;\nclass ATest {\n'
  + '  @Test void hangs() { while (true) {} }\n'
  + '  @Test void works() { work(); }\n'
  + '  void helper() {}\n}\n';
function execution(overrides = {}) {
  return { status: 'test_failed', mavenExecutions: [{ phase: 'test', exitCode: 1,
    stdout: '', stderr: '', surefireReports: [] }], ...overrides };
}
function remove(feedback) {
  return new AbnormalTestPrunerService().remove({ code, generatedTestClassName: 'demo.ATest', execution: feedback });
}
test('retains a test attributed by an OOM crash stack without named timeout XML', () => {
  const feedback = execution();
  feedback.mavenExecutions[0].surefireReports.push({ fileName: 'jvm.dump',
    content: 'java.lang.OutOfMemoryError: GC overhead limit exceeded\n'
      + '\tat demo.ATest.helper(ATest.java:5)\n\tat demo.ATest.hangs(ATest.java:3)' });
  const result = remove(feedback);
  assert.deepEqual(result.removedMethods, []);
  assert.equal(result.code, code);
});

function timeoutXml(type = 'java.util.concurrent.TimeoutException', message = 'Test method exceeded 120 seconds and did not finish after interruption (method watchdog).', name = 'hangs', owner = 'demo.ATest') {
  return { fileName: 'TEST-demo.ATest.xml', content: `<testsuite name="${owner}" tests="1" errors="1" failures="0" skipped="0"><testcase classname="${owner}" name="${name}" time="120"><error type="${type}" message="${message}"/></testcase></testsuite>` };
}
function reported(feedback, report) {
  feedback.mavenExecutions[0].surefireReports.push(report);
  return feedback;
}
for (const type of ['java.lang.StackOverflowError', 'java.lang.OutOfMemoryError']) {
  test(`retains a named ${type} failure rather than deleting it as a timeout`, () => {
    const feedback = reported(execution({ testReport: { failureDetails: [{ testClassName: 'demo.ATest', testName: 'hangs', kind: 'error', type }] } }), timeoutXml(type, 'fatal failure'));
    assert.equal(remove(feedback).code, code);
    assert.deepEqual(remove(feedback).removedMethods, []);
  });
}
for (const message of ['business request timed out', 'hangs() timed out after 30 seconds']) {
  test(`retains a TimeoutException without the 120 second test timeout: ${message}`, () => {
    const feedback = reported(execution({ testReport: { failureDetails: [{ testClassName: 'demo.ATest', testName: 'hangs', kind: 'error', type: 'java.util.concurrent.TimeoutException', message }] } }), timeoutXml('java.util.concurrent.TimeoutException', message));
    assert.equal(remove(feedback).code, code);
  });
}
test('retains a timeout inferred only from a dump without current named XML', () => {
  const feedback = execution();
  feedback.mavenExecutions[0].stderr = 'java.util.concurrent.TimeoutException: Test method exceeded 120 seconds (method watchdog).\n\tat demo.ATest.hangs(ATest.java:3)';
  assert.equal(remove(feedback).code, code);
});
test('retains a parsed timeout if the current test execution has no named XML', () => {
  const feedback = execution({ testReport: { failureDetails: [{ testClassName: 'demo.ATest', testName: 'hangs', kind: 'error', type: 'java.util.concurrent.TimeoutException', message: 'hangs() timed out after 120 seconds' }] } });
  assert.equal(remove(feedback).code, code);
});
test('deletes only the exact current XML test with a 120 second timeout and retains its full source', () => {
  const result = remove(reported(execution(), timeoutXml()));
  assert.deepEqual(result.removedMethods.map(method => method.name), ['hangs']);
  assert.match(result.removedMethods[0].code, /@Test void hangs\(\) \{ while \(true\) \{\} \}/);
  assert.doesNotMatch(result.code, /void hangs/);
  assert.match(result.code, /@Test void works/);
});
test('ignores timeout XML from an earlier Maven attempt', () => {
  const feedback = reported(execution(), timeoutXml());
  feedback.mavenExecutions.push({ phase: 'test', exitCode: 1, stdout: '', stderr: '', surefireReports: [] });
  assert.equal(remove(feedback).code, code);
});
for (const [name, owner] of [['unknown', 'demo.ATest'], ['hangs', 'demo.OtherTest']]) {
  test(`ignores timeout XML for ${owner}.${name}`, () => {
    assert.equal(remove(reported(execution(), timeoutXml(undefined, undefined, name, owner))).code, code);
  });
}
test('does not delete passed, ordinary failed, foreign, unlocated, or ambiguously attributed tests', () => {
  const failure = { testClassName: 'demo.ATest', testName: 'hangs', kind: 'error', type: 'java.util.concurrent.TimeoutException' };
  for (const feedback of [
    execution({ status: 'passed', testReport: { failureDetails: [failure] } }),
    execution({ testReport: { failureDetails: [{ ...failure, type: 'java.lang.IllegalStateException' }] } }),
    execution({ testReport: { failureDetails: [{ ...failure, testClassName: 'demo.OtherTest' }] } }),
    execution({ testReport: { failureDetails: [{ ...failure, testName: 'unknown' }] } }),
    execution({ mavenExecutions: [{ phase: 'test', exitCode: 1, stdout: '', stderr:
      'java.lang.OutOfMemoryError: heap space\n\tat demo.ATest.hangs(ATest.java:3)\n'
        + '\tat demo.ATest.works(ATest.java:4)', surefireReports: [] }] })
  ]) {
    assert.equal(remove(feedback).code, code);
    assert.deepEqual(remove(feedback).removedMethods, []);
  }
});
test('does not use the crash evidence of an earlier batch attempt to delete a reverified test', () => {
  const feedback = execution({ mavenExecutions: [{ phase: 'test', exitCode: 1,
    stdout: '', stderr: 'java.lang.OutOfMemoryError: heap space\n\tat demo.ATest.hangs(ATest.java:3)', surefireReports: [] },
  { phase: 'test', exitCode: 1, stdout: '', stderr: 'project infrastructure failed', surefireReports: [] }] });
  assert.equal(remove(feedback).code, code);
});

test('does not attribute an unrelated fatal stack to a later ordinary failure stack', () => {
  const feedback = execution({ mavenExecutions: [{ phase: 'test', exitCode: 1,
    stdout: '', stderr: 'java.lang.OutOfMemoryError: heap space\n\tat demo.OtherTest.hangs(OtherTest.java:3)\n\n'
      + 'java.lang.IllegalStateException: ordinary failure\n\tat demo.ATest.works(ATest.java:4)', surefireReports: [] }] });
  assert.equal(remove(feedback).code, code);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { MavenBatchDiagnosticAttributionService } from '../src/main/services/maven-batch-diagnostic-attribution.service.ts';

const candidates = [{
  candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  filePath: 'D:\\work\\module\\src\\test\\java\\demo\\ATmp1Test.java',
  qualifiedTestClassName: 'demo.ATmp1Test'
}, {
  candidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  filePath: 'D:\\work\\module\\src\\test\\java\\demo\\BTmp1Test.java',
  qualifiedTestClassName: 'demo.BTmp1Test'
}, {
  candidateId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  filePath: 'D:\\work\\module\\src\\test\\java\\demo\\CTmp1Test.java',
  qualifiedTestClassName: 'demo.CTmp1Test'
}];

test('attributes javac diagnostics by normalized managed path and leaves other candidates unproven', () => {
  const result = new MavenBatchDiagnosticAttributionService().attributeCompile({
    candidates,
    stdout: [
      '[ERROR] D:/work/module/src/test/java/demo/BTmp1Test.java:[17,9] cannot find symbol',
      '[ERROR]   symbol:   method missing()',
      '[ERROR]   location: class demo.BTmp1Test'
    ].join('\n'),
    stderr: ''
  });

  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.attributedFailureCandidateIds, [candidates[1].candidateId]);
  assert.equal(result.results[candidates[1].candidateId].status, 'COMPILE_FAILED');
  assert.match(result.results[candidates[1].candidateId].diagnostic, /cannot find symbol/);
  assert.equal(result.results[candidates[0].candidateId].status, 'UNPROVEN');
  assert.equal(result.results[candidates[2].candidateId].status, 'UNPROVEN');
});

test('attributes Maven javac diagnostics whose Windows path has a leading slash', () => {
  const result = new MavenBatchDiagnosticAttributionService().attributeCompile({
    candidates: [candidates[0]],
    stdout: [
      '[ERROR] /D:/work/module/src/test/java/demo/ATmp1Test.java:[18,48] cannot find symbol',
      '[ERROR]   symbol:   class MissingType',
      '[ERROR]   location: package demo'
    ].join('\n'),
    stderr: ''
  });

  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.attributedFailureCandidateIds, [candidates[0].candidateId]);
  assert.equal(result.results[candidates[0].candidateId].status, 'COMPILE_FAILED');
  assert.match(result.results[candidates[0].candidateId].diagnostic, /MissingType/);
});

test('does not guess when a compile diagnostic names no uniquely managed file or class', () => {
  const result = new MavenBatchDiagnosticAttributionService().attributeCompile({
    candidates,
    stdout: '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin',
    stderr: '[ERROR] Compilation failure'
  });

  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.attributedFailureCandidateIds, []);
  assert.ok(Object.values(result.results).every((item) => item.status === 'UNPROVEN'));
});

test('attributes literal Surefire XML per test class without treating an absent class as passed', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuite name="batch" tests="3" failures="1" errors="0" skipped="0">',
    '  <testcase classname="demo.ATmp1Test" name="passes"/>',
    '  <testcase classname="demo.BTmp1Test" name="fails">',
    '    <failure type="org.opentest4j.AssertionFailedError" message="expected true">stack</failure>',
    '  </testcase>',
    '  <testcase classname="demo.BTmp1Test" name="alsoPasses"/>',
    '</testsuite>'
  ].join('\n');
  const result = new MavenBatchDiagnosticAttributionService().attributeSurefire({
    candidates,
    artifacts: [{ fileName: 'TEST-batch.xml', content: xml }],
    stdout: '',
    stderr: ''
  });

  assert.equal(result.results[candidates[0].candidateId].status, 'PASSED');
  assert.equal(result.results[candidates[1].candidateId].status, 'TEST_FAILED');
  assert.match(result.results[candidates[1].candidateId].diagnostic, /expected true/);
  assert.equal(result.results[candidates[2].candidateId].status, 'UNPROVEN');
});

test('attributes a fork crash only when Maven explicitly names the managed test class', () => {
  const crashOutput = [
    '[INFO] Running demo.BTmp1Test',
    'java.lang.IllegalStateException: application terminated the test JVM',
    '\tat demo.BTmp1Test.startsApplication(BTmp1Test.java:23)',
    '[ERROR] The forked VM terminated without properly saying goodbye.',
    '[ERROR] Crashed tests:',
    '[ERROR] demo.BTmp1Test',
    'x'.repeat(4_000)
  ].join('\n');
  const result = new MavenBatchDiagnosticAttributionService().attributeSurefire({
    candidates,
    artifacts: [],
    stdout: crashOutput,
    stderr: ''
  });

  assert.equal(result.results[candidates[0].candidateId].status, 'UNPROVEN');
  assert.equal(result.results[candidates[1].candidateId].status, 'TEST_FAILED');
  assert.equal(result.results[candidates[2].candidateId].status, 'UNPROVEN');
  assert.deepEqual(result.attributedFailureCandidateIds, [candidates[1].candidateId]);
  assert.match(result.results[candidates[1].candidateId].diagnostic, /Crashed tests:/);
  assert.match(result.results[candidates[1].candidateId].diagnostic, /demo\.BTmp1Test/);
  assert.ok(result.results[candidates[1].candidateId].diagnostic.length <= 2_000);
});

test('attributes a generated-test timeout only to the explicitly listed managed class', () => {
  const timeoutOutput = [
    '[ERROR] Generated test validation timed out after 120 seconds.',
    '[ERROR] The generated test likely contains an infinite loop, unbounded recursion, deadlock, or blocking call.',
    '[ERROR] Timed out tests:',
    '[ERROR] demo.BTmp1Test'
  ].join('\n');
  const result = new MavenBatchDiagnosticAttributionService().attributeSurefire({
    candidates,
    artifacts: [],
    stdout: '',
    stderr: timeoutOutput
  });

  assert.equal(result.results[candidates[0].candidateId].status, 'UNPROVEN');
  assert.equal(result.results[candidates[1].candidateId].status, 'TEST_FAILED');
  assert.equal(result.results[candidates[2].candidateId].status, 'UNPROVEN');
  assert.deepEqual(result.attributedFailureCandidateIds, [candidates[1].candidateId]);
  assert.match(result.results[candidates[1].candidateId].diagnostic, /Timed out tests:/);
  assert.match(result.results[candidates[1].candidateId].diagnostic, /demo\.BTmp1Test/);
});

test('attributes a Surefire JVM dump to the one managed test class in its crash stack', () => {
  const result = new MavenBatchDiagnosticAttributionService().attributeSurefire({
    candidates,
    artifacts: [{
      fileName: '2026-09-18T11-03-20_195-jvmRun1.dump',
      content: [
        'java.lang.OutOfMemoryError: Java heap space',
        '\\tat com.example.TaskService.canWriteData(TaskService.java:1508)',
        '\\tat demo.BTmp1Test.generatesUnboundedInput(BTmp1Test.java:789)'
      ].join('\n')
    }, {
      fileName: '2026-09-18T11-03-20_195-jvmRun1.dumpstream',
      content: 'Java heap space'
    }],
    stdout: '[ERROR] Java heap space',
    stderr: ''
  });

  assert.equal(result.results[candidates[0].candidateId].status, 'UNPROVEN');
  assert.equal(result.results[candidates[1].candidateId].status, 'TEST_FAILED');
  assert.equal(result.results[candidates[2].candidateId].status, 'UNPROVEN');
  assert.deepEqual(result.attributedFailureCandidateIds, [candidates[1].candidateId]);
  assert.match(result.results[candidates[1].candidateId].diagnostic,
    /OutOfMemoryError: Java heap space/);
  assert.match(result.results[candidates[1].candidateId].diagnostic,
    /demo\.BTmp1Test\.generatesUnboundedInput/);
});

test('does not turn an unstructured class-name mention into a Surefire failure', () => {
  const result = new MavenBatchDiagnosticAttributionService().attributeSurefire({
    candidates,
    artifacts: [],
    stdout: [
      '[ERROR] command used -Dtest=demo.BTmp1Test but no report was produced',
      '[INFO] Running demo.BTmp1Test',
      'java.lang.IllegalStateException: caught and logged by the test',
      '\tat demo.BTmp1Test.logsCaughtFailure(BTmp1Test.java:31)'
    ].join('\n'),
    stderr: '[ERROR] Maven infrastructure failed before the test JVM started'
  });

  assert.deepEqual(result.attributedFailureCandidateIds, []);
  assert.ok(Object.values(result.results).every((item) => item.status === 'UNPROVEN'));
});

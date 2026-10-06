import test from 'node:test';
import assert from 'node:assert/strict';
import { fullSourceFacts } from './fixtures/full-source.mjs';
import { attributeFullSourceResults, passedFullSourceTestNames } from '../src/main/services/full-source-result-attribution.ts';
import { hasFullSourceTargetExecution } from '../src/main/services/full-source-execution-evidence.ts';

function report(names) {
  return { status: 'passed', mavenExecutions: [{ phase: 'test', surefireReports: [{ fileName: 'TEST-example.TargetTest.xml',
    content: `<testsuite name="example.TargetTest" tests="${names.length}" failures="0" errors="0" skipped="0">`
      + names.map(name => `<testcase name="${name}" classname="example.TargetTest"/>`).join('') + '</testsuite>' }] }],
    testReport: { generatedTestClassName: 'example.TargetTest', generatedTests: names.length, failures: 0, errors: 0, skipped: 0 } };
}

test('full-source recognizes an exact real protected bridge without accepting a fake or stubbed bridge', () => {
  const facts = fullSourceFacts(1), target = facts.methods[0];
  target.invocationPlan.strategy = 'TEST_SUBCLASS_BRIDGE';
  facts.targetFixturePlan.constructionMode = 'TEST_SUBCLASS';
  const body = 'target.invokeWork0(); assertNotNull(target);';
  const source = `class TargetTest { @InjectMocks TestTarget target;
    static class TestTarget extends Target { void invokeWork0() { super.work0(); } }
    @Test void m1_ok() { ${body} } }`;
  assert.equal(hasFullSourceTargetExecution(facts, target, source, body), true);
  assert.equal(hasFullSourceTargetExecution(facts, target, source.replace('@InjectMocks TestTarget target;',
    'Target target = new TestTarget();'), body), true);
  for (const invalid of [source.replace('super.work0();', ''), source.replace('extends Target', 'extends Other'),
    source.replace('super.work0();', 'super.work0(); } void work0() {'),
    source.replace('@InjectMocks TestTarget target;', 'TestTarget target = mock(TestTarget.class);'),
    source.replace(body, 'doReturn(0).when(target).invokeWork0(); ' + body)]) {
    const raw = invalid.slice(invalid.indexOf('@Test void m1_ok() {') + '@Test void m1_ok() {'.length, invalid.lastIndexOf('} }'));
    assert.equal(hasFullSourceTargetExecution(facts, target, invalid, raw), false, invalid);
  }
  target.parameterTypes = ['int'];
  const typedBody = body.replace('invokeWork0()', 'invokeWork0(3)');
  const typedSource = source.replace('void invokeWork0()', 'void invokeWork0(int arg0)')
    .replace('super.work0()', 'super.work0(arg0)').replace(body, typedBody);
  assert.equal(hasFullSourceTargetExecution(facts, target, typedSource, typedBody), true);
  assert.equal(hasFullSourceTargetExecution(facts, target, typedSource.replace('super.work0(arg0)', 'super.work0(0)'), typedBody), false);
});

test('full-source rejects a mocked static selected target as real production execution', () => {
  const facts = fullSourceFacts(1), target = facts.methods[0];
  target.invocationPlan.staticMethod = true;
  const body = 'Target.work0(); assertTrue(true);';
  const source = `class TargetTest { @Test void m1_ok() { ${body} } }`;
  assert.equal(hasFullSourceTargetExecution(facts, target, source, body), true);
  const mocked = 'try (MockedStatic<Target> selected = mockStatic(Target.class)) { ' + body + ' }';
  assert.equal(hasFullSourceTargetExecution(facts, target, source.replace(body, mocked), mocked), false);
  target.invocationPlan.staticMethod = false;
  facts.targetFixturePlan.constructionMode = 'MOCK_CALLS_REAL_METHODS';
  const realBody = 'target.work0(); assertNotNull(target);';
  const realMock = `class TargetTest { Target target = mock(Target.class, CALLS_REAL_METHODS); @Test void m1_ok() { ${realBody} } }`;
  assert.equal(hasFullSourceTargetExecution(facts, target, realMock, realBody), true);
  facts.targetFixturePlan.constructionMode = 'DIRECT_CONSTRUCTOR';
  assert.equal(hasFullSourceTargetExecution(facts, target, realMock, realBody), false);
});
test('full-source method attribution uses exact ordered identities and actual test bodies', () => {
  const facts = fullSourceFacts(2);
  const source = `class TargetTest { Target target = new Target(); @Test void m1_ok() { target.work0(); assertNotNull(target); }
    @Test void m2_empty() { } /* @Test void m2_failed() { target.work1(); fail(); } */ }`;
  const execution = report(['m1_ok','m2_empty']);
  const results = attributeFullSourceResults(facts, source, execution, execution, {
    retainedFailureMembers: ['test:m2_failed:3'], deletedTests: [] });
  assert.equal(results[0].methodId, facts.methods[0].methodId);
  assert.equal(results[0].status, 'PASSED');
  assert.deepEqual(results[1].passedTestNames, []);
  assert.equal(results[1].status, 'RETAINED_FAILURE');
  assert.deepEqual(results[1].retainedFailureMembers, ['test:m2_failed:3']);
});
test('full-source publication rejects wrong names failure XML and prefix-only proof', () => {
  const facts = fullSourceFacts(1);
  const source = 'class TargetTest { Target target = new Target(); @Test void m1_ok() { target.work0(); assertNotNull(target); } }';
  assert.throws(() => attributeFullSourceResults(facts, source, report(['other']), report(['m1_ok']),
    { retainedFailureMembers: [], deletedTests: [] }));
  const broken = report(['m1_ok']); broken.mavenExecutions[0].surefireReports[0].content = '<testsuite failures="1" errors="0" skipped="0"/>';
  assert.throws(() => passedFullSourceTestNames(broken));
  const noCall = source.replace('target.work0();', '');
  assert.equal(attributeFullSourceResults(facts, noCall, report(['m1_ok']), report(['m1_ok']),
    { retainedFailureMembers: [], deletedTests: [] })[0].status, 'NO_VALID_TEST');
});

test('full-source counts real receivers and refuses mock, stub, verify-only and wrong reflection signature', () => {
  const facts = fullSourceFacts(1), execution = report(['m1_ok']);
  const result = source => attributeFullSourceResults(facts, source, execution, execution,
    { retainedFailureMembers: [], deletedTests: [] })[0].passedTestNames;
  const source = 'class TargetTest { Target target = new Target(); @Test void m1_ok() { target.work0(); assertNotNull(target); } }';
  assert.deepEqual(result(source), ['m1_ok']);
  assert.deepEqual(result(source.replace('Target target = new Target();', '@InjectMocks Target target;')), ['m1_ok']);
  for (const altered of [
    source.replace('new Target()', 'mock(Target.class)'),
    source.replace('target.work0();', 'when(target.work0()).thenReturn(1);'),
    source.replace('target.work0();', 'verify(target).work0();'),
    source.replace('target.work0();', 'target = mock(Target.class); target.work0();'),
    source.replace('target.work0();', 'doReturn(1).when(target).work0(); target.work0();'),
    source.replace('target.work0();', 'other.work0();'),
    source.replace('target.work0();', 'target.work0(1);'),
    source.replace('target.work0();', '/* target.work0(); */')
  ]) assert.deepEqual(result(altered), [], altered);
  facts.methods[0].invocationPlan.strategy = 'CONTROLLED_REFLECTION';
  const reflect = source.replace('target.work0();', 'Method method = Target.class.getDeclaredMethod("work0"); method.setAccessible(true); method.invoke(target);');
  assert.deepEqual(result(reflect), ['m1_ok']);
  for (const altered of [reflect.replace('"work0"', '"work0", String.class'),
    reflect.replace('method.invoke(target)', 'method.invoke(other)'),
    reflect.replace('Target.class.getDeclaredMethod', 'Other.class.getDeclaredMethod'),
    reflect.replace('method.setAccessible(true);', ''),
    reflect.replace('Method method', '/* Method decoy = Target.class.getDeclaredMethod("work0"); */ Method method')
      .replace('getDeclaredMethod("work0"); method.', 'getDeclaredMethod("other"); method.')
  ]) assert.deepEqual(result(altered), [], altered);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fullSourceFacts } from './fixtures/full-source.mjs';
import { nonValidatingFullSourceTestNames } from '../src/main/services/full-source-result-attribution.ts';

function fixture(parameters = [], argumentsText = '"work0"', invokeArguments = 'target') {
  const facts = fullSourceFacts(1);
  facts.methods[0].parameterTypes = parameters;
  facts.methods[0].invocationPlan.strategy = 'CONTROLLED_REFLECTION';
  facts.methods[0].invocationPlan.parameterClassLiterals = parameters.map(p => `${p}.class`);
  const source = `class TargetTest { @InjectMocks Target target;
    private Method getPrivateMethod(String name, Class<?>... paramTypes) throws Exception {
      Method m = Target.class.getDeclaredMethod(name, paramTypes);
      m.setAccessible(true);
      return m;
    }
    @Test void m1_ok() throws Exception {
      Method method = getPrivateMethod(${argumentsText});
      assertNotNull(method.invoke(${invokeArguments}));
    }
  }`;
  return { facts, source };
}

test('full-source publication retains a real target invocation through a returned Method helper', () => {
  const { facts, source } = fixture();
  assert.deepEqual(nonValidatingFullSourceTestNames(facts, source), []);
});

test('full-source publication resolves the exact vararg reflection signature at the factory call', () => {
  const { facts, source } = fixture(['java.lang.String'], '"work0", java.lang.String.class', 'target, "value"');
  assert.deepEqual(nonValidatingFullSourceTestNames(facts, source), []);
  for (const invalid of [source.replace('java.lang.String.class', 'Integer.class'),
    source.replace('target, "value"', 'target'), source.replace('"work0", java.lang.String.class', '"work1", java.lang.String.class')]) {
    assert.deepEqual(nonValidatingFullSourceTestNames(facts, invalid), ['m1_ok']);
  }
});

test('full-source publication supports a fixed lookup factory returning the accessible handle', () => {
  const { facts, source } = fixture();
  const fixed = source.replace('getPrivateMethod(String name, Class<?>... paramTypes)', 'getPrivateMethod()')
    .replace('getDeclaredMethod(name, paramTypes)', 'getDeclaredMethod("work0")')
    .replace('getPrivateMethod("work0")', 'getPrivateMethod()');
  assert.deepEqual(nonValidatingFullSourceTestNames(facts, fixed), []);
});

test('full-source publication refuses wrong or unavailable reflection hidden behind a helper', () => {
  const { facts, source } = fixture();
  for (const invalid of [source.replace('Target.class.getDeclaredMethod', 'Other.class.getDeclaredMethod'),
    source.replace('m.setAccessible(true);', ''), source.replace('return m;', 'return other;'),
    source.replace('getDeclaredMethod(name, paramTypes)', 'getDeclaredMethod("work1", paramTypes)'),
    source.replace('method.invoke(target)', 'method.invoke(other)'),
    source.replace('@InjectMocks Target target;', 'Target target = mock(Target.class);'),
    source.replace('assertNotNull(method.invoke(target));', 'assertEquals(0, 0);'),
    source.replace('assertNotNull(method.invoke(target));', 'method = other; assertNotNull(method.invoke(target));'),
    source.replace('return m;', 'if (name.isEmpty()) return other; return m;'),
    source.replace('m.setAccessible(true);', 'name = "work1"; m.setAccessible(true);'),
    source.replace('assertNotNull(method.invoke(target));', 'method.setAccessible(false); assertNotNull(method.invoke(target));')]) {
    assert.deepEqual(nonValidatingFullSourceTestNames(facts, invalid), ['m1_ok'], invalid);
  }
});

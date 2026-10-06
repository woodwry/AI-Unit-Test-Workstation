import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JavaTestStructureService,
  normalizeJavaForComparison,
  sanitizeJava
} from '../src/main/services/java-test-structure.service.ts';

test('Java masking preserves UTF-16 positions when comments contain supplementary characters', () => {
  const code = '// 🧪 archived\npublic class ExampleTest {}';
  const masked = sanitizeJava(code);
  assert.equal(masked.length, code.length);
  assert.equal(masked.indexOf('public class'), code.indexOf('public class'));
  assert.equal(masked.slice(code.indexOf('public class')), 'public class ExampleTest {}');
});


test('Java structure comparison ignores comments and formatting while preserving literals', () => {
  const compact = [
    'class Example {',
    '  String value() { return "a b"; }',
    '}'
  ].join('\n');
  const formatted = [
    'class Example {',
    '  // formatting-only comment',
    '  String value( ) {',
    '    return "a b";',
    '  }',
    '}'
  ].join('\r\n');
  const changedLiteral = formatted.replace('"a b"', '"ab"');

  assert.equal(
    normalizeJavaForComparison(compact),
    normalizeJavaForComparison(formatted)
  );
  assert.notEqual(
    normalizeJavaForComparison(compact),
    normalizeJavaForComparison(changedLiteral)
  );
  assert.notEqual(
    normalizeJavaForComparison('int count = 1;'),
    normalizeJavaForComparison('intcount = 1;')
  );
  assert.equal(
    normalizeJavaForComparison('String value = """\r\ntext\r\n""";'),
    normalizeJavaForComparison('String value = """\ntext\n""";')
  );
});

test('Java structure exposes lifecycle methods separately from ordinary helpers', () => {
  const code = [
    'class ExampleTest {',
    '  @org.junit.jupiter.api.BeforeEach',
    '  void setUp() {}',
    '  void helper() {}',
    '}'
  ].join('\n');

  const methods = new JavaTestStructureService().findMethods(code);

  assert.equal(methods.find(({ name }) => name === 'setUp')?.isLifecycleMethod, true);
  assert.equal(methods.find(({ name }) => name === 'helper')?.isLifecycleMethod, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { JavaTestStructureService } from '../src/main/services/java-test-structure.service.ts';
import { MethodWavePartMergerService } from '../src/main/services/method-wave-part-merger.service.ts';

function validPart(partIndex, code) {
  return {
    partIndex,
    partBatchId: String(partIndex).repeat(64),
    scenarioIds: [`scenario-${partIndex}`],
    candidateId: `11111111-1111-4111-8111-11111111111${partIndex}`,
    testClassName: `TaskServiceTmp1Part${partIndex}Test`,
    code
  };
}

const PART_ONE = [
  'package demo;',
  'import java.util.List;',
  'import org.junit.jupiter.api.*;',
  'public class TaskServiceTmp1Part1Test {',
  '  private String exactField;',
  '  private String conflictField;',
  '  @BeforeEach void setUpOne() { this.first(); this.shared(); }',
  '  @AfterEach void tearDownOne() { this.afterOne(); }',
  '  @BeforeAll static void beforeAllOne() { globalOne(); }',
  '  @AfterAll static void afterAllOne() { globalAfterOne(); }',
  '  void helperExact() { this.shared(); }',
  '  int helperConflict() { return 1; }',
  '  @Test void alpha() { helperExact(); }',
  '}',
  ''
].join('\n');

const PART_TWO = [
  'package demo;',
  'import java.awt.List;',
  'import org.junit.jupiter.api.*;',
  'public class TaskServiceTmp1Part2Test {',
  '  private String exactField;',
  '  private Object conflictField;',
  '  @BeforeEach void setUpTwo() { this.shared(); this.second(); }',
  '  @AfterEach void tearDownTwo() { this.afterTwo(); }',
  '  @BeforeAll static void beforeAllTwo() { globalTwo(); }',
  '  @AfterAll static void afterAllTwo() { globalAfterTwo(); }',
  '  void helperExact() { this.shared(); }',
  '  int helperConflict() { return 2; }',
  '  @Test void alpha() { helperExact(); }',
  '  @Test void beta() { helperConflict(); }',
  '}',
  ''
].join('\n');

test('retains class-level test initialization supplied by later Parts', () => {
  // Regression: taking only Part 1's header drops the Mockito extension from
  // later Parts, leaving every merged @Mock and @InjectMocks field null.
  const parts = [1, 2, 3].map((index) => validPart(index, [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'import org.junit.jupiter.api.extension.ExtendWith;',
    'import org.mockito.junit.jupiter.MockitoExtension;',
    ...(index === 1 ? [] : ['@ExtendWith(MockitoExtension.class)']),
    `public class TaskServiceTmp1Part${index}Test {`,
    '  @Mock Repository repository;',
    `  @Test void scenario${index}() { repository.load(); }`,
    '}'
  ].join('\n')));
  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64), waveId: 'f'.repeat(64), waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test', parts
  });
  assert.match(result.code, /@ExtendWith\(MockitoExtension\.class\)\s+public class TaskServiceTmp1Test/);
  assert.equal((result.code.match(/@ExtendWith/g) ?? []).length, 1);
  assert.equal(result.ordinaryTestMethodCount, 3);
});

test('widely merges valid Parts, isolates support conflicts, and unifies lifecycle stages', () => {
  const merger = new MethodWavePartMergerService();
  const result = merger.merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, PART_ONE),
      validPart(2, PART_TWO),
      validPart(3, 'package demo; public class TaskServiceTmp1Part3Test {')
    ]
  });

  assert.deepEqual(result.acceptedPartIndexes, [1, 2]);
  assert.deepEqual(result.skippedPartIndexes, [3]);
  assert.match(result.code, /public class TaskServiceTmp1Test/);
  assert.match(result.code, /import java\.util\.List;/);
  assert.match(result.code, /import java\.awt\.List;/);
  assert.equal((result.code.match(/private String exactField;/g) ?? []).length, 1);
  assert.match(result.code, /private String conflictField;/);
  assert.match(result.code, /private Object conflictFieldPart2;/);
  assert.doesNotMatch(result.code, /private Object conflictField;/);
  assert.match(result.code, /return 1;/);
  assert.match(result.code, /return 2;/);
  assert.equal((result.code.match(/int helperConflict\(\)/g) ?? []).length, 1);
  assert.equal((result.code.match(/int helperConflictPart2\(\)/g) ?? []).length, 1);
  assert.match(result.code, /void beta\(\) \{ helperConflictPart2\(\); \}/);
  assert.equal((result.code.match(/this\.shared\(\);/g) ?? []).length, 2);
  assert.match(result.code, /this\.first\(\);[\s\S]*this\.second\(\);/);

  const structure = new JavaTestStructureService();
  const lifecycle = structure.findMethods(result.code).filter((method) => (
    method.isLifecycleMethod
  ));
  assert.equal(lifecycle.length, 4);
  assert.equal((result.code.match(/@BeforeEach/g) ?? []).length, 1);
  assert.equal((result.code.match(/@AfterEach/g) ?? []).length, 1);
  assert.equal((result.code.match(/@BeforeAll/g) ?? []).length, 1);
  assert.equal((result.code.match(/@AfterAll/g) ?? []).length, 1);
  assert.deepEqual(
    structure.findTestMethods(result.code).map((method) => method.name),
    ['alpha', 'beta']
  );

  const exactHelper = Object.values(result.provenance.members).find((member) => (
    member.name === 'helperExact'
  ));
  assert.deepEqual(exactHelper.partIndexes, [1, 2]);
  assert.equal(exactHelper.sourceRanges.length, 2);
  assert.ok(result.provenance.lifecycleStaticForms.every((item) => item.isStatic));
});

test('renames conflicting Part fields and their local references instead of emitting duplicates', () => {
  // Mutation caught: deduplicating fields only by their complete declaration retains
  // same-name Mockito members when Parts differ only by visibility or initialization.
  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, [
        'package demo;',
        'import org.junit.jupiter.api.Test;',
        'public class TaskServiceTmp1Part1Test {',
        '  @Mock private Repository repository;',
        '  @InjectMocks private Service service;',
        '  @Mock private Calendar calendar;',
        '  @Test void firstScenario() { repository.load(); service.run(calendar); }',
        '}',
        ''
      ].join('\n')),
      validPart(2, [
        'package demo;',
        'import org.junit.jupiter.api.Test;',
        'public class TaskServiceTmp1Part2Test {',
        '  @Mock Repository repository;',
        '  @InjectMocks Service service;',
        '  Calendar calendar = new Calendar();',
        '  @Test void secondScenario() { repository.save(); service.run(calendar); }',
        '}',
        ''
      ].join('\n'))
    ]
  });

  const structure = new JavaTestStructureService();
  const fieldNames = structure.findFields(result.code).flatMap((field) => field.names);
  assert.equal(new Set(fieldNames).size, fieldNames.length);
  assert.match(result.code, /@Mock private Repository repository;/);
  assert.match(result.code, /@Mock Repository repositoryPart2;/);
  assert.match(result.code, /@InjectMocks Service servicePart2;/);
  assert.match(result.code, /Calendar calendarPart2 = new Calendar\(\);/);
  assert.match(
    result.code,
    /secondScenario\(\) \{ repositoryPart2\.save\(\); servicePart2\.run\(calendarPart2\); \}/
  );
  assert.match(
    result.code,
    /firstScenario\(\) \{ repository\.load\(\); service\.run\(calendar\); \}/
  );
});

test('places every Part field before the first merged test method', () => {
  // Mutation caught: appending each Part's members as one block emits
  // Part 2 fields after Part 1 test methods, producing a malformed test class layout.
  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, [
        'package demo;',
        'import org.junit.jupiter.api.Test;',
        'public class TaskServiceTmp1Part1Test {',
        '  @Mock private FirstRepository firstRepository;',
        '  @Test void firstScenario() { firstRepository.load(); }',
        '}',
        ''
      ].join('\n')),
      validPart(2, [
        'package demo;',
        'import org.junit.jupiter.api.Test;',
        'public class TaskServiceTmp1Part2Test {',
        '  @Mock private SecondRepository secondRepository;',
        '  @InjectMocks private SecondService secondService;',
        '  @Test void secondScenario() { secondService.run(secondRepository); }',
        '}',
        ''
      ].join('\n'))
    ]
  });

  const structure = new JavaTestStructureService();
  const fields = structure.findFields(result.code);
  const tests = structure.findTestMethods(result.code);
  assert.equal(fields.length, 3);
  assert.deepEqual(tests.map((method) => method.name), [
    'firstScenario',
    'secondScenario'
  ]);
  assert.ok(fields.every((field) => field.endOffset <= tests[0].startOffset));
});

test('renames colliding Part test methods locally without dropping tests', () => {
  const partCode = (partIndex, methodName, assertion) => [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    `public class TaskServiceTmp1Part${partIndex}Test {`,
    '  @Test',
    `  void ${methodName}() { ${assertion} }`,
    '}',
    ''
  ].join('\n');

  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, partCode(1, 'testP01', 'assert true;')),
      validPart(2, partCode(2, 'testP01', 'assert false;')),
      validPart(3, partCode(3, 'testP01_2', 'assert 1 == 1;'))
    ]
  });

  assert.equal(result.ordinaryTestMethodCount, 3);
  assert.deepEqual(result.passedTestMethods, [
    'testP01',
    'testP01_3',
    'testP01_2'
  ]);
  assert.equal((result.code.match(/@Test/g) ?? []).length, 3);
  assert.match(result.code, /void testP01\(\) \{ assert true; \}/);
  assert.match(result.code, /void testP01_3\(\) \{ assert false; \}/);
  assert.match(result.code, /void testP01_2\(\) \{ assert 1 == 1; \}/);
});

test('renames a conflicting Part helper and only its local call sites', () => {
  const partCode = (partIndex, helperValue, testName) => [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    `public class TaskServiceTmp1Part${partIndex}Test {`,
    `  private String fixture() { return "${helperValue}"; }`,
    '  @Test',
    `  void ${testName}() { assert fixture().equals("${helperValue}"); }`,
    '}',
    ''
  ].join('\n');

  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, partCode(1, 'first', 'firstScenario')),
      validPart(2, partCode(2, 'second', 'secondScenario'))
    ]
  });

  assert.equal((result.code.match(/String fixture\(\)/g) ?? []).length, 1);
  assert.equal((result.code.match(/String fixturePart2\(\)/g) ?? []).length, 1);
  assert.match(result.code, /firstScenario\(\) \{ assert fixture\(\)\.equals\("first"\); \}/);
  assert.match(
    result.code,
    /secondScenario\(\) \{ assert fixturePart2\(\)\.equals\("second"\); \}/
  );
});

test('retains legal helper overloads with the same name', () => {
  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, [
        'package demo;',
        'import org.junit.jupiter.api.Test;',
        'public class TaskServiceTmp1Part1Test {',
        '  private String fixture() { return "first"; }',
        '  @Test void firstScenario() { fixture(); }',
        '}',
        ''
      ].join('\n')),
      validPart(2, [
        'package demo;',
        'import org.junit.jupiter.api.Test;',
        'public class TaskServiceTmp1Part2Test {',
        '  private String fixture(String value) { return value; }',
        '  @Test void secondScenario() { fixture("second"); }',
        '}',
        ''
      ].join('\n'))
    ]
  });

  assert.match(result.code, /String fixture\(\)/);
  assert.match(result.code, /String fixture\(String value\)/);
  assert.doesNotMatch(result.code, /fixturePart2/);
});

test('skips only a Part whose declared class identity is wrong', () => {
  const result = new MethodWavePartMergerService().merge({
    methodId: 'a'.repeat(64),
    waveId: 'f'.repeat(64),
    waveIndex: 1,
    outputTestClassName: 'TaskServiceTmp1Test',
    parts: [
      validPart(1, PART_ONE),
      validPart(2, PART_TWO.replace('TaskServiceTmp1Part2Test', 'WrongName'))
    ]
  });

  assert.deepEqual(result.acceptedPartIndexes, [1]);
  assert.deepEqual(result.skippedPartIndexes, [2]);
  assert.equal(new JavaTestStructureService().findTestMethods(result.code).length, 1);
});

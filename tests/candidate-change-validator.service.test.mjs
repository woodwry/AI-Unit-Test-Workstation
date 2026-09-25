import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CandidateChangeValidator,
  preserveAcceptedWildcardImports,
  restoreReferencedAllowedTypeImports
} from '../src/main/services/candidate-change-validator.service.ts';
import * as candidateChangeModule from '../src/main/services/candidate-change-validator.service.ts';


const ACCEPTED = [
  'package demo;',
  '',
  'import org.junit.jupiter.api.BeforeEach;',
  'import org.junit.jupiter.api.Test;',
  'import static org.junit.jupiter.api.Assertions.assertEquals;',
  '',
  'class ExampleServiceTest {',
  '  private Repository repository;',
  '  private String unrelatedValue = "stable";',
  '',
  '  @BeforeEach',
  '  void setUp() {',
  '    repository = new Repository();',
  '  }',
  '',
  '  private void compilerHelper() {',
  '    repository.load();',
  '  }',
  '',
  '  private String uniqueHelper() {',
  '    return repository.value();',
  '  }',
  '',
  '  private String unrelatedHelper() {',
  '    return unrelatedValue;',
  '  }',
  '',
  '  @Test',
  '  void affectedTest() {',
  '    assertEquals("expected", uniqueHelper());',
  '  }',
  '',
  '  @Test',
  '  void otherTest() {',
  '    assertEquals("stable", unrelatedHelper());',
  '  }',
  '}',
  ''
].join('\n');

const validator = new CandidateChangeValidator();

function diagnostic(overrides = {}) {
  return {
    status: 'compile_failed',
    compilerErrors: [],
    affectedTestNames: [],
    exceptions: [],
    generatedTestFrames: [],
    productionFrames: [],
    missingSymbols: [],
    relatedTypeFqns: [],
    truncated: false,
    droppedItemCount: 0,
    ...overrides
  };
}

function validate(candidateCode, repairDiagnostic) {
  return validator.validate({
    acceptedCode: ACCEPTED,
    candidateCode,
    diagnostic: repairDiagnostic
  });
}

function repairUnreportedException(input) {
  assert.equal(
    typeof candidateChangeModule.applyDeterministicUnreportedExceptionRepair,
    'function',
    'deterministic unreported-exception repair must be implemented'
  );
  return candidateChangeModule.applyDeterministicUnreportedExceptionRepair(input);
}

function removeMethod(code, name) {
  const pattern = new RegExp(
    `\\n  @Test\\n  void ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}\\n`
  );
  return code.replace(pattern, '\n');
}

test('deterministic unreported-exception repair appends the exact FQN to a private helper throws clause', () => {
  const code = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class ExampleServiceTest {',
    '  @Test',
    '  void affectedTest() {',
    '    setUpPublicStubs();',
    '  }',
    '',
    '  private void setUpPublicStubs() throws demo.ReportException {',
    '    ExampleService.class.getDeclaredMethod("hidden");',
    '  }',
    '}',
    ''
  ].join('\n');

  const result = repairUnreportedException({
    code,
    candidateFilePath: String.raw`D:\work\ExampleServiceTest.java`,
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: '/D:/work/ExampleServiceTest.java',
        line: 12,
        column: 51,
        category: 'unreported_exception',
        message: '未报告的异常错误 java.lang.NoSuchMethodException；必须对其进行捕获或声明以便抛出'
      }]
    })
  });

  assert.equal(result.applied, true);
  assert.equal(result.repairedCompilerErrorCount, 1);
  assert.equal(
    result.code,
    code.replace(
      'throws demo.ReportException {',
      'throws demo.ReportException, java.lang.NoSuchMethodException {'
    )
  );
});

test('deterministic unreported-exception repair adds a throws clause to the exact JUnit test method', () => {
  const code = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class ExampleServiceTest {',
    '  @Test',
    '  void affectedTest() {',
    '    ExampleService.class.getDeclaredMethod("hidden");',
    '  }',
    '',
    '  @Test',
    '  void unrelatedTest() {',
    '    assert true;',
    '  }',
    '}',
    ''
  ].join('\n');

  const result = repairUnreportedException({
    code,
    candidateFilePath: '/work/ExampleServiceTest.java',
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: '/work/ExampleServiceTest.java',
        line: 8,
        column: 51,
        category: 'unreported_exception',
        message: 'unreported exception java.lang.NoSuchMethodException; must be caught or declared to be thrown'
      }]
    })
  });

  assert.equal(result.applied, true);
  assert.match(result.code, /void affectedTest\(\) throws java\.lang\.NoSuchMethodException \{/);
  assert.match(result.code, /void unrelatedTest\(\) \{/);
});

test('deterministic unreported-exception repair does not duplicate an already declared exception', () => {
  const code = [
    'package demo;',
    '',
    'class ExampleServiceTest {',
    '  private void helper() throws NoSuchMethodException {',
    '    ExampleService.class.getDeclaredMethod("hidden");',
    '  }',
    '}',
    ''
  ].join('\n');

  const result = repairUnreportedException({
    code,
    candidateFilePath: '/work/ExampleServiceTest.java',
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: '/work/ExampleServiceTest.java',
        line: 5,
        column: 51,
        category: 'unreported_exception',
        message: 'unreported exception java.lang.NoSuchMethodException'
      }]
    })
  });

  assert.deepEqual(result, {
    code,
    applied: false,
    repairedCompilerErrorCount: 0
  });
});

test('deterministic unreported-exception repair refuses a non-private helper', () => {
  const code = [
    'package demo;',
    '',
    'class ExampleServiceTest {',
    '  void helper() {',
    '    ExampleService.class.getDeclaredMethod("hidden");',
    '  }',
    '}',
    ''
  ].join('\n');

  const result = repairUnreportedException({
    code,
    candidateFilePath: '/work/ExampleServiceTest.java',
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: '/work/ExampleServiceTest.java',
        line: 5,
        column: 51,
        category: 'unreported_exception',
        message: 'unreported exception java.lang.NoSuchMethodException'
      }]
    })
  });

  assert.equal(result.code, code);
  assert.equal(result.applied, false);
});

test('deterministic unreported-exception repair refuses overridden methods and non-FQN diagnostics', () => {
  const code = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class ExampleServiceTest extends BaseTest {',
    '  @Override',
    '  @Test',
    '  void affectedTest() {',
    '    ExampleService.class.getDeclaredMethod("hidden");',
    '  }',
    '',
    '  @Test',
    '  void otherTest() {',
    '    ExampleService.class.getDeclaredMethod("other");',
    '  }',
    '}',
    ''
  ].join('\n');

  const result = repairUnreportedException({
    code,
    candidateFilePath: '/work/ExampleServiceTest.java',
    diagnostic: diagnostic({
      compilerErrors: [
        {
          filePath: '/work/ExampleServiceTest.java',
          line: 9,
          column: 51,
          category: 'unreported_exception',
          message: 'unreported exception java.lang.NoSuchMethodException'
        },
        {
          filePath: '/work/ExampleServiceTest.java',
          line: 14,
          column: 51,
          category: 'unreported_exception',
          message: 'unreported exception IOException'
        }
      ]
    })
  });

  assert.equal(result.code, code);
  assert.equal(result.applied, false);
});

test('restores accepted wildcard imports without retaining redundant explicit replacements', () => {
  const acceptedCode = [
    'package demo;',
    '',
    'import static org.junit.jupiter.api.Assertions.*;',
    'import static org.mockito.Mockito.*;',
    '',
    'class WildcardRepairTest {',
    '  void helper() {',
    '    when(service.load()).thenReturn("value");',
    '  }',
    '}'
  ].join('\n');
  const candidateCode = acceptedCode
    .replace(
      'import static org.junit.jupiter.api.Assertions.*;',
      'import static org.junit.jupiter.api.Assertions.assertNotNull;'
    )
    .replace(
      'import static org.mockito.Mockito.*;',
      'import static org.mockito.Mockito.when;'
    )
    .replace('  void helper() {', '  void helper() throws Exception {');

  const normalized = preserveAcceptedWildcardImports({
    acceptedCode,
    candidateCode,
    diagnostic: diagnostic()
  });

  assert.match(normalized, /import static org\.junit\.jupiter\.api\.Assertions\.\*;/);
  assert.match(normalized, /import static org\.mockito\.Mockito\.\*;/);
  assert.doesNotMatch(normalized, /import static org\.junit\.jupiter\.api\.Assertions\.assertNotNull;/);
  assert.doesNotMatch(normalized, /import static org\.mockito\.Mockito\.when;/);
  assert.match(normalized, /void helper\(\) throws Exception/);
});

test('restores a uniquely allowed import for a referenced simple type', () => {
  const candidateCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class TaskServiceTmp1Test {',
    '  private Task task;',
    '  @Test void generatedScenario() { task.toString(); }',
    '}',
    ''
  ].join('\n');

  const normalized = restoreReferencedAllowedTypeImports({
    candidateCode,
    allowedImports: [
      'import com.dtsz.model.entity.report.Task;',
      'import org.junit.jupiter.api.Test;'
    ]
  });

  assert.match(normalized, /import com\.dtsz\.model\.entity\.report\.Task;/);
  assert.equal(
    (normalized.match(/import com\.dtsz\.model\.entity\.report\.Task;/g) ?? []).length,
    1
  );
});

test('does not guess an allowed type import when its simple name is ambiguous', () => {
  const candidateCode = [
    'package demo;',
    'class TaskServiceTmp1Test {',
    '  private Task task;',
    '}',
    ''
  ].join('\n');

  const normalized = restoreReferencedAllowedTypeImports({
    candidateCode,
    allowedImports: [
      'import com.example.first.Task;',
      'import com.example.second.Task;'
    ]
  });

  assert.equal(normalized, candidateCode);
});

test('does not add a redundant explicit import covered by an existing wildcard', () => {
  const candidateCode = [
    'package demo;',
    'import com.dtsz.model.entity.report.*;',
    'class TaskServiceTmp1Test {',
    '  private Task task;',
    '}',
    ''
  ].join('\n');

  const normalized = restoreReferencedAllowedTypeImports({
    candidateCode,
    allowedImports: ['import com.dtsz.model.entity.report.Task;']
  });

  assert.equal(normalized, candidateCode);
});

test('candidate permitted change rejects deleted, renamed, reordered, added, or disabled tests', async (t) => {
  const first = [
    '  @Test',
    '  void affectedTest() {',
    '    assertEquals("expected", uniqueHelper());',
    '  }'
  ].join('\n');
  const second = [
    '  @Test',
    '  void otherTest() {',
    '    assertEquals("stable", unrelatedHelper());',
    '  }'
  ].join('\n');
  const cases = [
    {
      name: 'deleted',
      code: removeMethod(ACCEPTED, 'affectedTest'),
      violation: 'TEST_METHOD_DELETED'
    },
    {
      name: 'renamed',
      code: ACCEPTED.replace('void affectedTest()', 'void renamedTest()'),
      violation: 'TEST_METHOD_RENAMED'
    },
    {
      name: 'reordered',
      code: ACCEPTED.replace(`${first}\n\n${second}`, `${second}\n\n${first}`),
      violation: 'TEST_METHOD_REORDERED'
    },
    {
      name: 'added',
      code: ACCEPTED.replace(
        '\n}',
        '\n\n  @Test\n  void addedTest() {}\n}'
      ),
      violation: 'TEST_METHOD_ADDED'
    },
    {
      name: 'disabled',
      code: ACCEPTED.replace(
        '  @Test\n  void affectedTest()',
        '  @org.junit.jupiter.api.Disabled\n  @Test\n  void affectedTest()'
      ),
      violation: 'TEST_METHOD_DISABLED'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = validate(item.code, diagnostic({
        affectedTestNames: ['affectedTest']
      }));
      assert.equal(result.accepted, false);
      assert.ok(result.violationCodes.includes(item.violation));
    });
  }
});

test('explicit useless-test deletion preserves unmarked tests and their order', () => {
  const accepted = ACCEPTED.replace('\n}', '\n  @Test\n  void placeholder() {}\n}');
  const candidate = accepted.replace(
    '  @Test\n  void placeholder() {}',
    '  // [删除无用测试] placeholder'
  );
  assert.deepEqual(validator.validate({
    acceptedCode: accepted, candidateCode: candidate, diagnostic: diagnostic()
  }), { accepted: true });

  const missing = validator.validate({
    acceptedCode: accepted,
    candidateCode: removeMethod(candidate, 'otherTest'),
    diagnostic: diagnostic()
  });
  assert.equal(missing.accepted, false);
  assert.ok(missing.violationCodes.includes('TEST_METHOD_DELETED'));
  assert.deepEqual(missing.memberNames, ['otherTest']);

  const reordered = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate.replace('void affectedTest()', 'void temporary()')
      .replace('void otherTest()', 'void affectedTest()')
      .replace('void temporary()', 'void otherTest()'),
    diagnostic: diagnostic()
  });
  assert.equal(reordered.accepted, false);
  assert.ok(reordered.violationCodes.includes('TEST_METHOD_REORDERED'));
});

test('deletion markers in literals, block comments, inline comments, or retained names do not authorize deletions', () => {
  const markers = [
    '  /*\n  // [删除无用测试] affectedTest\n  */',
    '  String marker = "// [删除无用测试] affectedTest";',
    '  String marker = """\n  // [删除无用测试] affectedTest\n  """;',
    '  int marker = 0; // [删除无用测试] affectedTest',
    '  // [删除无用测试] otherTest',
    '  // [删除无用测试] oldDeletedTest',
    '  // [删除无用测试] affectedTest extra'
  ];
  for (const marker of markers) {
    const result = validate(
      removeMethod(ACCEPTED, 'affectedTest').replace('\n}', `\n${marker}\n}`),
      diagnostic()
    );
    assert.equal(result.accepted, false, marker);
    assert.ok(result.violationCodes.includes('TEST_METHOD_DELETED'), marker);
  }
});

test('explicit deletion does not authorize edits to an unrelated retained test', () => {
  const candidate = removeMethod(ACCEPTED, 'affectedTest')
    .replace('\n}', '\n  // [删除无用测试] affectedTest\n}')
    .replace('assertEquals("stable", unrelatedHelper());', 'assertEquals("changed", unrelatedHelper());');
  const result = validate(candidate, diagnostic());
  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_TEST_CHANGED'));
  assert.deepEqual(result.memberNames, ['otherTest']);
});

test('candidate permitted change rejects assertion and Mock edits in an unrelated test', () => {
  const candidate = ACCEPTED.replace(
    'assertEquals("stable", unrelatedHelper());',
    'assertEquals("changed", unrelatedHelper());\n    repository.verifyUnexpectedCall();'
  );

  const result = validate(candidate, diagnostic({
    affectedTestNames: ['affectedTest']
  }));

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_TEST_CHANGED'));
  assert.deepEqual(result.memberNames, ['otherTest']);
});

test('candidate permitted change accepts a checked-exception fix in a compiler-hit helper', () => {
  const helperLine = ACCEPTED.slice(0, ACCEPTED.indexOf('private void compilerHelper'))
    .split('\n').length;
  const candidate = ACCEPTED.replace(
    'private void compilerHelper() {',
    'private void compilerHelper() throws ReportException {'
  );

  const result = validate(candidate, diagnostic({
    compilerErrors: [{
      filePath: 'ExampleServiceTest.java',
      line: helperLine,
      column: 3,
      category: 'unreported_exception',
      message: 'unreported exception demo.ReportException'
    }]
  }));

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts a Surefire test and only helpers uniquely reached from it', () => {
  const candidate = ACCEPTED
    .replace('return repository.value();', 'return repository.value().trim();')
    .replace(
      'assertEquals("expected", uniqueHelper());',
      'assertEquals("expected", uniqueHelper().trim());'
    );

  const result = validate(candidate, diagnostic({
    status: 'test_failed',
    affectedTestNames: ['affectedTest']
  }));

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts removing unused imports while repairing an affected test', () => {
  const accepted = ACCEPTED.replace(
    'import org.junit.jupiter.api.Test;',
    [
      'import org.junit.jupiter.api.Test;',
      'import static org.mockito.Mockito.anySet;',
      'import demo.support.DataCellPropertyCalContext;'
    ].join('\n')
  );
  const candidate = accepted
    .replace('import static org.mockito.Mockito.anySet;\n', '')
    .replace('import demo.support.DataCellPropertyCalContext;\n', '')
    .replace(
      'assertEquals("expected", uniqueHelper());',
      'assertEquals("expected", uniqueHelper().trim());'
    );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      status: 'test_failed',
      affectedTestNames: ['affectedTest']
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts an Analyzer-whitelisted wildcard import', () => {
  const candidate = ACCEPTED
    .replace(
      'import org.junit.jupiter.api.Test;',
      'import org.junit.jupiter.api.Test;\nimport static org.mockito.Mockito.*;'
    )
    .replace(
      'assertEquals("expected", uniqueHelper());',
      'when(repository.value()).thenReturn("expected");\n    assertEquals("expected", uniqueHelper());'
    );

  const result = validator.validate({
    acceptedCode: ACCEPTED,
    candidateCode: candidate,
    diagnostic: diagnostic({
      status: 'test_failed',
      affectedTestNames: ['affectedTest']
    }),
    allowedImports: ['org.mockito.Mockito.*']
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change still rejects an unlisted wildcard import', () => {
  const candidate = ACCEPTED
    .replace(
      'import org.junit.jupiter.api.Test;',
      'import org.junit.jupiter.api.Test;\nimport static org.mockito.Mockito.*;'
    )
    .replace(
      'assertEquals("expected", uniqueHelper());',
      'when(repository.value()).thenReturn("expected");\n    assertEquals("expected", uniqueHelper());'
    );

  const result = validator.validate({
    acceptedCode: ACCEPTED,
    candidateCode: candidate,
    diagnostic: diagnostic({
      status: 'test_failed',
      affectedTestNames: ['affectedTest']
    }),
    allowedImports: []
  });

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('IMPORT_OUT_OF_SCOPE'));
  assert.ok(result.memberNames.includes('org.mockito.Mockito.*'));
});

test('candidate permitted change accepts an import that resolves a compiler error on an existing field', () => {
  const accepted = [
    'package demo;',
    '',
    'class BrokenImportTest {',
    '  private MissingRepository repository;',
    '  @Test void affectedTest() { repository.load(); }',
    '}',
    ''
  ].join('\n');
  const candidate = accepted.replace(
    '\n\nclass BrokenImportTest',
    '\n\nimport demo.repository.MissingRepository;\n\nclass BrokenImportTest'
  );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: 'src/test/java/demo/BrokenImportTest.java',
        line: 4,
        column: 11,
        category: 'compilation_error',
        message: '找不到符号'
      }]
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts compile-hit shared field repairs in every referencing test', () => {
  const accepted = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class SharedBrokenFieldsTest {',
    '  private wrong.repository.TaskRepository taskRepository;',
    '  private wrong.time.CalendarFunction calendarFunc;',
    '  @Test void firstScenario() { taskRepository.load(); calendarFunc.shift(); }',
    '  @Test void secondScenario() { calendarFunc.shift(); }',
    '  @Test void unrelatedScenario() { stable(); }',
    '  private void stable() {}',
    '}',
    ''
  ].join('\n');
  const candidate = accepted
    .replace(
      'import org.junit.jupiter.api.Test;',
      [
        'import org.junit.jupiter.api.Test;',
        'import demo.repository.TaskRepository;',
        'import demo.time.CalendarFunc;'
      ].join('\n')
    )
    .replace(
      'private wrong.repository.TaskRepository taskRepository;',
      'private TaskRepository taskRepository;'
    )
    .replace(
      'private wrong.time.CalendarFunction calendarFunc;',
      'private CalendarFunc calendarFunc;'
    )
    .replace(
      'taskRepository.load(); calendarFunc.shift();',
      'TaskRepository current = taskRepository; current.load(); calendarFunc.shift();'
    )
    .replace(
      '@Test void secondScenario() { calendarFunc.shift(); }',
      '@Test void secondScenario() { CalendarFunc current = calendarFunc; current.shift(); }'
    );
  const lines = accepted.split('\n');

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      compilerErrors: [
        {
          filePath: 'src/test/java/demo/SharedBrokenFieldsTest.java',
          line: lines.findIndex((line) => line.includes('TaskRepository taskRepository')) + 1,
          column: 11,
          category: 'compilation_error',
          message: '找不到符号'
        },
        {
          filePath: 'src/test/java/demo/SharedBrokenFieldsTest.java',
          line: lines.findIndex((line) => line.includes('CalendarFunction calendarFunc')) + 1,
          column: 11,
          category: 'compilation_error',
          message: '找不到符号'
        }
      ]
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('compile-hit shared field repair still rejects a test that does not reference the field', () => {
  const accepted = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'class SharedBrokenFieldTest {',
    '  private wrong.Repository repository;',
    '  @Test void affectedScenario() { repository.load(); }',
    '  @Test void unrelatedScenario() { stable(); }',
    '  private void stable() {}',
    '}',
    ''
  ].join('\n');
  const candidate = accepted
    .replace('private wrong.Repository repository;', 'private Repository repository;')
    .replace('stable();', 'stable(); stable();');
  const fieldLine = accepted.split('\n')
    .findIndex((line) => line.includes('wrong.Repository')) + 1;

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: 'src/test/java/demo/SharedBrokenFieldTest.java',
        line: fieldLine,
        column: 11,
        category: 'compilation_error',
        message: 'cannot find symbol'
      }]
    })
  });

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_TEST_CHANGED'));
  assert.ok(result.memberNames.includes('unrelatedScenario'));
});

test('candidate permitted change accepts imports for baseline types omitted by compiler diagnostics', () => {
  const accepted = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'class TruncatedCompilerDiagnosticTest {',
    '  private MissingRepository repository;',
    '  private MissingReport report;',
    '  @Test void affectedTest() { repository.load(report); }',
    '}',
    ''
  ].join('\n');
  const candidate = accepted.replace(
    'import org.junit.jupiter.api.Test;',
    [
      'import org.junit.jupiter.api.Test;',
      'import demo.repository.MissingRepository;',
      'import demo.report.MissingReport;'
    ].join('\n')
  );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      compilerErrors: [{
        filePath: 'src/test/java/demo/TruncatedCompilerDiagnosticTest.java',
        line: 6,
        column: 11,
        category: 'compilation_error',
        message: '找不到符号'
      }]
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts a shared fixture repair used by affected and passing tests', () => {
  const accepted = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'class SharedFixtureTest {',
    '  private Service service;',
    '  private void resetMocks() { service.reset(); }',
    '  @Test void affectedTest() { resetMocks(); service.failingPath(); }',
    '  @Test void passingTest() { resetMocks(); service.passingPath(); }',
    '}',
    ''
  ].join('\n');
  const candidate = accepted
    .replace(
      'import org.junit.jupiter.api.Test;',
      'import org.junit.jupiter.api.Test;\nimport demo.support.BaseManager;'
    )
    .replace(
      '  private Service service;',
      '  private Service service;\n  private BaseManager reportUnitRepository;'
    )
    .replace(
      'private void resetMocks() { service.reset(); }',
      'private void resetMocks() { service.reset(); reportUnitRepository.get("RU1"); }'
    );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      status: 'test_failed',
      affectedTestNames: ['affectedTest']
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts a new helper and its field and import when only affected tests reach it', () => {
  const candidate = ACCEPTED
    .replace(
      'import org.junit.jupiter.api.Test;',
      'import org.junit.jupiter.api.Test;\nimport demo.support.ExpectedValue;'
    )
    .replace(
      '  private Repository repository;',
      '  private Repository repository;\n  private ExpectedValue expectedValue = new ExpectedValue("expected");'
    )
    .replace(
      'assertEquals("expected", uniqueHelper());',
      'assertEquals(expectedText(), uniqueHelper());'
    )
    .replace(
      '\n}',
      [
        '',
        '  private String expectedText() {',
        '    return expectedValue.text();',
        '  }',
        '}',
        ''
      ].join('\n')
    );

  const result = validate(candidate, diagnostic({
    status: 'test_failed',
    affectedTestNames: ['affectedTest']
  }));

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change rejects a new helper reached by an unaffected test', () => {
  const candidate = ACCEPTED
    .replace(
      'assertEquals("stable", unrelatedHelper());',
      'assertEquals("stable", addedHelper());'
    )
    .replace(
      '\n}',
      '\n\n  private String addedHelper() { return unrelatedHelper(); }\n}\n'
    );

  const result = validate(candidate, diagnostic({
    status: 'test_failed',
    affectedTestNames: ['affectedTest']
  }));

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_TEST_CHANGED'));
  assert.ok(result.violationCodes.includes('UNRELATED_METHOD_CHANGED'));
  assert.ok(result.memberNames.includes('addedHelper'));
});

test('candidate permitted change rejects a new helper reached from lifecycle setup', () => {
  const candidate = ACCEPTED
    .replace(
      '    repository = new Repository();',
      '    repository = new Repository();\n    addedHelper();'
    )
    .replace(
      '\n}',
      '\n\n  private void addedHelper() { repository.load(); }\n}\n'
    );

  const result = validate(candidate, diagnostic({
    status: 'test_failed',
    affectedTestNames: ['affectedTest']
  }));

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_METHOD_CHANGED'));
  assert.ok(result.violationCodes.includes('UNRELATED_LIFECYCLE_CHANGED'));
  assert.ok(result.memberNames.includes('addedHelper'));
});

test('candidate permitted change accepts related import, field, and lifecycle setup edits', () => {
  const candidate = ACCEPTED
    .replace(
      'import org.junit.jupiter.api.Test;',
      'import org.junit.jupiter.api.Test;\nimport demo.support.ExpectedValue;'
    )
    .replace(
      '  private Repository repository;',
      '  private Repository repository;\n  private ExpectedValue expectedValue;'
    )
    .replace(
      '    repository = new Repository();',
      '    repository = new Repository();\n    expectedValue = new ExpectedValue("expected");'
    )
    .replace(
      'assertEquals("expected", uniqueHelper());',
      'assertEquals(expectedValue.text(), uniqueHelper());'
    );

  const result = validate(candidate, diagnostic({
    status: 'test_failed',
    affectedTestNames: ['affectedTest']
  }));

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts a new Mockito injection field for an affected test', () => {
  const accepted = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.InjectMocks;',
    '',
    'class ServiceTest {',
    '  @InjectMocks',
    '  private Service service;',
    '',
    '  @Test',
    '  void affectedTest() { service.load(); }',
    '',
    '  @Test',
    '  void passingTest() { service.validate(); }',
    '}',
    ''
  ].join('\n');
  const candidate = accepted
    .replace(
      'import org.mockito.InjectMocks;',
      'import org.mockito.InjectMocks;\nimport org.mockito.Mock;\nimport demo.ReportRepository;'
    )
    .replace(
      '  @InjectMocks',
      '  @Mock(answer = org.mockito.Answers.RETURNS_DEEP_STUBS)\n'
        + '  private ReportRepository reportRepository;\n\n'
        + '  @InjectMocks'
    );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      status: 'test_failed',
      affectedTestNames: ['affectedTest']
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change accepts correcting an existing Mockito injection field type', () => {
  const accepted = [
    'package demo;',
    '',
    'import demo.base.BaseManager;',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.InjectMocks;',
    'import org.mockito.Mock;',
    '',
    'class ServiceTest {',
    '  @InjectMocks',
    '  private Service service;',
    '',
    '  @Mock',
    '  private BaseManager repository;',
    '',
    '  @Test',
    '  void affectedTest() { service.load(); }',
    '',
    '  @Test',
    '  void passingTest() { service.validate(); }',
    '}',
    ''
  ].join('\n');
  const candidate = accepted
    .replace('import demo.base.BaseManager;', 'import demo.repository.TaskRepository;')
    .replace('private BaseManager repository;', 'private TaskRepository repository;');

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({
      status: 'test_failed',
      affectedTestNames: ['affectedTest']
    })
  });

  assert.deepEqual(result, { accepted: true });
});

test('candidate permitted change rejects unrelated helper and field edits', async (t) => {
  const cases = [
    {
      name: 'helper',
      code: ACCEPTED.replace('return unrelatedValue;', 'return unrelatedValue.trim();'),
      violation: 'UNRELATED_METHOD_CHANGED',
      member: 'unrelatedHelper'
    },
    {
      name: 'field',
      code: ACCEPTED.replace('"stable";', '"changed";'),
      violation: 'UNRELATED_FIELD_CHANGED',
      member: 'unrelatedValue'
    }
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const result = validate(item.code, diagnostic({
        affectedTestNames: ['affectedTest']
      }));
      assert.equal(result.accepted, false);
      assert.ok(result.violationCodes.includes(item.violation));
      assert.ok(result.memberNames.includes(item.member));
    });
  }
});

test('candidate permitted change rejects an edit to one unrelated overloaded helper', () => {
  const accepted = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'class OverloadedTest {',
    '  private String helper(String value) { return value; }',
    '  private String helper(int value) { return String.valueOf(value); }',
    '  @Test',
    '  void affectedTest() {}',
    '}'
  ].join('\n');
  const candidate = accepted.replace(
    'return String.valueOf(value);',
    'return Integer.toString(value);'
  );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic({ affectedTestNames: ['affectedTest'] })
  });

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_METHOD_CHANGED'));
  assert.ok(result.memberNames.includes('helper'));
});

test('candidate permitted change rejects an edit to one unaffected overloaded test', () => {
  const accepted = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'class OverloadedTest {',
    '  @Test',
    '  void caseOf(String value) { consume(value); }',
    '  @Test',
    '  void caseOf(int value) { consume(value); }',
    '  private void consume(Object value) {}',
    '}'
  ].join('\n');
  const candidate = accepted.replace(
    'consume(value); }',
    'consume(value.trim()); }'
  );

  const result = validator.validate({
    acceptedCode: accepted,
    candidateCode: candidate,
    diagnostic: diagnostic()
  });

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_TEST_CHANGED'));
});

test('candidate permitted change rejects unrelated setup statements beside a related field', () => {
  const candidate = ACCEPTED.replace(
    '    repository = new Repository();',
    '    repository = new Repository();\n    unrelatedValue = "changed";'
  );

  const result = validate(candidate, diagnostic({
    status: 'test_failed',
    affectedTestNames: ['affectedTest']
  }));

  assert.equal(result.accepted, false);
  assert.ok(result.violationCodes.includes('UNRELATED_LIFECYCLE_CHANGED'));
  assert.ok(result.memberNames.includes('setUp'));
});

test('candidate permitted change accepts formatting-only edits but rejects literal changes', () => {
  const formatted = ACCEPTED
    .replaceAll('\n', '\r\n')
    .replace('void affectedTest()', 'void affectedTest( )')
    .replace(
      'assertEquals("expected", uniqueHelper());',
      '// same behavior\r\n    assertEquals( "expected" , uniqueHelper( ) );'
    );
  const formattingResult = validate(formatted, diagnostic({
    affectedTestNames: ['affectedTest']
  }));
  const literalResult = validate(
    ACCEPTED.replace('"stable";', '"changed";'),
    diagnostic({ affectedTestNames: ['affectedTest'] })
  );

  assert.deepEqual(formattingResult, { accepted: true });
  assert.equal(literalResult.accepted, false);
  assert.ok(literalResult.violationCodes.includes('UNRELATED_FIELD_CHANGED'));
});

test('candidate permitted change rejects an identical repair candidate before Maven reruns', () => {
  const code = ACCEPTED;
  const result = new CandidateChangeValidator().validate({
    acceptedCode: code,
    candidateCode: code,
    diagnostic: diagnostic({ affectedTestMethods: ['failingScenario'] })
  });

  assert.equal(result.accepted, false);
  assert.deepEqual(result.violationCodes, ['NO_EFFECTIVE_CHANGE']);
});

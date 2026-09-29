import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  MethodTestBundleMergerService
} from '../src/main/services/method-test-bundle-merger.service.ts';
import { JavaTestStructureService } from '../src/main/services/java-test-structure.service.ts';

const METHOD_ID = 'b'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function batch(index, tests) {
  const className = `TaskServiceTmp${index}Test`;
  const methods = tests.map(({ name, body }) => [
    '    @Test',
    `    void ${name}() {`,
    `        ${body}`,
    '    }'
  ].join('\n')).join('\n\n');
  const code = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.BeforeEach;',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mock;',
    '',
    `public class ${className} {`,
    '    @Mock',
    '    private Repository repository;',
    '',
    '    @BeforeEach',
    '    void setUp() {',
    '        repository.reset();',
    '    }',
    '',
    '    private String fixture() {',
    '        return "value";',
    '    }',
    '',
    methods,
    '}',
    ''
  ].join('\n');
  return {
    batchId: String(index).repeat(64),
    filePath: `D:\\work\\TaskServiceTmp${index}Test.java`,
    sha256: sha256(code),
    code,
    ordinaryTestMethodCount: tests.length,
    passedTestMethods: tests.map((item) => item.name)
  };
}

test('merges verified TMP batches, deduplicates support members, and retains test order', () => {
  const merger = new MethodTestBundleMergerService();
  const result = merger.merge(METHOD_ID, [
    batch(1, [{ name: 'coversA', body: 'fixture();' }]),
    batch(2, [{ name: 'coversB', body: 'repository.find();' }]),
    batch(3, [{ name: 'coversA', body: 'repository.save();' }])
  ]);

  assert.equal(result.methodId, METHOD_ID);
  assert.equal(result.ordinaryTestMethodCount, 3);
  assert.deepEqual(result.passedTestMethods, [
    'coversA',
    'coversB',
    'coversABatch3'
  ]);
  assert.deepEqual(result.sourceBatchIds, [
    '1'.repeat(64),
    '2'.repeat(64),
    '3'.repeat(64)
  ]);
  assert.equal((result.code.match(/private Repository repository;/g) ?? []).length, 1);
  assert.equal((result.code.match(/void setUp\(\)/g) ?? []).length, 1);
  assert.equal((result.code.match(/String fixture\(\)/g) ?? []).length, 1);
  assert.ok(result.code.indexOf('void coversA()') < result.code.indexOf('void coversB()'));
  assert.ok(result.code.indexOf('void coversB()') < result.code.indexOf('void coversABatch3()'));
  assert.match(result.code, /public class TaskServiceTmp1Test\b/);
});

test('places support fields from every verified TMP before the first merged test method', () => {
  const verifiedBatch = (index, fieldType, fieldName, testName) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      'import org.junit.jupiter.api.Test;',
      'import org.mockito.Mock;',
      `public class ${className} {`,
      `    @Mock private ${fieldType} ${fieldName};`,
      `    @Test void ${testName}() { ${fieldName}.toString(); }`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [testName]
    };
  };

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    verifiedBatch(1, 'FirstRepository', 'firstRepository', 'firstScenario'),
    verifiedBatch(2, 'SecondRepository', 'secondRepository', 'secondScenario')
  ]);
  const structure = new JavaTestStructureService();
  const fields = structure.findFields(result.code);
  const tests = structure.findTestMethods(result.code);

  assert.deepEqual(tests.map((method) => method.name), [
    'firstScenario',
    'secondScenario'
  ]);
  assert.ok(fields.every((field) => field.endOffset <= tests[0].startOffset));
});

test('deduplicates the same field type across imported and fully qualified spellings', () => {
  const importedCode = [
    'package demo;',
    '',
    'import com.example.report.ReportUnitRepository;',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mock;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Mock',
    '    private ReportUnitRepository reportUnitRepository;',
    '',
    '    @Test',
    '    void importedTypeScenario() { reportUnitRepository.toString(); }',
    '}',
    ''
  ].join('\n');
  const qualifiedCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mock;',
    '',
    'public class TaskServiceTmp2Test {',
    '    @Mock',
    '    private com.example.report.ReportUnitRepository reportUnitRepository;',
    '',
    '    @Test',
    '    void qualifiedTypeScenario() { reportUnitRepository.toString(); }',
    '}',
    ''
  ].join('\n');

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    {
      batchId: '1'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp1Test.java',
      sha256: sha256(importedCode),
      code: importedCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['importedTypeScenario']
    },
    {
      batchId: '2'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp2Test.java',
      sha256: sha256(qualifiedCode),
      code: qualifiedCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['qualifiedTypeScenario']
    }
  ]);

  assert.equal(
    (result.code.match(/ReportUnitRepository reportUnitRepository;/g) ?? []).length,
    1
  );
  assert.deepEqual(result.passedTestMethods, [
    'importedTypeScenario',
    'qualifiedTypeScenario'
  ]);
});

test('deduplicates same-package field types across simple and fully qualified spellings', () => {
  const packageName = 'com.dtsz.collection.model.service';
  const simpleCode = [
    `package ${packageName};`,
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mock;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Mock',
    '    private FrequencyService frequencyService;',
    '',
    '    @Test',
    '    void simpleTypeScenario() { frequencyService.toString(); }',
    '}',
    ''
  ].join('\n');
  const qualifiedCode = [
    `package ${packageName};`,
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.Mock;',
    '',
    'public class TaskServiceTmp2Test {',
    '    @Mock',
    `    private ${packageName}.FrequencyService frequencyService;`,
    '',
    '    @Test',
    '    void qualifiedTypeScenario() { frequencyService.toString(); }',
    '}',
    ''
  ].join('\n');

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    {
      batchId: '1'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp1Test.java',
      sha256: sha256(simpleCode),
      code: simpleCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['simpleTypeScenario']
    },
    {
      batchId: '2'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp2Test.java',
      sha256: sha256(qualifiedCode),
      code: qualifiedCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['qualifiedTypeScenario']
    }
  ]);

  assert.equal(
    (result.code.match(/FrequencyService frequencyService;/g) ?? []).length,
    1
  );
  assert.deepEqual(result.passedTestMethods, [
    'simpleTypeScenario',
    'qualifiedTypeScenario'
  ]);
});

test('does not deduplicate same-name fields imported from different packages', () => {
  const batchWithImport = (index, importedType) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      `import ${importedType};`,
      'import org.junit.jupiter.api.Test;',
      `public class ${className} {`,
      '    private ReportUnitRepository reportUnitRepository;',
      `    @Test void batch${index}Scenario() { reportUnitRepository.toString(); }`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [`batch${index}Scenario`]
    };
  };

  assert.throws(
    () => new MethodTestBundleMergerService().merge(METHOD_ID, [
      batchWithImport(1, 'com.example.first.ReportUnitRepository'),
      batchWithImport(2, 'com.example.second.ReportUnitRepository')
    ]),
    /conflicting (?:import|support member)/i
  );
});

test('ignores a conflicting field declaration that no active member uses', () => {
  const firstCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '    private FrequencyService frequencyService;',
    '    @Test void firstScenario() { assert true; }',
    '}',
    ''
  ].join('\n');
  const secondCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp2Test {',
    '    private ReportUnitService frequencyService;',
    '    @Test void secondScenario() { assert true; }',
    '}',
    ''
  ].join('\n');

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    {
      batchId: '1'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp1Test.java',
      sha256: sha256(firstCode),
      code: firstCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['firstScenario']
    },
    {
      batchId: '2'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp2Test.java',
      sha256: sha256(secondCode),
      code: secondCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['secondScenario']
    }
  ]);

  assert.match(result.code, /private FrequencyService frequencyService;/);
  assert.doesNotMatch(result.code, /private ReportUnitService frequencyService;/);
  assert.deepEqual(result.passedTestMethods, ['firstScenario', 'secondScenario']);
});

test('retains final-round TODO comments for failed tests while merging passing tests', () => {
  const code = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @Test',
    '    void passingScenario() {}',
    '',
    '    // TODO 当前测试方法需要修复',
    '    // @Test',
    '    // void firstFailure() {',
    '    //     throw new IllegalStateException("first");',
    '    // }',
    '',
    '    // TODO 当前测试方法需要修复',
    '    // @Test',
    '    // void secondFailure() {',
    '    //     throw new IllegalStateException("second");',
    '    // }',
    '}',
    ''
  ].join('\n');

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [{
    batchId: '1'.repeat(64),
    filePath: 'D:\\work\\TaskServiceTmp1Test.java',
    sha256: sha256(code),
    code,
    ordinaryTestMethodCount: 1,
    passedTestMethods: ['passingScenario']
  }]);

  assert.deepEqual(result.passedTestMethods, ['passingScenario']);
  assert.equal(result.ordinaryTestMethodCount, 1);
  assert.equal(
    [...result.code.matchAll(/^\s*\/\/ TODO 当前测试方法需要修复\s*$/gm)].length,
    2
  );
  assert.match(result.code, /\/\/ void firstFailure\(\) \{/);
  assert.match(result.code, /\/\/ void secondFailure\(\) \{/);
});

test('prefers active support over a conflicting retained-only declaration regardless of batch order', () => {
  const activeCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    'import org.mockito.InjectMocks;',
    '',
    'public class TaskServiceTmp1Test {',
    '    @InjectMocks',
    '    private TaskService taskService;',
    '',
    '    @Test',
    '    void passingScenario() { taskService.toString(); }',
    '}',
    ''
  ].join('\n');
  const retainedCode = [
    'package demo;',
    '',
    'import org.junit.jupiter.api.Test;',
    '',
    'public class TaskServiceTmp2Test {',
    '    private final TaskService taskService = new TaskService();',
    '',
    '    // TODO 当前测试方法需要修复',
    '    // @Test',
    '    // void failedScenario() { taskService.toString(); }',
    '}',
    ''
  ].join('\n');
  const active = {
    batchId: '1'.repeat(64),
    filePath: 'D:\\work\\TaskServiceTmp1Test.java',
    sha256: sha256(activeCode),
    code: activeCode,
    ordinaryTestMethodCount: 1,
    passedTestMethods: ['passingScenario']
  };
  const retained = {
    batchId: '2'.repeat(64),
    filePath: 'D:\\work\\TaskServiceTmp2Test.java',
    sha256: sha256(retainedCode),
    code: retainedCode,
    ordinaryTestMethodCount: 0,
    passedTestMethods: []
  };

  for (const batches of [[active, retained], [retained, active]]) {
    const result = new MethodTestBundleMergerService().merge(METHOD_ID, batches);

    assert.deepEqual(result.passedTestMethods, ['passingScenario']);
    assert.equal(result.ordinaryTestMethodCount, 1);
    assert.equal((result.code.match(/TaskService taskService/g) ?? []).length, 1);
    assert.match(result.code, /@InjectMocks\s+private TaskService taskService;/);
    assert.doesNotMatch(result.code, /taskService\s*=\s*new TaskService/);
    assert.match(result.code, /\/\/ TODO 当前测试方法需要修复/);
    assert.match(result.code, /\/\/ void failedScenario\(\)/);
  }
});

test('rejects a batch whose digest or declared ordinary test count is not exact', () => {
  const merger = new MethodTestBundleMergerService();
  const valid = batch(1, [{ name: 'coversA', body: 'fixture();' }]);

  assert.throws(
    () => merger.merge(METHOD_ID, [{ ...valid, sha256: '0'.repeat(64) }]),
    /digest/i
  );
  assert.throws(
    () => merger.merge(METHOD_ID, [{ ...valid, ordinaryTestMethodCount: 2 }]),
    /test method count/i
  );
});

test('retains overloaded support methods with distinct parameter signatures', () => {
  const code = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test {',
    '    private String fixture() { return "none"; }',
    '    private String fixture(String value) { return value; }',
    '    @Test',
    '    void coversOverloads() { fixture(); fixture("x"); }',
    '}',
    ''
  ].join('\n');
  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [{
    batchId: '4'.repeat(64),
    filePath: 'D:\\work\\TaskServiceTmp1Test.java',
    sha256: sha256(code),
    code,
    ordinaryTestMethodCount: 1,
    passedTestMethods: ['coversOverloads']
  }]);

  assert.match(result.code, /String fixture\(\)/);
  assert.match(result.code, /String fixture\(String value\)/);
});

test('renders every direct class member with conventional indentation', () => {
  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    batch(1, [{ name: 'coversA', body: 'fixture();' }])
  ]);

  assert.match(result.code, /\n    @Mock\n    private Repository repository;/);
  assert.match(result.code, /\n    @Test\n    void coversA\(\)/);
});

test('merges a compact test whose first member shares the class declaration line', () => {
  const code = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp1Test { @Test void compact() {} }',
    ''
  ].join('\n');

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [{
    batchId: '5'.repeat(64),
    filePath: 'D:\\work\\TaskServiceTmp1Test.java',
    sha256: sha256(code),
    code,
    ordinaryTestMethodCount: 1,
    passedTestMethods: ['compact']
  }]);

  assert.equal(result.ordinaryTestMethodCount, 1);
  assert.equal((result.code.match(/public class TaskServiceTmp1Test/g) ?? []).length, 1);
  assert.match(result.code, /void compact\(\)/);
});

test('renames only a duplicate test declaration when its body calls an overloaded helper', () => {
  const secondCode = [
    'package demo;',
    'import org.junit.jupiter.api.Test;',
    'public class TaskServiceTmp2Test {',
    '    @Test',
    '    void coversA() { coversA(1); }',
    '    private void coversA(int value) {}',
    '}',
    ''
  ].join('\n');

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    batch(1, [{ name: 'coversA', body: 'fixture();' }]),
    {
      batchId: '2'.repeat(64),
      filePath: 'D:\\work\\TaskServiceTmp2Test.java',
      sha256: sha256(secondCode),
      code: secondCode,
      ordinaryTestMethodCount: 1,
      passedTestMethods: ['coversA']
    }
  ]);

  assert.match(result.code, /void coversABatch2\(\) \{ coversA\(1\); \}/);
  assert.match(result.code, /private void coversA\(int value\)/);
  assert.equal((result.code.match(/void coversA\(\)/g) ?? []).length, 1);
});

test('rejects conflicting same-name fields that use brace initializers', () => {
  const braceBatch = (index, values) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      'import org.junit.jupiter.api.Test;',
      `public class ${className} {`,
      `    private final int[] values = {${values}};`,
      `    @Test void batch${index}Scenario() { values.toString(); }`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [`batch${index}Scenario`]
    };
  };

  assert.throws(
    () => new MethodTestBundleMergerService().merge(METHOD_ID, [
      braceBatch(1, '1, 2'),
      braceBatch(2, '3, 4')
    ]),
    /conflicting support member/i
  );
});

test('detects helper signature collisions even when parameter names differ', () => {
  const helperBatch = (index, parameterName) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      'import org.junit.jupiter.api.Test;',
      `public class ${className} {`,
      `    private String fixture(String ${parameterName}) { return ${parameterName}; }`,
      `    @Test void batch${index}Scenario() { fixture("value"); }`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [`batch${index}Scenario`]
    };
  };

  assert.throws(
    () => new MethodTestBundleMergerService().merge(METHOD_ID, [
      helperBatch(1, 'value'),
      helperBatch(2, 'input')
    ]),
    /conflicting support member/i
  );
});

test('detects helper signature collisions after Java generic erasure', () => {
  const genericBatch = (index, typeArgument) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      'import java.util.List;',
      'import org.junit.jupiter.api.Test;',
      `public class ${className} {`,
      `    private void fixture(List<${typeArgument}> values) {}`,
      `    @Test void batch${index}Scenario() { fixture(List.of()); }`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [`batch${index}Scenario`]
    };
  };

  assert.throws(
    () => new MethodTestBundleMergerService().merge(METHOD_ID, [
      genericBatch(1, 'String'),
      genericBatch(2, 'Integer')
    ]),
    /conflicting support member/i
  );
});

test('aggregates each JUnit lifecycle stage once in stable batch order', () => {
  const lifecycleBatch = (index, statement) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      'import org.junit.jupiter.api.BeforeEach;',
      'import org.junit.jupiter.api.Test;',
      `public class ${className} {`,
      '    @BeforeEach',
      '    void setUp() {',
      `        ${statement}`,
      '        sharedSetup();',
      '    }',
      '    private void sharedSetup() {}',
      `    private void setup${index}() {}`,
      `    @Test void batch${index}Scenario() {}`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [`batch${index}Scenario`]
    };
  };

  const result = new MethodTestBundleMergerService().merge(METHOD_ID, [
    lifecycleBatch(1, 'setup1();'),
    lifecycleBatch(2, 'setup2();')
  ]);

  assert.equal((result.code.match(/@BeforeEach/g) ?? []).length, 1);
  assert.equal((result.code.match(/void setUp\(\)/g) ?? []).length, 1);
  assert.ok(result.code.indexOf('setup1();') < result.code.indexOf('sharedSetup();'));
  assert.ok(result.code.indexOf('sharedSetup();') < result.code.indexOf('setup2();'));
  assert.equal((result.code.match(/sharedSetup\(\);/g) ?? []).length, 1);
});

test('rejects ambiguous explicit imports before a formal merge reaches Maven', () => {
  const importBatch = (index, importedType) => {
    const className = `TaskServiceTmp${index}Test`;
    const code = [
      'package demo;',
      `import ${importedType};`,
      'import org.junit.jupiter.api.Test;',
      `public class ${className} {`,
      `    @Test void batch${index}Scenario() { Client value = null; }`,
      '}',
      ''
    ].join('\n');
    return {
      batchId: String(index).repeat(64),
      filePath: `D:\\work\\${className}.java`,
      sha256: sha256(code),
      code,
      ordinaryTestMethodCount: 1,
      passedTestMethods: [`batch${index}Scenario`]
    };
  };

  assert.throws(
    () => new MethodTestBundleMergerService().merge(METHOD_ID, [
      importBatch(1, 'com.example.first.Client'),
      importBatch(2, 'com.example.second.Client')
    ]),
    /conflicting import/i
  );
});

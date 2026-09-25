import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TestWriterService } from '../src/main/services/test-writer.service.ts';

test('writes the next test beside a module target when the backend suggests a workspace-root path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-'));

  try {
    const targetFilePath = join(
      workspaceRoot,
      'manager-core',
      'src',
      'main',
      'java',
      'com',
      'example',
      'DemandVO.java'
    );
    const existingTestPath = join(
      workspaceRoot,
      'manager-core',
      'src',
      'test',
      'java',
      'com',
      'example',
      'DemandVOTest.java'
    );
    const misplacedSuggestion = join(
      workspaceRoot,
      'src',
      'test',
      'java',
      'com',
      'example',
      'DemandVOTest.java'
    );

    await mkdir(join(targetFilePath, '..'), { recursive: true });
    await mkdir(join(existingTestPath, '..'), { recursive: true });
    await writeFile(targetFilePath, 'package com.example;\npublic class DemandVO {}\n', 'utf8');
    await writeFile(existingTestPath, 'package com.example;\nclass DemandVOTest {}\n', 'utf8');

    const result = await new TestWriterService().writeGeneratedTest({
      workspaceRoot,
      targetFilePath,
      suggestedTestPath: misplacedSuggestion,
      testClassName: 'DemandVOTest',
      content: 'package com.example;\nclass DemandVOTest {}\n'
    });

    const expectedPath = join(
      workspaceRoot,
      'manager-core',
      'src',
      'test',
      'java',
      'com',
      'example',
      'DemandVO1Test.java'
    );
    assert.equal(result.testFilePath, expectedPath);
    assert.equal(result.testClassName, 'DemandVO1Test');
    assert.match(await readFile(expectedPath, 'utf8'), /class DemandVO1Test\b/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('continues the target class sequence when a numbered backend suggestion becomes stale', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-'));

  try {
    const packageDirectory = join(workspaceRoot, 'manager-core', 'src', 'test', 'java', 'com', 'example');
    const targetFilePath = join(
      workspaceRoot,
      'manager-core',
      'src',
      'main',
      'java',
      'com',
      'example',
      'DemandVO.java'
    );
    await mkdir(join(targetFilePath, '..'), { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(targetFilePath, 'package com.example;\npublic class DemandVO {}\n', 'utf8');
    await writeFile(join(packageDirectory, 'DemandVOTest.java'), 'class DemandVOTest {}\n', 'utf8');
    await writeFile(join(packageDirectory, 'DemandVO1Test.java'), 'class DemandVO1Test {}\n', 'utf8');

    const result = await new TestWriterService().writeGeneratedTest({
      workspaceRoot,
      targetFilePath,
      suggestedTestPath: join(packageDirectory, 'DemandVO1Test.java'),
      testClassName: 'DemandVO1Test',
      content: 'package com.example;\nclass DemandVO1Test {}\n'
    });

    assert.equal(result.testFilePath, join(packageDirectory, 'DemandVO2Test.java'));
    assert.equal(result.testClassName, 'DemandVO2Test');
    assert.match(await readFile(result.testFilePath, 'utf8'), /class DemandVO2Test\b/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('rejects a module test directory junction that resolves outside the workspace', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-outside-'));

  try {
    const targetFilePath = join(
      workspaceRoot,
      'manager-core',
      'src',
      'main',
      'java',
      'com',
      'example',
      'DemandVO.java'
    );
    const testSourceParent = join(workspaceRoot, 'manager-core', 'src', 'test');
    const linkedTestSourceRoot = join(testSourceParent, 'java');
    await mkdir(join(targetFilePath, '..'), { recursive: true });
    await mkdir(testSourceParent, { recursive: true });
    await writeFile(targetFilePath, 'package com.example;\npublic class DemandVO {}\n', 'utf8');
    await symlink(outsideRoot, linkedTestSourceRoot, 'junction');

    await assert.rejects(
      new TestWriterService().writeGeneratedTest({
        workspaceRoot,
        targetFilePath,
        testClassName: 'DemandVOTest',
        content: 'package com.example;\nclass DemandVOTest {}\n'
      }),
      /workspace|工作区/i
    );
    await assert.rejects(access(join(outsideRoot, 'DemandVOTest.java')));
    await assert.rejects(access(join(outsideRoot, 'com', 'example')));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('rejects a rename when the generated class has additional self references', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-'));

  try {
    const targetFilePath = join(workspaceRoot, 'src', 'main', 'java', 'com', 'example', 'DemandVO.java');
    const testPackageDirectory = join(workspaceRoot, 'src', 'test', 'java', 'com', 'example');
    await mkdir(join(targetFilePath, '..'), { recursive: true });
    await mkdir(testPackageDirectory, { recursive: true });
    await writeFile(targetFilePath, 'package com.example;\npublic class DemandVO {}\n', 'utf8');
    await writeFile(join(testPackageDirectory, 'DemandVOTest.java'), 'class DemandVOTest {}\n', 'utf8');

    await assert.rejects(
      new TestWriterService().writeGeneratedTest({
        workspaceRoot,
        targetFilePath,
        testClassName: 'DemandVOTest',
        content: 'package com.example;\nclass DemandVOTest { DemandVOTest() {} }\n'
      }),
      /无法安全重命名/
    );
    await assert.rejects(access(join(testPackageDirectory, 'DemandVO1Test.java')));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('rejects unsafe self references when the backend omits the generated class name', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-'));

  try {
    const targetFilePath = join(workspaceRoot, 'src', 'main', 'java', 'com', 'example', 'DemandVO.java');
    const testPackageDirectory = join(workspaceRoot, 'src', 'test', 'java', 'com', 'example');
    await mkdir(join(targetFilePath, '..'), { recursive: true });
    await mkdir(testPackageDirectory, { recursive: true });
    await writeFile(targetFilePath, 'package com.example;\npublic class DemandVO {}\n', 'utf8');
    await writeFile(join(testPackageDirectory, 'DemandVOTest.java'), 'class DemandVOTest {}\n', 'utf8');

    await assert.rejects(
      new TestWriterService().writeGeneratedTest({
        workspaceRoot,
        targetFilePath,
        content: 'package com.example;\nclass DemandVOTest { DemandVOTest() {} }\n'
      }),
      /无法安全重命名/
    );
    await assert.rejects(access(join(testPackageDirectory, 'DemandVO1Test.java')));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('round trips an explicitly named method batch TMP file by owned digest', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-'));

  try {
    const targetFilePath = join(
      workspaceRoot,
      'manager-core',
      'src',
      'main',
      'java',
      'com',
      'example',
      'TaskService.java'
    );
    await mkdir(join(targetFilePath, '..'), { recursive: true });
    await writeFile(
      targetFilePath,
      'package com.example;\npublic class TaskService {}\n',
      'utf8'
    );
    const service = new TestWriterService();
    const prepared = await service.prepareMethodBatchTemporaryGeneratedTest({
      workspaceRoot,
      targetFilePath,
      plannedRelativeTestPath: (
        'manager-core/src/test/java/com/example/TaskServiceTest.java'
      ),
      outputTestClassName: 'TaskServiceTmp2Test',
      content: (
        'package com.example;\n'
        + 'public class PlaceholderTest {\n'
        + '  @org.junit.jupiter.api.Test void generated() {}\n'
        + '}\n'
      )
    });

    assert.equal(prepared.testClassName, 'TaskServiceTmp2Test');
    assert.equal(
      prepared.relativePath,
      'manager-core/src/test/java/com/example/TaskServiceTmp2Test.java'
    );
    assert.match(prepared.content, /class TaskServiceTmp2Test\b/);
    assert.equal(await service.inspectExistingMethodBatchTemporaryGeneratedTest({
      workspaceRoot,
      targetFilePath,
      plannedRelativeTestPath: (
        'manager-core/src/test/java/com/example/TaskServiceTest.java'
      ),
      outputTestClassName: 'TaskServiceTmp2Test'
    }), null);
    const written = await service.writePreparedGeneratedTest(prepared);

    const inspected = await service.inspectExistingMethodBatchTemporaryGeneratedTest({
      workspaceRoot,
      targetFilePath,
      plannedRelativeTestPath: (
        'manager-core/src/test/java/com/example/TaskServiceTest.java'
      ),
      outputTestClassName: 'TaskServiceTmp2Test'
    });
    assert.equal(inspected?.testFilePath, written.testFilePath);
    assert.equal(inspected?.sha256, written.sha256);
    assert.equal(inspected?.content, prepared.content);

    assert.equal(await service.loadOwnedGeneratedTest({
      workspaceRoot,
      filePath: written.testFilePath,
      expectedSha256: written.sha256
    }), prepared.content);
    await assert.rejects(
      service.loadOwnedGeneratedTest({
        workspaceRoot,
        filePath: written.testFilePath,
        expectedSha256: '0'.repeat(64)
      }),
      /modified|淇敼|digest/i
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('idempotently deletes a generated result without requiring its original digest', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ai-unit-test-writer-delete-'));
  const filePath = join(
    workspaceRoot,
    'module-a',
    'src',
    'test',
    'java',
    'example',
    'Task1Test.java'
  );

  try {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, 'class Task1Test { void externallyModified() {} }\n', 'utf8');
    const service = new TestWriterService();

    await service.deleteGeneratedTestIfPresent({ workspaceRoot, filePath });
    await service.deleteGeneratedTestIfPresent({ workspaceRoot, filePath });

    await assert.rejects(access(filePath), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

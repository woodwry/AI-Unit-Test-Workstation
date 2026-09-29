import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DirectTestLocatorService } from '../src/main/services/direct-test-locator.service.ts';

test('finds named and shared tests that exercise the target class', async () => {
  const root = await mkdtemp(join(tmpdir(), 'direct-tests-'));
  try {
    const mainDirectory = join(root, 'src', 'main', 'java', 'com', 'example');
    const testDirectory = join(root, 'src', 'test', 'java', 'com', 'example');
    await mkdir(mainDirectory, { recursive: true });
    await mkdir(testDirectory, { recursive: true });
    const targetFile = join(mainDirectory, 'Order.java');
    await writeFile(targetFile, 'package com.example; public class Order {}');
    await Promise.all([
      writeFile(join(testDirectory, 'Order2Test.java'), 'package com.example; public class Order2Test {}'),
      writeFile(join(testDirectory, 'OrderTest.java'), 'package com.example; public class OrderTest {}'),
      writeFile(join(testDirectory, 'Order1Test.java'), 'package com.example; public class Order1Test {}'),
      writeFile(join(testDirectory, 'OrderAdditionalTest.java'), 'package com.example; public class OrderAdditionalTest { Order target; }'),
      writeFile(join(testDirectory, 'OrderHelperTest.java'), 'package com.example; public class OrderHelperTest {}'),
      writeFile(join(testDirectory, 'BaselineTest.java'), 'package com.example; public class BaselineTest { Order target; }'),
      writeFile(join(testDirectory, 'Order3Test.java'), 'package com.other; public class Order3Test {}')
    ]);

    const result = await new DirectTestLocatorService().find(root, targetFile, 'Order');

    assert.deepEqual(result.map((item) => item.className), [
      'OrderTest',
      'Order1Test',
      'Order2Test',
      'BaselineTest',
      'OrderAdditionalTest'
    ]);
    assert.deepEqual(result.map((item) => item.qualifiedName), [
      'com.example.OrderTest',
      'com.example.Order1Test',
      'com.example.Order2Test',
      'com.example.BaselineTest',
      'com.example.OrderAdditionalTest'
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('returns an empty list when the target test package does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'direct-tests-empty-'));
  try {
    const mainDirectory = join(root, 'src', 'main', 'java', 'com', 'example');
    await mkdir(mainDirectory, { recursive: true });
    const targetFile = join(mainDirectory, 'Order.java');
    await writeFile(targetFile, 'package com.example; public class Order {}');

    assert.deepEqual(await new DirectTestLocatorService().find(root, targetFile, 'Order'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

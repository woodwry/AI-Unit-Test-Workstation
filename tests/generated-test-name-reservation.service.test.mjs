import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GeneratedTestNameReservationService
} from '../src/main/services/generated-test-name-reservation.service.ts';

async function harness(t, prefix) {
  const moduleRoot = await mkdtemp(join(tmpdir(), prefix));
  const testDirectory = join(moduleRoot, 'src', 'test', 'java');
  await mkdir(testDirectory, { recursive: true });
  t.after(async () => {
    await rm(moduleRoot, { recursive: true, force: true });
  });
  return { moduleRoot, testDirectory };
}

test('concurrent reservations skip user files and claim different numbered names', async (t) => {
  const { moduleRoot, testDirectory } = await harness(t, 'formal-name-race-');
  const userFile = join(testDirectory, 'TaskService1Test.java');
  await writeFile(userFile, 'class TaskService1Test { /* user */ }\n', 'utf8');
  const reservations = new GeneratedTestNameReservationService();

  const claimed = await Promise.all([
    reservations.reserve(moduleRoot, 'TaskService'),
    reservations.reserve(moduleRoot, 'TaskService')
  ]);

  assert.deepEqual(
    claimed.map((item) => item.testClassName).sort(),
    ['TaskService2Test', 'TaskService3Test']
  );
  assert.equal(
    await readFile(userFile, 'utf8'),
    'class TaskService1Test { /* user */ }\n'
  );
  for (const reservation of claimed) {
    assert.equal(await readFile(reservation.filePath, 'utf8'), '');
    assert.equal(reservation.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  }
});

test('reserves inside an explicit package test directory', async (t) => {
  const { moduleRoot } = await harness(t, 'formal-name-package-');
  const reservations = new GeneratedTestNameReservationService();

  const reservation = await reservations.reserve(moduleRoot, 'TaskService', {
    relativeTestDirectory: 'src/test/java/com/example'
  });

  assert.equal(
    reservation.filePath,
    join(moduleRoot, 'src', 'test', 'java', 'com', 'example', 'TaskService1Test.java')
  );
});

test('release refuses a modified reservation and preserves the user content', async (t) => {
  const { moduleRoot } = await harness(t, 'formal-name-release-');
  const reservations = new GeneratedTestNameReservationService();
  const reservation = await reservations.reserve(moduleRoot, 'TaskService');
  const userEdit = 'class TaskService1Test { void userEdit() {} }\n';
  await writeFile(reservation.filePath, userEdit, 'utf8');

  await assert.rejects(
    reservations.release(reservation),
    /modified|changed|ownership/i
  );
  assert.equal(await readFile(reservation.filePath, 'utf8'), userEdit);
});

test('refuses to reserve a formal test anywhere outside module src/test/java', async (t) => {
  const { moduleRoot } = await harness(t, 'formal-name-source-guard-');
  const reservations = new GeneratedTestNameReservationService();

  await assert.rejects(
    reservations.reserve(moduleRoot, 'TaskService', {
      relativeTestDirectory: 'src/main/java/com/example'
    }),
    /src\/test\/java|test source/i
  );
});

test('release rejects a forged reservation that points at production source', async (t) => {
  const { moduleRoot } = await harness(t, 'formal-name-release-guard-');
  const sourceFile = join(
    moduleRoot,
    'src',
    'main',
    'java',
    'com',
    'example',
    'DoNotDelete.java'
  );
  await mkdir(join(sourceFile, '..'), { recursive: true });
  await writeFile(sourceFile, '', 'utf8');
  const reservations = new GeneratedTestNameReservationService();
  const realReservation = await reservations.reserve(moduleRoot, 'TaskService');

  await assert.rejects(
    reservations.release({
      ...realReservation,
      filePath: sourceFile,
      relativePath: 'src/main/java/com/example/DoNotDelete.java',
      testClassName: 'DoNotDelete'
    }),
    /src\/test\/java|reservation|test source/i
  );

  assert.equal(await readFile(sourceFile, 'utf8'), '');
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileSystemService } from '../src/main/services/file-system.service.ts';

test('workspace search lists a matching source file after the former 1200-file boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-file-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const earlyDirectory = join(root, 'aaa');
  const targetDirectory = join(root, 'zzz', 'func');
  await mkdir(earlyDirectory, { recursive: true });
  await mkdir(targetDirectory, { recursive: true });
  await Promise.all(Array.from({ length: 1200 }, (_, index) =>
    writeFile(join(earlyDirectory, `Early${String(index).padStart(4, '0')}.java`), '', 'utf8')
  ));
  await writeFile(join(targetDirectory, 'ExtendFunc.java'), 'class ExtendFunc {}\n', 'utf8');

  const service = new FileSystemService();
  assert.equal(
    typeof service.listWorkspaceSearchFiles,
    'function',
    'quick file search needs an untruncated recursive workspace listing'
  );

  const files = await service.listWorkspaceSearchFiles(root);
  assert.equal(files.length, 1201);
  assert.ok(files.some((file) => file.name === 'ExtendFunc.java'));
});

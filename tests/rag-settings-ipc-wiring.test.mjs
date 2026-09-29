import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('local RAG storage directory is not exposed through the renderer bridge', async () => {
  const [types, preload, main, section] = await Promise.all([
    readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/RagSettingsSection.tsx', import.meta.url), 'utf8')
  ]);

  for (const source of [types, preload, main, section]) {
    assert.doesNotMatch(source, /selectRagDatabaseRoot|rag-settings:select-database-root/);
  }
  assert.doesNotMatch(types, /getRagSettings:\s*\(\)\s*=>/);
  assert.doesNotMatch(types, /saveRagSettings:\s*\(/);
  assert.doesNotMatch(preload, /rag-settings:(?:get|save)/);
  assert.doesNotMatch(main, /ipcMain\.handle\('rag-settings:(?:get|save)'/);
  assert.doesNotMatch(section, /向量数据库根目录|数据库根目录/);
  assert.doesNotMatch(preload, /workstation:\s*\{[\s\S]*ipcRenderer\s*[,}]/);
});

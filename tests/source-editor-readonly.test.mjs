import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8');

test('source editor is read-only and does not expose a manual save button', () => {
  assert.match(
    appSource,
    /const\s+MONACO_EDITOR_OPTIONS[\s\S]*?readOnly:\s*true[\s\S]*?domReadOnly:\s*true/s
  );
  assert.doesNotMatch(appSource, /title="保存当前文件"/);
  assert.doesNotMatch(appSource, /<Save\s+size=/);
});
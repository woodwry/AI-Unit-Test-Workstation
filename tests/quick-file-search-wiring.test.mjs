import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('opens fuzzy file search with Ctrl+N and supports keyboard navigation', async () => {
  const app = await readFile('src/renderer/src/App.tsx', 'utf8');

  assert.match(app, /event\.ctrlKey/);
  assert.match(app, /event\.key\.toLowerCase\(\) !== 'n'/);
  assert.match(app, /event\.preventDefault\(\)[\s\S]*?openQuickFileSearch\(\)/);
  assert.match(app, /collectWorkspaceSearchFiles\(activeRoot\)/);
  assert.doesNotMatch(
    app,
    /if \(cached && isSameWorkspaceRoot[^}]*setIsQuickFileSearchLoading\(false\);\s*return;\s*\}/
  );
  assert.match(app, /scoreQuickFileName/);
  assert.match(app, /event\.key === 'ArrowDown'/);
  assert.match(app, /event\.key === 'ArrowUp'/);
  assert.match(app, /event\.key === 'Enter'/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /从资源管理器打开代码文件，或按 Ctrl\+N 搜索文件/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /role="listbox"/);
});

test('styles quick file search as a dark workbench overlay', async () => {
  const styles = await readFile('src/renderer/src/styles.css', 'utf8');

  assert.match(styles, /\.quick-file-search-backdrop/);
  assert.match(styles, /\.quick-file-search-dialog/);
  assert.match(styles, /\.quick-file-search-result\.selected/);
  assert.match(styles, /background: #2e4053/);
});

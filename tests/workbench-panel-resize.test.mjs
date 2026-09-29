import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(
  new URL('../src/renderer/src/App.tsx', import.meta.url),
  'utf8'
);
const stylesSource = await readFile(
  new URL('../src/renderer/src/styles.css', import.meta.url),
  'utf8'
);

test('拖宽侧栏时保留中间操作区并按窗口宽度限制面板', () => {
  assert.match(
    appSource,
    /const MIN_EDITOR_COLUMN_WIDTH = 220;/
  );
  assert.match(
    appSource,
    /clampPanelWidthForViewport\(\s*'right'/
  );
  assert.match(
    appSource,
    /minmax\(\$\{MIN_EDITOR_COLUMN_WIDTH\}px, 1fr\)/
  );
});

test('Monaco and its scrollbars shrink with the editor grid while a side panel is resized', () => {
  assert.match(
    appSource,
    /useLayoutEffect\(\(\) => \{\s*editorRef\.current\?\.layout\(\);\s*\}, \[leftPanelWidth, rightPanelWidth\]\);/
  );
  assert.match(
    stylesSource,
    /\.editor-column\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s
  );
  assert.match(
    stylesSource,
    /\.editor-surface\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s
  );
  assert.match(
    stylesSource,
    /\.local-monaco-editor-host\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s
  );
});

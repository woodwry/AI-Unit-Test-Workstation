import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, stylesSource] = await Promise.all([
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
]);

test('editor tabs hide the horizontal scrollbar and translate wheel input into horizontal scrolling', () => {
  assert.match(
    appSource,
    /<div className="editor-tab-list" onWheel=\{scrollEditorTabsWithWheel\}>/
  );
  assert.match(
    appSource,
    /function scrollEditorTabsWithWheel\([\s\S]*?scrollLeft \+= horizontalDelta;/
  );
  assert.match(
    stylesSource,
    /\.editor-tab-list\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/s
  );
  assert.match(
    stylesSource,
    /\.editor-tab-list::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/s
  );
});

test('the active editor tab has a blue bottom indicator', () => {
  assert.match(
    stylesSource,
    /\.editor-tab\.active\s*\{[^}]*box-shadow:\s*inset 0 -2px 0 var\(--focus-border\);/s
  );
});

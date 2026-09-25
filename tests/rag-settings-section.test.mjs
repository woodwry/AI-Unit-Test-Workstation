import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('workspace settings expose one RAG section with independent embedding interface management', async () => {
  const [dialog, section] = await Promise.all([
    readFile(new URL('../src/renderer/src/WorkspaceSettingsDialog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/RagSettingsSection.tsx', import.meta.url), 'utf8')
  ]);

  assert.equal((dialog.match(/>\s*RAG\s*</g) ?? []).length, 1);
  assert.match(dialog, /activeSettingsSection\s*===\s*'rag'/);
  assert.match(dialog, /visibleSettingsSection\s*===\s*'rag'\s*\?\s*' rag-settings-view'/);
  assert.match(dialog, /<RagSettingsSection[\s\S]*isOpen=\{isOpen\s*&&\s*visibleSettingsSection\s*===\s*'rag'\}/);

  assert.match(section, /Embedding 接口/);
  assert.doesNotMatch(section, /数据库根目录|向量数据库根目录/);
  assert.doesNotMatch(section, /getRagSettings|selectRagDatabaseRoot|saveRagSettings/);
  assert.match(section, /ragApi\.getRagEmbeddingInterfaces\(\)/);
  assert.match(section, /ragApi\.createRagEmbeddingInterface\(/);
  assert.match(section, /ragApi\.updateRagEmbeddingInterface\(/);
  assert.match(section, /ragApi\.selectRagEmbeddingInterface\(/);
  assert.match(section, /ragApi\.deleteRagEmbeddingInterface\(/);
  assert.match(section, /ragApi\.testRagEmbeddingInterfaceConnection\(/);
  assert.match(section, /async function selectEmbeddingInterface\(id: string\)/);
  assert.doesNotMatch(section, /精准查询\s*\+\s*FTS5/);
  assert.doesNotMatch(section, /不使用 Embedding 接口/);
  assert.doesNotMatch(section, /selectEmbeddingInterface\(null\)/);
  assert.match(section, /const controlsDisabled\s*=\s*isBusy/);
  assert.match(section, /role="alert"/);
  assert.doesNotMatch(section, /value=\{draft\.embeddingModel/);
  assert.match(section, /type="radio"[\s\S]*active-rag-embedding-interface/);
  assert.match(section, />\s*名称\s*<input/);
  assert.match(section, />\s*Base URL\s*<input/);
  assert.match(section, />\s*Embedding 模型\s*<input/);
});

test('RAG settings fill the content area and no longer reserve local storage controls', async () => {
  const styles = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8');
  const ragViewRule = styles.match(/\.workspace-settings-view\.rag-settings-view\s*\{([^}]*)\}/)?.[1] ?? '';
  const ragCardFillRule = styles.match(/\.rag-settings-view\s*>\s*\.rag-settings-card\s*\{([^}]*)\}/)?.[1] ?? '';
  const ragContentFillRule = styles.match(/\.rag-settings-view \.rag-settings-card \.rag-embedding-interface-manager,[\s\S]*?\.rag-settings-view \.rag-settings-card \.rag-embedding-interface-editor\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(styles, /\.rag-settings-card\s*\{/);
  assert.match(ragViewRule, /padding:\s*0/);
  assert.match(ragCardFillRule, /max-width:\s*none/);
  assert.match(ragCardFillRule, /min-height:\s*100%/);
  assert.match(ragContentFillRule, /border:\s*0/);
  assert.match(ragContentFillRule, /border-radius:\s*0/);
  assert.match(ragContentFillRule, /padding:\s*24px/);
  assert.doesNotMatch(styles, /\.rag-settings-storage|\.rag-settings-field/);
  assert.match(styles, /\.rag-embedding-interface-manager\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.rag-settings-card[\s\S]*:focus-visible[\s\S]*outline:/);
});

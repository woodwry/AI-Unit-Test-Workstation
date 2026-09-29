import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('接口卡片的主要区域由原生 label 扩大单选命中范围', async () => {
  const source = await readFile(
    'src/renderer/src/WorkspaceModelSettingsSection.tsx',
    'utf8'
  );
  assert.match(
    source,
    /<label className="model-interface-row-select">[\s\S]*?<input type="radio"[\s\S]*?<div className="model-interface-row-main">[\s\S]*?<\/label>/
  );
  assert.match(
    source,
    /<\/label>\s*<div className="model-interface-row-actions">/
  );
});

test('大模型接口列表移除标题说明并使用简短的新增文案', async () => {
  const source = await readFile(
    'src/renderer/src/WorkspaceModelSettingsSection.tsx',
    'utf8'
  );

  assert.doesNotMatch(source, /本地保存，可选择任意一个用于生成/);
  assert.match(source, /<Plus size=\{14\} \/> 新增<\/button>/);
  assert.doesNotMatch(source, /<Plus size=\{14\} \/> 新建<\/button>/);
  assert.match(source, /还没有接口，点击“新增”开始配置。/);
});

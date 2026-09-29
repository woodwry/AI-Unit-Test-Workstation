import assert from 'node:assert/strict';
import test from 'node:test';

test('复制模型接口环境变量时写入规范化后的变量名', async () => {
  const clipboardModule = await import('../src/renderer/src/model-settings-clipboard.ts').catch(() => ({}));
  assert.equal(
    typeof clipboardModule.copyModelInterfaceEnvironmentVariable,
    'function',
    '应提供环境变量名复制函数'
  );

  let clipboardText = '';
  const copiedName = await clipboardModule.copyModelInterfaceEnvironmentVariable(
    '  DASHSCOPE_API_KEY  ',
    { writeText: async (text) => { clipboardText = text; } }
  );

  assert.equal(clipboardText, 'DASHSCOPE_API_KEY');
  assert.equal(copiedName, 'DASHSCOPE_API_KEY');
});

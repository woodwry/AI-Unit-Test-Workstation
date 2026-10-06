import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'vite';
import { ModelInterfaceConnectionTestService } from '../../src/main/services/model-interface-connection-test.service';
import { validateModelInterfaceConnectionTestRequest } from '../../src/main/services/workspace-model-ipc-validation';

test.use({ channel: 'msedge', viewport: { width: 1440, height: 960 } });

test('实际模型设置页面测试未保存参数，显示平台错误和本地格式错误', async ({ page }, testInfo) => {
  const calls: Array<{ path?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    calls.push({ path: request.url, body: data });
    const valid = data.thinking && typeof data.thinking === 'object';
    response.writeHead(valid ? 200 : 400, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(valid
      ? { choices: [{ delta: { content: 'OK' } }] }
      : { error: { code: 'invalid_parameter_error', message: "'thinking' must be json_object" } })}\n\n`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    const bridgeRequests: unknown[] = [];
    const service = new ModelInterfaceConnectionTestService();
    await page.exposeBinding('testConnectionBridge', async (_source, raw) => {
      bridgeRequests.push(raw);
      const request = validateModelInterfaceConnectionTestRequest(raw);
      // 已有接口的 Key 留空时，由主进程使用存储的凭证。
      expect(request.interfaceId).toBe('existing');
      expect(request.apiKey).toBeUndefined();
      return service.test({ ...request, apiKey: 'stored-test-key' });
    });
    await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');
    await page.evaluate(baseUrl => {
      (window as any).modelConnectionFixture = { view: {
        schemaVersion: 1, activeInterfaceId: 'existing', activeInterfaceConfigured: true,
        secureStorageAvailable: true, interfaces: [{ id: 'existing', name: '测试平台',
          baseUrl, model: 'configured-model', credentialMode: 'direct', hasStoredApiKey: true,
          requestParameters: { thinking: 'enabled' },
          createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' }]
      } };
    }, `http://127.0.0.1:${port}/v1`);
    const built = await build({ configFile: false, logLevel: 'error',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') }, esbuild: { jsx: 'automatic' },
      build: { write: false, minify: false,
        lib: { entry: resolve('tests/e2e/support/model-connection-test.tsx'),
          formats: ['iife'], name: 'ModelConnectionTestFixture' } }
    });
    const bundle = (Array.isArray(built) ? built[0] : built) as { output: Array<{ type: string; code?: string }> };
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addStyleTag({ path: resolve('src/renderer/src/styles.css') });
    await page.addScriptTag({ content: bundle.output.find(item => item.type === 'chunk')!.code! });
    await page.getByRole('button', { name: '编辑 测试平台', exact: true }).click();
    const testButton = page.getByRole('button', { name: '测试连接', exact: true });
    await testButton.click();
    await expect(page.getByRole('status')).toContainText('thinking 参数必须是 JSON 对象');
    expect(calls[0].path).toBe('/v1/chat/completions');
    expect(calls[0].body.thinking).toBe('enabled');
    await page.screenshot({ path: testInfo.outputPath('invalid-model-parameter.png') });

    // 不保存，修改参数后再测试必须使用当前新值。
    await page.getByLabel('参数值 1', { exact: true }).fill('{"type":"enabled"}');
    await testButton.click();
    await expect(page.getByRole('status')).toHaveText('连接测试成功。');
    expect(calls[1].body.thinking).toEqual({ type: 'enabled' });

    await page.getByLabel('参数值 1', { exact: true }).fill('{broken}');
    await testButton.click();
    await expect(page.getByRole('status')).toHaveText('参数值不是有效 JSON。');
    await expect(page.locator('.model-interface-parameter-error')).toHaveText('参数值不是有效 JSON。');
    expect(bridgeRequests).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

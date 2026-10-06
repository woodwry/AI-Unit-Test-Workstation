import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ModelInterfaceConnectionTestService } from '../src/main/services/model-interface-connection-test.service.ts';

const sse = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const token = { choices: [{ delta: { content: 'OK' } }] };

async function platform(t, handler) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ path: request.url, method: request.method, headers: request.headers,
      body: body ? JSON.parse(body) : null });
    handler(response, calls.at(-1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { calls, request: { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`,
    model: 'configured-model', credentialMode: 'direct', apiKey: 'private-key' } };
}

test('真实调用所选模型并原样发送高级参数，而非只读取模型列表', async t => {
  const { request, calls } = await platform(t, response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse(token));
  });
  const result = await new ModelInterfaceConnectionTestService().test({ ...request,
    requestParameters: { thinking: { type: 'enabled' }, reasoning_effort: 'max', max_tokens: 256000 } });
  assert.equal(result.ok, true);
  assert.equal(calls[0].path, '/v1/chat/completions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer private-key');
  assert.deepEqual(calls[0].body, { model: 'configured-model', stream: true,
    messages: [{ role: 'user', content: 'Reply with OK only.' }],
    thinking: { type: 'enabled' }, reasoning_effort: 'max', max_tokens: 256000 });
});

test('当前平台 HTTP400 SSE 参数错误在连接测试中显示原因', async t => {
  const { request } = await platform(t, response => {
    response.writeHead(400, { 'content-type': 'text/event-stream' });
    response.end(sse({ error: { code: 'invalid_parameter_error',
      type: 'invalid_request_error', message: "'thinking' must be json_object" } }));
  });
  const result = await new ModelInterfaceConnectionTestService().test({ ...request,
    requestParameters: { thinking: 'enabled' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_request');
  assert.match(result.message, /thinking.*JSON 对象/);
});

for (const [status, code] of [[400, 'invalid_request'], [401, 'authentication_failed'],
  [403, 'authentication_failed'], [402, 'quota_exhausted'], [404, 'not_found'],
  [429, 'rate_limited'], [500, 'network_error'], [405, 'unsupported'], [501, 'unsupported']]) {
  test(`HTTP ${status} 不误报成功并分类为 ${code}`, async t => {
    const { request } = await platform(t, response => { response.writeHead(status); response.end('{}'); });
    const result = await new ModelInterfaceConnectionTestService().test(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  });
}

test('HTTP200 JSON error 仍视为失败，未知错误正文不泄露凭证', async t => {
  const { request } = await platform(t, response => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { type: 'invalid_request_error',
      message: 'failure containing private-key and confidential details' } }));
  });
  const result = await new ModelInterfaceConnectionTestService().test(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_request');
  assert.doesNotMatch(result.message, /private-key|confidential/);
});

test('SSE 仅有角色首包，随后额度错误，不能判成功', async t => {
  const { request } = await platform(t, response => {
    response.setHeader('content-type', 'text/event-stream');
    response.write(sse({ choices: [{ delta: { role: 'assistant', content: '' } }] }));
    setTimeout(() => response.end(sse({ error: { code: 'insufficient_quota' } })), 5);
  });
  const result = await new ModelInterfaceConnectionTestService().test(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quota_exhausted');
});

test('跨数据块的 CRLF 流能识别实际推理内容，收到后主动取消长流', async t => {
  let closed = false;
  const { request } = await platform(t, response => {
    response.on('close', () => { closed = true; });
    response.setHeader('content-type', 'text/event-stream');
    response.write(': keep-alive\r\n\r\ndata: {"choices":[{"delta":{"reasoning_content":"');
    setTimeout(() => response.write('Thinking"}}]}\r'), 5);
    setTimeout(() => response.write('\n\r\n'), 10);
  });
  const result = await new ModelInterfaceConnectionTestService().test(request);
  assert.equal(result.ok, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, true);
});

for (const [label, body, type] of [
  ['空 JSON', '{}', 'application/json'],
  ['HTML', '<html>login</html>', 'text/html'],
  ['仅角色和结束标记', sse({ choices: [{ delta: { role: 'assistant' } }] }) + 'data: [DONE]\n\n', 'text/event-stream']
]) {
  test(`${label} 不应判定模型可用`, async t => {
    const { request } = await platform(t, response => {
      response.setHeader('content-type', type); response.end(body);
    });
    const result = await new ModelInterfaceConnectionTestService().test(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_response');
  });
}

test('平台忽略 stream 返回完整 JSON 时检查实际内容', async t => {
  const { request, calls } = await platform(t, response => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  const result = await new ModelInterfaceConnectionTestService({ TEST_MODEL_KEY: 'environment-key' }).test({
    ...request, credentialMode: 'environment', environmentVariableName: 'TEST_MODEL_KEY', apiKey: undefined });
  assert.equal(result.ok, true);
  assert.equal(calls[0].headers.authorization, 'Bearer environment-key');
  assert.equal(calls[0].body.max_tokens, 16);
});

test('保护字段不能通过高级参数覆盖，缺少凭证时也不请求平台', async t => {
  const { request, calls } = await platform(t, response => response.end(sse(token)));
  const service = new ModelInterfaceConnectionTestService();
  for (const field of ['model', 'messages', 'stream', 'authorization']) {
    const result = await service.test({ ...request, requestParameters: { [field]: 'override' } });
    assert.equal(result.code, 'invalid_configuration');
  }
  assert.equal((await service.test({ ...request, apiKey: '' })).code, 'invalid_configuration');
  assert.equal(calls.length, 0);
});

test('超时包含等响应正文的阶段，断开挂起流', async t => {
  const { request } = await platform(t, response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': waiting\n\n');
  });
  const result = await new ModelInterfaceConnectionTestService({}, 80).test(request);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timeout');
});

test('异常大的响应被限制，不无限读取', async t => {
  const { request } = await platform(t, response => {
    response.setHeader('content-type', 'application/json');
    response.end(' '.repeat(65 * 1024));
  });
  assert.equal((await new ModelInterfaceConnectionTestService().test(request)).code, 'invalid_response');
});

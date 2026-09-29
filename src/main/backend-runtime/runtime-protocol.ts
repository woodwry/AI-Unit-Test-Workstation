import type { RuntimeServiceId } from './release-contract.ts';

export type RuntimeHandshake = Readonly<{
  protocol: 1;
  service: RuntimeServiceId;
  instanceId: string;
  pid: number;
  host: '127.0.0.1';
  port: number;
}>;

export type RuntimeHandshakeExpectation = Readonly<{
  service: RuntimeServiceId;
  instanceId: string;
  pid: number;
}>;

export type RuntimeStatus = 'live' | 'ready' | 'not_ready';

export type RuntimeStatusResponse = Readonly<{
  protocol: 1;
  service: RuntimeServiceId;
  instanceId: string;
  status: RuntimeStatus;
}>;

export type RuntimeStatusExpectation = Readonly<{
  service: RuntimeServiceId;
  instanceId: string;
  endpoint: 'live' | 'ready';
}>;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDSHAKE_KEYS = ['host', 'instanceId', 'pid', 'port', 'protocol', 'service'] as const;
const STATUS_KEYS = ['instanceId', 'protocol', 'service', 'status'] as const;
const MAX_HANDSHAKE_LINE_LENGTH = 4096;

function protocolError(scope: '握手' | '状态响应', field: string): never {
  // 错误信息只指出字段，不拼接子进程原始输出，避免意外回显敏感内容。
  throw new TypeError(`运行时${scope}无效：${field}`);
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  scope: '握手' | '状态响应'
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return protocolError(scope, '结构');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return protocolError(scope, '字段集合');
  }

  // 拒绝 getter/setter，确保校验过程只读取普通 JSON 数据属性。
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor) || !descriptor.enumerable)) {
    return protocolError(scope, '字段描述符');
  }
  return record;
}

function assertExpectedInstance(instanceId: string, scope: '握手' | '状态响应'): void {
  if (!UUID_V4_PATTERN.test(instanceId)) {
    protocolError(scope, '预期 instanceId');
  }
}

function assertCommonFields(
  record: Record<string, unknown>,
  expectation: Pick<RuntimeStatusExpectation, 'service' | 'instanceId'>,
  scope: '握手' | '状态响应'
): void {
  assertExpectedInstance(expectation.instanceId, scope);
  if (record.protocol !== 1) protocolError(scope, 'protocol');
  if (record.service !== expectation.service) protocolError(scope, 'service');
  if (record.instanceId !== expectation.instanceId || !UUID_V4_PATTERN.test(record.instanceId as string)) {
    protocolError(scope, 'instanceId');
  }
}

/**
 * 校验子进程 stdout 中已经完成 JSON 解析的握手对象。
 * 返回值只包含协议规定的六个字段，不保留调用方对象引用。
 */
export function parseRuntimeHandshake(
  value: unknown,
  expectation: RuntimeHandshakeExpectation
): RuntimeHandshake {
  if (!Number.isSafeInteger(expectation.pid) || expectation.pid <= 0) {
    protocolError('握手', '预期 pid');
  }
  const record = exactRecord(value, HANDSHAKE_KEYS, '握手');
  assertCommonFields(record, expectation, '握手');
  if (record.pid !== expectation.pid) protocolError('握手', 'pid');
  if (record.host !== '127.0.0.1') protocolError('握手', 'host');
  if (!Number.isSafeInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535) {
    protocolError('握手', 'port');
  }

  return Object.freeze({
    protocol: 1,
    service: expectation.service,
    instanceId: expectation.instanceId,
    pid: expectation.pid,
    host: '127.0.0.1',
    port: Number(record.port)
  });
}

/** 解析并校验 stdout 单行握手；JSON 解析错误不会回显原始行。 */
export function parseRuntimeHandshakeLine(
  line: string,
  expectation: RuntimeHandshakeExpectation
): RuntimeHandshake {
  if (
    typeof line !== 'string' ||
    line.length === 0 ||
    line.length > MAX_HANDSHAKE_LINE_LENGTH ||
    line.trim() !== line ||
    /[\r\n\u0000]/.test(line)
  ) {
    protocolError('握手', 'stdout 行');
  }

  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    protocolError('握手', 'JSON');
  }
  return parseRuntimeHandshake(value, expectation);
}

/**
 * 校验内部 live/ready 接口的固定响应。ready 端点只接受 ready/not_ready，
 * live 端点只接受 live，HTTP 200/503 的对应关系由请求层继续校验。
 */
export function parseRuntimeStatusResponse(
  value: unknown,
  expectation: RuntimeStatusExpectation
): RuntimeStatusResponse {
  const record = exactRecord(value, STATUS_KEYS, '状态响应');
  assertCommonFields(record, expectation, '状态响应');
  const allowedStatuses: readonly RuntimeStatus[] = expectation.endpoint === 'live'
    ? ['live']
    : ['ready', 'not_ready'];
  if (typeof record.status !== 'string' || !allowedStatuses.includes(record.status as RuntimeStatus)) {
    protocolError('状态响应', 'status');
  }

  return Object.freeze({
    protocol: 1,
    service: expectation.service,
    instanceId: expectation.instanceId,
    status: record.status as RuntimeStatus
  });
}

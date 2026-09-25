const SAFE_ERROR_NAMES = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError'
])

export type SafeRendererErrorFingerprint =
  | 'DUPLICATE_REGISTRATION'
  | 'INVALID_URL'
  | 'BROWSER_EXTERNAL'
  | 'CHUNK_LOAD'
  | 'CSP'
  | 'UNKNOWN'

const MAX_CLASSIFIED_MESSAGE_LENGTH = 2048

const SAFE_ERROR_FINGERPRINT_RULES: ReadonlyArray<Readonly<{
  fingerprint: Exclude<SafeRendererErrorFingerprint, 'UNKNOWN'>
  patterns: readonly RegExp[]
}>> = [
  {
    fingerprint: 'DUPLICATE_REGISTRATION',
    patterns: [
      /cannot register two commands with the same id/i,
      /another version of monaco-vscode-api has already been loaded/i,
      /services are already initialized/i,
      /\balready (?:been )?(?:loaded|registered|initialized)\b/i,
      /\bduplicate (?:command|module|property|registration|service|view)\b/i
    ]
  },
  {
    fingerprint: 'BROWSER_EXTERNAL',
    patterns: [
      /externalized for browser compatibility/i,
      /__vite-browser-external/i,
      /node:fs\/promises.*(?:does not provide|not supported|unavailable)/i,
      /\breadFile is not a function\b/i
    ]
  },
  {
    fingerprint: 'INVALID_URL',
    patterns: [
      /\bERR_INVALID_URL\b/i,
      /\binvalid url\b/i,
      /failed to construct ['"]?URL/i,
      /invalid (?:module |resource )?url/i
    ]
  },
  {
    fingerprint: 'CSP',
    patterns: [
      /content security policy/i,
      /violates the following content security policy/i,
      /refused to (?:connect|execute|load).*because.*policy/i,
      /\bunsafe-eval\b/i
    ]
  },
  {
    fingerprint: 'CHUNK_LOAD',
    patterns: [
      /failed to fetch dynamically imported module/i,
      /error loading dynamically imported module/i,
      /importing a module script failed/i,
      /failed to load module script/i,
      /unable to preload css/i,
      /\bChunkLoadError\b/i,
      /loading chunk .* failed/i,
      /\bERR_FILE_NOT_FOUND\b/i
    ]
  }
]

export function getSafeRendererErrorType(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error
    // 只允许稳定名称通过，绝不读取或拼接 message、stack 等敏感字段。
    const name = error.name
    return SAFE_ERROR_NAMES.has(name) ? name : 'Error'
  } catch {
    return 'Error'
  }
}

export function getSafeRendererErrorFingerprint(error: unknown): SafeRendererErrorFingerprint {
  try {
    if (!(error instanceof Error)) return 'UNKNOWN'

    // message 只在 renderer 内存中参与固定规则匹配，绝不返回或写入日志。
    const rawMessage = error.message
    const message = typeof rawMessage === 'string'
      ? rawMessage.slice(0, MAX_CLASSIFIED_MESSAGE_LENGTH)
      : ''
    for (const rule of SAFE_ERROR_FINGERPRINT_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(message))) {
        return rule.fingerprint
      }
    }
  } catch {
    // 自定义 Error getter 可能抛错；诊断必须退化为固定值，不能泄露原始对象。
  }
  return 'UNKNOWN'
}

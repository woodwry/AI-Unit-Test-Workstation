import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MonacoDecorationIdStore,
  updateOpenFileContentByPath
} from '../src/renderer/src/monaco-editor-document-state.ts'
import {
  getSafeRendererErrorFingerprint,
  getSafeRendererErrorType
} from '../src/renderer/src/renderer-safe-error.ts'


test('local decoration replacement returns the previous IDs', () => {
  const store = new MonacoDecorationIdStore()
  const key = 'd:\\workspace\\app.ts'

  assert.deepEqual(store.replace(key, ['local-1']), [])
  assert.deepEqual(store.replace(key, ['local-2', 'local-3']), ['local-1'])
  assert.deepEqual(store.replace(key, []), ['local-2', 'local-3'])
})

test('decoration release removes only one URI and clear returns everything else', () => {
  const store = new MonacoDecorationIdStore()
  const firstKey = 'd:\\workspace\\first.ts'
  const secondKey = 'd:\\workspace\\second.ts'

  store.replace(firstKey, ['first-local'])
  store.replace(secondKey, ['second-local'])

  assert.deepEqual(store.release(firstKey), ['first-local'])
  assert.deepEqual(store.release(firstKey), [])
  assert.deepEqual(store.clear(), [{ canonicalKey: secondKey, ids: ['second-local'] }])
  assert.deepEqual(store.clear(), [])
})

test('a late content event updates its own path without changing the active file', () => {
  const firstFile = { path: 'D:\\workspace\\a.ts', content: 'old A', active: false }
  const activeFile = { path: 'D:\\workspace\\b.ts', content: 'B', active: true }
  const files = [firstFile, activeFile]

  const updated = updateOpenFileContentByPath(files, firstFile.path, 'new A')

  assert.notStrictEqual(updated, files)
  assert.deepEqual(updated[0], { path: firstFile.path, content: 'new A', active: false })
  assert.strictEqual(updated[1], activeFile)
  assert.strictEqual(
    updateOpenFileContentByPath(updated, 'D:\\workspace\\missing.ts', 'ignored'),
    updated
  )
  assert.strictEqual(updateOpenFileContentByPath(updated, firstFile.path, 'new A'), updated)
})

test('renderer error classification never exposes messages, stacks, URIs, content, or credentials', () => {
  const secret = 'sk-proj-FAKE_API_KEY_SENTINEL'
  const fileUri = 'file:///D:/private/customer.ts'
  const fileContent = 'PRIVATE_FILE_CONTENT_SENTINEL'
  const sensitiveText = `${secret} ${fileUri} ${fileContent}`
  const error = new TypeError(sensitiveText)
  error.stack = `TypeError: ${sensitiveText}\n    at ${fileUri}:1:1`

  assert.equal(getSafeRendererErrorType(error), 'TypeError')
  assert.equal(getSafeRendererErrorFingerprint(error), 'UNKNOWN')

  const fingerprintCases = [
    [new Error(`Cannot register two commands with the same id: ${sensitiveText}`), 'DUPLICATE_REGISTRATION'],
    [new Error(`Module node:fs/promises has been externalized for browser compatibility: ${sensitiveText}`), 'BROWSER_EXTERNAL'],
    [new TypeError(`Failed to construct URL for ${fileUri}: Invalid URL`), 'INVALID_URL'],
    [new TypeError(`Failed to fetch dynamically imported module: ${fileUri}`), 'CHUNK_LOAD'],
    [new EvalError(`Refused to execute because of Content Security Policy: ${sensitiveText}`), 'CSP']
  ]
  for (const [classifiedError, expectedFingerprint] of fingerprintCases) {
    const fingerprint = getSafeRendererErrorFingerprint(classifiedError)
    assert.equal(fingerprint, expectedFingerprint)
    assert.equal(fingerprint.includes(secret), false)
    assert.equal(fingerprint.includes(fileUri), false)
    assert.equal(fingerprint.includes(fileContent), false)
  }

  let nameReads = 0
  const changingNameError = new Error(sensitiveText)
  Object.defineProperty(changingNameError, 'name', {
    get() {
      nameReads += 1
      return nameReads === 1 ? 'TypeError' : sensitiveText
    }
  })
  const changingNameResult = getSafeRendererErrorType(changingNameError)
  assert.equal(changingNameResult, 'TypeError')
  assert.equal(nameReads, 1)

  const disguisedError = new Error(sensitiveText)
  disguisedError.name = `Custom-${sensitiveText}`
  assert.equal(getSafeRendererErrorType(disguisedError), 'Error')

  const throwingMessageError = new Error('placeholder')
  Object.defineProperty(throwingMessageError, 'message', {
    get() {
      throw new Error(sensitiveText)
    }
  })
  assert.equal(getSafeRendererErrorFingerprint(throwingMessageError), 'UNKNOWN')

  const allowedNonErrorTypes = new Set([
    'undefined',
    'object',
    'boolean',
    'number',
    'bigint',
    'string',
    'symbol',
    'function'
  ])
  const nonErrors = [
    undefined,
    null,
    true,
    42,
    42n,
    sensitiveText,
    Symbol(sensitiveText),
    () => sensitiveText,
    { name: 'TypeError', message: sensitiveText }
  ]

  for (const value of nonErrors) {
    const result = getSafeRendererErrorType(value)
    assert.equal(allowedNonErrorTypes.has(result), true)
    assert.equal(result.includes(secret), false)
    assert.equal(result.includes(fileUri), false)
    assert.equal(result.includes(fileContent), false)
    assert.equal(getSafeRendererErrorFingerprint(value), 'UNKNOWN')
  }
})

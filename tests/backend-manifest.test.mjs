import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseBackendManifest } from '../src/main/backend-runtime/backend-manifest.ts';

const schemaUrl = new URL('../packaging/windows/backend-manifest.schema.json', import.meta.url);

function file(path, hashCharacter, size = 10) {
  return { path, size, sha256: hashCharacter.repeat(64) };
}

function validManifest() {
  const agentService = file('backend/agent-service/agent-service.exe', 'a', 101);
  const javaAnalyzer = file('backend/java-analyzer/java-analyzer.jar', 'b', 102);
  const javaRuntime = file('runtimes/java-21/bin/javaw.exe', 'c', 103);
  return {
    schemaVersion: 1,
    product: { version: '0.1.0', platform: 'win32', arch: 'x64' },
    javaRuntime: {
      distribution: 'Eclipse Temurin',
      vendor: 'Eclipse Adoptium',
      version: '21.0.11+10',
      architecture: 'x86_64'
    },
    components: {
      agentService: { version: '0.1.0' },
      javaAnalyzer: { version: '0.1.0' }
    },
    entrypoints: { agentService, javaAnalyzer, javaRuntime },
    files: [
      file('.ai-unit-test-managed-stage', 'd'),
      agentService,
      javaAnalyzer,
      file('licenses/THIRD_PARTY_NOTICES_ZH.txt', 'e'),
      javaRuntime,
      file('runtimes/java-21/legal/java.base/LICENSE', 'f')
    ]
  };
}

test('parses a deterministic Windows x64 backend manifest', () => {
  const parsed = parseBackendManifest(validManifest());
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.javaRuntime, {
    distribution: 'Eclipse Temurin',
    vendor: 'Eclipse Adoptium',
    version: '21.0.11+10',
    architecture: 'x86_64'
  });
  assert.equal(parsed.entrypoints.agentService.sha256, 'a'.repeat(64));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.files), true);
});

test('rejects unsafe, non-canonical and Windows-ambiguous relative paths', () => {
  for (const unsafePath of [
    '../outside.exe',
    'backend/../outside.exe',
    '/absolute.exe',
    'C:/absolute.exe',
    'C:drive-relative.exe',
    'backend\\agent-service.exe',
    'backend//agent-service.exe',
    'backend/./agent-service.exe'
  ]) {
    const manifest = validManifest();
    manifest.files[3].path = unsafePath;
    assert.throws(() => parseBackendManifest(manifest), /后端资源清单无效/);
  }

  const caseCollision = validManifest();
  caseCollision.files.splice(3, 0, file('BACKEND/agent-service/agent-service.exe', '1'));
  caseCollision.files.sort((left, right) => left.path < right.path ? -1 : 1);
  assert.throws(() => parseBackendManifest(caseCollision), /Windows 路径重复/);
});

test('requires files to be sorted with unique paths', () => {
  const unsorted = validManifest();
  [unsorted.files[1], unsorted.files[2]] = [unsorted.files[2], unsorted.files[1]];
  assert.throws(() => parseBackendManifest(unsorted), /排序或重复/);

  const duplicate = validManifest();
  duplicate.files.splice(2, 0, structuredClone(duplicate.files[1]));
  assert.throws(() => parseBackendManifest(duplicate), /排序或重复/);
});

test('rejects invalid versions, sizes and SHA-256 values', () => {
  const invalidVersion = validManifest();
  invalidVersion.product.version = '0.1';
  assert.throws(() => parseBackendManifest(invalidVersion), /product.version/);

  const invalidSize = validManifest();
  invalidSize.files[3].size = -1;
  assert.throws(() => parseBackendManifest(invalidSize), /size/);

  const invalidHash = validManifest();
  invalidHash.files[3].sha256 = 'A'.repeat(64);
  assert.throws(() => parseBackendManifest(invalidHash), /sha256/);
});

test('requires each entrypoint size and hash to match the files list', () => {
  const manifest = validManifest();
  manifest.entrypoints.agentService = {
    ...manifest.entrypoints.agentService,
    sha256: '9'.repeat(64)
  };
  assert.throws(() => parseBackendManifest(manifest), /entrypoints 与 files 不一致/);
});

test('rejects extra fields and manifest self-reference without echoing values', () => {
  const extra = validManifest();
  extra.environment = { AI_UNIT_TEST_ACCESS_TOKEN: 'secret-marker' };
  assert.throws(
    () => parseBackendManifest(extra),
    (error) => {
      assert.doesNotMatch(error.message, /secret-marker/);
      return true;
    }
  );

  const selfReference = validManifest();
  // 保持文件列表仍按序排列，让该用例只验证清单禁止引用自身。
  selfReference.files.splice(1, 0, file('backend-manifest.json', '0'));
  assert.throws(() => parseBackendManifest(selfReference), /自引用/);
});

test('publishes a strict schema with the pinned Temurin identity', async () => {
  const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.javaRuntime.properties.distribution.const, 'Eclipse Temurin');
  assert.equal(schema.properties.javaRuntime.properties.vendor.const, 'Eclipse Adoptium');
  assert.equal(schema.properties.javaRuntime.properties.version.const, '21.0.11+10');
  assert.equal(schema.properties.javaRuntime.properties.architecture.const, 'x86_64');
  assert.equal(schema.$defs.file.additionalProperties, false);
});

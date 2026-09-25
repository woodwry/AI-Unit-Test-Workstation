import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainSource = await readFile(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
);

test('unpackaged development uses configured IDE services instead of a staged backend jar', () => {
  assert.doesNotMatch(
    mainSource,
    /import\s*\{\s*DevelopmentBackendRuntime\s*\}/
  );
  assert.match(
    mainSource,
    /if\s*\(!app\.isPackaged\s*&&\s*!e2eRuntime\)\s*\{[\s\S]*?managedBackendRuntime\s*=\s*null;[\s\S]*?return;/
  );
  assert.match(
    mainSource,
    /await\s+readBackendSettings\(\)[\s\S]*?aiClient\.setBackendSettings/
  );
  assert.match(
    mainSource,
    /assertBackendReady:\s*app\.isPackaged\s*&&\s*!isRemoteBackendMode\(\)\s*&&\s*!isExternalBackendClientMode\(\)[\s\S]*?\?\s*assertManagedBackendRuntimeReady[\s\S]*?:\s*undefined/
  );
});

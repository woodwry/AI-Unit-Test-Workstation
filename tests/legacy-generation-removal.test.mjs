import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function listProductionSources(root) {
  const sources = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await listProductionSources(path));
    } else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      sources.push({ path, text: await readFile(path, 'utf8') });
    }
  }
  return sources;
}

test('production generation wiring contains no access-category or scoring loop', async () => {
  const sources = await listProductionSources('src');
  const forbidden = [
    /MethodPriorityService/u,
    /fixedScoreBaselines/u,
    /ACCESS_CATEGORIES/u,
    /PUBLIC.*PACKAGE_PRIVATE.*PROTECTED.*PRIVATE/su
  ];
  const violations = sources.flatMap((source) => forbidden
    .filter((pattern) => pattern.test(source.text))
    .map((pattern) => `${pattern.source}: ${source.path}`));

  assert.deepEqual(violations, []);
});

test('main has no single global active generation session', async () => {
  const main = await readFile('src/main/index.ts', 'utf8');

  assert.equal(/activeGenerationSession|generationSessionSnapshot/u.test(main), false);
  assert.match(main, /ClassTaskRuntimeService/u);
});

test('only class-task IPC is exposed for unit-test generation', async () => {
  const [main, preload, types] = await Promise.all([
    readFile('src/main/index.ts', 'utf8'),
    readFile('src/preload/index.ts', 'utf8'),
    readFile('src/shared/types.ts', 'utf8')
  ]);

  for (const source of [main, preload, types]) {
    assert.doesNotMatch(source, /generation:(?:start|stop|accept|revoke|snapshot|target|progress)/u);
    assert.doesNotMatch(source, /GenerationSessionSnapshot|StartGenerationSessionRequest/u);
  }
  assert.match(preload, /CLASS_TASK_CHANNELS\.run/u);
  assert.match(types, /ClassTaskAppApi/u);
});

test('backend client contains no legacy multi-method generation route', async () => {
  const client = await readFile('src/main/services/ai-client.ts', 'utf8');

  assert.doesNotMatch(client, /\/api\/unit-tests\/generation-sessions/u);
  assert.match(client, /\/api\/unit-tests\/method-generation-sessions/u);
});

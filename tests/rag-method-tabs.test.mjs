import assert from 'node:assert/strict';
import test from 'node:test';
import * as tabs from '../src/renderer/src/class-tasks/workbench-tab-state.ts';

test('method source tabs deduplicate by exact knowledge identity and deletion preserves other tabs', () => {
  let state = tabs.createEmptyWorkbenchTabs();
  const first = { entryId: 'entry', methodId: 'method-1', ownerFqn: 'a.Target', methodName: 'run', canonicalSignature: 'run(int)' };
  const second = { ...first, methodId: 'method-2', canonicalSignature: 'run(String)' };
  state = tabs.openRagMethodTab(state, first);
  state = tabs.openRagMethodTab(state, second);
  state = tabs.openRagMethodTab(state, first);
  assert.equal(state.items.length, 2);
  assert.equal(state.items.find(item => item.id === state.activeId).methodId, 'method-1');
  state = tabs.closeRagMethodTabs(state, { entryId: 'entry', methodId: 'method-1' });
  assert.deepEqual(state.items.map(item => item.methodId), ['method-2']);
  assert.equal(state.activeId, state.items[0].id);
  state = tabs.closeRagMethodTabs(state, { entryId: 'entry' });
  assert.equal(state.items.length, 0);
  assert.equal(state.activeId, null);
});

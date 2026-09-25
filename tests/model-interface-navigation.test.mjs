import test from 'node:test';
import assert from 'node:assert/strict';

const navigation = await import('../src/renderer/src/model-interface-form-state.ts').catch(() => ({}));

test('dirty model interface editor requests an in-app discard confirmation', () => {
  assert.equal(
    typeof navigation.resolveModelInterfaceBackAction,
    'function',
    'model interface back navigation must expose an explicit decision'
  );
  assert.equal(navigation.resolveModelInterfaceBackAction(true), 'confirm-discard');
});

test('clean model interface editor returns to the list immediately', () => {
  assert.equal(
    typeof navigation.resolveModelInterfaceBackAction,
    'function',
    'model interface back navigation must expose an explicit decision'
  );
  assert.equal(navigation.resolveModelInterfaceBackAction(false), 'return-to-list');
});

test('new model interface editor saves through the create channel', () => {
  assert.equal(
    typeof navigation.resolveModelInterfaceSaveMode,
    'function',
    'model interface persistence mode must distinguish the new-editor sentinel'
  );
  assert.equal(navigation.resolveModelInterfaceSaveMode('new'), 'create');
});

test('existing model interface editor saves through the update channel', () => {
  assert.equal(
    typeof navigation.resolveModelInterfaceSaveMode,
    'function',
    'model interface persistence mode must distinguish persisted IDs'
  );
  assert.equal(navigation.resolveModelInterfaceSaveMode('11111111-1111-4111-8111-111111111111'), 'update');
});

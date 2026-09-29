import test from 'node:test';
import assert from 'node:assert/strict';

const editorState = await import('../src/renderer/src/model-interface-form-state.ts').catch(() => ({}));

const directDraft = {
  name: 'Old',
  baseUrl: 'https://models.example.test/v1',
  model: 'old-model',
  credentialMode: 'direct',
  environmentVariableName: '',
  apiKey: 'secret'
};

test('changing model interface form data clears stale save and connection errors', () => {
  assert.equal(
    typeof editorState.reduceModelInterfaceEditorState,
    'function',
    'model interface editor must centralize transient message cleanup'
  );
  const changedDraft = { ...directDraft, model: 'new-model' };
  const next = editorState.reduceModelInterfaceEditorState(
    {
      draft: directDraft,
      feedback: 'old save error',
      connectionResult: { ok: false, code: 'invalid_configuration', message: 'old connection error' }
    },
    { type: 'draft-changed', draft: changedDraft }
  );
  assert.deepEqual(next, { draft: changedDraft, feedback: '', connectionResult: null });
});

test('successful save does not leave a persistent message on the interface list', () => {
  assert.equal(
    typeof editorState.reduceModelInterfaceEditorState,
    'function',
    'model interface editor must centralize save completion state'
  );
  const next = editorState.reduceModelInterfaceEditorState(
    {
      draft: directDraft,
      feedback: 'old feedback',
      connectionResult: { ok: true, code: 'success', message: 'old connection result' }
    },
    { type: 'save-succeeded' }
  );
  assert.deepEqual(next, { draft: directDraft, feedback: '', connectionResult: null });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { MonacoEditorSession } from '../src/renderer/src/monaco-editor-session.ts';

function isMonacoStageFailure(stage, causeMessage) {
  return (error) =>
    error?.stage === stage &&
    error.cause instanceof Error &&
    causeMessage.test(error.cause.message);
}

function makeMonacoHarness() {
  const calls = [];
  const models = [];
  const editors = [];
  const failures = new Map();
  const contentListeners = new Map();
  let nextListenerId = 1;

  function maybeFail(operationName) {
    const remaining = failures.get(operationName) ?? 0;
    if (remaining === 0) return;
    failures.delete(operationName);
    calls.push({ op: `${operationName}.failure` });
    throw new Error(`Injected failure: ${operationName}`);
  }

  function encodePath(path) {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
      .join('/');
  }

  class FakeUri {
    constructor(scheme, authority, path, fsPath = path) {
      this.scheme = scheme;
      this.authority = authority;
      this.path = path;
      this.fsPath = fsPath;
    }

    static file(rawPath) {
      maybeFail('Uri.file');
      calls.push({ op: 'Uri.file', path: rawPath });
      const slashPath = rawPath.replaceAll('\\', '/');
      if (slashPath.startsWith('//')) {
        const [authority = '', ...parts] = slashPath.slice(2).split('/');
        const path = `/${parts.join('/')}`;
        return new FakeUri('file', authority, path, `\\\\${authority}\\${parts.join('\\')}`);
      }
      const path = /^[A-Za-z]:\//.test(slashPath) ? `/${slashPath}` : slashPath;
      return new FakeUri('file', '', path, rawPath);
    }

    static parse(value) {
      maybeFail('Uri.parse');
      calls.push({ op: 'Uri.parse', value });
      const match = /^([A-Za-z][A-Za-z\d+.-]*):\/\/([^/]*)(\/.*)$/.exec(value);
      if (!match) throw new Error(`Malformed URI: ${value}`);
      const path = decodeURIComponent(match[3]);
      const authority = decodeURIComponent(match[2]);
      return new FakeUri(match[1], authority, path, path);
    }

    with(changes) {
      return new FakeUri(
        changes.scheme ?? this.scheme,
        changes.authority ?? this.authority,
        changes.path ?? this.path,
        changes.path ?? this.fsPath
      );
    }

    toString() {
      return `${this.scheme}://${encodeURIComponent(this.authority)}${encodePath(this.path)}`;
    }
  }

  function makeDisposable(operationName, onDispose = () => {}) {
    let disposed = false;
    return {
      dispose() {
        calls.push({ op: `${operationName}.dispose` });
        maybeFail(`${operationName}.dispose`);
        if (disposed) return;
        disposed = true;
        onDispose();
      },
      get disposed() {
        return disposed;
      }
    };
  }

  function createFakeModel(value, language, uri) {
    let currentValue = value;
    let versionId = 1;
    let disposed = false;
    const modelContentListeners = [];
    const willDisposeListeners = [];

    const model = {
      uri,
      language,
      setValue() {
        throw new Error('model.setValue is forbidden');
      },
      getValue() {
        return currentValue;
      },
      getVersionId() {
        return versionId;
      },
      getFullModelRange() {
        return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: currentValue.length + 1 };
      },
      onDidChangeContent(listener) {
        maybeFail('model.onDidChangeContent');
        const id = nextListenerId++;
        const entry = { id, listener, disposed: false, model };
        modelContentListeners.push(entry);
        contentListeners.set(id, entry);
        calls.push({ op: 'model.onDidChangeContent', uri: uri.toString(), listenerId: id });
        return makeDisposable('contentListener', () => {
          entry.disposed = true;
        });
      },
      onWillDispose(listener) {
        maybeFail('model.onWillDispose');
        const entry = { listener, disposed: false };
        willDisposeListeners.push(entry);
        calls.push({ op: 'model.onWillDispose', uri: uri.toString() });
        return makeDisposable('modelDisposeListener', () => {
          entry.disposed = true;
        });
      },
      isDisposed() {
        return disposed;
      },
      dispose() {
        calls.push({ op: 'model.dispose', uri: uri.toString() });
        maybeFail('model.dispose');
        if (disposed) return;
        for (const entry of [...willDisposeListeners]) {
          if (!entry.disposed) entry.listener();
        }
        disposed = true;
      },
      _replaceValue(nextValue) {
        currentValue = nextValue;
        versionId += 1;
        for (const entry of [...modelContentListeners]) {
          if (!entry.disposed) entry.listener({ changes: [] });
        }
      }
    };
    models.push(model);
    return model;
  }

  const editorApi = {
    create(host, options) {
      maybeFail('editor.create');
      calls.push({ op: 'editor.create', host, options });
      let currentModel = options.model ?? null;
      let disposed = false;
      const editor = {
        viewState: null,
        setValue() {
          throw new Error('editor.setValue is forbidden');
        },
        updateOptions(optionsToApply) {
          maybeFail('editor.updateOptions');
          calls.push({ op: 'editor.updateOptions', options: optionsToApply });
        },
        getModel() {
          return currentModel;
        },
        setModel(model) {
          maybeFail(model === null ? 'editor.setModel:null' : 'editor.setModel:model');
          maybeFail('editor.setModel');
          calls.push({ op: 'editor.setModel', model });
          currentModel = model;
        },
        saveViewState() {
          maybeFail('editor.saveViewState');
          calls.push({ op: 'editor.saveViewState', model: currentModel, viewState: editor.viewState });
          return editor.viewState;
        },
        restoreViewState(viewState) {
          maybeFail('editor.restoreViewState');
          calls.push({ op: 'editor.restoreViewState', model: currentModel, viewState });
          editor.viewState = viewState;
        },
        pushUndoStop() {
          maybeFail('editor.pushUndoStop');
          calls.push({ op: 'editor.pushUndoStop', model: currentModel });
          return true;
        },
        executeEdits(source, edits) {
          maybeFail('editor.executeEdits');
          calls.push({ op: 'editor.executeEdits', source, edits, model: currentModel });
          if (currentModel === null) return false;
          currentModel._replaceValue(edits.at(-1)?.text ?? '');
          return true;
        },
        dispose() {
          calls.push({ op: 'editor.dispose' });
          maybeFail('editor.dispose');
          disposed = true;
        },
        isDisposed() {
          return disposed;
        }
      };
      editors.push(editor);
      return editor;
    },
    createModel(value, language, uri) {
      maybeFail('editor.createModel');
      calls.push({ op: 'editor.createModel', value, language, uri: uri.toString() });
      return createFakeModel(value, language, uri);
    },
    getModel(uri) {
      maybeFail('editor.getModel');
      calls.push({ op: 'editor.getModel', uri: uri.toString() });
      // Monaco/adapter 可能短暂返回 stale exact candidate；session 必须自行检查 isDisposed()。
      return models.find((model) => model.uri.toString() === uri.toString()) ?? null;
    },
    getModels() {
      maybeFail('editor.getModels');
      calls.push({ op: 'editor.getModels' });
      return models.filter((model) => !model.isDisposed());
    },
    setModelLanguage(model, language) {
      maybeFail('editor.setModelLanguage');
      calls.push({ op: 'editor.setModelLanguage', model, language });
      model.language = language;
    },
    setTheme(theme) {
      maybeFail('editor.setTheme');
      calls.push({ op: 'editor.setTheme', theme });
    },
    defineTheme(themeName, data) {
      maybeFail('editor.defineTheme');
      calls.push({ op: 'editor.defineTheme', themeName, data });
    },
    setModelMarkers(model, owner, markers) {
      maybeFail('editor.setModelMarkers');
      calls.push({ op: 'editor.setModelMarkers', model, owner, markers });
    }
  };

  const monaco = {
    Uri: FakeUri,
    Range: class FakeRange {},
    MarkerSeverity: { Error: 8, Warning: 4 },
    editor: editorApi
  };

  return {
    monaco,
    host: { id: 'host' },
    calls,
    models,
    editors,
    emitUserEdit(model, value) {
      model._replaceValue(value);
    },
    emitLateContentEvent(listenerId) {
      const entry = contentListeners.get(listenerId);
      assert.ok(entry, `Unknown listener ${listenerId}`);
      calls.push({ op: 'lateContentEvent', listenerId });
      entry.listener({ changes: [] });
    },
    setNextFailure(operationName) {
      failures.set(operationName, 1);
    }
  };
}

function desired(overrides = {}) {
  return {
    activeDocument: null,
    openFilePaths: [],
    options: {},
    theme: 'vs-dark',
    onError(error) {
      throw error;
    },
    onDidChangeContent() {},
    ...overrides
  };
}

function operationNames(calls) {
  return calls.map((call) => call.op);
}

test('latest desired state is the only snapshot applied during first attach', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const lifecycle = [];

  session.updateDesiredState(
    desired({
      activeDocument: { path: 'D:\\Demo\\A.java', value: 'class A {}', language: 'java' },
      openFilePaths: ['D:\\Demo\\A.java'],
      options: { fontSize: 12 },
      theme: 'first-theme'
    })
  );
  session.updateDesiredState(
    desired({
      activeDocument: { path: 'D:\\Demo\\B.java', value: 'class B {}', language: 'java' },
      openFilePaths: ['D:\\Demo\\B.java'],
      options: { fontSize: 16 },
      theme: 'second-theme',
      onDidAttach() {
        lifecycle.push('onDidAttach');
        harness.calls.push({ op: 'app.onDidAttach' });
      },
      onDidChangeModel(event) {
        lifecycle.push(event.kind);
        harness.calls.push({ op: `app.${event.kind}`, event });
      }
    })
  );

  const editor = session.attachEditor(harness.monaco, harness.host);

  assert.equal(editor, harness.editors[0]);
  assert.equal(harness.models.length, 1);
  assert.equal(harness.models[0].getValue(), 'class B {}');
  assert.equal(session.getCanonicalKeyForDocumentUri(harness.models[0].uri.toString()), 'file:///d:/demo/b.java');
  assert.deepEqual(lifecycle, ['onDidAttach', 'activate']);
  assert.deepEqual(
    operationNames(harness.calls).filter((name) =>
      ['editor.create', 'app.onDidAttach', 'editor.setModel', 'model.onDidChangeContent', 'app.activate'].includes(name)
    ),
    ['editor.create', 'app.onDidAttach', 'editor.setModel', 'model.onDidChangeContent', 'app.activate']
  );
  assert.ok(harness.calls.some((call) => call.op === 'editor.updateOptions' && call.options.fontSize === 16));
  assert.ok(harness.calls.some((call) => call.op === 'editor.setTheme' && call.theme === 'second-theme'));
  assert.equal(harness.calls.some((call) => call.op === 'editor.createModel' && call.value === 'class A {}'), false);
});

test('latest desired state lifecycle guards reject missing, duplicate, and disposed attach', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();

  assert.throws(
    () => session.attachEditor(harness.monaco, harness.host),
    /desired state must be provided before attach/
  );
  session.updateDesiredState(desired());
  session.attachEditor(harness.monaco, harness.host);
  assert.throws(() => session.attachEditor(harness.monaco, harness.host), /already attached/);
  session.dispose();
  assert.throws(() => session.attachEditor(harness.monaco, harness.host), /disposed/);
});

test('URI/ownership canonicalizes Windows paths and preserves encoded path characters and UNC authority', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const activations = [];
  const firstPath = 'D:\\Demo\\A.java';
  const aliasPath = 'd:/demo/A.java';

  session.updateDesiredState(
    desired({
      activeDocument: { path: firstPath, value: 'class A {}', language: 'java' },
      openFilePaths: [firstPath],
      onDidChangeModel(event) {
        if (event.kind === 'activate') activations.push(event.current);
      }
    })
  );
  session.attachEditor(harness.monaco, harness.host);
  const firstModel = harness.editors[0].getModel();
  session.updateDesiredState(
    desired({
      activeDocument: { path: aliasPath, value: 'class A {}', language: 'java' },
      openFilePaths: [aliasPath],
      onDidChangeModel(event) {
        if (event.kind === 'activate') activations.push(event.current);
      }
    })
  );

  assert.equal(harness.models.length, 1);
  assert.equal(harness.editors[0].getModel(), firstModel);
  assert.equal(activations.at(-1).path, aliasPath);
  assert.equal(activations.at(-1).key, 'file:///d:/demo/a.java');

  for (const rawPath of [
    'C:\\Space Folder\\100%#雪.java',
    '\\\\Server\\Share Name\\100%#雪.java'
  ]) {
    const uri = harness.monaco.Uri.file(rawPath);
    const serialized = uri.toString();
    const key = session.getCanonicalKeyForDocumentUri(serialized);
    assert.ok(key, rawPath);
    assert.match(serialized, /%20/);
    assert.match(serialized, /%25/);
    assert.match(serialized, /%23/);
    assert.match(serialized, /%E9%9B%AA/i);
    if (rawPath.startsWith('\\\\')) assert.match(key, /^file:\/\/server\//);
  }

  assert.equal(session.getCanonicalKeyForDocumentUri('file:///bad/%E0%A4%A'), null);
  assert.equal(session.getCanonicalKeyForDocumentUri('not a uri'), null);
});

test('URI/ownership acquires exact and canonical existing models as borrowed before creating owned models', () => {
  const exactHarness = makeMonacoHarness();
  const exactUri = exactHarness.monaco.Uri.file('D:\\Demo\\Exact.java');
  const exactModel = exactHarness.monaco.editor.createModel('external exact', 'java', exactUri);
  const exactEvents = [];
  const exactSession = new MonacoEditorSession();
  exactSession.updateDesiredState(
    desired({
      activeDocument: { path: 'D:\\Demo\\Exact.java', value: 'external exact', language: 'java' },
      openFilePaths: ['D:\\Demo\\Exact.java'],
      onDidChangeModel(event) {
        if (event.kind === 'activate') exactEvents.push(event.current);
      }
    })
  );
  exactSession.attachEditor(exactHarness.monaco, exactHarness.host);
  assert.equal(exactEvents[0].model, exactModel);
  assert.equal(exactEvents[0].ownership, 'borrowed');

  const scanHarness = makeMonacoHarness();
  const scanUri = scanHarness.monaco.Uri.file('D:\\DEMO\\Scan.java');
  const scanModel = scanHarness.monaco.editor.createModel('external scan', 'java', scanUri);
  const scanEvents = [];
  const scanSession = new MonacoEditorSession();
  scanSession.updateDesiredState(
    desired({
      activeDocument: { path: 'd:/demo/Scan.java', value: 'external scan', language: 'java' },
      openFilePaths: ['d:/demo/Scan.java'],
      onDidChangeModel(event) {
        if (event.kind === 'activate') scanEvents.push(event.current);
      }
    })
  );
  scanSession.attachEditor(scanHarness.monaco, scanHarness.host);
  assert.equal(scanEvents[0].model, scanModel);
  assert.equal(scanEvents[0].ownership, 'borrowed');
  assert.ok(
    operationNames(scanHarness.calls).indexOf('editor.getModel') <
      operationNames(scanHarness.calls).lastIndexOf('editor.getModels')
  );

  const ownedHarness = makeMonacoHarness();
  const ownedEvents = [];
  const ownedSession = new MonacoEditorSession();
  ownedSession.updateDesiredState(
    desired({
      activeDocument: { path: 'D:\\Demo\\Owned.java', value: 'owned', language: 'java' },
      openFilePaths: ['D:\\Demo\\Owned.java'],
      onDidChangeModel(event) {
        if (event.kind === 'activate') ownedEvents.push(event.current);
      }
    })
  );
  ownedSession.attachEditor(ownedHarness.monaco, ownedHarness.host);
  assert.equal(ownedEvents[0].ownership, 'owned');
  assert.ok(ownedHarness.calls.some((call) => call.op === 'editor.createModel'));
});

test('URI/ownership rejects a disposed exact candidate before scanning or creating a live owned model', () => {
  const harness = makeMonacoHarness();
  const path = 'D:\\Demo\\DisposedExact.java';
  const uri = harness.monaco.Uri.file(path);
  const stale = harness.monaco.editor.createModel('stale', 'java', uri);
  stale.dispose();
  const activations = [];
  const session = new MonacoEditorSession();
  session.updateDesiredState(
    desired({
      activeDocument: { path, value: 'live', language: 'java' },
      openFilePaths: [path],
      onDidChangeModel(event) {
        if (event.kind === 'activate') activations.push(event.current);
      }
    })
  );

  const editor = session.attachEditor(harness.monaco, harness.host);

  assert.notEqual(editor.getModel(), stale);
  assert.equal(editor.getModel().isDisposed(), false);
  assert.equal(editor.getModel().getValue(), 'live');
  assert.equal(activations.at(-1).ownership, 'owned');
  assert.equal(harness.models.length, 2);
});

test('URI/ownership externally disposed borrowed active model releases once and rebuilds from latest state', async () => {
  const harness = makeMonacoHarness();
  const uri = harness.monaco.Uri.file('D:\\Demo\\Borrowed.java');
  const borrowed = harness.monaco.editor.createModel('external', 'java', uri);
  const events = [];
  const errors = [];
  const session = new MonacoEditorSession();
  session.updateDesiredState(
    desired({
      activeDocument: { path: 'D:\\Demo\\Borrowed.java', value: 'external', language: 'java' },
      openFilePaths: ['D:\\Demo\\Borrowed.java'],
      onError(error) {
        errors.push(error);
      },
      onDidChangeModel(event, monaco) {
        events.push({ event, monaco });
      }
    })
  );
  const editor = session.attachEditor(harness.monaco, harness.host);

  borrowed.dispose();

  assert.equal(editor.getModel(), null);
  assert.equal(events.filter(({ event }) => event.kind === 'release').length, 1);
  assert.equal(events.find(({ event }) => event.kind === 'release').monaco, harness.monaco);
  assert.equal(events.find(({ event }) => event.kind === 'release').event.model.ownership, 'borrowed');
  assert.equal(session.getModelByCanonicalKey('file:///d:/demo/borrowed.java'), null);

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 0);
  assert.notEqual(editor.getModel(), borrowed);
  assert.equal(editor.getModel().getValue(), 'external');
  assert.equal(events.filter(({ event }) => event.kind === 'release').length, 1);
});

test('URI/ownership defers release callback updates and applies only the latest snapshot after will-dispose', async () => {
  const harness = makeMonacoHarness();
  const pathA = 'D:\\Demo\\DeferredA.java';
  const pathB = 'D:\\Demo\\DeferredB.java';
  const uriA = harness.monaco.Uri.file(pathA);
  const uriB = harness.monaco.Uri.file(pathB).toString();
  const borrowedA = harness.monaco.editor.createModel('external A', 'java', uriA);
  const session = new MonacoEditorSession();
  const errors = [];
  const events = [];
  let updatedDuringRelease = false;

  function state(activeDocument) {
    return desired({
      activeDocument,
      openFilePaths: [pathA, pathB],
      onError(error) {
        errors.push(error);
      },
      onDidChangeModel(event) {
        events.push(event);
        if (event.kind === 'release' && !updatedDuringRelease) {
          updatedDuringRelease = true;
          session.updateDesiredState(
            state({ path: pathB, value: 'transient B', language: 'java' })
          );
          session.updateDesiredState(
            state({ path: pathA, value: 'latest A', language: 'java' })
          );
        }
      }
    });
  }

  session.updateDesiredState(state({ path: pathA, value: 'external A', language: 'java' }));
  const editor = session.attachEditor(harness.monaco, harness.host);
  const callsBeforeDispose = harness.calls.length;

  borrowedA.dispose();

  assert.equal(editor.getModel(), null);
  assert.equal(events.filter((event) => event.kind === 'release').length, 1);
  assert.equal(
    harness.calls.slice(callsBeforeDispose).some(
      (call) => call.op === 'editor.createModel' && call.uri === uriB
    ),
    false
  );

  await Promise.resolve();
  await Promise.resolve();

  assert.notEqual(editor.getModel(), borrowedA);
  assert.equal(editor.getModel().isDisposed(), false);
  assert.equal(editor.getModel().getValue(), 'latest A');
  assert.equal(events.filter((event) => event.kind === 'release').length, 1);
  assert.equal(errors.length, 0);
  assert.equal(
    harness.calls.slice(callsBeforeDispose).some(
      (call) => call.op === 'editor.createModel' && call.uri === uriB
    ),
    false
  );
});

test('A to B to A switches atomically, restores per-model state, and rejects late epochs', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const changes = [];
  const pathA = 'D:\\Demo\\A.java';
  const aliasA = 'd:/demo/A.java';
  const pathB = 'D:\\Demo\\B.java';

  function state(activeDocument) {
    return desired({
      activeDocument,
      openFilePaths: [pathA, pathB],
      onDidChangeContent(change) {
        changes.push(change);
      },
      onWillChangeModel(previous, nextPath) {
        harness.calls.push({ op: 'app.onWillChangeModel', previous, nextPath });
      },
      onDidChangeModel(event) {
        harness.calls.push({ op: `app.${event.kind}`, event });
      }
    });
  }

  session.updateDesiredState(state({ path: pathA, value: 'class A {}', language: 'java' }));
  const editor = session.attachEditor(harness.monaco, harness.host);
  const modelA = editor.getModel();
  const firstAListener = harness.calls.find((call) => call.op === 'model.onDidChangeContent').listenerId;
  harness.emitUserEdit(modelA, 'edited A');
  assert.equal(changes.at(-1).path, pathA);
  editor.viewState = { id: 'view-A' };

  harness.calls.length = 0;
  session.updateDesiredState(state({ path: pathB, value: 'class B {}', language: 'java' }));
  const modelB = editor.getModel();
  const switchToB = harness.calls
    .map((call) =>
      call.op === 'editor.setModel' ? `editor.setModel:${call.model === null ? 'null' : 'model'}` : call.op
    )
    .filter((name) =>
      [
        'contentListener.dispose',
        'editor.saveViewState',
        'app.onWillChangeModel',
        'editor.setModel:null',
        'editor.setModel:model',
        'editor.setModelLanguage',
        'editor.restoreViewState',
        'model.onDidChangeContent',
        'app.activate'
      ].includes(name)
    );
  assert.deepEqual(switchToB, [
    'contentListener.dispose',
    'editor.saveViewState',
    'app.onWillChangeModel',
    'editor.setModel:null',
    'editor.setModel:model',
    'editor.setModelLanguage',
    'editor.restoreViewState',
    'model.onDidChangeContent',
    'app.activate'
  ]);
  assert.notEqual(modelB, modelA);
  assert.equal(modelA.getValue(), 'edited A');
  assert.equal(modelB.getValue(), 'class B {}');
  assert.equal(editor.viewState, null);

  const changesBeforeLateA = changes.length;
  harness.emitLateContentEvent(firstAListener);
  assert.equal(changes.length, changesBeforeLateA);
  harness.emitUserEdit(modelB, 'edited B');
  assert.equal(changes.at(-1).path, pathB);
  editor.viewState = { id: 'view-B' };

  session.updateDesiredState(state({ path: aliasA, value: 'edited A', language: 'java' }));
  assert.equal(editor.getModel(), modelA);
  assert.deepEqual(editor.viewState, { id: 'view-A' });
  assert.equal(modelB.getValue(), 'edited B');

  const changesBeforeOldEpoch = changes.length;
  harness.emitLateContentEvent(firstAListener);
  assert.equal(changes.length, changesBeforeOldEpoch);
  harness.emitUserEdit(modelA, 'edited A again');
  assert.equal(changes.at(-1).path, aliasA);
  assert.equal(changes.at(-1).uri, modelA.uri.toString());
});

test('A to B switch releases a closed owned model only after detaching and activating B', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const pathA = 'D:\\Raw Case\\A.java';
  const pathB = 'D:\\Raw Case\\B.java';
  const events = [];

  function state(activeDocument, openFilePaths) {
    return desired({
      activeDocument,
      openFilePaths,
      onWillChangeModel(previous, nextPath) {
        harness.calls.push({ op: 'app.onWillChangeModel', previous, nextPath });
      },
      onDidChangeModel(event, monaco) {
        events.push({ event, monaco });
        harness.calls.push({ op: `app.${event.kind}`, event });
      }
    });
  }

  session.updateDesiredState(state({ path: pathA, value: 'A', language: 'java' }, [pathA]));
  const editor = session.attachEditor(harness.monaco, harness.host);
  const modelA = editor.getModel();
  const firstActivation = events.find(({ event }) => event.kind === 'activate').event.current;

  harness.calls.length = 0;
  session.updateDesiredState(state({ path: pathB, value: 'B', language: 'java' }, [pathB]));

  const names = harness.calls.map((call) =>
    call.op === 'editor.setModel' ? `editor.setModel:${call.model === null ? 'null' : 'model'}` : call.op
  );
  const release = events.find(({ event }) => event.kind === 'release');
  assert.ok(release);
  assert.equal(release.monaco, harness.monaco);
  assert.equal(release.event.model.path, pathA);
  assert.equal(release.event.model.epoch, firstActivation.epoch);
  assert.equal(release.event.model.model, modelA);
  assert.equal(modelA.isDisposed(), true);
  assert.ok(names.indexOf('editor.setModel:null') < names.indexOf('app.activate'));
  assert.ok(names.indexOf('app.activate') < names.indexOf('app.release'));
  assert.ok(names.indexOf('app.release') < names.indexOf('model.dispose'));
});

test('programmatic edit suppression preserves undo and view state without hiding later user edits', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const path = 'D:\\Demo\\Sync.java';
  const changes = [];

  function state(value) {
    return desired({
      activeDocument: { path, value, language: 'java' },
      openFilePaths: [path],
      onDidChangeContent(change) {
        changes.push(change);
      }
    });
  }

  session.updateDesiredState(state('initial'));
  const editor = session.attachEditor(harness.monaco, harness.host);
  const model = editor.getModel();
  const rangeBeforeSync = model.getFullModelRange();
  editor.viewState = { id: 'before-sync' };
  harness.calls.length = 0;

  session.updateDesiredState(state('server value'));

  assert.equal(model.getValue(), 'server value');
  assert.equal(changes.length, 0);
  assert.deepEqual(editor.viewState, { id: 'before-sync' });
  const syncCalls = harness.calls.filter((call) =>
    ['editor.saveViewState', 'editor.pushUndoStop', 'editor.executeEdits', 'editor.restoreViewState'].includes(call.op)
  );
  assert.deepEqual(syncCalls.map((call) => call.op), [
    'editor.saveViewState',
    'editor.pushUndoStop',
    'editor.executeEdits',
    'editor.pushUndoStop',
    'editor.restoreViewState'
  ]);
  assert.equal(syncCalls.find((call) => call.op === 'editor.executeEdits').source, 'workstation.external-sync');
  assert.deepEqual(syncCalls.find((call) => call.op === 'editor.executeEdits').edits, [
    {
      range: rangeBeforeSync,
      text: 'server value',
      forceMoveMarkers: true
    }
  ]);

  harness.emitUserEdit(model, 'user value');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].value, 'user value');

  harness.setNextFailure('editor.executeEdits');
  assert.throws(
    () => session.updateDesiredState(state('failing server value')),
    isMonacoStageFailure('reconcile', /Injected failure: editor\.executeEdits/)
  );
  harness.emitUserEdit(model, 'user after failure');
  assert.equal(changes.length, 2);
  assert.equal(changes[1].value, 'user after failure');
});

test('teardown closes inactive and active owned models and releases each exactly once', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const pathA = 'D:\\Demo\\CloseA.java';
  const pathB = 'D:\\Demo\\CloseB.java';
  const events = [];

  function state(activeDocument, openFilePaths) {
    return desired({
      activeDocument,
      openFilePaths,
      onDidChangeModel(event) {
        events.push(event);
      }
    });
  }

  session.updateDesiredState(state({ path: pathA, value: 'A', language: 'java' }, [pathA, pathB]));
  const editor = session.attachEditor(harness.monaco, harness.host);
  const modelA = editor.getModel();
  session.updateDesiredState(state({ path: pathB, value: 'B', language: 'java' }, [pathA, pathB]));
  const modelB = editor.getModel();

  session.updateDesiredState(state({ path: pathB, value: 'B', language: 'java' }, [pathB]));
  assert.equal(modelA.isDisposed(), true);
  assert.equal(modelB.isDisposed(), false);
  assert.equal(events.filter((event) => event.kind === 'release' && event.model.model === modelA).length, 1);

  session.updateDesiredState(state(null, []));
  assert.equal(editor.getModel(), null);
  assert.equal(modelB.isDisposed(), true);
  assert.equal(events.filter((event) => event.kind === 'release' && event.model.model === modelB).length, 1);
  assert.equal(session.getModelByCanonicalKey('file:///d:/demo/closea.java'), null);
  assert.equal(session.getModelByCanonicalKey('file:///d:/demo/closeb.java'), null);
});

test('teardown detach retains model and view state for reattach, then detached close sweeps immediately', () => {
  const harness = makeMonacoHarness();
  const session = new MonacoEditorSession();
  const path = 'D:\\Demo\\Reattach.java';
  const lifecycle = [];
  const events = [];

  function state(activeDocument, openFilePaths) {
    return desired({
      activeDocument,
      openFilePaths,
      onDidAttach(editor) {
        lifecycle.push({ kind: 'attach', editor });
        harness.calls.push({ op: 'app.onDidAttach' });
      },
      onDidDetach(editor) {
        lifecycle.push({ kind: 'detach', editor });
        harness.calls.push({ op: 'app.onDidDetach' });
      },
      onDidChangeModel(event, monaco) {
        events.push({ event, monaco });
      }
    });
  }

  session.updateDesiredState(state({ path, value: 'value', language: 'java' }, [path]));
  const firstEditor = session.attachEditor(harness.monaco, harness.host);
  const model = firstEditor.getModel();
  firstEditor.viewState = { id: 'retained-view' };
  harness.calls.length = 0;

  session.detachEditor();

  const detachNames = operationNames(harness.calls);
  assert.ok(detachNames.indexOf('app.onDidDetach') < detachNames.indexOf('editor.setModel'));
  assert.ok(detachNames.indexOf('editor.setModel') < detachNames.indexOf('editor.dispose'));
  assert.equal(firstEditor.getModel(), null);
  assert.equal(firstEditor.isDisposed(), true);
  assert.equal(model.isDisposed(), false);
  assert.equal(events.some(({ event }) => event.kind === 'release'), false);

  const secondEditor = session.attachEditor(harness.monaco, { id: 'second-host' });
  assert.notEqual(secondEditor, firstEditor);
  assert.equal(secondEditor.getModel(), model);
  assert.deepEqual(secondEditor.viewState, { id: 'retained-view' });

  session.detachEditor();
  const releasesBeforeClose = events.filter(({ event }) => event.kind === 'release').length;
  session.updateDesiredState(state(null, []));
  assert.equal(model.isDisposed(), true);
  assert.equal(events.filter(({ event }) => event.kind === 'release').length, releasesBeforeClose + 1);
  assert.equal(events.find(({ event }) => event.kind === 'release').monaco, harness.monaco);
  session.detachEditor();
});

test('teardown borrowed models release with retained facade but are never disposed by the session', () => {
  const harness = makeMonacoHarness();
  const path = 'D:\\Demo\\BorrowedClose.java';
  const borrowed = harness.monaco.editor.createModel('external', 'java', harness.monaco.Uri.file(path));
  const releases = [];
  const session = new MonacoEditorSession();
  function borrowedState(activeDocument, openFilePaths) {
    return desired({
      activeDocument,
      openFilePaths,
      onDidChangeModel(event, monaco) {
        if (event.kind !== 'release') return;
        releases.push({ event, monaco });
      }
    });
  }
  session.updateDesiredState(borrowedState({ path, value: 'external', language: 'java' }, [path]));
  session.attachEditor(harness.monaco, harness.host);
  session.detachEditor();
  session.updateDesiredState(borrowedState(null, []));

  assert.equal(releases.length, 1);
  assert.equal(releases[0].monaco, harness.monaco);
  assert.equal(releases[0].event.model.ownership, 'borrowed');
  assert.equal(borrowed.isDisposed(), false);

  const externalHarness = makeMonacoHarness();
  const externalPath = 'D:\\Demo\\ExternalDispose.java';
  const externallyDisposed = externalHarness.monaco.editor.createModel(
    'external',
    'java',
    externalHarness.monaco.Uri.file(externalPath)
  );
  const externalReleases = [];
  const externalSession = new MonacoEditorSession();
  externalSession.updateDesiredState(
    desired({
      activeDocument: { path: externalPath, value: 'external', language: 'java' },
      openFilePaths: [externalPath],
      onDidChangeModel(event, monaco) {
        if (event.kind === 'release') externalReleases.push({ event, monaco });
      }
    })
  );
  externalSession.attachEditor(externalHarness.monaco, externalHarness.host);
  externalSession.detachEditor();
  externallyDisposed.dispose();
  assert.equal(externalReleases.length, 1);
  assert.equal(externalReleases[0].monaco, externalHarness.monaco);
});

test('failure initial editor and callback acquisition rolls back editor and newly owned model', async (t) => {
  await t.test('editor.create can fail once and attach can retry', () => {
    const harness = makeMonacoHarness();
    const session = new MonacoEditorSession();
    session.updateDesiredState(desired());
    harness.setNextFailure('editor.create');
    assert.throws(
      () => session.attachEditor(harness.monaco, harness.host),
      isMonacoStageFailure('editor-create', /Injected failure: editor\.create/)
    );
    assert.equal(harness.editors.length, 0);
    assert.ok(session.attachEditor(harness.monaco, harness.host));
  });

  await t.test('onDidAttach failure disposes the acquired editor and can retry', () => {
    const harness = makeMonacoHarness();
    const session = new MonacoEditorSession();
    let fail = true;
    session.updateDesiredState(
      desired({
        onDidAttach() {
          if (fail) {
            fail = false;
            throw new Error('Injected callback failure: onDidAttach');
          }
        }
      })
    );
    assert.throws(
      () => session.attachEditor(harness.monaco, harness.host),
      isMonacoStageFailure('attach-callback', /onDidAttach/)
    );
    assert.equal(harness.editors[0].isDisposed(), true);
    assert.equal(harness.editors[0].getModel(), null);
    assert.equal(session.attachEditor(harness.monaco, harness.host), harness.editors[1]);
  });

  await t.test('listener acquisition failure disposes new owned model and editor before retry', () => {
    const harness = makeMonacoHarness();
    const session = new MonacoEditorSession();
    const path = 'D:\\Demo\\InitialFailure.java';
    session.updateDesiredState(
      desired({
        activeDocument: { path, value: 'value', language: 'java' },
        openFilePaths: [path]
      })
    );
    harness.setNextFailure('model.onDidChangeContent');
    assert.throws(
      () => session.attachEditor(harness.monaco, harness.host),
      isMonacoStageFailure('reconcile', /Injected failure: model\.onDidChangeContent/)
    );
    assert.equal(harness.editors[0].getModel(), null);
    assert.equal(harness.editors[0].isDisposed(), true);
    assert.equal(harness.models[0].isDisposed(), true);
    const retried = session.attachEditor(harness.monaco, harness.host);
    assert.notEqual(retried.getModel(), harness.models[0]);
  });

  await t.test('borrowed model survives failed initial listener acquisition', () => {
    const harness = makeMonacoHarness();
    const path = 'D:\\Demo\\BorrowedInitialFailure.java';
    const borrowed = harness.monaco.editor.createModel('external', 'java', harness.monaco.Uri.file(path));
    const session = new MonacoEditorSession();
    session.updateDesiredState(
      desired({
        activeDocument: { path, value: 'external', language: 'java' },
        openFilePaths: [path]
      })
    );
    harness.setNextFailure('model.onDidChangeContent');
    assert.throws(
      () => session.attachEditor(harness.monaco, harness.host),
      isMonacoStageFailure('reconcile', /model\.onDidChangeContent/)
    );
    assert.equal(borrowed.isDisposed(), false);
    assert.equal(session.attachEditor(harness.monaco, harness.host).getModel(), borrowed);
  });
});

test('failure post-attach acquisition leaves null stable state, preserves A, rolls back B, and retries', async (t) => {
  const scenarios = [
    { name: 'Uri.file', operation: 'Uri.file' },
    { name: 'createModel', operation: 'editor.createModel' },
    { name: 'model dispose listener', operation: 'model.onWillDispose' },
    { name: 'setModel target new owned', operation: 'editor.setModel:model', targetSetModel: 'owned' },
    {
      name: 'setModel target borrowed',
      operation: 'editor.setModel:model',
      targetSetModel: 'borrowed',
      borrowedB: true
    },
    { name: 'setModelLanguage', operation: 'editor.setModelLanguage' },
    { name: 'executeEdits', operation: 'editor.executeEdits', borrowedB: true },
    { name: 'restoreViewState', operation: 'editor.restoreViewState' },
    { name: 'content listener', operation: 'model.onDidChangeContent' },
    { name: 'onWillChangeModel callback', callback: 'will' },
    { name: 'onDidChangeModel callback', callback: 'did' }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const harness = makeMonacoHarness();
      const pathA = 'D:\\Demo\\StableA.java';
      const pathB = 'D:\\Demo\\FailB.java';
      const borrowedB = scenario.borrowedB
        ? harness.monaco.editor.createModel('stale B', 'java', harness.monaco.Uri.file(pathB))
        : null;
      const session = new MonacoEditorSession();
      const changes = [];
      let failWill = false;
      let failDid = false;

      function state(activeDocument) {
        return desired({
          activeDocument,
          openFilePaths: [pathA, pathB],
          onDidChangeContent(change) {
            changes.push(change);
          },
          onWillChangeModel() {
            if (failWill) {
              failWill = false;
              throw new Error('Injected callback failure: onWillChangeModel');
            }
          },
          onDidChangeModel(event) {
            if (failDid && event.kind === 'activate' && event.current?.path === pathB) {
              failDid = false;
              throw new Error('Injected callback failure: onDidChangeModel');
            }
          }
        });
      }

      session.updateDesiredState(state({ path: pathA, value: 'A', language: 'java' }));
      const editor = session.attachEditor(harness.monaco, harness.host);
      const modelA = editor.getModel();
      const listenerA = harness.calls.find(
        (call) => call.op === 'model.onDidChangeContent' && call.uri === modelA.uri.toString()
      ).listenerId;

      if (scenario.operation) harness.setNextFailure(scenario.operation);
      if (scenario.callback === 'will') failWill = true;
      if (scenario.callback === 'did') failDid = true;
      const attemptCallStart = harness.calls.length;
      assert.throws(
        () => session.updateDesiredState(state({ path: pathB, value: 'B', language: 'java' })),
        isMonacoStageFailure('reconcile', /Injected/)
      );

      if (scenario.targetSetModel !== undefined) {
        const attemptCalls = harness.calls.slice(attemptCallStart);
        const failureIndex = attemptCalls.findIndex(
          (call) => call.op === 'editor.setModel:model.failure'
        );
        assert.ok(failureIndex >= 0);
        if (scenario.targetSetModel === 'owned') {
          assert.ok(attemptCalls.findIndex((call) => call.op === 'editor.createModel') < failureIndex);
        } else {
          assert.equal(attemptCalls.some((call) => call.op === 'editor.createModel'), false);
          assert.ok(attemptCalls.findIndex((call) => call.op === 'model.onWillDispose') < failureIndex);
        }
      }

      assert.equal(editor.getModel(), null, scenario.name);
      assert.equal(session.getModelByCanonicalKey('file:///d:/demo/stablea.java'), modelA);
      assert.equal(modelA.isDisposed(), false);
      assert.equal(session.getModelByCanonicalKey('file:///d:/demo/failb.java'), null);
      if (borrowedB !== null) assert.equal(borrowedB.isDisposed(), false);
      for (const model of harness.models) {
        if (model !== modelA && model !== borrowedB) assert.equal(model.isDisposed(), true, scenario.name);
      }
      const changesBeforeLate = changes.length;
      harness.emitLateContentEvent(listenerA);
      assert.equal(changes.length, changesBeforeLate);

      session.updateDesiredState(state({ path: pathB, value: 'B', language: 'java' }));
      assert.ok(editor.getModel());
      assert.equal(editor.getModel().getValue(), 'B');
      assert.equal(modelA.isDisposed(), false);
    });
  }
});

test('failure teardown continues every cleanup, reports first error, and dispose stays idempotent', async (t) => {
  const scenarios = [
    { name: 'content listener dispose', operation: 'contentListener.dispose' },
    { name: 'detach setModel', operation: 'editor.setModel' },
    { name: 'editor dispose', operation: 'editor.dispose' },
    { name: 'model dispose listener', operation: 'modelDisposeListener.dispose' },
    { name: 'owned model dispose', operation: 'model.dispose' },
    { name: 'onDidDetach callback', callback: 'detach' },
    { name: 'release callback', callback: 'release' }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      const harness = makeMonacoHarness();
      const session = new MonacoEditorSession();
      const pathA = 'D:\\Demo\\CleanupA.java';
      const pathB = 'D:\\Demo\\CleanupB.java';
      const releases = [];
      let failDetach = scenario.callback === 'detach';
      let failRelease = scenario.callback === 'release';

      function state(activeDocument) {
        return desired({
          activeDocument,
          openFilePaths: [pathA, pathB],
          onDidDetach() {
            harness.calls.push({ op: 'app.onDidDetach' });
            if (failDetach) {
              failDetach = false;
              throw new Error('Injected callback failure: onDidDetach');
            }
          },
          onDidChangeModel(event) {
            if (event.kind !== 'release') return;
            releases.push(event.model);
            if (failRelease) {
              failRelease = false;
              throw new Error('Injected callback failure: release');
            }
          }
        });
      }

      session.updateDesiredState(state({ path: pathA, value: 'A', language: 'java' }));
      const editor = session.attachEditor(harness.monaco, harness.host);
      const modelA = editor.getModel();
      session.updateDesiredState(state({ path: pathB, value: 'B', language: 'java' }));
      const modelB = editor.getModel();
      if (scenario.operation) harness.setNextFailure(scenario.operation);

      assert.throws(() => session.dispose(), /Injected/);

      assert.equal(releases.length, 2, scenario.name);
      assert.equal(session.getModelByCanonicalKey('file:///d:/demo/cleanupa.java'), null);
      assert.equal(session.getModelByCanonicalKey('file:///d:/demo/cleanupb.java'), null);
      assert.ok(harness.calls.some((call) => call.op === 'editor.dispose'));
      assert.ok(harness.calls.filter((call) => call.op === 'model.dispose').length >= 2);
      if (scenario.operation !== 'model.dispose') {
        assert.equal(modelA.isDisposed(), true);
        assert.equal(modelB.isDisposed(), true);
      } else {
        assert.equal([modelA, modelB].filter((model) => model.isDisposed()).length, 1);
      }

      const callCount = harness.calls.length;
      const releaseCount = releases.length;
      session.dispose();
      assert.equal(harness.calls.length, callCount);
      assert.equal(releases.length, releaseCount);
      assert.throws(() => session.attachEditor(harness.monaco, harness.host), /disposed/);
    });
  }
});

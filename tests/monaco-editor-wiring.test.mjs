import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rendererSource = (fileName) =>
  readFile(new URL(`../src/renderer/src/${fileName}`, import.meta.url), 'utf8');

const workstationSource = (fileName) =>
  readFile(new URL(`../${fileName}`, import.meta.url), 'utf8');

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function getCssRule(source, selector) {
  const match = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, 's').exec(source);
  assert.ok(match, `missing .${selector} CSS rule`);
  return match[1];
}

function getRegion(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing region start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `missing region end: ${endNeedle}`);
  return source.slice(start, end);
}

function assertOrdered(source, needles, message) {
  let previous = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle, previous + 1);
    assert.notEqual(index, -1, `${message}: missing ${needle}`);
    assert.ok(index > previous, `${message}: ${needle} is out of order`);
    previous = index;
  }
}

function assertNoRawErrorConsoleArgument(source, label) {
  assert.doesNotMatch(
    source,
    /console\.(?:error|warn|log)\s*\([^;]*,\s*error\s*\)/s,
    `${label} must not pass a raw error as a console argument`
  );
  assert.doesNotMatch(
    source,
    /console\.(?:error|warn|log)\s*\([^;]*\berror\.(?:message|stack)\b/s,
    `${label} must not expose error message or stack`
  );
}

test('runtime initializes the local Monaco core exactly once without an extension runtime', async () => {
  const source = await rendererSource('vscode-runtime.ts');

  assert.match(source, /let\s+coreRuntimeReady:\s*Promise<void>\s*\|\s*null\s*=\s*null/);
  assert.match(source, /export\s+function\s+initializeVsCodeCoreRuntime\s*\(\)\s*:\s*Promise<void>/);

  const coreStart = source.indexOf('async function initializeCoreRuntime');
  const initializeCall = source.search(/\binitialize\s*\(/);

  assert.notEqual(coreStart, -1, 'missing initializeCoreRuntime implementation');
  assert.equal(countMatches(source, /\binitialize\s*\(/g), 1, 'production initialize() must be called once');
  assert.ok(initializeCall > coreStart, 'the production initialize() call must live in initializeCoreRuntime');
  assert.doesNotMatch(source, /initializeVsCodeRuntime|initializeFullRuntime|runtime descriptor|extension/i);
});

test('VS Code runtime uses the dependency-provided default dark workbench theme', async () => {
  const source = await rendererSource('vscode-runtime.ts');

  assert.match(
    source,
    /import\s+\{\s*ThemeSettingDefaults\s*\}\s+from\s+['"]@codingame\/monaco-vscode-api\/vscode\/vs\/workbench\/services\/themes\/common\/workbenchThemeService['"]/
  );
  assert.match(
    source,
    /['"]workbench\.colorTheme['"]:\s*ThemeSettingDefaults\.COLOR_THEME_DARK/
  );
  assert.doesNotMatch(source, /Default Dark Modern/);
});

test('LocalMonacoEditor is a lifecycle-driven native Monaco host with a sibling overlay', async () => {
  const [source, styles] = await Promise.all([
    rendererSource('LocalMonacoEditor.tsx'),
    rendererSource('styles.css')
  ]);

  assert.match(source, /from\s+['"]monaco-editor['"]/);
  assert.match(source, /MonacoEditorLifecycle[\s\S]*?from\s+['"]\.\/monaco-editor-lifecycle['"]/);
  assert.match(source, /initializeVsCodeCoreRuntime[\s\S]*?from\s+['"]\.\/vscode-runtime['"]/);
  assert.doesNotMatch(source, /@monaco-editor\/react/);

  const overlayIndex = source.indexOf('className={`local-monaco-editor-overlay');
  const hostIndex = source.indexOf('className="local-monaco-editor-host"');
  assert.notEqual(overlayIndex, -1, 'missing independent editor overlay');
  assert.ok(hostIndex > overlayIndex, 'host must be a sibling after the overlay');
  assert.match(
    source,
    /<div\s+ref=\{hostRef\}\s+className="local-monaco-editor-host"\s*\/>/,
    'Monaco host DOM must remain empty'
  );
  assert.match(source, /编辑器正在初始化/);
  assert.match(source, /编辑器初始化失败，请重启工作站/);

  for (const forbidden of [
    /writeFile/,
    /createModelReference/,
    /files-service-override/,
    /\.\s*save\s*\(/
  ]) {
    assert.doesNotMatch(source, forbidden);
  }

  assert.match(source, /useMemo\([\s\S]*?\n\s*\[session\]\s*\n\s*\)/);
  assert.match(source, /useEffect\(\(\)\s*=>\s*\{[\s\S]*?return\s*\(\)\s*=>\s*run\.cancel\(\);[\s\S]*?\},\s*\[lifecycle\]\s*\)/);
  assert.doesNotMatch(source, /lifecycle\.dispose\s*\(/);
  assert.doesNotMatch(source, /updateDesiredState\s*\(/, 'Local host must not own desired state');

  for (const selector of ['local-monaco-editor', 'local-monaco-editor-host']) {
    const rule = getCssRule(styles, selector);
    assert.match(rule, /width:\s*100%/);
    assert.match(rule, /height:\s*100%/);
    assert.match(rule, /min-height:\s*0/);
  }
  assert.match(getCssRule(styles, 'local-monaco-editor-overlay'), /position:\s*absolute/);
});

test('local Monaco registers bundled Java syntax before creating the editor', async () => {
  const [localSource, appSource, appearanceSource] = await Promise.all([
    rendererSource('LocalMonacoEditor.tsx'),
    rendererSource('App.tsx'),
    rendererSource('monaco-editor-appearance.ts')
  ]);

  assertOrdered(
    localSource,
    ['configureWorkstationMonaco(monaco)', 'session.attachEditor(monaco, host)'],
    'Monaco appearance must be configured before editor creation'
  );
  assert.match(appearanceSource, /setMonarchTokensProvider\(['"]java['"],\s*WORKSTATION_JAVA_LANGUAGE\)/);
  assert.match(appSource, /renderLineHighlight:\s*['"]none['"]/);
  assert.match(appSource, /cursorStyle:\s*['"]line['"]/);
  assert.match(appSource, /cursorWidth:\s*2/);

});

test('Monaco initialization diagnostics wrap every fixed stage without changing the call boundaries', async () => {
  const [localSource, appearanceSource, sessionSource, appSource] = await Promise.all([
    rendererSource('LocalMonacoEditor.tsx'),
    rendererSource('monaco-editor-appearance.ts'),
    rendererSource('monaco-editor-session.ts'),
    rendererSource('App.tsx')
  ]);

  assert.match(localSource, /runMonacoStageAsync\(['"]core-runtime['"],\s*initializeVsCodeCoreRuntime\)/);
  assert.match(appearanceSource, /ThemeSettingDefaults\.COLOR_THEME_DARK/);
  assert.doesNotMatch(appearanceSource, /monaco\.editor\.defineTheme\s*\(/);
  assert.doesNotMatch(sessionSource, /'defineTheme'/);
  assert.match(appearanceSource, /runMonacoStage\(['"]java-language-registration['"],\s*\(\)\s*=>\s*\{[\s\S]*?getLanguages\(\)[\s\S]*?languages\.register/);
  assert.match(appearanceSource, /runMonacoStage\(['"]java-configuration['"],\s*\(\)\s*=>\s*monaco\.languages\.setLanguageConfiguration/);
  assert.match(appearanceSource, /runMonacoStage\(['"]java-tokenizer['"],\s*\(\)\s*=>\s*monaco\.languages\.setMonarchTokensProvider/);
  assert.match(sessionSource, /runMonacoStage\(['"]editor-create['"],\s*\(\)\s*=>\s*monaco\.editor\.create/);
  assert.match(sessionSource, /runMonacoStage\(['"]attach-callback['"],\s*\(\)\s*=>\s*this\.desiredState!\.onDidAttach/);
  assert.equal((sessionSource.match(/runMonacoStage\(['"]reconcile['"]/g) ?? []).length, 2);
  assert.equal((appSource.match(/runMonacoStage\(['"]local-decoration['"]/g) ?? []).length, 2);
  assert.doesNotMatch(appSource, /jdt-semantic-decoration|onJavaSemanticTokens|onJavaDiagnostics/);
});

test('main dynamically loads one StrictMode-external editor session without starting an extension runtime', async () => {
  const source = await rendererSource('main.tsx');
  const sessionCreation = source.indexOf('const editorSession = new MonacoEditorSession()');
  const strictModeRender = source.indexOf('<React.StrictMode>');

  assert.doesNotMatch(
    source,
    /import\s+\{\s*MonacoEditorSession\s*\}\s+from\s+['"]\.\/monaco-editor-session['"]/
  );
  assert.match(
    source,
    /const\s+\[\{\s*App\s*\},\s*\{\s*MonacoEditorSession\s*\}\]\s*=\s*await\s+Promise\.all\(\[\s*import\(['"]\.\/App['"]\),\s*import\(['"]\.\/monaco-editor-session['"]\)\s*\]\)/
  );
  assert.equal(countMatches(source, /new\s+MonacoEditorSession\(\)/g), 1);
  assert.notEqual(sessionCreation, -1, 'missing root MonacoEditorSession');
  assert.notEqual(strictModeRender, -1, 'missing StrictMode workbench render');
  assert.ok(sessionCreation < strictModeRender, 'session must be created before rendering the workbench StrictMode tree');
  assert.match(source, /<React\.StrictMode>[\s\S]*?<App\s+editorSession=\{editorSession\}\s*\/>[\s\S]*?<\/React\.StrictMode>/);
  assert.match(source, /const\s+disposeEditorSession\s*=\s*\(\)\s*:\s*void\s*=>\s*editorSession\.dispose\(\)/);
  assert.match(source, /window\.addEventListener\(['"]beforeunload['"],\s*disposeEditorSession\)/);
  assert.match(
    source,
    /import\.meta\.hot\?\.dispose\(\(\)\s*=>\s*\{[\s\S]*?window\.removeEventListener\(['"]beforeunload['"],\s*disposeEditorSession\)[\s\S]*?disposeEditorSession\(\)[\s\S]*?\}\)/
  );
  assert.doesNotMatch(source, /initializeVsCodeRuntime|startVsCodeRuntime|VSCODE_RUNTIME_INIT_FAILURE/);
  assertNoRawErrorConsoleArgument(source, 'main');
});

test('App gates startup workspace restoration across React StrictMode effect replay', async () => {
  const source = await rendererSource('App.tsx');
  const startupEffect =
    source.match(/useEffect\(\(\) => \{\s*updateSemanticTokenStyles\(DEFAULT_SEMANTIC_TOKEN_STYLES\)[\s\S]*?\}, \[\]\);/)?.[0] ?? '';

  assert.match(source, /const startupWorkspaceRestoreStartedRef = useRef\(false\)/);
  assert.match(source, /const startupRestoreRequestRef = useRef\(0\)/);
  assert.match(
    startupEffect,
    /if \(!startupWorkspaceRestoreStartedRef\.current && !manualWorkspaceImportStartedRef\.current\) \{[\s\S]*?startupWorkspaceRestoreStartedRef\.current = true;[\s\S]*?void restoreLastWorkspace\(requestId\);/
  );
});

test('App exposes one authoritative desired-state bridge and native Local host', async () => {
  const [source, localSource] = await Promise.all([
    rendererSource('App.tsx'),
    rendererSource('LocalMonacoEditor.tsx')
  ]);

  assert.doesNotMatch(source, /@monaco-editor\/react/);
  assert.doesNotMatch(source, /<Editor\b/);
  assert.match(source, /import\s+\{\s*LocalMonacoEditor\s*\}\s+from\s+['"]\.\/LocalMonacoEditor['"]/);
  for (const forbidden of [
    /import\s+\{[^}]*\bSuspense\b[^}]*\}\s+from\s+['"]react['"]/,
    /import\s+\{[^}]*\blazy\b[^}]*\}\s+from\s+['"]react['"]/,
    /\blazy\s*\(/,
    /<Suspense\b/,
    /LazyLocalMonacoEditor/,
    /LocalMonacoEditorModuleFailure/,
    /MONACO_MODULE_LOAD_FAILURE/,
    /import\(['"]\.\/LocalMonacoEditor['"]\)/
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /type\s+AppProps\s*=\s*\{\s*editorSession:\s*MonacoEditorSession;?\s*\}/);
  assert.match(source, /export\s+function\s+App\(\{\s*editorSession\s*\}:\s*AppProps\)/);
  assert.match(source, /const\s+MONACO_EDITOR_OPTIONS:\s*MonacoEditorOptions\s*=\s*\{[\s\S]*?automaticLayout:\s*true[\s\S]*?padding:\s*\{\s*top:\s*14,\s*bottom:\s*14\s*\}[\s\S]*?\};/);

  const editorSurface = getRegion(source, '<div className="editor-surface">', '<footer className="statusbar">');
  assert.match(
    editorSurface,
    /<LocalMonacoEditor\s+session=\{editorSession\}\s+onError=\{handleEditorError\}\s*\/>/
  );

  const desiredState = getRegion(source, 'const editorDesiredState', 'useEffect(() => {');
  assert.match(desiredState, /activeDocument:\s*selectedFile\s*\?[\s\S]*?:\s*null/);
  assert.match(desiredState, /path:\s*selectedFile\.path/);
  assert.match(desiredState, /value:\s*selectedFile\.content/);
  assert.match(desiredState, /language:\s*editorLanguage/);
  assert.match(desiredState, /openFilePaths:\s*openFiles\.map\(\(file\)\s*=>\s*file\.path\)/);
  assert.match(desiredState, /options:\s*MONACO_EDITOR_OPTIONS/);
  assert.match(desiredState, /theme:\s*DEFAULT_EDITOR_THEME/);
  assert.match(desiredState, /onError:\s*handleEditorError/);

  assert.equal(countMatches(source, /editorSession\.updateDesiredState\(editorDesiredState\)/g), 1);
  assert.match(
    source,
    /useEffect\(\(\)\s*=>\s*\{\s*try\s*\{\s*editorSession\.updateDesiredState\(editorDesiredState\);?\s*\}\s*catch\s*\(error\)\s*\{\s*handleEditorError\(error\);?\s*\}\s*\},\s*\[editorDesiredState,\s*editorSession,\s*handleEditorError\]\s*\)/
  );
  assert.doesNotMatch(localSource, /updateDesiredState\s*\(/);
  assert.match(source, /setOpenFiles\(\[\]\)[\s\S]*?setActiveFilePath\(null\)/, 'workspace reset must publish empty desired paths');
  assert.doesNotMatch(source, /updateActiveFileContent\s*\(/);
  assert.match(
    desiredState,
    /onDidChangeContent:[\s\S]*?setOpenFiles\(\(files\)\s*=>\s*updateOpenFileContentByPath\(files,\s*change\.path,\s*change\.value\)\s+as\s+SelectedFile\[\]\s*\)/
  );

  const errorHandler = getRegion(source, 'const handleEditorError', 'const handleDidAttach');
  assert.match(errorHandler, /const\s+cause\s*=\s*getMonacoFailureCause\(error\)/);
  assert.match(
    errorHandler,
    /console\.error\(\s*['"]\[renderer\] MONACO_EDITOR_FAILURE['"],\s*getSafeRendererErrorType\(cause\),\s*getSafeRendererErrorFingerprint\(cause\)\s*\)/
  );
  assert.match(errorHandler, /setStatus\(['"]编辑器运行失败，请重启工作站['"]\)/);
  assertNoRawErrorConsoleArgument(errorHandler, 'App Monaco error boundary');
});

test('renderer normalizes resolved Monaco VS Code module ids before returning them to Vite', async () => {
  const source = await workstationSource('electron.vite.config.ts');
  const resolver = getRegion(source, 'function monacoVscodeInternalResolver', 'export default defineConfig');

  assert.match(source, /import\s+\{\s*normalizePath,\s*type\s+Plugin\s*\}\s+from\s+['"]vite['"]/);
  assert.match(resolver, /name:\s*['"]monaco-vscode-internal-resolver['"]/);
  assert.match(resolver, /enforce:\s*['"]pre['"]/);
  assert.match(resolver, /return\s+candidate\s*\?\s*normalizePath\(candidate\)\s*:\s*null/);
  assert.doesNotMatch(resolver, /return\s+candidate\s*\?\s*candidate\s*:\s*null/);
  assert.match(source, /plugins:\s*\[monacoVscodeInternalResolver\(\),\s*react\(\)\]/);
});

test('App owns only local Java decorations per canonical document URI', async () => {
  const source = await rendererSource('App.tsx');

  assert.equal(countMatches(source, /new\s+MonacoDecorationIdStore\(\)/g), 1);
  assert.equal(countMatches(source, /presentationMonacoRef\s*=\s*useRef<MonacoEditorFacade\s*\|\s*null>\(null\)/g), 1);
  assert.doesNotMatch(
    source,
    /LatestDocumentEventStore|JavaDiagnosticsEvent|JavaSemanticTokensEvent|onJavaSemanticTokens|onJavaDiagnostics|jdtls/
  );

  const attach = getRegion(source, 'const handleDidAttach', 'const handleWillChangeModel');
  assertOrdered(
    attach,
    [
      'editorRef.current = editor',
      'monacoRef.current = monaco',
      'presentationMonacoRef.current = monaco',
      'monaco.editor.setTheme(DEFAULT_EDITOR_THEME)'
    ],
    'attach must publish the editor facade before applying the local theme'
  );

  const willChange = getRegion(source, 'const handleWillChangeModel', 'const handleDidDetach');
  assert.match(willChange, /previous\.model\.deltaDecorations\(decorationStoreRef\.current\.release\(previous\.key\),\s*\[\]\)/);

  const detach = getRegion(source, 'const handleDidDetach', 'const handleDidChangeModel');
  assert.match(detach, /model\.deltaDecorations\(decorationStoreRef\.current\.release\(canonicalKey\),\s*\[\]\)/);
  assertOrdered(detach, ['editorRef.current = null', 'monacoRef.current = null'], 'detach must clear operational refs');
  assert.doesNotMatch(detach, /presentationMonacoRef\.current\s*=\s*null/);

  const modelChange = getRegion(source, 'const handleDidChangeModel', 'const editorDesiredState');
  const release = getRegion(modelChange, "event.kind === 'release'", "event.current");
  assert.match(release, /decorationStoreRef\.current\.release\(event\.model\.key\)/);
  assert.match(release, /event\.model\.model\.deltaDecorations\(released,\s*\[\]\)/);
  assert.match(modelChange, /applyJavaLocalSemanticDecorations\(/);
  assert.doesNotMatch(modelChange, /applyJavaSemanticTokenDecorations|setModelMarkers/);

  const workspaceGeneration = getRegion(
    source,
    'function clearWorkspacePresentationState()',
    'const handleEditorError'
  );
  assertOrdered(
    workspaceGeneration,
    [
      'decorationStoreRef.current.clear()',
      'editorSession.getModelByCanonicalKey(canonicalKey)',
      'model.deltaDecorations(ids, [])'
    ],
    'workspace generation cleanup'
  );
});

test('workspace generation cleanup is synchronous before publishing the next active root', async () => {
  const source = await rendererSource('App.tsx');
  const loadWorkspace = getRegion(
    source,
    'async function loadWorkspaceRoot(',
    'async function restoreWorkspaceViewState('
  );

  assert.match(
    loadWorkspace,
    /if\s*\(activeWorkspaceRootRef\.current\s*!==\s*selectedRoot\)\s*\{\s*clearWorkspacePresentationState\(\);\s*\}/,
    'only a real workspace generation change should synchronously retire presentation state'
  );
  assertOrdered(
    loadWorkspace,
    [
      'clearWorkspacePresentationState()',
      'activeWorkspaceRootRef.current = selectedRoot',
      'setWorkspaceRoot(selectedRoot)'
    ],
    'old generation cleanup must finish before the new root can pass IPC filtering'
  );
  assert.doesNotMatch(
    source,
    /\},\s*\[editorSession,\s*workspaceRoot\]\s*\);/,
    'workspace stores must not be cleared later by a passive workspaceRoot effect'
  );
});

test('local decoration refresh and reveal callbacks revalidate live session state', async () => {
  const source = await rendererSource('App.tsx');
  assert.match(
    source,
    /const\s+previousIds\s*=\s*decorationStoreRef\.current\.replace\(canonicalKey,\s*\[\]\)[\s\S]*?applyJavaLocalSemanticDecorations\(model,\s*monaco,\s*selectedFile\.content,\s*previousIds\)[\s\S]*?decorationStoreRef\.current\.replace\(canonicalKey,\s*nextIds\)/
  );

  const revealEffect = getRegion(source, 'const reveal = pendingEditorRevealRef.current', '}, [editorSession, selectedFile?.path])');
  const delayed = getRegion(revealEffect, 'scheduleAfterFirstPaint(() => {', '});');
  assert.match(delayed, /pendingEditorRevealRef\.current/);
  assert.match(delayed, /editorRef\.current/);
  assert.match(delayed, /editorSession\.getCanonicalKeyForDocumentUri/);
  assert.match(delayed, /editorSession\.getModelByCanonicalKey/);
  assert.match(delayed, /currentModel\s*!==\s*currentEditor\.getModel\(\)/);
});

test('native Monaco migration preserves the only renderer write boundary and safe new logs', async () => {
  const fileNames = [
    'App.tsx',
    'main.tsx',
    'LocalMonacoEditor.tsx',
    'monaco-editor-session.ts',
    'vscode-runtime.ts'
  ];
  const sources = new Map(
    await Promise.all(fileNames.map(async (fileName) => [fileName, await rendererSource(fileName)]))
  );
  const appSource = sources.get('App.tsx');
  const saveFunction = getRegion(appSource, 'async function saveCurrentFile()', 'function closeOpenFile(');

  assert.equal(countMatches(appSource, /window\.workstation\.writeFile\s*\(/g), 1);
  assert.equal(countMatches(saveFunction, /window\.workstation\.writeFile\s*\(/g), 1);
  for (const fileName of fileNames.slice(1)) {
    assert.doesNotMatch(sources.get(fileName), /window\.workstation\.writeFile/);
  }

  for (const fileName of [
    'main.tsx',
    'LocalMonacoEditor.tsx',
    'vscode-runtime.ts'
  ]) {
    assertNoRawErrorConsoleArgument(sources.get(fileName), fileName);
  }
});

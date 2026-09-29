import { initialize } from '@codingame/monaco-vscode-api';
import getConfigurationServiceOverride, {
  initUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override';
import getFilesServiceOverride from '@codingame/monaco-vscode-files-service-override';
import getHostServiceOverride from '@codingame/monaco-vscode-host-service-override';
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override';
import getTextMateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import {
  ThemeSettingDefaults
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService';
import editorWorker from '@codingame/monaco-vscode-api/workers/editor.worker?worker';
import textMateWorker from '@codingame/monaco-vscode-textmate-service-override/worker?worker';

let coreRuntimeReady: Promise<void> | null = null;

export function initializeVsCodeCoreRuntime(): Promise<void> {
  coreRuntimeReady ??= initializeCoreRuntime();
  return coreRuntimeReady;
}

async function initializeCoreRuntime(): Promise<void> {
  window.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === 'TextMateWorker') {
        return new textMateWorker();
      }

      return new editorWorker();
    }
  };

  await initUserConfiguration(
    JSON.stringify(
      {
        'editor.fontSize': 13,
        'editor.fontFamily': 'Cascadia Code, JetBrains Mono, Consolas, monospace',
        'editor.lineHeight': 21,
        'editor.minimap.enabled': true,
        'editor.scrollBeyondLastLine': false,
        'editor.smoothScrolling': true,
        'editor.wordWrap': 'off',
        'editor.letterSpacing': 0,
        'workbench.colorTheme': ThemeSettingDefaults.COLOR_THEME_DARK
      },
      null,
      2
    )
  );

  await initialize({
    ...getConfigurationServiceOverride(),
    ...getThemeServiceOverride(),
    ...getFilesServiceOverride(),
    ...getHostServiceOverride(),
    ...getQuickAccessServiceOverride(),
    ...getTextMateServiceOverride()
  });
}

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { normalizePath, type Plugin } from 'vite';

function monacoVscodeInternalResolver(): Plugin {
  const packagePrefix = '@codingame/monaco-vscode-api/vscode/';
  const packageRoot = resolve('node_modules/@codingame/monaco-vscode-api/vscode/src');

  return {
    name: 'monaco-vscode-internal-resolver',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith(packagePrefix)) {
        return null;
      }

      const internalPath = source.slice(packagePrefix.length);
      const resolvedPath = resolve(packageRoot, internalPath);
      const candidates = [`${resolvedPath}.js`, resolvedPath, resolve(resolvedPath, 'index.js')];
      const candidate = candidates.find((path) => existsSync(path));

      // Vite 内部统一使用正斜杠模块 ID。Windows 绝对路径若直接返回反斜杠，
      // 同一 VS Code 源文件可能因“裸模块导入”和“相对导入”被识别为两个模块实例。
      return candidate ? normalizePath(candidate) : null;
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // preload 必须先于页面脚本同步注入 bridge，避免 ESM 异步求值造成启动竞态。
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    server: {
      port: 5174,
      strictPort: true
    },
    worker: {
      format: 'es'
    },
    plugins: [monacoVscodeInternalResolver(), react()]
  }
});

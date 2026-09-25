#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDirectory);
const command = process.argv[2] || 'start';

const agentServiceUrl = process.env.AI_BACKEND_URL || 'https://woodwry.cn';
const javaAnalyzerUrl = process.env.JAVA_ANALYZER_URL
  || process.env.AI_JAVA_ANALYZER_URL
  || 'https://woodwry.cn/java-analyzer';
const quickStartCommand = 'npx @woodwry/ai-unit-test-workstation';

if (command === '--help' || command === '-h') {
  console.log(`AI Unit Test Workstation

Usage:
  ${quickStartCommand}
  ${quickStartCommand} -- dev

The client connects to:
  Agent Service: ${agentServiceUrl}
  Java Analyzer: ${javaAnalyzerUrl}`);
  process.exit(0);
}

const requestedMode = command === 'dev' ? 'dev' : 'start';
const builtMainPath = join(packageRoot, 'out', 'main', 'index.js');
const mode = requestedMode === 'start' && !existsSync(builtMainPath) ? 'dev' : requestedMode;

if (requestedMode === 'start' && mode === 'dev') {
  console.log('[AI Unit Test Workstation] 未检测到构建产物，正在从源码启动客户端。');
}

const remoteEnvironment = {
  ...process.env,
  AI_UNIT_TEST_REMOTE_BACKEND: 'true',
  AI_BACKEND_URL: agentServiceUrl,
  JAVA_ANALYZER_URL: javaAnalyzerUrl
};

const child = mode === 'dev'
  ? spawn(process.execPath, [join(packageRoot, 'scripts', 'run-electron-vite.mjs'), 'dev'], {
      cwd: packageRoot,
      env: remoteEnvironment,
      stdio: 'inherit'
    })
  : spawn(require('electron'), [packageRoot], {
      cwd: packageRoot,
      env: remoteEnvironment,
      stdio: 'inherit'
    });

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[AI Unit Test Workstation] 启动失败：' + error.message);
  process.exit(1);
});

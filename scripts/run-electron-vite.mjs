import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Electron forwards UTF-8 bytes to the inherited console. Chinese Windows
// PowerShell 5/CMD consoles otherwise decode those bytes with code page 936.
if (process.platform === 'win32') {
  const chcp = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'chcp.com');
  // Inherit stdin so Windows changes this console, not a detached helper console.
  const result = spawnSync(chcp, ['65001'], { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true });
  if (result.error || result.status !== 0) {
    // Headless/redirected launches may have no console; keep their UTF-8 pipes usable.
    process.stderr.write('[workstation] Could not select console UTF-8; set the terminal encoding to UTF-8 if needed.\n');
  }
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('electron-vite/package.json'));
// Keep argv, inherited environment, signals and electron-vite's launch behavior.
await import(pathToFileURL(join(packageRoot, 'bin', 'electron-vite.js')).href);

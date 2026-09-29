import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

/** Windows 文件复制使用 CF_HDROP；仅在用户执行粘贴时读取文件路径。 */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $items = @(Get-Clipboard -Format FileDropList -ErrorAction Stop | ForEach-Object { $_.FullName }); ConvertTo-Json -InputObject $items -Compress'
  ], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  const paths: unknown = JSON.parse(stdout.trim() || '[]');
  if (!Array.isArray(paths) || paths.length > 500 || paths.some(value => typeof value !== 'string' || value.length > 32767)) throw new Error('剪贴板文件列表无效');
  return paths;
}

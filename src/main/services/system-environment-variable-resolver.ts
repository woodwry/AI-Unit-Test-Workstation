import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_ENVIRONMENT_REGISTRY_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
] as const;

type ResolveEnvironmentVariableOptions = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readWindowsPersistedEnvironmentVariable?: (name: string) => Promise<string | undefined>;
};

export async function resolveSystemEnvironmentVariable(
  name: string,
  options: ResolveEnvironmentVariableOptions = {}
): Promise<string | undefined> {
  const normalizedName = name.trim();
  if (!ENVIRONMENT_VARIABLE_PATTERN.test(normalizedName)) return undefined;
  const processValue = (options.environment ?? process.env)[normalizedName]?.trim();
  if ((options.platform ?? process.platform) !== 'win32') {
    return processValue || undefined;
  }
  const readPersisted = options.readWindowsPersistedEnvironmentVariable ?? readWindowsPersistedEnvironmentVariable;
  const persistedValue = (await readPersisted(normalizedName))?.trim();
  return persistedValue || processValue || undefined;
}

async function readWindowsPersistedEnvironmentVariable(name: string): Promise<string | undefined> {
  for (const registryKey of WINDOWS_ENVIRONMENT_REGISTRY_KEYS) {
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        ['query', registryKey, '/v', name],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 }
      );
      const value = parseRegistryValue(String(stdout), name);
      if (value?.trim()) return value;
    } catch {
      // Missing keys and values are expected; continue with the next persisted scope.
    }
  }
  return undefined;
}

function parseRegistryValue(output: string, name: string): string | undefined {
  const expectedName = name.toLocaleLowerCase();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+(REG_(?:SZ|EXPAND_SZ))\s+(.*?)\s*$/i);
    if (match?.[1]?.toLocaleLowerCase() === expectedName) return match[3];
  }
  return undefined;
}

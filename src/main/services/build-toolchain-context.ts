import type {
  BuildSettingsValidationResult,
  BuildToolchainContext
} from '../../shared/types.ts';

const TOOLCHAIN_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+()\-]{0,127}$/;

export function extractBuildToolchainContext(
  validation: Pick<
    BuildSettingsValidationResult,
    'valid' | 'javaVersion' | 'mavenVersion'
  >
): BuildToolchainContext | null {
  if (!validation.valid) return null;
  const javaVersion = validation.javaVersion?.trim() ?? '';
  const mavenVersion = validation.mavenVersion?.trim() ?? '';
  if (
    !TOOLCHAIN_VERSION_PATTERN.test(javaVersion)
    || !TOOLCHAIN_VERSION_PATTERN.test(mavenVersion)
  ) {
    return null;
  }
  return { javaVersion, mavenVersion };
}

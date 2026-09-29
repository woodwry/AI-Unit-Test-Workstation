/**
 * Environment variables that must not be inherited by Maven child processes.
 * The active interface is resolved in the Electron main process, so only the
 * user-selected variable needs to be excluded here. API keys are never put in
 * the child environment.
 */
export function modelCredentialEnvironmentVariables(customName?: string): string[] {
  const normalized = customName?.trim();
  return normalized ? [normalized] : [];
}

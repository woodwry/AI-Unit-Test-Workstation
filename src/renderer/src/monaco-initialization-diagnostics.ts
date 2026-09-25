import {
  getSafeRendererErrorFingerprint,
  getSafeRendererErrorType
} from './renderer-safe-error.ts';

export type MonacoInitializationStage =
  | 'core-runtime'
  | 'theme-registration'
  | 'java-language-registration'
  | 'java-configuration'
  | 'java-tokenizer'
  | 'editor-create'
  | 'attach-callback'
  | 'reconcile'
  | 'local-decoration';

export const MONACO_STAGE_EVENT: Record<MonacoInitializationStage, string> = {
  'core-runtime': 'MONACO_CORE_RUNTIME_FAILURE',
  'theme-registration': 'MONACO_THEME_REGISTRATION_FAILURE',
  'java-language-registration': 'MONACO_JAVA_LANGUAGE_REGISTRATION_FAILURE',
  'java-configuration': 'MONACO_JAVA_CONFIGURATION_FAILURE',
  'java-tokenizer': 'MONACO_JAVA_TOKENIZER_FAILURE',
  'editor-create': 'MONACO_EDITOR_CREATE_FAILURE',
  'attach-callback': 'MONACO_EDITOR_ATTACH_CALLBACK_FAILURE',
  reconcile: 'MONACO_EDITOR_RECONCILE_FAILURE',
  'local-decoration': 'MONACO_LOCAL_DECORATION_FAILURE'
};

export class MonacoInitializationFailure extends Error {
  readonly stage: MonacoInitializationStage;

  constructor(stage: MonacoInitializationStage, cause: unknown) {
    super('Monaco initialization stage failed', { cause });
    this.name = 'MonacoInitializationFailure';
    this.stage = stage;
  }
}

export function toMonacoInitializationFailure(
  stage: MonacoInitializationStage,
  error: unknown
): MonacoInitializationFailure {
  return error instanceof MonacoInitializationFailure
    ? error
    : new MonacoInitializationFailure(stage, error);
}

export function getMonacoFailureCause(error: unknown): unknown {
  return error instanceof MonacoInitializationFailure ? error.cause : error;
}

export function reportMonacoStageFailure(
  stage: MonacoInitializationStage,
  error: unknown
): void {
  const cause = getMonacoFailureCause(error);
  console.error(
    `[renderer] ${MONACO_STAGE_EVENT[stage]}`,
    getSafeRendererErrorType(cause),
    getSafeRendererErrorFingerprint(cause)
  );
}

export function runMonacoStage<T>(
  stage: MonacoInitializationStage,
  operation: () => T
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MonacoInitializationFailure) throw error;
    reportMonacoStageFailure(stage, error);
    throw toMonacoInitializationFailure(stage, error);
  }
}

export async function runMonacoStageAsync<T>(
  stage: MonacoInitializationStage,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MonacoInitializationFailure) throw error;
    reportMonacoStageFailure(stage, error);
    throw toMonacoInitializationFailure(stage, error);
  }
}

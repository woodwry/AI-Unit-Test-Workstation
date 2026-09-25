export class ClassTaskApplicationInterruptedError extends Error {
  constructor() {
    super('Class task was interrupted because the Workstation is closing.');
    this.name = 'ClassTaskApplicationInterruptedError';
  }
}

export class ClassTaskPauseRequestedError extends Error {
  constructor() {
    super('Class task pause requested.');
    this.name = 'ClassTaskPauseRequestedError';
  }
}

export function isClassTaskApplicationInterruptedError(
  error: unknown
): error is ClassTaskApplicationInterruptedError {
  return error instanceof ClassTaskApplicationInterruptedError
    || (error instanceof Error && error.name === 'ClassTaskApplicationInterruptedError');
}

export function isClassTaskPauseRequestedError(
  error: unknown
): error is ClassTaskPauseRequestedError {
  return error instanceof ClassTaskPauseRequestedError
    || (error instanceof Error && error.name === 'ClassTaskPauseRequestedError');
}

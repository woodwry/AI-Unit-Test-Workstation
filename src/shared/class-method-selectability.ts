import type { ClassMethodSummary } from './class-task-contracts.ts';

type MethodCoverageTargetCounts = Pick<
  ClassMethodSummary,
  'lineCovered' | 'lineMissed' | 'branchCovered' | 'branchMissed'
>;

type MethodGenerationAvailability = Pick<ClassMethodSummary, 'generatable'>;

export function hasMethodCoverageTargets(method: MethodCoverageTargetCounts): boolean {
  return method.lineCovered + method.lineMissed > 0
    || method.branchCovered + method.branchMissed > 0;
}

export function isMethodSelectable(
  method: MethodCoverageTargetCounts & MethodGenerationAvailability
): boolean {
  return method.generatable && hasMethodCoverageTargets(method);
}

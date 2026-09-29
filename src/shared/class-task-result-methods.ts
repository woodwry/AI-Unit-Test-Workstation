import type {
  ClassTaskResultMethod,
  GeneratedClassTaskArtifact
} from './class-task-contracts.ts';

export function generatedResultMethodsFromArtifacts(
  artifacts: readonly GeneratedClassTaskArtifact[]
): ClassTaskResultMethod[] {
  return aggregateClassTaskResultMethods(artifacts.flatMap((artifact) => (
    (artifact.methodResults ?? []).map((method) => ({
      ...method,
      artifactId: artifact.id,
      filePath: artifact.filePath,
      testClassName: artifact.testClassName
    }))
  ))).sort((left, right) => (
    left.jacocoOrder - right.jacocoOrder
    || left.methodName.localeCompare(right.methodName)
  ));
}

export function aggregateClassTaskResultMethods(
  methods: readonly ClassTaskResultMethod[]
): ClassTaskResultMethod[] {
  const aggregated: ClassTaskResultMethod[] = [];
  const indexesByMethodId = new Map<string, number>();
  for (const method of methods) {
    const existingIndex = indexesByMethodId.get(method.methodId);
    if (existingIndex === undefined) {
      indexesByMethodId.set(method.methodId, aggregated.length);
      aggregated.push({ ...method });
      continue;
    }
    const existing = aggregated[existingIndex];
    if (
      existing.methodName !== method.methodName
      || existing.displaySignature !== method.displaySignature
    ) {
      throw new Error('Split formal artifacts contain inconsistent source method identity.');
    }
    aggregated[existingIndex] = {
      ...existing,
      jacocoOrder: Math.min(existing.jacocoOrder, method.jacocoOrder),
      ordinaryTestMethodCount: (
        existing.ordinaryTestMethodCount + method.ordinaryTestMethodCount
      )
    };
  }
  return aggregated;
}

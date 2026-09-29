import type {
  ClassTaskResultSnapshot,
  ClassTaskSnapshot,
  GeneratedClassTaskArtifact
} from '../../../shared/class-task-contracts';
import { aggregateClassTaskResultMethods } from '../../../shared/class-task-result-methods.ts';

export type ClassTaskResultMethodRow = {
  rowId: string;
  methodName: string;
  displaySignature: string;
  jacocoOrder: number | null;
  orderLabel: string;
  filePath: string;
  fileName: string;
  testClassName: string;
  testMethodCount: number;
  legacy: boolean;
};

export type ClassTaskResultSummary = {
  generatedMethodCount: number;
  generatedTestMethodCount: number;
  formalFileCount: number;
};

export type ClassTaskResultProgressView = {
  heading: string;
  description: string;
  methodCountLabel: string;
  totalMethodCount: number;
};

const MISSING_RESULT_TEST_FILE_MESSAGE = '测试文件不存在，请恢复文件后重试。';

export function normalizeClassTaskResultActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('测试文件不存在')
    ? MISSING_RESULT_TEST_FILE_MESSAGE
    : message;
}

export function buildClassTaskResultMethodRows(
  result: ClassTaskResultSnapshot,
  query = ''
): ClassTaskResultMethodRow[] {
  const generatedMethods = aggregateClassTaskResultMethods(result.generatedMethods);
  const rows = generatedMethods.length > 0
    ? generatedMethods.map((method) => ({
        rowId: `${method.artifactId}:${method.methodId}`,
        methodName: method.methodName,
        displaySignature: method.displaySignature,
        jacocoOrder: method.jacocoOrder,
        orderLabel: String(method.jacocoOrder + 1),
        filePath: method.filePath,
        fileName: fileNameOf(method.filePath),
        testClassName: method.testClassName,
        testMethodCount: method.ordinaryTestMethodCount,
        legacy: false
      }))
    : result.artifacts.map(legacyArtifactRow);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((row) => (
    row.methodName.toLocaleLowerCase().includes(normalizedQuery)
    || row.displaySignature.toLocaleLowerCase().includes(normalizedQuery)
    || row.fileName.toLocaleLowerCase().includes(normalizedQuery)
  ));
}

export function buildClassTaskResultSummary(
  result: ClassTaskResultSnapshot
): ClassTaskResultSummary {
  const generatedMethods = aggregateClassTaskResultMethods(result.generatedMethods);
  return {
    generatedMethodCount: generatedMethods.length > 0
      ? generatedMethods.length
      : new Set(result.artifacts.flatMap((artifact) => artifact.methodIds)).size,
    generatedTestMethodCount: result.artifacts.reduce(
      (sum, artifact) => sum + artifact.ordinaryTestMethodCount,
      0
    ),
    formalFileCount: result.artifacts.length
  };
}

export function buildClassTaskResultProgress(
  task: Pick<
    ClassTaskSnapshot,
    'state' | 'methodOrder' | 'coveredMethodIds' | 'currentMethodIndex'
  >,
  result: ClassTaskResultSnapshot,
  summary: ClassTaskResultSummary
): ClassTaskResultProgressView {
  const totalMethodCount = task.methodOrder.length > 0
    ? task.methodOrder.length
    : summary.generatedMethodCount;
  const recordedCompletedMethodCount = Math.max(
    0,
    Math.min(task.currentMethodIndex + 1, totalMethodCount)
  );
  const coveredMethodIds = new Set(task.coveredMethodIds ?? []);
  const coverageCompletedMethodCount = task.methodOrder.reduce(
    (count, methodId) => count + (coveredMethodIds.has(methodId) ? 1 : 0),
    0
  );
  const completedMethodCount = task.state === 'COMPLETED'
    ? totalMethodCount
    : Math.max(recordedCompletedMethodCount, coverageCompletedMethodCount);
  const completedMethodFraction = totalMethodCount > 0
    ? `${completedMethodCount}/${totalMethodCount} 个方法`
    : `${completedMethodCount} 个方法`;
  const resultMethodFraction = totalMethodCount > 0
    ? `${summary.generatedMethodCount}/${totalMethodCount} 个方法`
    : `${summary.generatedMethodCount} 个方法`;
  const methodCountLabel = totalMethodCount > 0
    ? `${summary.generatedMethodCount} / ${totalMethodCount} 已有结果`
    : `${summary.generatedMethodCount} 个已有结果`;

  let description: string;
  if (task.state === 'TERMINATED') {
    description = `已保留 ${result.artifacts.length} 个正式文件`;
  } else if (result.allScenariosSkipped === true) {
    description = '未生成测试，全部场景已跳过';
  } else {
    const resultLabel = task.state === 'COMPLETED' ? '已有结果' : '已有阶段结果';
    const stagedResultDescription = summary.generatedMethodCount === completedMethodCount
      ? ''
      : `，${resultMethodFraction}${resultLabel}`;
    description = `${completedMethodFraction}已完成${stagedResultDescription}，${summary.generatedTestMethodCount} 个测试已通过 Maven 验证`;
  }

  return {
    heading: resultHeadingFor(task.state),
    description,
    methodCountLabel,
    totalMethodCount
  };
}

function resultHeadingFor(state: ClassTaskSnapshot['state']): string {
  switch (state) {
    case 'COMPLETED': return '生成已完成';
    case 'TERMINATED': return '生成已终止';
    case 'RUNNING': return '生成进行中';
    case 'PAUSE_REQUESTED': return '正在暂停生成';
    case 'PAUSED': return '生成已暂停';
    case 'STOPPING': return '正在终止生成';
    case 'PRELOADING': return '正在准备生成';
    case 'READY': return '等待生成';
    case 'PRELOAD_FAILED': return '预加载失败';
    case 'FAILED': return '生成失败';
    case 'INTERRUPTED': return '生成已中断';
  }
}

function legacyArtifactRow(artifact: GeneratedClassTaskArtifact): ClassTaskResultMethodRow {
  return {
    rowId: `legacy:${artifact.id}`,
    methodName: '历史结果',
    displaySignature: '旧版本结果未保存方法签名',
    jacocoOrder: null,
    orderLabel: '—',
    filePath: artifact.filePath,
    fileName: fileNameOf(artifact.filePath),
    testClassName: artifact.testClassName,
    testMethodCount: artifact.ordinaryTestMethodCount,
    legacy: true
  };
}

function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

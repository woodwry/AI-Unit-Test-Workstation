import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ClassTaskResultPage } from '../../../src/renderer/src/class-tasks/ClassTaskResultPage';
import type { ClassTaskResultSnapshot, ClassTaskSnapshot, ClassTaskState } from '../../../src/shared/class-task-contracts';

const artifact = {
  id: 'artifact-1', filePath: 'D:/fixture/src/test/TaskService1Test.java',
  testClassName: 'TaskService1Test', ordinaryTestMethodCount: 1, methodIds: ['method-a'],
  sha256: 'a'.repeat(64), sealed: true, accepted: false,
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z'
};
const initialTask: ClassTaskSnapshot = {
  id: '11111111-1111-4111-8111-111111111111', workspaceRoot: 'D:/fixture',
  sourceFilePath: 'D:/fixture/src/TaskService.java', qualifiedClassName: 'example.TaskService',
  moduleKey: 'core', moduleDisplayPath: 'collection-core', state: 'RUNNING', preloadState: 'READY',
  ragEnabled: true, repairAttemptLimit: 6, unlimitedRepair: false, selectionMode: 'EXPLICIT',
  selectedMethodIds: ['method-a'], methodOrder: ['method-a'], coveredMethodIds: [],
  currentMethodIndex: 0, currentAtomicStep: 'MAVEN_COMPILE', activeGenerationBatch: null,
  tokenUsage: null, modelCallCount: 0, usageReportedCallCount: 0,
  generatedArtifacts: [artifact], coverageBaseline: null, coverageCurrent: null, coverageContributions: [],
  completionAttentionPending: false, startedAt: '2026-10-06T00:00:00.000Z',
  pausedAt: null, finishedAt: null, lastError: null, updatedAt: '2026-10-06T00:00:00.000Z'
};
const initialResult: ClassTaskResultSnapshot = {
  taskId: initialTask.id, state: 'COMPLETED', artifacts: [artifact], generatedMethods: [],
  tokenUsage: null, modelCallCount: 0, usageReportedCallCount: 0,
  coverageBaseline: null, coverageCurrent: null, coverageContributions: [], canAccept: true, canRevoke: true
};

function ResultActionsFixture(): JSX.Element {
  const [task, setTask] = useState(initialTask);
  const [result, setResult] = useState(initialResult);
  Object.assign(window, {
    updateResultActionState: (state: ClassTaskState, resultState?: ClassTaskState) => {
      setTask(current => ({ ...current, state }));
      if (resultState) setResult(current => ({ ...current, state: resultState }));
    }
  });
  return <ClassTaskResultPage task={task} result={result} actionBusy={false} actionError={null}
    onBack={() => {}} onAccept={() => Object.assign(window, { lastResultAction: 'accept' })}
    onRevoke={() => Object.assign(window, { lastResultAction: 'revoke' })} />;
}

createRoot(document.getElementById('root')!).render(<ResultActionsFixture />);

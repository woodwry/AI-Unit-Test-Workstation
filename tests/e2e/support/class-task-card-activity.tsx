import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ClassTaskCard } from '../../../src/renderer/src/class-tasks/ClassTaskCard';
import type { ClassTaskSnapshot } from '../../../src/shared/class-task-contracts';

const initialTask: ClassTaskSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceRoot: 'D:/fixture',
  sourceFilePath: 'D:/fixture/src/TaskService.java',
  qualifiedClassName: 'example.TaskService',
  moduleKey: 'core',
  moduleDisplayPath: 'collection-core',
  state: 'RUNNING',
  preloadState: 'READY',
  repairAttemptLimit: 5,
  unlimitedRepair: false,
  selectionMode: 'EXPLICIT',
  selectedMethodIds: ['method-a'],
  methodOrder: ['method-a'],
  currentMethodIndex: -1,
  currentAtomicStep: 'MODEL_GENERATION',
  activeGenerationBatch: { methodCount: 1, scenarioCount: 25 },
  generatedArtifacts: [],
  coverageBaseline: null,
  coverageCurrent: null,
  coverageContributions: [],
  completionAttentionPending: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  lastError: null,
  updatedAt: new Date().toISOString()
};

function ActivityFixture(): JSX.Element {
  const [task, setTask] = useState(initialTask);
  Object.assign(window, {
    updateTaskCard: (patch: Partial<ClassTaskSnapshot>) => setTask((current) => ({ ...current, ...patch }))
  });
  return <ClassTaskCard task={task} attentionAcknowledged={false} commandBusy={false} onIntent={() => {}} />;
}

createRoot(document.getElementById('root')!).render(<ActivityFixture />);

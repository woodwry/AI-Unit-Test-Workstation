import type { WorkspaceWorkbenchTabState } from '../../../shared/types';

export type SourceWorkbenchTab = {
  kind: 'source';
  id: `source:${string}`;
  filePath: string;
};

export type MethodConfigurationWorkbenchTab = {
  kind: 'method_configuration';
  id: `methods:${string}`;
  taskId: string;
  sourceFilePath: string;
  qualifiedClassName: string;
};

export type RagMethodWorkbenchTab = {
  kind: 'rag_method';
  id: `rag:${string}`;
  entryId: string;
  methodId: string;
  ownerFqn: string;
  methodName: string;
  canonicalSignature: string;
};

export type WorkbenchTab = SourceWorkbenchTab | MethodConfigurationWorkbenchTab | RagMethodWorkbenchTab;

export function openRagMethodTab(
  state: WorkbenchTabs,
  method: Omit<RagMethodWorkbenchTab, 'kind' | 'id'>
): WorkbenchTabs {
  return openTab(state, { ...method, kind: 'rag_method', id: `rag:${method.entryId}:${method.methodId}` });
}

export function closeRagMethodTabs(state: WorkbenchTabs, target: { entryId: string; methodId?: string }): WorkbenchTabs {
  for (const tab of state.items) {
    if (tab.kind === 'rag_method' && tab.entryId === target.entryId
        && (!target.methodId || tab.methodId === target.methodId)) {
      state = closeWorkbenchTab(state, tab.id);
    }
  }
  return state;
}

export type WorkbenchTabs = {
  items: WorkbenchTab[];
  activeId: WorkbenchTab['id'] | null;
};

type SourceTabTarget = {
  sourceFilePath: string;
};

type MethodConfigurationTabTarget = SourceTabTarget & {
  id: string;
  qualifiedClassName: string;
};

export function createEmptyWorkbenchTabs(): WorkbenchTabs {
  return { items: [], activeId: null };
}

export function restorePersistedWorkbenchTabs(input: {
  persistedTabs?: readonly WorkspaceWorkbenchTabState[];
  availableSourceFilePaths: readonly string[];
  activeId?: string;
}): WorkbenchTabs {
  const availableSources = new Set(input.availableSourceFilePaths);
  const persistedTabs = input.persistedTabs ?? input.availableSourceFilePaths.map((filePath) => ({
    kind: 'source' as const,
    filePath
  }));
  let restored = createEmptyWorkbenchTabs();
  for (const tab of persistedTabs) {
    if (tab.kind === 'source') {
      if (availableSources.has(tab.filePath)) {
        restored = openSourceTab(restored, { sourceFilePath: tab.filePath });
      }
      continue;
    }
    restored = openMethodConfigurationTab(restored, {
      id: tab.taskId,
      sourceFilePath: tab.sourceFilePath,
      qualifiedClassName: tab.qualifiedClassName
    });
  }
  return input.activeId
    ? activateWorkbenchTab(restored, input.activeId as WorkbenchTab['id'])
    : restored;
}

export function openSourceTab(state: WorkbenchTabs, target: SourceTabTarget): WorkbenchTabs {
  const id = `source:${target.sourceFilePath}` as const;
  const item: SourceWorkbenchTab = {
    kind: 'source',
    id,
    filePath: target.sourceFilePath
  };

  return openTab(state, item);
}

export function openMethodConfigurationTab(
  state: WorkbenchTabs,
  target: MethodConfigurationTabTarget
): WorkbenchTabs {
  const id = `methods:${target.id}` as const;
  const item: MethodConfigurationWorkbenchTab = {
    kind: 'method_configuration',
    id,
    taskId: target.id,
    sourceFilePath: target.sourceFilePath,
    qualifiedClassName: target.qualifiedClassName
  };

  return openTab(state, item);
}

export function activateWorkbenchTab(state: WorkbenchTabs, id: WorkbenchTab['id']): WorkbenchTabs {
  if (state.activeId === id || !state.items.some((item) => item.id === id)) {
    return state;
  }
  return { ...state, activeId: id };
}

export function closeWorkbenchTab(state: WorkbenchTabs, id: WorkbenchTab['id']): WorkbenchTabs {
  const closingIndex = state.items.findIndex((item) => item.id === id);
  if (closingIndex === -1) {
    return state;
  }

  const items = state.items.filter((item) => item.id !== id);
  if (state.activeId !== id) {
    return { ...state, items };
  }

  const nextActive = items[closingIndex] ?? items[closingIndex - 1] ?? null;
  return {
    items,
    activeId: nextActive?.id ?? null
  };
}

function openTab(state: WorkbenchTabs, item: WorkbenchTab): WorkbenchTabs {
  if (state.items.some((candidate) => candidate.id === item.id)) {
    return state.activeId === item.id ? state : { ...state, activeId: item.id };
  }

  return {
    items: [...state.items, item],
    activeId: item.id
  };
}

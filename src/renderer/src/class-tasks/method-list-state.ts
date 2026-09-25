import type { ClassMethodCatalog, ClassMethodSummary } from '../../../shared/class-task-contracts';

export type MethodSortKey =
  | 'jacoco'
  | 'name'
  | 'uncovered_instructions'
  | 'instruction_coverage'
  | 'uncovered_branches'
  | 'branch_coverage'
  | 'uncovered_complexity'
  | 'total_complexity'
  | 'uncovered_lines'
  | 'total_lines';
export type MethodSortDirection = 'asc' | 'desc';

export type MethodListState = {
  methods: ClassMethodSummary[];
  query: string;
  sortKey: MethodSortKey;
  sortDirection: MethodSortDirection;
  selectedMethodIds: string[];
};

export function createMethodListState(
  catalog: Pick<ClassMethodCatalog, 'methods'>,
  selectedMethodIds?: readonly string[]
): MethodListState {
  const methods = catalog.methods;
  const selectableIds = new Set(methods.filter((method) => method.generatable).map((method) => method.methodId));
  const selection = selectedMethodIds === undefined
    ? []
    : unique(selectedMethodIds.filter((methodId) => selectableIds.has(methodId)));

  return {
    methods,
    query: '',
    sortKey: 'jacoco',
    sortDirection: 'asc',
    selectedMethodIds: selection
  };
}

export function refreshMethodListState(
  state: MethodListState,
  catalog: Pick<ClassMethodCatalog, 'methods'>
): MethodListState {
  const selectableIds = new Set(
    catalog.methods
      .filter((method) => method.generatable)
      .map((method) => method.methodId)
  );
  return {
    ...state,
    methods: catalog.methods,
    selectedMethodIds: state.selectedMethodIds.filter((methodId) => selectableIds.has(methodId))
  };
}

export function setMethodQuery(state: MethodListState, query: string): MethodListState {
  return state.query === query ? state : { ...state, query };
}

export function setMethodSort(
  state: MethodListState,
  sortKey: MethodSortKey,
  sortDirection: MethodSortDirection
): MethodListState {
  return state.sortKey === sortKey && state.sortDirection === sortDirection
    ? state
    : { ...state, sortKey, sortDirection };
}

export function visibleMethodIds(state: MethodListState): string[] {
  const query = state.query.trim().toLocaleLowerCase();
  return sortedMethods(state)
    .filter((method) => {
      if (!query) return true;
      const searchable = method.methodName.toLocaleLowerCase();
      return searchable.includes(query);
    })
    .map((method) => method.methodId);
}

export function selectAllMethods(state: MethodListState): MethodListState {
  const selectedMethodIds = sortedMethods(state)
    .filter((method) => method.generatable)
    .map((method) => method.methodId);
  const allSelected = areAllMethodsSelected(state);
  return { ...state, selectedMethodIds: allSelected ? [] : selectedMethodIds };
}

export function areAllMethodsSelected(state: MethodListState): boolean {
  const selectableMethodIds = state.methods
    .filter((method) => method.generatable)
    .map((method) => method.methodId);
  if (selectableMethodIds.length === 0) return false;
  const selected = new Set(state.selectedMethodIds);
  return selectableMethodIds.every((methodId) => selected.has(methodId));
}

export function clearMethodSelection(state: MethodListState): MethodListState {
  return state.selectedMethodIds.length === 0 ? state : { ...state, selectedMethodIds: [] };
}

export function toggleMethodSelection(state: MethodListState, methodId: string): MethodListState {
  const method = state.methods.find((candidate) => candidate.methodId === methodId);
  if (!method?.generatable) {
    return state;
  }

  const selected = new Set(state.selectedMethodIds);
  if (selected.has(methodId)) {
    selected.delete(methodId);
  } else {
    selected.add(methodId);
  }

  return { ...state, selectedMethodIds: [...selected] };
}

export function selectedMethodOrder(state: MethodListState): string[] {
  const selected = new Set(state.selectedMethodIds);
  return sortedMethods(state)
    .filter((method) => selected.has(method.methodId))
    .map((method) => method.methodId);
}

export function sortedMethods(state: MethodListState): ClassMethodSummary[] {
  return sortMethods(state.methods, state.sortKey, state.sortDirection);
}

export function sortMethods(
  methods: readonly ClassMethodSummary[],
  key: MethodSortKey,
  direction: MethodSortDirection
): ClassMethodSummary[] {
  return [...methods].sort((left, right) => {
    const primary = compareByKey(left, right, key);

    if (primary !== 0) {
      return direction === 'asc' ? primary : -primary;
    }
    return left.jacocoOrder - right.jacocoOrder;
  });
}

function compareByKey(
  left: ClassMethodSummary,
  right: ClassMethodSummary,
  key: MethodSortKey
): number {
  switch (key) {
    case 'jacoco':
      return left.jacocoOrder - right.jacocoOrder;
    case 'name':
      return left.displaySignature.localeCompare(right.displaySignature, 'zh-CN', {
        sensitivity: 'base'
      });
    case 'uncovered_instructions':
      return left.instructionMissed - right.instructionMissed;
    case 'instruction_coverage':
      return coverageRatio(left.instructionCovered, left.instructionMissed)
        - coverageRatio(right.instructionCovered, right.instructionMissed);
    case 'uncovered_branches':
      return left.branchMissed - right.branchMissed;
    case 'branch_coverage':
      return coverageRatio(left.branchCovered, left.branchMissed)
        - coverageRatio(right.branchCovered, right.branchMissed);
    case 'uncovered_complexity':
      return left.complexityMissed - right.complexityMissed;
    case 'total_complexity':
      return (left.complexityCovered + left.complexityMissed)
        - (right.complexityCovered + right.complexityMissed);
    case 'uncovered_lines':
      return left.lineMissed - right.lineMissed;
    case 'total_lines':
      return (left.lineCovered + left.lineMissed) - (right.lineCovered + right.lineMissed);
  }
}

function coverageRatio(covered: number, missed: number): number {
  const total = covered + missed;
  return total === 0 ? -1 : covered / total;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

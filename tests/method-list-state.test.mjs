import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areAllMethodsSelected,
  clearMethodSelection,
  createMethodListState,
  selectedMethodOrder,
  selectAllMethods,
  setMethodQuery,
  setMethodSort,
  toggleMethodSelection,
  visibleMethodIds
} from '../src/renderer/src/class-tasks/method-list-state.ts';
import * as methodListState from '../src/renderer/src/class-tasks/method-list-state.ts';

const METHODS = [
  method('saveTask', '(Ljava/lang/String;)V', 2, 3, 1),
  method('getChildZipFile', '()V', 0, 8, 4),
  method('deleteTask', '()V', 3, 1, 0),
  method('getChildZipFile', '(I)V', 1, 5, 2)
];

function method(methodName, descriptor, jacocoOrder, lineMissed, branchMissed) {
  return {
    methodId: `${methodName}:${descriptor}`,
    methodName,
    descriptor,
    displaySignature: `${methodName}${descriptor}`,
    firstLine: 10 + jacocoOrder * 10,
    lastLine: 19 + jacocoOrder * 10,
    jacocoOrder,
    lineCovered: 1,
    lineMissed,
    branchCovered: 0,
    branchMissed,
    instructionCovered: 10,
    instructionMissed: lineMissed * 2,
    complexityCovered: 2,
    complexityMissed: branchMissed + 1,
    coverageGap: lineMissed + branchMissed > 0,
    generatable: true,
    unavailableReason: null,
    modifiers: ['public']
  };
}

test('default order follows the JaCoCo report while the initial selection stays empty', () => {
  const state = createMethodListState({ methods: METHODS });
  assert.deepEqual(state.selectedMethodIds, []);
  assert.equal(areAllMethodsSelected(state), false);
  assert.deepEqual(visibleMethodIds(state), [
    'getChildZipFile:()V',
    'getChildZipFile:(I)V',
    'saveTask:(Ljava/lang/String;)V',
    'deleteTask:()V'
  ]);

  const queried = setMethodQuery(state, 'ZIPfile');
  assert.deepEqual(visibleMethodIds(queried), [
    'getChildZipFile:()V',
    'getChildZipFile:(I)V'
  ]);
  assert.deepEqual(queried.selectedMethodIds, state.selectedMethodIds);
});

test('method lists start empty and select every generatable method only after an explicit select-all action', () => {
  const unavailable = {
    ...method('nativeOnly', '()V', 4, 1, 0),
    generatable: false,
    unavailableReason: 'Analyzer could not resolve the method'
  };
  const catalog = { methods: [...METHODS, unavailable] };

  const initiallyEmpty = createMethodListState(catalog);
  assert.deepEqual(initiallyEmpty.selectedMethodIds, []);
  assert.equal(areAllMethodsSelected(initiallyEmpty), false);

  const explicitEmpty = createMethodListState(catalog, []);
  assert.deepEqual(explicitEmpty.selectedMethodIds, []);
  assert.equal(areAllMethodsSelected(explicitEmpty), false);

  const allSelected = selectAllMethods(initiallyEmpty);
  assert.deepEqual(allSelected.selectedMethodIds, [
    'getChildZipFile:()V',
    'getChildZipFile:(I)V',
    'saveTask:(Ljava/lang/String;)V',
    'deleteTask:()V'
  ]);
  assert.equal(areAllMethodsSelected(allSelected), true);

  const afterManualCancellation = toggleMethodSelection(allSelected, METHODS[0].methodId);
  assert.equal(afterManualCancellation.selectedMethodIds.includes(METHODS[0].methodId), false);
  assert.equal(afterManualCancellation.selectedMethodIds.length, METHODS.length - 1);
  assert.equal(areAllMethodsSelected(afterManualCancellation), false);
});

test('method query matches case-insensitive continuous method-name text only', () => {
  const parameterOnlyMatch = {
    ...method('importExcelBatch', '(Ljava/util/Map;)V', 0, 1, 0),
    displaySignature: 'importExcelBatch(File, String, Map<Integer,List<String>>)'
  };
  const methodNameMatch = {
    ...method('getWorkbook', '()V', 1, 1, 0),
    displaySignature: 'getWorkbook()'
  };
  const nonContiguousMatch = {
    ...method('findAllTaskByTaskGroupTemplate', '()V', 2, 1, 0),
    displaySignature: 'findAllTaskByTaskGroupTemplate()'
  };
  const state = createMethodListState({
    methods: [parameterOnlyMatch, methodNameMatch, nonContiguousMatch]
  });

  assert.deepEqual(visibleMethodIds(setMethodQuery(state, 'GET')), [methodNameMatch.methodId]);
  assert.deepEqual(visibleMethodIds(setMethodQuery(state, 'gwb')), []);
});

test('default order matches JaCoCo report order instead of re-sorting by coverage metrics', () => {
  const catalogOrderedMethods = [
    method('smallGap', '()V', 0, 1, 0),
    method('largeGap', '()V', 1, 9, 0),
    method('mediumGap', '()V', 2, 4, 0)
  ];

  const state = createMethodListState({ methods: catalogOrderedMethods });

  assert.equal(state.sortKey, 'jacoco');
  assert.equal(state.sortDirection, 'asc');
  assert.deepEqual(visibleMethodIds(state), [
    'smallGap:()V',
    'largeGap:()V',
    'mediumGap:()V'
  ]);
});

test('refreshing method coverage keeps the current view and selections that still exist', () => {
  let current = createMethodListState(
    { methods: METHODS },
    ['getChildZipFile:()V', 'deleteTask:()V']
  );
  current = setMethodQuery(current, 'child');
  current = setMethodSort(current, 'uncovered_lines', 'desc');
  const refreshedMethods = [
    { ...METHODS[1], lineCovered: 7, lineMissed: 1 },
    method('newMethod', '()V', 1, 2, 0)
  ];

  const refreshed = typeof methodListState.refreshMethodListState === 'function'
    ? methodListState.refreshMethodListState(current, { methods: refreshedMethods })
    : null;

  assert.deepEqual(refreshed, {
    methods: refreshedMethods,
    query: 'child',
    sortKey: 'uncovered_lines',
    sortDirection: 'desc',
    selectedMethodIds: ['getChildZipFile:()V']
  });
});

test('fully covered methods remain visible and selectable like the JaCoCo report', () => {
  const fullyCovered = method('fullyCovered', '()V', 4, 0, 0);
  const analyzerReportedGap = {
    ...method('analyzerReportedGap', '()V', 5, 0, 0),
    coverageGap: true
  };
  const state = createMethodListState(
    { methods: [...METHODS, fullyCovered, analyzerReportedGap] },
    [fullyCovered.methodId, analyzerReportedGap.methodId]
  );

  assert.equal(fullyCovered.coverageGap, false);
  assert.deepEqual(
    visibleMethodIds(state),
    [
      'getChildZipFile:()V',
      'getChildZipFile:(I)V',
      'saveTask:(Ljava/lang/String;)V',
      'deleteTask:()V',
      fullyCovered.methodId,
      analyzerReportedGap.methodId
    ]
  );
  assert.deepEqual(state.selectedMethodIds, [fullyCovered.methodId, analyzerReportedGap.methodId]);

  const selected = selectAllMethods(clearMethodSelection(state));
  assert.equal(selected.selectedMethodIds.includes(fullyCovered.methodId), true);
  assert.equal(selected.selectedMethodIds.length, METHODS.length + 2);
});

test('all JaCoCo metric sort keys order rows and retain JaCoCo order for ties', () => {
  const state = createMethodListState({ methods: METHODS });

  assert.deepEqual(
    visibleMethodIds(setMethodSort(state, 'uncovered_instructions', 'desc')),
    ['getChildZipFile:()V', 'getChildZipFile:(I)V', 'saveTask:(Ljava/lang/String;)V', 'deleteTask:()V']
  );
  assert.deepEqual(
    visibleMethodIds(setMethodSort(state, 'uncovered_complexity', 'asc')),
    ['deleteTask:()V', 'saveTask:(Ljava/lang/String;)V', 'getChildZipFile:(I)V', 'getChildZipFile:()V']
  );
  assert.deepEqual(
    visibleMethodIds(setMethodSort(state, 'total_lines', 'desc')),
    ['getChildZipFile:()V', 'getChildZipFile:(I)V', 'saveTask:(Ljava/lang/String;)V', 'deleteTask:()V']
  );
});

test('select all toggles the full catalog rather than only filtered rows', () => {
  const filtered = clearMethodSelection(setMethodQuery(
    createMethodListState({ methods: METHODS }),
    'delete'
  ));

  const selected = selectAllMethods(filtered);

  assert.equal(selected.selectedMethodIds.length, METHODS.length);
  assert.deepEqual(visibleMethodIds(selected), ['deleteTask:()V']);
  assert.deepEqual(selectAllMethods(selected).selectedMethodIds, []);
});

test('sort order controls execution order while selection toggles stay immutable', () => {
  const initial = clearMethodSelection(createMethodListState({ methods: METHODS }));
  const selected = toggleMethodSelection(
    toggleMethodSelection(initial, 'saveTask:(Ljava/lang/String;)V'),
    'getChildZipFile:()V'
  );
  const sorted = setMethodSort(selected, 'uncovered_lines', 'desc');

  assert.deepEqual(selectedMethodOrder(sorted), [
    'getChildZipFile:()V',
    'saveTask:(Ljava/lang/String;)V'
  ]);
  assert.deepEqual(initial.selectedMethodIds, []);
});

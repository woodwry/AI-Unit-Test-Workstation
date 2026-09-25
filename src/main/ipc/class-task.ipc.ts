import { resolve } from 'node:path';

import {
  CLASS_TASK_CHANNELS,
  type AcceptClassTaskRequest,
  type AddClassTasksRequest,
  type CheckClassTaskMethodsRequest,
  type GetClassTaskMethodsRequest,
  type GetClassTaskResultRequest,
  type ListClassTasksRequest,
  type PauseClassTaskRequest,
  type RemoveClassTaskRequest,
  type ReorderClassTasksRequest,
  type ResumeClassTaskRequest,
  type RetryModulePreloadRequest,
  type RevokeClassTaskRequest,
  type RunAllClassTasksRequest,
  type RunClassTaskRequest,
  type SaveMethodSelectionRequest,
  type StopModulePreloadRequest,
  type TerminateAllClassTasksRequest,
  type TerminateClassTaskRequest,
  type WorkspaceRequest
} from '../../shared/class-task-contracts.ts';
import {
  validateAcceptClassTaskRequest,
  validateAddClassTasksRequest,
  validateCheckClassTaskMethodsRequest,
  validateGetClassTaskMethodsRequest,
  validateGetClassTaskResultRequest,
  validateListClassTasksRequest,
  validatePauseClassTaskRequest,
  validateRemoveClassTaskRequest,
  validateReorderClassTasksRequest,
  validateResumeClassTaskRequest,
  validateRetryModulePreloadRequest,
  validateRevokeClassTaskRequest,
  validateRunAllClassTasksRequest,
  validateRunClassTaskRequest,
  validateSaveMethodSelectionRequest,
  validateStopModulePreloadRequest,
  validateTerminateAllClassTasksRequest,
  validateTerminateClassTaskRequest
} from '../services/class-task-ipc-validation.ts';
import type { ClassTaskRuntimeService } from '../services/class-task-runtime.service.ts';

type IpcInvokeEvent = unknown;
type IpcHandler = (event: IpcInvokeEvent, request: unknown) => unknown;

export type ClassTaskIpcMainPort = {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
};

export type ClassTaskIpcRuntimePort = Pick<
  ClassTaskRuntimeService,
  | 'addClassTasks'
  | 'removeClassTask'
  | 'reorderClassTasks'
  | 'listClassTasks'
  | 'getClassTaskMethods'
  | 'checkClassTaskMethods'
  | 'saveMethodSelection'
  | 'runTask'
  | 'pauseTask'
  | 'resumeTask'
  | 'terminateTask'
  | 'runAll'
  | 'terminateAll'
  | 'getTaskResult'
  | 'acceptTaskResult'
  | 'revokeTaskResult'
  | 'retryModulePreload'
  | 'stopModulePreload'
>;

export type ClassTaskIpcDependencies = {
  ipcMain: ClassTaskIpcMainPort;
  runtime: ClassTaskIpcRuntimePort;
  isTrustedSender(event: IpcInvokeEvent): boolean;
  getActiveWorkspaceRoot(): string | null;
  isShuttingDown?(): boolean;
};

type RequestValidator<T extends WorkspaceRequest> = (request: unknown) => T;

/** Registers the frozen class-task surface without exposing Electron primitives. */
export function registerClassTaskIpc(dependencies: ClassTaskIpcDependencies): () => void {
  const registered: string[] = [];
  const handle = <T extends WorkspaceRequest, R>(
    channel: string,
    validate: RequestValidator<T>,
    run: (request: T) => R | Promise<R>
  ): void => {
    dependencies.ipcMain.removeHandler(channel);
    dependencies.ipcMain.handle(channel, async (event, rawRequest) => {
      if (!dependencies.isTrustedSender(event)) {
        throw new Error('拒绝来自不受信任页面的请求（untrusted IPC sender）。');
      }
      const request = validate(rawRequest);
      assertActiveWorkspace(request.workspaceRoot, dependencies.getActiveWorkspaceRoot());
      try {
        return await run(request);
      } catch (error) {
        if (dependencies.isShuttingDown?.() && isExpectedShutdownAbort(error)) {
          return undefined as R;
        }
        throw error;
      }
    });
    registered.push(channel);
  };

  handle(CLASS_TASK_CHANNELS.add, validateAddClassTasksRequest,
    (request: AddClassTasksRequest) => dependencies.runtime.addClassTasks(request));
  handle(CLASS_TASK_CHANNELS.remove, validateRemoveClassTaskRequest,
    (request: RemoveClassTaskRequest) => dependencies.runtime.removeClassTask(request));
  handle(CLASS_TASK_CHANNELS.reorder, validateReorderClassTasksRequest,
    (request: ReorderClassTasksRequest) => dependencies.runtime.reorderClassTasks(request));
  handle(CLASS_TASK_CHANNELS.list, validateListClassTasksRequest,
    (request: ListClassTasksRequest) => dependencies.runtime.listClassTasks(request));
  handle(CLASS_TASK_CHANNELS.getMethods, validateGetClassTaskMethodsRequest,
    (request: GetClassTaskMethodsRequest) => dependencies.runtime.getClassTaskMethods(request));
  handle(CLASS_TASK_CHANNELS.checkMethods, validateCheckClassTaskMethodsRequest,
    (request: CheckClassTaskMethodsRequest) => dependencies.runtime.checkClassTaskMethods(request));
  handle(CLASS_TASK_CHANNELS.saveSelection, validateSaveMethodSelectionRequest,
    (request: SaveMethodSelectionRequest) => dependencies.runtime.saveMethodSelection(request));
  handle(CLASS_TASK_CHANNELS.run, validateRunClassTaskRequest,
    (request: RunClassTaskRequest) => dependencies.runtime.runTask(request));
  handle(CLASS_TASK_CHANNELS.pause, validatePauseClassTaskRequest,
    (request: PauseClassTaskRequest) => dependencies.runtime.pauseTask(request));
  handle(CLASS_TASK_CHANNELS.resume, validateResumeClassTaskRequest,
    (request: ResumeClassTaskRequest) => dependencies.runtime.resumeTask(request));
  handle(CLASS_TASK_CHANNELS.terminate, validateTerminateClassTaskRequest,
    (request: TerminateClassTaskRequest) => dependencies.runtime.terminateTask(request));
  handle(CLASS_TASK_CHANNELS.runAll, validateRunAllClassTasksRequest,
    (request: RunAllClassTasksRequest) => dependencies.runtime.runAll(request));
  handle(CLASS_TASK_CHANNELS.terminateAll, validateTerminateAllClassTasksRequest,
    (request: TerminateAllClassTasksRequest) => dependencies.runtime.terminateAll(request));
  handle(CLASS_TASK_CHANNELS.getResult, validateGetClassTaskResultRequest,
    (request: GetClassTaskResultRequest) => dependencies.runtime.getTaskResult(request));
  handle(CLASS_TASK_CHANNELS.accept, validateAcceptClassTaskRequest,
    (request: AcceptClassTaskRequest) => dependencies.runtime.acceptTaskResult(request));
  handle(CLASS_TASK_CHANNELS.revoke, validateRevokeClassTaskRequest,
    (request: RevokeClassTaskRequest) => dependencies.runtime.revokeTaskResult(request));
  handle(CLASS_TASK_CHANNELS.retryModulePreload, validateRetryModulePreloadRequest,
    (request: RetryModulePreloadRequest) => dependencies.runtime.retryModulePreload(request));
  handle(CLASS_TASK_CHANNELS.stopModulePreload, validateStopModulePreloadRequest,
    (request: StopModulePreloadRequest) => dependencies.runtime.stopModulePreload(request));

  return () => {
    for (const channel of registered) dependencies.ipcMain.removeHandler(channel);
  };
}

function assertActiveWorkspace(requested: string, active: string | null): void {
  if (!active || pathKey(requested) !== pathKey(active)) {
    throw new Error('请求工作区不是当前工作区（active workspace mismatch）。');
  }
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isExpectedShutdownAbort(error: unknown): boolean {
  return error instanceof Error && error.message === '生成已停止。';
}

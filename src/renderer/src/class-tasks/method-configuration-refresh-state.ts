import type { ClassTaskSnapshot } from '../../../shared/class-task-contracts';

export function methodCoverageRefreshBlockReason(state: ClassTaskSnapshot['state']): string | null {
  if (state === 'PRELOADING') {
    return '正在预加载方法与覆盖率信息，暂时不能手动刷新。';
  }
  if (['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'STOPPING'].includes(state)) {
    return '任务执行或暂停期间不能手动刷新，正式文件生成后的覆盖率会自动更新。';
  }
  return null;
}

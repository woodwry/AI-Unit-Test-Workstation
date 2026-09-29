import type { ModelInterfaceView } from '../../shared/types';

export function filterModelInterfaces(
  items: ModelInterfaceView[],
  query: string
): ModelInterfaceView[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return items;
  return items.filter((item) => [
    item.name,
    item.model,
    item.baseUrl,
    item.credentialMode === 'direct' ? 'API Key' : '环境变量',
    item.environmentVariableName ?? ''
  ].some((value) => value.toLocaleLowerCase().includes(normalized)));
}

export function clampSelectedIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(index, 0), count - 1);
}

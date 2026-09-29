import type { ModelTokenUsage } from '../../shared/types';

export type TokenUsageDisplay = {
  input: string;
  output: string;
  total: string;
};

const TOKEN_NUMBER = new Intl.NumberFormat('en-US');
const UNREPORTED = '未上报';

function formatTokenValue(value: number | null | undefined): string {
  return Number.isSafeInteger(value) && value != null && value >= 0
    ? TOKEN_NUMBER.format(value)
    : UNREPORTED;
}

export function resolveTokenUsageDisplay(
  usage?: ModelTokenUsage,
  modelCallCount?: number,
  usageReportedCallCount?: number
): TokenUsageDisplay {
  if (modelCallCount === 0) {
    return { input: '0', output: '0', total: '0' };
  }
  if (
    modelCallCount !== undefined
    && modelCallCount > 0
    && usageReportedCallCount === 0
  ) {
    return {
      input: UNREPORTED,
      output: UNREPORTED,
      total: UNREPORTED
    };
  }
  return {
    input: formatTokenValue(usage?.inputTokens),
    output: formatTokenValue(usage?.outputTokens),
    total: formatTokenValue(usage?.totalTokens)
  };
}

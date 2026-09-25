/** 大模型供应商实际返回的 Token 用量；缺失指标保持 null。 */
export type ModelTokenUsage = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

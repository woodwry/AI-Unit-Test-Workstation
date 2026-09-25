// 保存或删除期间保持弹窗打开，避免用户丢失凭证草稿或错过最终结果。
export function canCloseModelSettings(mutationBusy: boolean): boolean {
  return !mutationBusy;
}

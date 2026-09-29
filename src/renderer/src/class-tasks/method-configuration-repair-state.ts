export type RepairConfigurationResolution =
  | {
      valid: true;
      repairAttemptLimit: number | null;
      unlimitedRepair: boolean;
    }
  | {
      valid: false;
      message: string;
    };

export function resolveRepairConfiguration(
  rawLimit: string,
  unlimitedRepair: boolean
): RepairConfigurationResolution {
  if (unlimitedRepair) {
    return { valid: true, repairAttemptLimit: null, unlimitedRepair: true };
  }
  if (rawLimit.trim() === '') {
    return { valid: false, message: '请填写修复轮次或勾选无限制' };
  }
  const repairAttemptLimit = Number(rawLimit);
  if (!Number.isSafeInteger(repairAttemptLimit) || repairAttemptLimit < 1) {
    return { valid: false, message: '修复轮次必须是正整数' };
  }
  return { valid: true, repairAttemptLimit, unlimitedRepair: false };
}

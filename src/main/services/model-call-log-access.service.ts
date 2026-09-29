import type { AuthState } from '../../shared/auth-contracts.ts';
import type {
  ModelCallLogSettings,
  SaveModelCallLogSettingsRequest
} from '../../shared/types.ts';

type AuthStateProvider = Readonly<{
  getState(): AuthState;
}>;

type ModelCallLogSettingsStore = Readonly<{
  get(): Promise<ModelCallLogSettings>;
  save(request: SaveModelCallLogSettingsRequest): Promise<ModelCallLogSettings>;
}>;

const DISABLED_MODEL_CALL_LOG_SETTINGS: ModelCallLogSettings = Object.freeze({
  enabled: false
});

export function canManageModelCallLogs(state: AuthState): boolean {
  return state.status === 'disabled'
    || (state.status === 'authenticated' && state.user?.role === 'ADMIN');
}

/**
 * Keeps model-call logs behind the main-process authorization boundary.
 * Runtime callers receive a disabled setting for ordinary users even when an
 * older local preference still has logging enabled.
 */
export class ModelCallLogAccessService {
  private readonly settings: ModelCallLogSettingsStore;
  private readonly auth: AuthStateProvider;

  constructor(
    settings: ModelCallLogSettingsStore,
    auth: AuthStateProvider
  ) {
    this.settings = settings;
    this.auth = auth;
  }

  async get(): Promise<ModelCallLogSettings> {
    if (!canManageModelCallLogs(this.auth.getState())) {
      return DISABLED_MODEL_CALL_LOG_SETTINGS;
    }
    return this.settings.get();
  }

  async getForManagement(): Promise<ModelCallLogSettings> {
    this.assertCanManage();
    return this.settings.get();
  }

  async saveForManagement(
    request: SaveModelCallLogSettingsRequest
  ): Promise<ModelCallLogSettings> {
    this.assertCanManage();
    return this.settings.save(request);
  }

  assertCanManage(): void {
    if (!canManageModelCallLogs(this.auth.getState())) {
      throw new Error('只有管理员可以管理模型调用记录。');
    }
  }
}

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AdminUser,
  AuthState,
  CreateUserRequest,
  LoginRequest,
  UpdateUserRequest
} from '../../shared/auth-contracts.ts';
import type { CredentialCipher } from './credential-cipher.ts';
import {
  AiClient,
  RemoteAuthError,
  type RemoteAuthSession
} from './ai-client.ts';

type PersistedRefreshSession = Readonly<{
  version: 3;
  endpointHash: string;
  encryptedRefreshToken: string;
  rememberedUntilEpochMs: number;
}>;

type RestoredRefreshSession = Readonly<{
  refreshToken: string;
}>;

type AuthSessionServiceOptions = Readonly<{
  client: AiClient;
  storagePath: string;
  cipher: CredentialCipher;
  authenticationEnabled?: () => boolean;
  now?: () => number;
}>;

const REFRESH_EARLY_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;
const INVALID_EXPIRY_REFRESH_DELAY_MS = 5 * 60_000;
const REMEMBER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthSessionService {
  private readonly client: AiClient;
  private readonly storagePath: string;
  private readonly cipher: CredentialCipher;
  private readonly authenticationEnabled: () => boolean;
  private readonly now: () => number;
  private state: AuthState = { status: 'restoring', user: null };
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private rememberSession = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<AuthState> | null = null;
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(options: AuthSessionServiceOptions) {
    this.client = options.client;
    this.storagePath = options.storagePath;
    this.cipher = options.cipher;
    this.authenticationEnabled = options.authenticationEnabled ?? (() => true);
    this.now = options.now ?? Date.now;
    this.client.setUserAccessTokenProvider(() => this.accessToken);
    this.client.setUserAuthFailureHandler((code) => {
      if (code === 'ACCOUNT_UNAVAILABLE') {
        this.accessToken = null;
        this.cancelRefreshTimer();
        this.setState({ status: 'account-unavailable', user: null });
      } else if (code === 'SESSION_EXPIRED' && this.refreshToken) {
        void this.refreshSession().catch(() => undefined);
      }
    });
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<AuthState> {
    if (!this.authenticationEnabled()) {
      return this.setState({ status: 'disabled', user: null });
    }
    const persisted = await this.readPersistedRefreshSession();
    if (!persisted) return this.setState({ status: 'anonymous', user: null });
    this.refreshToken = persisted.refreshToken;
    this.rememberSession = true;
    return this.retry();
  }

  async login(request: LoginRequest): Promise<AuthState> {
    try {
      const session = await this.client.loginUser(request.loginName.trim(), request.password);
      await this.acceptSession(session, request.rememberMe);
      return this.state;
    } catch (error) {
      if (isAccountUnavailable(error)) {
        await this.clearSession(false);
        return this.setState({ status: 'account-unavailable', user: null });
      }
      throw error;
    }
  }

  async retry(): Promise<AuthState> {
    if (!this.refreshToken) return this.setState({ status: 'anonymous', user: null });
    try {
      return await this.refreshSession();
    } catch (error) {
      if (this.rememberSession) {
        return this.setState({ status: 'server-unavailable', user: null });
      }
      throw error;
    }
  }

  async forget(): Promise<void> {
    await this.clearSession(true);
    this.setState({ status: 'anonymous', user: null });
  }

  async logout(): Promise<void> {
    const refreshToken = this.refreshToken;
    try {
      if (refreshToken) await this.client.logoutUser(refreshToken);
    } finally {
      await this.clearSession(true);
      this.setState({ status: 'anonymous', user: null });
    }
  }

  async recordTaskExecution(): Promise<void> {
    if (this.state.status !== 'authenticated') return;
    await this.client.recordTaskExecution();
  }

  async listUsers(): Promise<AdminUser[]> {
    this.requireAdmin();
    return await this.client.listUsers();
  }

  async createUser(request: CreateUserRequest): Promise<AdminUser> {
    this.requireAdmin();
    return await this.client.createUser(request);
  }

  async updateUser(request: UpdateUserRequest): Promise<AdminUser> {
    this.requireAdmin();
    const { id, ...changes } = request;
    const updated = await this.client.updateUser(id, changes);
    if (this.state.user?.id === updated.id) {
      if (typeof changes.password === 'string') {
        await this.clearSession(true);
        this.setState({ status: 'anonymous', user: null });
        return updated;
      }
      this.setState({ status: 'authenticated', user: updated });
    }
    return updated;
  }

  async deleteUser(id: string): Promise<boolean> {
    this.requireAdmin();
    return await this.client.deleteUser(id);
  }

  dispose(): void {
    this.cancelRefreshTimer();
    this.listeners.clear();
    this.accessToken = null;
    this.refreshToken = null;
  }

  private async refreshSession(): Promise<AuthState> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = this.refreshToken;
    if (!refreshToken) return this.setState({ status: 'anonymous', user: null });
    const refresh = this.performRefreshSession(refreshToken);
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  private async performRefreshSession(refreshToken: string): Promise<AuthState> {
    try {
      const session = await this.client.refreshUserSession(refreshToken);
      if (this.refreshToken !== refreshToken) return this.state;
      await this.acceptSession(session, this.rememberSession);
      return this.state;
    } catch (error) {
      if (this.refreshToken !== refreshToken) return this.state;
      if (isAccountUnavailable(error)) {
        this.accessToken = null;
        this.cancelRefreshTimer();
        return this.setState({ status: 'account-unavailable', user: null });
      }
      if (error instanceof RemoteAuthError && error.statusCode === 401) {
        await this.clearSession(true);
        return this.setState({ status: 'anonymous', user: null });
      }
      throw error;
    }
  }

  private async acceptSession(session: RemoteAuthSession, rememberSession: boolean): Promise<void> {
    if (session.user.isAvailable !== 1) {
      await this.clearSession(true);
      this.setState({ status: 'account-unavailable', user: null });
      return;
    }
    if (rememberSession) {
      await this.persistRefreshToken(session.refreshToken);
    } else {
      await this.removePersistedSession();
    }
    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
    this.rememberSession = rememberSession;
    this.scheduleRefresh(session.accessTokenExpiresAt);
    this.setState({ status: 'authenticated', user: session.user });
  }

  private scheduleRefresh(expiresAt: string): void {
    this.cancelRefreshTimer();
    const parsedExpiry = Date.parse(expiresAt);
    const delay = Number.isFinite(parsedExpiry)
      ? Math.max(MIN_REFRESH_DELAY_MS, parsedExpiry - Date.now() - REFRESH_EARLY_MS)
      : INVALID_EXPIRY_REFRESH_DELAY_MS;
    this.refreshTimer = setTimeout(() => {
      void this.refreshSession().catch(() => {
        // A transport failure keeps the current UI state; the next API call or
        // backend availability probe will expose the server outage.
      });
    }, delay);
    this.refreshTimer.unref?.();
  }

  private cancelRefreshTimer(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private requireAdmin(): void {
    if (this.state.status !== 'authenticated' || this.state.user?.role !== 'ADMIN') {
      throw new Error('需要管理员权限。');
    }
  }

  private setState(state: AuthState): AuthState {
    this.state = state;
    for (const listener of this.listeners) listener(state);
    return state;
  }

  private endpointHash(): string {
    const endpoint = this.client.getUserAuthenticationEndpoint()
      .trim().replace(/\/+$/, '').toLowerCase();
    return createHash('sha256').update(endpoint).digest('hex');
  }

  private async persistRefreshToken(refreshToken: string): Promise<void> {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法保存登录状态。');
    }
    const record: PersistedRefreshSession = {
      version: 3,
      endpointHash: this.endpointHash(),
      encryptedRefreshToken: this.cipher.encryptString(refreshToken).toString('base64'),
      rememberedUntilEpochMs: this.now() + REMEMBER_SESSION_MS
    };
    await fs.mkdir(dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  }

  private async readPersistedRefreshSession(): Promise<RestoredRefreshSession | null> {
    try {
      if (!this.cipher.isEncryptionAvailable()) return null;
      const raw = JSON.parse(await fs.readFile(this.storagePath, 'utf8')) as Partial<PersistedRefreshSession>;
      if (
        raw.version !== 3
        || raw.endpointHash !== this.endpointHash()
        || typeof raw.encryptedRefreshToken !== 'string'
        || typeof raw.rememberedUntilEpochMs !== 'number'
        || !Number.isFinite(raw.rememberedUntilEpochMs)
        || raw.rememberedUntilEpochMs <= this.now()
      ) {
        await this.removePersistedSession();
        return null;
      }
      return {
        refreshToken: this.cipher.decryptString(Buffer.from(raw.encryptedRefreshToken, 'base64'))
      };
    } catch {
      await this.removePersistedSession();
      return null;
    }
  }

  private async clearSession(removePersisted: boolean): Promise<void> {
    this.cancelRefreshTimer();
    this.accessToken = null;
    this.refreshToken = null;
    this.rememberSession = false;
    if (removePersisted) await this.removePersistedSession();
  }

  private async removePersistedSession(): Promise<void> {
    await fs.rm(this.storagePath, { force: true }).catch(() => undefined);
  }
}

function isAccountUnavailable(error: unknown): boolean {
  return error instanceof RemoteAuthError && error.code === 'ACCOUNT_UNAVAILABLE';
}

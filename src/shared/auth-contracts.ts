export type AuthUser = Readonly<{
  id: string;
  tenantId: string;
  loginName: string;
  role: 'ADMIN' | 'USER';
  isAvailable: 0 | 1;
  lastLoginAt: string | null;
}>;

export type AdminUser = AuthUser & Readonly<{
  loginCount: number;
  taskExecutionCount: number;
  lastLoginIp: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AuthState = Readonly<{
  status: 'disabled' | 'restoring' | 'anonymous' | 'authenticated' | 'account-unavailable' | 'server-unavailable';
  user: AuthUser | null;
}>;

export type LoginRequest = Readonly<{
  loginName: string;
  password: string;
  rememberMe: boolean;
}>;

export type CreateUserRequest = Readonly<{
  loginName: string;
  password: string;
  role: 'ADMIN' | 'USER';
  isAvailable: 0 | 1;
}>;

export type UpdateUserRequest = Readonly<{
  id: string;
  loginName?: string;
  password?: string;
  role?: 'ADMIN' | 'USER';
  isAvailable?: 0 | 1;
}>;

export type DeleteUserRequest = Readonly<{ id: string }>;

export const AUTH_CHANNELS = Object.freeze({
  state: 'auth:state',
  login: 'auth:login',
  logout: 'auth:logout',
  forget: 'auth:forget',
  retry: 'auth:retry',
  changed: 'auth:changed',
  listUsers: 'auth:admin:list-users',
  createUser: 'auth:admin:create-user',
  updateUser: 'auth:admin:update-user',
  deleteUser: 'auth:admin:delete-user'
});

export type AuthAppApi = {
  getAuthState: () => Promise<AuthState>;
  login: (request: LoginRequest) => Promise<AuthState>;
  logout: () => Promise<void>;
  forgetAuthentication: () => Promise<void>;
  retryAuthentication: () => Promise<AuthState>;
  onAuthStateChanged: (callback: (state: AuthState) => void) => () => void;
  listUsers: () => Promise<AdminUser[]>;
  createUser: (request: CreateUserRequest) => Promise<AdminUser>;
  updateUser: (request: UpdateUserRequest) => Promise<AdminUser>;
  deleteUser: (request: DeleteUserRequest) => Promise<boolean>;
};

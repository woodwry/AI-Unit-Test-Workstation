import { KeyRound, LockKeyhole, Mail, User } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AuthState } from '../../shared/auth-contracts';
import { BackendUnavailableView } from './BackendAvailabilityGate';

type AuthGateProps = Readonly<{ children: ReactNode; loading: ReactNode }>;
type AuthMode = 'login' | 'register';
type LoginFieldKey = 'loginName' | 'password';
type LoginFieldErrors = Partial<Record<LoginFieldKey, string>>;
type RegisterFieldKey = 'loginName' | 'email' | 'code' | 'password';
type RegisterFieldErrors = Partial<Record<RegisterFieldKey, string>>;

export function AuthGate({ children, loading }: AuthGateProps): JSX.Element {
  const [state, setState] = useState<AuthState>({ status: 'restoring', user: null });
  const [mode, setMode] = useState<AuthMode>('login');
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [loginFieldErrors, setLoginFieldErrors] = useState<LoginFieldErrors>({});
  const [registerLoginName, setRegisterLoginName] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerCode, setRegisterCode] = useState('');
  const [registerFieldErrors, setRegisterFieldErrors] = useState<RegisterFieldErrors>({});
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.workstation.onAuthStateChanged((nextState) => {
      if (!disposed) setState(nextState);
    });
    void window.workstation.getAuthState()
      .then(async (current) => {
        if (disposed) return;
        if (current.status === 'restoring') {
          const restored = await window.workstation.retryAuthentication();
          if (!disposed) setState(restored);
          return;
        }
        setState(current);
      })
      .catch(() => {
        if (!disposed) setState({ status: 'anonymous', user: null });
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (codeCooldown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setCodeCooldown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [codeCooldown]);

  const selectMode = useCallback((nextMode: AuthMode): void => {
    setMode(nextMode);
    setError('');
    setLoginFieldErrors({});
    setRegisterFieldErrors({});
  }, []);

  const clearLoginFieldError = useCallback((field: LoginFieldKey): void => {
    setLoginFieldErrors((current) => withoutLoginFieldError(current, field));
  }, []);

  const clearRegisterFieldError = useCallback((field: RegisterFieldKey): void => {
    setRegisterFieldErrors((current) => withoutRegisterFieldError(current, field));
  }, []);

  const submitLogin = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const nextFieldErrors = buildLoginFieldErrors({ loginName, password });
    setLoginFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;
    setSubmitting(true);
    try {
      const nextState = await window.workstation.login({ loginName, password, rememberMe });
      setPassword('');
      setLoginFieldErrors({});
      setState(nextState);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '';
      setError(message.includes('账号或密码错误') ? '账号或密码错误。' : '登录失败');
    } finally {
      setSubmitting(false);
    }
  }, [loginName, password, rememberMe, submitting]);

  const sendRegistrationCode = useCallback(async (): Promise<void> => {
    if (sendingCode || codeCooldown > 0) return;
    setError('');
    if (!registerEmail.trim()) {
      setRegisterFieldErrors((current) => ({ ...current, email: '请输入邮箱' }));
      return;
    }
    clearRegisterFieldError('email');
    setSendingCode(true);
    try {
      const response = await window.workstation.sendRegistrationEmailCode({ email: registerEmail });
      setCodeCooldown(response.resendAfterSeconds);
    } catch (failure) {
      setError(isEmailRegistrationServiceUnavailable(failure) ? '邮箱注册服务不可用' : authErrorMessage(failure, '验证码发送失败'));
    } finally {
      setSendingCode(false);
    }
  }, [clearRegisterFieldError, codeCooldown, registerEmail, sendingCode]);

  const submitRegistration = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setError('');
    const nextFieldErrors = buildRegisterFieldErrors({
      loginName: registerLoginName,
      email: registerEmail,
      code: registerCode,
      password: registerPassword
    });
    setRegisterFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;
    setSubmitting(true);
    try {
      const nextState = await window.workstation.registerWithEmail({
        loginName: registerLoginName,
        email: registerEmail,
        password: registerPassword,
        verificationCode: registerCode.trim(),
        rememberMe
      });
      setRegisterPassword('');
      setRegisterCode('');
      setRegisterFieldErrors({});
      setState(nextState);
    } catch (failure) {
      setError(isEmailRegistrationServiceUnavailable(failure) ? '邮箱注册服务不可用' : authErrorMessage(failure, '注册失败'));
    } finally {
      setSubmitting(false);
    }
  }, [registerCode, registerEmail, registerLoginName, registerPassword, rememberMe, submitting]);

  const returnToLogin = useCallback(async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    setError('');
    try {
      await window.workstation.forgetAuthentication();
      setState({ status: 'anonymous', user: null });
    } catch {
      setError('无法清除登录状态，请稍后重试。');
    } finally {
      setRetrying(false);
    }
  }, [retrying]);

  if (state.status === 'restoring') return <>{loading}</>;
  if (state.status === 'disabled' || state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'account-unavailable' || state.status === 'server-unavailable') {
    return (
      <BackendUnavailableView
        retrying={retrying}
        onRetry={() => void returnToLogin()}
        code="SERVER_UNAVAILABLE"
      />
    );
  }

  return (
    <div className="auth-login-screen">
      <main className="auth-login-page">
        <section className="auth-login-panel" aria-labelledby="auth-login-title">
          <div className="auth-login-mark" aria-hidden="true">
            <LockKeyhole size={22} strokeWidth={1.7} />
          </div>
          <h1 id="auth-login-title">{mode === 'login' ? '登录' : '邮箱注册'}</h1>
          <div className="auth-mode-tabs" role="tablist" aria-label="账号入口">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              onClick={() => selectMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              onClick={() => selectMode('register')}
            >
              注册
            </button>
          </div>
          {mode === 'login' ? (
            <form onSubmit={(event) => void submitLogin(event)}>
              <label className={authFieldClassName(loginFieldErrors.loginName)}>
                <User size={16} strokeWidth={1.6} aria-hidden="true" />
                <input
                  aria-label="用户名或邮箱"
                  autoFocus
                  autoComplete="username"
                  maxLength={255}
                  placeholder="用户名 / 邮箱"
                  value={loginName}
                  onChange={(event) => {
                    setLoginName(event.target.value);
                    clearLoginFieldError('loginName');
                  }}
                />
              </label>
              {loginFieldErrors.loginName && <AuthFieldError message={loginFieldErrors.loginName} />}
              <label className={authFieldClassName(loginFieldErrors.password)}>
                <LockKeyhole size={16} strokeWidth={1.6} aria-hidden="true" />
                <input
                  aria-label="密码"
                  autoComplete="current-password"
                  maxLength={1024}
                  placeholder="密码"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearLoginFieldError('password');
                  }}
                />
              </label>
              {loginFieldErrors.password && <AuthFieldError message={loginFieldErrors.password} />}
              <RememberMe checked={rememberMe} onChange={setRememberMe} />
              {error && <div className="auth-login-error" role="alert">{error}</div>}
              <button type="submit" disabled={submitting}>
                {submitting ? '正在登录…' : '登录'}
              </button>
            </form>
          ) : (
            <form onSubmit={(event) => void submitRegistration(event)}>
              <label className={authFieldClassName(registerFieldErrors.loginName)}>
                <User size={16} strokeWidth={1.6} aria-hidden="true" />
                <input
                  aria-label="用户名"
                  autoComplete="username"
                  maxLength={255}
                  placeholder="用户名"
                  value={registerLoginName}
                  onChange={(event) => {
                    setRegisterLoginName(event.target.value);
                    clearRegisterFieldError('loginName');
                  }}
                />
              </label>
              {registerFieldErrors.loginName && <AuthFieldError message={registerFieldErrors.loginName} />}
              <label className={authFieldClassName(registerFieldErrors.email)}>
                <Mail size={16} strokeWidth={1.6} aria-hidden="true" />
                <input
                  aria-label="邮箱"
                  autoComplete="email"
                  maxLength={255}
                  placeholder="邮箱"
                  type="email"
                  value={registerEmail}
                  onChange={(event) => {
                    setRegisterEmail(event.target.value);
                    clearRegisterFieldError('email');
                  }}
                />
              </label>
              {registerFieldErrors.email && <AuthFieldError message={registerFieldErrors.email} />}
              <label className={authFieldClassName(registerFieldErrors.code, 'auth-code-field')}>
                <KeyRound size={16} strokeWidth={1.6} aria-hidden="true" />
                <input
                  aria-label="验证码"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="验证码"
                  value={registerCode}
                  onChange={(event) => {
                    setRegisterCode(event.target.value);
                    clearRegisterFieldError('code');
                  }}
                />
                <button
                  type="button"
                  className="auth-code-button"
                  disabled={sendingCode || codeCooldown > 0}
                  onClick={() => void sendRegistrationCode()}
                >
                  {codeCooldown > 0 ? `${codeCooldown}s` : sendingCode ? '发送中' : '获取验证码'}
                </button>
              </label>
              {registerFieldErrors.code && <AuthFieldError message={registerFieldErrors.code} />}
              <label className={authFieldClassName(registerFieldErrors.password)}>
                <LockKeyhole size={16} strokeWidth={1.6} aria-hidden="true" />
                <input
                  aria-label="注册密码"
                  autoComplete="new-password"
                  maxLength={1024}
                  minLength={6}
                  placeholder="设置密码"
                  type="password"
                  value={registerPassword}
                  onChange={(event) => {
                    setRegisterPassword(event.target.value);
                    clearRegisterFieldError('password');
                  }}
                />
              </label>
              {registerFieldErrors.password && <AuthFieldError message={registerFieldErrors.password} />}
              <p className="auth-password-rule">密码至少 8 位，并且需要同时包含字母和数字。</p>
              <RememberMe checked={rememberMe} onChange={setRememberMe} />
              {error && <div className="auth-login-error" role="alert">{error}</div>}
              <button type="submit" disabled={submitting}>
                {submitting ? '正在注册…' : '注册并登录'}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}

function AuthFieldError({ message }: Readonly<{ message: string }>): JSX.Element {
  return (
    <div className="auth-field-error" role="alert">
      <span className="auth-field-error-mark" aria-hidden="true">!</span>
      <span>{message}</span>
    </div>
  );
}

function RememberMe({
  checked,
  onChange
}: Readonly<{ checked: boolean; onChange: (value: boolean) => void }>): JSX.Element {
  return (
    <label className="auth-remember-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>记住我</span>
    </label>
  );
}

function authFieldClassName(error: string | undefined, extraClassName = ''): string {
  return ['auth-login-field', extraClassName, error ? 'auth-field-invalid' : ''].filter(Boolean).join(' ');
}

function buildLoginFieldErrors(fields: Readonly<{
  loginName: string;
  password: string;
}>): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  if (!fields.loginName.trim()) errors.loginName = '请输入用户名或邮箱';
  if (!fields.password.trim()) errors.password = '请输入密码';
  return errors;
}
function buildRegisterFieldErrors(fields: Readonly<{
  loginName: string;
  email: string;
  code: string;
  password: string;
}>): RegisterFieldErrors {
  const errors: RegisterFieldErrors = {};
  if (!fields.loginName.trim()) errors.loginName = '请输入用户名';
  if (!fields.email.trim()) errors.email = '请输入邮箱';
  if (!fields.code.trim()) errors.code = '请输入验证码';
  if (!fields.password.trim()) errors.password = '请输入密码';
  return errors;
}

function withoutLoginFieldError(errors: LoginFieldErrors, field: LoginFieldKey): LoginFieldErrors {
  if (!errors[field]) return errors;
  const next = { ...errors };
  delete next[field];
  return next;
}

function withoutRegisterFieldError(errors: RegisterFieldErrors, field: RegisterFieldKey): RegisterFieldErrors {
  if (!errors[field]) return errors;
  const next = { ...errors };
  delete next[field];
  return next;
}

function authErrorMessage(failure: unknown, fallback: string): string {
  if (!(failure instanceof Error) || !failure.message.trim()) return fallback;
  return failure.message.endsWith('。') ? failure.message : `${failure.message}。`;
}

function isEmailRegistrationServiceUnavailable(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false;
  return /Error invoking remote method 'auth:register:(?:send-email-code|email)'|net::ERR_|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|Failed to fetch/i.test(failure.message);
}

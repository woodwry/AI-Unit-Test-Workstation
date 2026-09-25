import { Code2, LockKeyhole, User } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AuthState } from '../../shared/auth-contracts';
import { BackendUnavailableView } from './BackendAvailabilityGate';

type AuthGateProps = Readonly<{ children: ReactNode; loading: ReactNode }>;

export function AuthGate({ children, loading }: AuthGateProps): JSX.Element {
  const [state, setState] = useState<AuthState>({ status: 'restoring', user: null });
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const submit = useCallback(async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const nextState = await window.workstation.login({ loginName, password, rememberMe });
      setPassword('');
      setState(nextState);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '';
      setError(message.includes('账号或密码错误') ? '账号或密码错误。' : '登录失败');
    } finally {
      setSubmitting(false);
    }
  }, [loginName, password, rememberMe, submitting]);

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
      <div className="auth-login-titlebar">
        <Code2 size={13} aria-hidden="true" />
        <span>AI Unit Test Workstation</span>
      </div>
      <main className="auth-login-page">
        <section className="auth-login-panel" aria-labelledby="auth-login-title">
          <div className="auth-login-mark" aria-hidden="true">
            <LockKeyhole size={22} strokeWidth={1.7} />
          </div>
          <h1 id="auth-login-title">登录</h1>
          <form onSubmit={(event) => void submit(event)}>
            <label className="auth-login-field">
              <User size={16} strokeWidth={1.6} aria-hidden="true" />
              <input
                aria-label="账号"
                autoFocus
                autoComplete="username"
                maxLength={255}
                placeholder="账号"
                value={loginName}
                onChange={(event) => setLoginName(event.target.value)}
              />
            </label>
            <label className="auth-login-field">
              <LockKeyhole size={16} strokeWidth={1.6} aria-hidden="true" />
              <input
                aria-label="密码"
                autoComplete="current-password"
                maxLength={1024}
                placeholder="密码"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label className="auth-remember-row">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              <span>记住我</span>
            </label>
            {error && <div className="auth-login-error" role="alert">{error}</div>}
            <button
              type="submit"
              disabled={submitting}
            >
              {submitting ? '正在登录…' : '登录'}
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';

export function Login() {
  const qc = useQueryClient();
  const methods = useQuery({ queryKey: ['authMethods'], queryFn: api.authMethods, retry: false, staleTime: Infinity });
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const m = methods.data;
  const registering = mode === 'register' && !!m?.registration;

  const submit = async () => {
    if (registering && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await (registering ? api.register(username, password) : api.passwordLogin(username, password));
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
    setConfirm('');
  };

  return (
    <div className="login">
      <div className="login-card">
        <img className="brand-mark" src="/favicon.svg" alt="" />
        <h1>Ratatoskr</h1>
        <div className="muted">Your mail, from any IMAP server.</div>
        {methods.isLoading && <div className="muted">Loading…</div>}
        {methods.error && <div className="error-text">Could not reach the server: {(methods.error as Error).message}</div>}
        {m?.password && (
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              className="input"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Username"
              aria-label="Username"
              required
              maxLength={100}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <input
              className="input"
              type="password"
              name="password"
              autoComplete={registering ? 'new-password' : 'current-password'}
              placeholder="Password"
              aria-label="Password"
              required
              minLength={registering ? 10 : undefined}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {registering && (
              <input
                className="input"
                type="password"
                name="confirm"
                autoComplete="new-password"
                placeholder="Repeat password"
                aria-label="Repeat password"
                required
                maxLength={256}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
            {registering && <div className="hint">At least 10 characters.</div>}
            {error && (
              <div className="error-text" role="alert">
                {error}
              </div>
            )}
            <button className="btn primary" type="submit" disabled={busy}>
              {registering ? 'Create account' : 'Sign in'}
            </button>
            {m.registration && (
              <button type="button" className="btn ghost" onClick={() => switchMode(registering ? 'login' : 'register')}>
                {registering ? 'I already have an account' : 'Create an account'}
              </button>
            )}
          </form>
        )}
        {m?.password && (m.oidc || m.dev) && <div className="login-divider">or</div>}
        {m?.oidc && (
          <a className={`btn${m.password ? '' : ' primary'}`} href="/auth/login">
            Sign in with {m.oidc.label}
          </a>
        )}
        {m?.dev && !m.oidc && (
          <a className="btn" href="/auth/dev-login">
            Dev login
          </a>
        )}
      </div>
    </div>
  );
}

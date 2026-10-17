import { Mail } from 'lucide-react';

export function Login() {
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand-mark">
          <Mail size={26} />
        </div>
        <h1>Ratatoskr</h1>
        <div className="muted">Your mail, from any IMAP server.</div>
        <a className="btn primary" href="/auth/login">
          Sign in
        </a>
      </div>
    </div>
  );
}

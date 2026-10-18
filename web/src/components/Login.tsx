
export function Login() {
  return (
    <div className="login">
      <div className="login-card">
        <img className="brand-mark" src="/favicon.svg" alt="" />
        <h1>Ratatoskr</h1>
        <div className="muted">Your mail, from any IMAP server.</div>
        <a className="btn primary" href="/auth/login">
          Sign in
        </a>
      </div>
    </div>
  );
}

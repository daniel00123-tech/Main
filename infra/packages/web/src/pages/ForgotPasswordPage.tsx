import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const resetPath = useMemo(() => {
    if (!resetUrl) return null;
    try {
      const url = new URL(resetUrl);
      return `${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }, [resetUrl]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResetUrl(null);
    setExpiresAt(null);
    setMessage(null);
    try {
      const result = await api.requestPasswordReset(email.trim());
      setMessage(result.message);
      if (result.resetUrl) {
        setResetUrl(result.resetUrl);
        setExpiresAt(result.expiresAt ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to request password reset");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand-block" style={{ padding: 0 }}>
          <div className="brand-mark">IN</div>
          <div className="brand-text">
            <span className="brand-name">INFRA</span>
            <span className="brand-context">Company portal</span>
          </div>
        </div>
        <h1>Reset password</h1>
        <p className="muted">
          Enter your account email to generate a secure single-use link. Email delivery is not
          configured yet — copy the link shown on the next screen.
        </p>

        {resetUrl && resetPath ? (
          <div className="info-banner" style={{ marginBottom: 16 }}>
            <p style={{ margin: "0 0 8px" }}>{message}</p>
            <p className="small" style={{ margin: "0 0 8px", wordBreak: "break-all" }}>
              {resetUrl}
            </p>
            {expiresAt ? (
              <p className="muted small" style={{ margin: 0 }}>
                Expires {new Date(expiresAt).toLocaleString()}
              </p>
            ) : null}
          </div>
        ) : null}

        {!resetUrl ? (
          <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            {error ? <p className="error-text">{error}</p> : null}
            {message && !resetUrl ? <p className="muted small">{message}</p> : null}
            <button className="button button-primary" type="submit" disabled={loading}>
              {loading ? "Generating link…" : "Get reset link"}
            </button>
          </form>
        ) : resetPath ? (
          <Link to={resetPath} className="button button-primary">
            Set new password
          </Link>
        ) : null}

        <p className="muted small" style={{ marginTop: 20 }}>
          <Link to="/portal/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

import { FormEvent, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { InfraBrand } from "../components/InfraBrand";

export default function ForgotPasswordPage() {
  const emailId = useId();
  const statusId = useId();
  const errorId = useId();
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

  const completed = Boolean(message || resetUrl || error);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (loading || (completed && resetUrl)) return;
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

  const statusText = loading
    ? "Sending reset link…"
    : error
      ? error
      : resetUrl
        ? "Your password reset link is ready."
        : message
          ? message
          : "";

  return (
    <div className="login-page">
      <div className="login-card">
        <InfraBrand showStack context="Company portal" size={36} />
        <h1>Reset password</h1>
        <p className="login-intro">
          Enter your email address and we&apos;ll provide a secure link to choose a new password.
        </p>

        <p id={statusId} className="status-announcer sr-only" aria-live="polite" aria-atomic="true">
          {statusText}
        </p>

        {loading ? (
          <p className="info-banner" role="status" aria-labelledby={statusId}>
            Sending reset link…
          </p>
        ) : null}

        {error && !loading ? (
          <p id={errorId} className="error-box" role="alert">
            {error}
          </p>
        ) : null}

        {resetUrl && resetPath && !loading ? (
          <div className="info-banner success-banner" role="status">
            <p style={{ margin: "0 0 8px", fontWeight: 600 }}>Reset link ready</p>
            <p style={{ margin: "0 0 12px" }}>
              {message ??
                "Use the button below to set a new password. This link is single-use and expires soon."}
            </p>
            {expiresAt ? (
              <p className="small" style={{ margin: "0 0 12px", color: "var(--text-secondary)" }}>
                Expires {new Date(expiresAt).toLocaleString()}
              </p>
            ) : null}
            <Link to={resetPath} className="button button-primary">
              Set new password
            </Link>
          </div>
        ) : null}

        {message && !resetUrl && !loading && !error ? (
          <div className="info-banner success-banner" role="status">
            <p style={{ margin: 0 }}>{message}</p>
          </div>
        ) : null}

        {!resetUrl ? (
          <form className="login-form" onSubmit={(e) => void handleSubmit(e)} aria-busy={loading}>
            <label htmlFor={emailId}>
              Email
              <input
                id={emailId}
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                disabled={loading}
                required
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : statusId}
              />
            </label>
            <button
              className="button button-primary"
              type="submit"
              disabled={loading || !email.trim()}
            >
              {loading ? "Sending reset link…" : "Send reset link"}
            </button>
          </form>
        ) : null}

        <p className="muted small" style={{ marginTop: 20 }}>
          <Link to="/portal/login">Back to sign in</Link>
          {" · "}
          <Link to="/privacy">Privacy Policy</Link>
        </p>
      </div>
    </div>
  );
}

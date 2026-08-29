import { FormEvent, useId, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { SESSION_EXPIRED_STORAGE_KEY } from "../lib/session-policy";

function readExpiredFlag(state: { sessionExpired?: boolean } | null): boolean {
  if (state?.sessionExpired) return true;
  try {
    return sessionStorage.getItem(SESSION_EXPIRED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function PortalLoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const successMessage = (location.state as { message?: string } | null)?.message;
  const sessionExpired = readExpiredFlag(location.state as { sessionExpired?: boolean } | null);
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) {
    return <Navigate to="/portal" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
      navigate("/portal");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">INFRA</div>
        <div className="brand-sub">Company portal</div>

        <h1>Sign in</h1>
        <p className="login-intro">Sign in to your company portal.</p>

        {sessionExpired ? (
          <p className="info-banner" role="status">
            Your session expired after 30 minutes of inactivity. Sign in again.
          </p>
        ) : successMessage ? (
          <p className="info-banner" role="status">
            {successMessage}
          </p>
        ) : null}

        <form
          className="login-form"
          onSubmit={(e) => void handleSubmit(e)}
          aria-busy={loading}
          noValidate
        >
          <label htmlFor={emailId}>
            Email
            <input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </label>
          <label htmlFor={passwordId}>
            Password
            <input
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
            />
          </label>
          <p className="login-form-meta">
            <Link to="/forgot-password">Forgot password?</Link>
          </p>
          {error ? (
            <p id={errorId} className="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <button className="button button-primary" type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

import { FormEvent, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { SESSION_EXPIRED_STORAGE_KEY } from "../lib/session-policy";

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const successMessage = (location.state as { message?: string } | null)?.message;
  let sessionExpired = Boolean((location.state as { sessionExpired?: boolean } | null)?.sessionExpired);
  try {
    sessionExpired = sessionExpired || sessionStorage.getItem(SESSION_EXPIRED_STORAGE_KEY) === "1";
  } catch {
    /* ignore */
  }
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user?.isPlatformAdmin) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
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
            <span className="brand-context">Admin Control Panel</span>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="muted">
          Access the INFRA Admin Control Panel to manage companies, integrations, and access.
        </p>
        {sessionExpired ? (
          <p className="info-banner" role="status">
            Your session expired after 30 minutes of inactivity. Sign in again.
          </p>
        ) : successMessage ? (
          <p className="info-banner">{successMessage}</p>
        ) : null}
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
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <p className="login-form-meta">
            <Link to="/forgot-password">Forgot password?</Link>
          </p>
          {error ? <p className="error-text">{error}</p> : null}
          <button className="button button-primary" type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted small" style={{ marginTop: 20 }}>
          Company users: <Link to="/portal/login">sign in to your company portal</Link>
        </p>
      </div>
    </div>
  );
}

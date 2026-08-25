import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";

export default function PasswordSetupPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";

  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(true);

  useEffect(() => {
    if (!token) {
      setValidating(false);
      setError("Missing setup token. Use the secure link provided for account handover.");
      return;
    }

    void (async () => {
      try {
        const result = await api.validatePasswordSetupToken(token);
        if (!result.valid) {
          setError(result.error ?? "Invalid or expired setup token");
          return;
        }
        setMaskedEmail(result.maskedEmail ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to validate setup token");
      } finally {
        setValidating(false);
      }
    })();
  }, [token]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api.completePasswordSetup(token, password, confirmPassword);
      navigate("/login", {
        replace: true,
        state: { message: "Password set successfully. Sign in with your new password." },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password setup failed");
    } finally {
      setLoading(false);
    }
  }

  if (validating) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="brand">INFRA</div>
          <p className="muted">Validating secure setup link…</p>
        </div>
      </div>
    );
  }

  if (!token || (error && !maskedEmail)) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="brand">INFRA</div>
          <h1>Password setup unavailable</h1>
          <p className="error-text">{error}</p>
          <p className="muted">
            Setup links are single-use and expire after one hour. Request a new link if
            needed.
          </p>
          <Link to="/login" className="button button-secondary">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">INFRA</div>
        <div className="brand-sub">Platform admin account handover</div>
        <h1>Set your password</h1>
        <p className="muted">
          Create your permanent Platform Admin password for{" "}
          {maskedEmail ? <strong>{maskedEmail}</strong> : "your account"}. Your password is
          sent over HTTPS, hashed server-side, and never stored in plaintext.
        </p>

        <form className="login-form" onSubmit={(e) => void handleSubmit(e)}>
          <label>
            New password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
          <label>
            Confirm password
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
          <p className="muted">Minimum 12 characters.</p>
          {error ? <p className="error-text">{error}</p> : null}
          <button className="button button-primary" type="submit" disabled={loading}>
            {loading ? "Saving password…" : "Set password"}
          </button>
        </form>

        <p className="login-footer muted">
          Already set your password? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

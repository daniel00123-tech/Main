import { Link } from "react-router-dom";

export default function PortalLoginPage() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">INFRA</div>
        <div className="brand-sub">Company portal</div>
        <div className="prototype-badge">EL Business login prototype</div>

        <h1>Sign in</h1>
        <p className="muted">
          Company administrators and staff sign in to manage connectors, credits,
          team access, and AI connections for their organisation only.
        </p>

        <form className="login-form" onSubmit={(e) => e.preventDefault()}>
          <label>
            Email
            <input type="email" defaultValue="charlie@el.example" readOnly />
          </label>
          <label>
            Password
            <input type="password" defaultValue="••••••••" readOnly />
          </label>
          <button className="button button-primary" type="submit">
            Sign in to EL Business
          </button>
        </form>

        <p className="login-footer muted">
          Platform owners use the{" "}
          <Link to="/">admin control plane</Link> to manage all companies.
        </p>

        <div className="login-demo-note">
          <strong>Prototype:</strong> After sign-in, Charlie Smith (Owner) sees
          only EL Business — not HT or Caddington.
        </div>
      </div>
    </div>
  );
}

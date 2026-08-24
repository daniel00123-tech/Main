import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ErrorState, LoadingState } from "../components";
import { usePortalCompany } from "./usePortalCompany";

const NAV = [
  { to: "/portal/dashboard", label: "Dashboard" },
  { to: "/portal/connectors", label: "Connectors" },
  { to: "/portal/ai-connections", label: "AI Connections" },
  { to: "/portal/team", label: "Team" },
  { to: "/portal/usage", label: "Usage" },
  { to: "/portal/billing", label: "Billing & Credits" },
  { to: "/portal/settings", label: "Settings" },
];

export default function PortalShell() {
  const { user, logout } = useAuth();
  const { company, membership, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !user) return <ErrorState message={error ?? "Portal unavailable"} />;

  return (
    <div className="app-shell portal-shell">
      <aside className="sidebar portal-sidebar">
        <div className="brand">{company.name}</div>
        <div className="brand-sub">Powered by INFRA</div>
        <div className="prototype-badge">Company portal</div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} className="nav-link" to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="portal-user">
          <div className="portal-user-name">{user.displayName}</div>
          <div className="portal-user-role">{membership?.role ?? "member"}</div>
          <button className="button button-small" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

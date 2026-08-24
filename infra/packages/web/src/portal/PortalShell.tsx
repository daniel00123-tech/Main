import { NavLink, Outlet } from "react-router-dom";
import { EL_TENANT } from "./mock-data";

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
  const { company, loggedInUser } = EL_TENANT;

  return (
    <div className="app-shell portal-shell">
      <aside className="sidebar portal-sidebar">
        <div className="brand">{company.name}</div>
        <div className="brand-sub">Powered by INFRA</div>
        <div className="prototype-badge">Company portal · EL</div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} className="nav-link" to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="portal-user">
          <div className="portal-user-name">{loggedInUser.name}</div>
          <div className="portal-user-role">{loggedInUser.role}</div>
          <button className="button button-small" type="button">
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

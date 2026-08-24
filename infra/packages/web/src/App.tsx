import { NavLink, Route, Routes } from "react-router-dom";
import {
  AdminAuthShell,
  PortalAuthShell,
  useAuth,
} from "./context/AuthContext";
import AiClientsPage from "./pages/AiClientsPage";
import AuditLogPage from "./pages/AuditLogPage";
import BillingPage from "./pages/BillingPage";
import CataloguePage from "./pages/CataloguePage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyDetailPage from "./pages/CompanyDetailPage";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import McpEnvironmentsPage from "./pages/McpEnvironmentsPage";
import SettingsPage from "./pages/SettingsPage";
import SystemHealthPage from "./pages/SystemHealthPage";
import UsagePage from "./pages/UsagePage";
import UsersPermissionsPage from "./pages/UsersPermissionsPage";
import PortalShell from "./portal/PortalShell";
import PortalLoginPage from "./portal/PortalLoginPage";
import PortalDashboardPage from "./portal/PortalDashboardPage";
import PortalConnectorsPage from "./portal/PortalConnectorsPage";
import PortalBillingPage from "./portal/PortalBillingPage";
import PortalUsagePage from "./portal/PortalUsagePage";
import PortalAiConnectionsPage from "./portal/PortalAiConnectionsPage";
import PortalTeamPage from "./portal/PortalTeamPage";
import PortalSettingsPage from "./portal/PortalSettingsPage";

const ADMIN_NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/companies", label: "Companies" },
  { to: "/connectors", label: "Connectors" },
  { to: "/mcp-environments", label: "MCP Environments" },
  { to: "/ai-clients", label: "AI Clients" },
  { to: "/users", label: "Users & Permissions" },
  { to: "/usage", label: "Usage" },
  { to: "/billing", label: "Billing" },
  { to: "/system-health", label: "System Health" },
  { to: "/audit-log", label: "Audit Log" },
  { to: "/settings", label: "Settings" },
];

function AdminShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">INFRA</div>
        <div className="brand-sub">Platform admin · all companies</div>
        <div className="prototype-badge">Control plane</div>
        <nav>
          {ADMIN_NAV.map((item) => (
            <NavLink
              key={item.to}
              className="nav-link"
              to={item.to}
              end={item.end}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="portal-link-box">
          <NavLink to="/portal/login" className="nav-link">
            → Company portal
          </NavLink>
        </div>
        <div className="sidebar-footer">
          <div className="muted">{user?.displayName}</div>
          <button className="button button-secondary" type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/portal/login" element={<PortalLoginPage />} />

      <Route element={<PortalAuthShell />}>
        <Route path="/portal" element={<PortalShell />}>
          <Route path="dashboard" element={<PortalDashboardPage />} />
          <Route path="connectors" element={<PortalConnectorsPage />} />
          <Route path="ai-connections" element={<PortalAiConnectionsPage />} />
          <Route path="team" element={<PortalTeamPage />} />
          <Route path="usage" element={<PortalUsagePage />} />
          <Route path="billing" element={<PortalBillingPage />} />
          <Route path="settings" element={<PortalSettingsPage />} />
        </Route>
      </Route>

      <Route element={<AdminAuthShell />}>
        <Route
          path="/*"
          element={
            <AdminShell>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/companies" element={<CompaniesPage />} />
                <Route path="/companies/:slug" element={<CompanyDetailPage />} />
                <Route path="/connectors" element={<CataloguePage />} />
                <Route path="/mcp-environments" element={<McpEnvironmentsPage />} />
                <Route path="/ai-clients" element={<AiClientsPage />} />
                <Route path="/users" element={<UsersPermissionsPage />} />
                <Route path="/usage" element={<UsagePage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/system-health" element={<SystemHealthPage />} />
                <Route path="/audit-log" element={<AuditLogPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </AdminShell>
          }
        />
      </Route>
    </Routes>
  );
}

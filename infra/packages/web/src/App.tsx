import { NavLink, Route, Routes } from "react-router-dom";
import AiClientsPage from "./pages/AiClientsPage";
import AuditLogPage from "./pages/AuditLogPage";
import BillingPage from "./pages/BillingPage";
import CataloguePage from "./pages/CataloguePage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyDetailPage from "./pages/CompanyDetailPage";
import DashboardPage from "./pages/DashboardPage";
import McpEnvironmentsPage from "./pages/McpEnvironmentsPage";
import SettingsPage from "./pages/SettingsPage";
import SystemHealthPage from "./pages/SystemHealthPage";
import UsagePage from "./pages/UsagePage";
import UsersPermissionsPage from "./pages/UsersPermissionsPage";

const NAV_ITEMS = [
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">INFRA</div>
        <div className="brand-sub">Business AI control plane</div>
        <div className="prototype-badge">Visual prototype</div>
        <nav>
          {NAV_ITEMS.map((item) => (
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
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Shell>
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
    </Shell>
  );
}

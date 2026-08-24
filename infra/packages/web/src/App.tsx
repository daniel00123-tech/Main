import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  Building2,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  Globe,
  LayoutDashboard,
  Menu,
  Network,
  Plug,
  Receipt,
  Settings,
  Shield,
  Tags,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  AdminAuthShell,
  PortalAuthShell,
  useAuth,
} from "./context/AuthContext";
import {
  Button,
  ToastHost,
  useMediaQuery,
  useSidebarCollapsed,
} from "./components";
import AiClientsPage from "./pages/AiClientsPage";
import AuditLogPage from "./pages/AuditLogPage";
import BillingPage from "./pages/BillingPage";
import CataloguePage from "./pages/CataloguePage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyDetailPage from "./pages/CompanyDetailPage";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import PasswordSetupPage from "./pages/PasswordSetupPage";
import McpEnvironmentsPage from "./pages/McpEnvironmentsPage";
import PricingRulesPage from "./pages/PricingRulesPage";
import ProviderCostsPage from "./pages/ProviderCostsPage";
import SettingsPage from "./pages/SettingsPage";
import SystemHealthPage from "./pages/SystemHealthPage";
import UsagePage from "./pages/UsagePage";
import UsersPermissionsPage from "./pages/UsersPermissionsPage";
import PortalShell from "./portal/PortalShell";
import PortalEntryRedirect from "./portal/PortalEntryRedirect";
import PortalLoginPage from "./portal/PortalLoginPage";
import PortalDashboardPage from "./portal/PortalDashboardPage";
import PortalConnectorsPage from "./portal/PortalConnectorsPage";
import PortalBillingPage from "./portal/PortalBillingPage";
import PortalUsagePage from "./portal/PortalUsagePage";
import PortalAiConnectionsPage from "./portal/PortalAiConnectionsPage";
import PortalTeamPage from "./portal/PortalTeamPage";
import PortalSettingsPage from "./portal/PortalSettingsPage";
import PortalActivityPage from "./portal/PortalActivityPage";
import { useState } from "react";

type NavItem = {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
};

type NavGroup = { label: string; items: NavItem[] };

const ADMIN_NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: <LayoutDashboard size={18} />, end: true },
      { to: "/companies", label: "Companies", icon: <Building2 size={18} /> },
      { to: "/portal", label: "Company portal", icon: <Globe size={18} /> },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/connectors", label: "Connectors", icon: <Plug size={18} /> },
      { to: "/mcp-environments", label: "AI Gateways", icon: <Network size={18} /> },
      { to: "/ai-clients", label: "AI Clients", icon: <Bot size={18} /> },
    ],
  },
  {
    label: "Access",
    items: [{ to: "/users", label: "Users & Roles", icon: <Users size={18} /> }],
  },
  {
    label: "Commercial",
    items: [
      { to: "/usage", label: "Usage", icon: <ChartColumn size={18} /> },
      { to: "/billing", label: "Billing", icon: <Wallet size={18} /> },
      { to: "/commercial/provider-costs", label: "Provider Costs", icon: <Receipt size={18} /> },
      { to: "/commercial/pricing-rules", label: "Pricing Rules", icon: <Tags size={18} /> },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/system-health", label: "System Health", icon: <Activity size={18} /> },
      { to: "/audit-log", label: "Audit Log", icon: <Shield size={18} /> },
      { to: "/settings", label: "Settings", icon: <Settings size={18} /> },
    ],
  },
];

function AdminShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const isMobile = useMediaQuery("(max-width: 900px)");
  const [mobileOpen, setMobileOpen] = useState(false);

  const shellClass = [
    "app-shell",
    !isMobile && collapsed ? "nav-collapsed" : "",
    isMobile && mobileOpen ? "mobile-nav-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const showLabels = isMobile || !collapsed;

  return (
    <div className={shellClass}>
      <div className="mobile-nav-scrim" onClick={() => setMobileOpen(false)} aria-hidden />
      <div className="mobile-topbar">
        <Button type="button" variant="ghost" size="sm" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
          <Menu size={18} />
        </Button>
        <strong style={{ letterSpacing: "0.08em" }}>INFRA</strong>
        <span className="muted small" style={{ marginLeft: "auto" }}>
          Control Plane
        </span>
      </div>

      <aside className="sidebar" aria-label="Platform navigation">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden>
            IN
          </div>
          {showLabels ? (
            <div className="brand-text">
              <span className="brand-name">INFRA</span>
              <span className="brand-context">Control Plane</span>
            </div>
          ) : null}
          {!isMobile ? (
            <button
              type="button"
              className="button button-ghost button-small nav-collapse-btn"
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              title={collapsed ? "Expand" : "Collapse"}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            </button>
          ) : (
            <button
              type="button"
              className="button button-ghost button-small nav-collapse-btn"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            >
              <X size={16} />
            </button>
          )}
        </div>

        <nav>
          {ADMIN_NAV.map((group) => (
            <div key={group.label} className="nav-section">
              {showLabels ? <div className="nav-section-label">{group.label}</div> : null}
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  className="nav-link"
                  to={item.to}
                  end={item.end}
                  title={!showLabels ? item.label : undefined}
                  onClick={() => setMobileOpen(false)}
                >
                  {item.icon}
                  <span className="label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        {showLabels ? (
          <div className="sidebar-footer">
            <div className="sidebar-footer-meta">
              <div style={{ fontWeight: 600 }}>{user?.displayName}</div>
              <div className="muted small">Platform administrator</div>
            </div>
            <div className="sidebar-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMobileOpen(false);
                  navigate("/portal");
                }}
              >
                Company portal
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </div>
        ) : (
          <div className="sidebar-footer">
            <Button type="button" variant="ghost" size="sm" title="Sign out" onClick={() => void logout()}>
              <X size={16} />
            </Button>
          </div>
        )}
      </aside>

      <main className="main">{children}</main>
      <ToastHost />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup-password" element={<PasswordSetupPage />} />
      <Route path="/portal/login" element={<PortalLoginPage />} />

      <Route element={<PortalAuthShell />}>
        <Route path="/portal" element={<PortalEntryRedirect />} />
        {/* Legacy flat portal paths → entry redirect (must precede :companySlug) */}
        <Route path="/portal/dashboard" element={<PortalEntryRedirect />} />
        <Route path="/portal/ai-connections" element={<PortalEntryRedirect />} />
        <Route path="/portal/connectors" element={<PortalEntryRedirect />} />
        <Route path="/portal/team" element={<PortalEntryRedirect />} />
        <Route path="/portal/usage" element={<PortalEntryRedirect />} />
        <Route path="/portal/billing" element={<PortalEntryRedirect />} />
        <Route path="/portal/settings" element={<PortalEntryRedirect />} />
        <Route path="/portal/activity" element={<PortalEntryRedirect />} />
        <Route path="/portal/:companySlug" element={<PortalShell />}>
          <Route index element={<PortalDashboardPage />} />
          <Route path="dashboard" element={<PortalDashboardPage />} />
          <Route path="connectors" element={<PortalConnectorsPage />} />
          <Route path="ai-connections" element={<PortalAiConnectionsPage />} />
          <Route path="team" element={<PortalTeamPage />} />
          <Route path="usage" element={<PortalUsagePage />} />
          <Route path="billing" element={<PortalBillingPage />} />
          <Route path="activity" element={<PortalActivityPage />} />
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
                <Route path="/commercial/provider-costs" element={<ProviderCostsPage />} />
                <Route path="/commercial/pricing-rules" element={<PricingRulesPage />} />
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

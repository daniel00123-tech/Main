import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  Building2,
  ChartColumn,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Network,
  Plug,
  PoundSterling,
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
import { InfraBrand } from "./components/InfraBrand";
import AiClientsPage from "./pages/AiClientsPage";
import AuditLogPage from "./pages/AuditLogPage";
import BillingPage from "./pages/BillingPage";
import CataloguePage from "./pages/CataloguePage";
import ConnectorOversightPage from "./pages/ConnectorOversightPage";
import CompaniesPage from "./pages/CompaniesPage";
import CompanyDetailPage from "./pages/CompanyDetailPage";
import DashboardPage from "./pages/DashboardPage";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import PasswordSetupPage from "./pages/PasswordSetupPage";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import McpEnvironmentsPage from "./pages/McpEnvironmentsPage";
import PricingRulesPage from "./pages/PricingRulesPage";
import ProviderCostsPage from "./pages/ProviderCostsPage";
import FailedRequestsPage from "./pages/FailedRequestsPage";
import SettingsPage from "./pages/SettingsPage";
import SystemHealthPage from "./pages/SystemHealthPage";
import UsagePage from "./pages/UsagePage";
import UsersPermissionsPage from "./pages/UsersPermissionsPage";
import EconomicsPage from "./pages/EconomicsPage";
import EconomicsDetailPage from "./pages/EconomicsDetailPage";
import InteractionsPage from "./pages/InteractionsPage";
import QualityIssuesPage from "./pages/QualityIssuesPage";
import QualityImprovementsPage from "./pages/QualityImprovementsPage";
import DailyImprovementPage from "./pages/DailyImprovementPage";
import KnowledgeIntakePage from "./pages/KnowledgeIntakePage";
import PlatformOverheadsPage from "./pages/PlatformOverheadsPage";
import PortalShell from "./portal/PortalShell";
import PortalEntryRedirect from "./portal/PortalEntryRedirect";
import PortalLoginPage from "./portal/PortalLoginPage";
import PortalDashboardPage from "./portal/PortalDashboardPage";
import PortalConnectorsPage from "./portal/PortalConnectorsPage";
import PortalMicrosoft365Page from "./portal/PortalMicrosoft365Page";
import PortalBillingPage from "./portal/PortalBillingPage";
import PortalUsagePage from "./portal/PortalUsagePage";
import PortalAiConnectionsPage from "./portal/PortalAiConnectionsPage";
import PortalUsersPage from "./portal/PortalUsersPage";
import PortalSettingsPage from "./portal/PortalSettingsPage";
import PortalActivityPage from "./portal/PortalActivityPage";
import PortalActionsPage from "./portal/PortalActionsPage";
import PortalAutomationsPage from "./portal/PortalAutomationsPage";
import PortalChatPage from "./portal/PortalChatPage";
import AdminCompanySwitcher from "./components/AdminCompanySwitcher";
import ScopeBanner from "./components/ScopeBanner";
import { AdminScopeProvider } from "./context/AdminScopeContext";
import PortalCompanyPickerPage from "./pages/PortalCompanyPickerPage";
import { useEffect, useMemo, useState } from "react";

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
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/connectors", label: "Connectors", icon: <Plug size={18} /> },
      { to: "/connector-oversight", label: "Oversight", icon: <Network size={18} /> },
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
      { to: "/economics", label: "Economics", icon: <PoundSterling size={18} /> },
      { to: "/billing", label: "Billing", icon: <Wallet size={18} /> },
      { to: "/commercial/provider-costs", label: "Provider costs", icon: <Receipt size={18} /> },
      { to: "/commercial/pricing-rules", label: "Pricing", icon: <Tags size={18} /> },
      { to: "/commercial/overheads", label: "Overheads", icon: <Receipt size={18} /> },
      { to: "/usage", label: "Usage", icon: <ChartColumn size={18} /> },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/system-health", label: "System health", icon: <Activity size={18} /> },
      { to: "/failed-requests", label: "Failed requests", icon: <Activity size={18} /> },
    ],
  },
  {
    label: "Audit & Quality",
    items: [
      { to: "/interactions", label: "Interactions", icon: <MessageSquare size={18} /> },
      { to: "/quality", label: "Quality", icon: <CircleAlert size={18} /> },
      { to: "/quality/engineering", label: "Daily improvement", icon: <CircleAlert size={18} /> },
      { to: "/quality/knowledge-intake", label: "Knowledge Intake", icon: <CircleAlert size={18} /> },
      { to: "/quality/improvements", label: "Improvement Reviews", icon: <CircleAlert size={18} /> },
      { to: "/audit-log", label: "Audit log", icon: <Shield size={18} /> },
    ],
  },
  {
    label: "Settings",
    items: [{ to: "/settings", label: "Settings", icon: <Settings size={18} /> }],
  },
];

function groupContainsPath(group: NavGroup, pathname: string): boolean {
  return group.items.some((item) =>
    item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const isMobile = useMediaQuery("(max-width: 900px)");
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeGroup = useMemo(
    () => ADMIN_NAV.find((group) => groupContainsPath(group, location.pathname))?.label ?? "Overview",
    [location.pathname],
  );
  const [openGroups, setOpenGroups] = useState<string[]>([activeGroup]);

  useEffect(() => {
    setOpenGroups((current) => (current.includes(activeGroup) ? current : [...current, activeGroup]));
  }, [activeGroup]);

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
        <InfraBrand context="Admin" size={28} />
        <span className="muted small" style={{ marginLeft: "auto" }}>
          Control panel
        </span>
      </div>

      <aside className="sidebar" aria-label="Platform navigation">
        <div className="brand-block">
          {showLabels ? (
            <InfraBrand context="Admin" />
          ) : (
            <InfraBrand compact />
          )}
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
          {ADMIN_NAV.map((group) => {
            const expanded = openGroups.includes(group.label);
            return (
              <div key={group.label} className="nav-section">
                {showLabels ? (
                  <button
                    type="button"
                    className="nav-section-toggle"
                    aria-expanded={expanded}
                    onClick={() =>
                      setOpenGroups((current) =>
                        current.includes(group.label)
                          ? current.filter((label) => label !== group.label)
                          : [...current, group.label],
                      )
                    }
                  >
                    {group.label}
                    <ChevronDown size={14} style={{ transform: expanded ? "rotate(180deg)" : undefined }} />
                  </button>
                ) : null}
                <div className="nav-section-items">
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
              </div>
            );
          })}
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
                  navigate("/portal/select");
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
          <div className="sidebar-footer sidebar-footer-collapsed">
            <button
              type="button"
              className="button button-ghost button-small nav-expand-btn"
              aria-label="Expand navigation"
              title="Expand navigation"
              onClick={() => setCollapsed(false)}
            >
              <ChevronsRight size={16} />
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title="Company portal"
              aria-label="Company portal"
              onClick={() => navigate("/portal/select")}
            >
              <Globe size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => void logout()}
            >
              <LogOut size={16} />
            </Button>
          </div>
        )}
      </aside>

      <main className="main">
        <AdminScopeProvider>
          <div className="admin-toolbar">
            <AdminCompanySwitcher />
          </div>
          <ScopeBanner />
          {children}
        </AdminScopeProvider>
      </main>
      <ToastHost />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/setup-password" element={<PasswordSetupPage />} />
      <Route path="/portal/login" element={<PortalLoginPage />} />
      <Route path="/privacy" element={<PrivacyPolicyPage />} />

      <Route element={<PortalAuthShell />}>
        <Route path="/portal" element={<PortalEntryRedirect />} />
        <Route path="/portal/select" element={<PortalCompanyPickerPage />} />
        {/* Legacy flat portal paths → entry redirect (must precede :companySlug) */}
        <Route path="/portal/dashboard" element={<PortalEntryRedirect />} />
        <Route path="/portal/ai-connections" element={<PortalEntryRedirect />} />
        <Route path="/portal/connectors" element={<PortalEntryRedirect />} />
        <Route path="/portal/team" element={<PortalEntryRedirect />} />
        <Route path="/portal/users" element={<PortalEntryRedirect />} />
        <Route path="/portal/usage" element={<PortalEntryRedirect />} />
        <Route path="/portal/billing" element={<PortalEntryRedirect />} />
        <Route path="/portal/settings" element={<PortalEntryRedirect />} />
        <Route path="/portal/activity" element={<PortalEntryRedirect />} />
        <Route path="/portal/actions" element={<PortalEntryRedirect />} />
        <Route path="/portal/automations" element={<PortalEntryRedirect />} />
        <Route path="/portal/chat" element={<PortalEntryRedirect />} />
        <Route path="/portal/:companySlug" element={<PortalShell />}>
          <Route index element={<Navigate to="chat" replace />} />
          <Route path="dashboard" element={<PortalDashboardPage />} />
          <Route path="chat" element={<PortalChatPage />} />
          <Route path="chat/:conversationId" element={<PortalChatPage />} />
          <Route path="connectors" element={<PortalConnectorsPage />} />
          <Route path="microsoft-365" element={<PortalMicrosoft365Page />} />
          <Route path="ai-connections" element={<PortalAiConnectionsPage />} />
          <Route path="actions" element={<PortalActionsPage />} />
          <Route path="automations" element={<PortalAutomationsPage />} />
          <Route path="users" element={<PortalUsersPage />} />
          <Route path="team" element={<Navigate to="users" replace />} />
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
                <Route path="/connector-oversight" element={<ConnectorOversightPage />} />
                <Route path="/mcp-environments" element={<McpEnvironmentsPage />} />
                <Route path="/ai-clients" element={<AiClientsPage />} />
                <Route path="/users" element={<UsersPermissionsPage />} />
                <Route path="/usage" element={<UsagePage />} />
                <Route path="/economics" element={<EconomicsPage />} />
                <Route path="/economics/:companyId" element={<EconomicsDetailPage />} />
                <Route path="/interactions" element={<InteractionsPage />} />
                <Route path="/quality" element={<QualityIssuesPage />} />
                <Route path="/quality/engineering" element={<DailyImprovementPage />} />
                <Route path="/quality/knowledge-intake" element={<KnowledgeIntakePage />} />
                <Route path="/quality/improvements" element={<QualityImprovementsPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/commercial/overheads" element={<PlatformOverheadsPage />} />
                <Route path="/commercial/provider-costs" element={<ProviderCostsPage />} />
                <Route path="/commercial/pricing-rules" element={<PricingRulesPage />} />
                <Route path="/system-health" element={<SystemHealthPage />} />
                <Route path="/failed-requests" element={<FailedRequestsPage />} />
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

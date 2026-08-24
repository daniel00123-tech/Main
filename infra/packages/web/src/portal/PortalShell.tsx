import { useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Bot,
  ChartColumn,
  LayoutDashboard,
  Menu,
  Plug,
  Settings,
  Users,
  Wallet,
  X,
  ChevronsLeft,
  ChevronsRight,
  Shield,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  ErrorState,
  LoadingState,
  ToastHost,
  useMediaQuery,
  useSidebarCollapsed,
} from "../components";
import { humanRole } from "../lib/format";
import { PortalCompanyProvider, usePortalCompany } from "./usePortalCompany";

type NavItem = {
  path: string;
  label: string;
  icon: React.ReactNode;
  roles?: string[];
};

const ALL_NAV: NavItem[] = [
  { path: "dashboard", label: "Overview", icon: <LayoutDashboard size={18} /> },
  { path: "connectors", label: "Connections", icon: <Plug size={18} /> },
  { path: "ai-connections", label: "AI connections", icon: <Bot size={18} /> },
  {
    path: "team",
    label: "Team",
    icon: <Users size={18} />,
    roles: ["company_admin", "director", "manager", "supervisor"],
  },
  {
    path: "usage",
    label: "Usage",
    icon: <ChartColumn size={18} />,
    roles: ["company_admin", "director", "manager", "supervisor", "office_staff"],
  },
  {
    path: "billing",
    label: "Billing",
    icon: <Wallet size={18} />,
    roles: ["company_admin", "director"],
  },
  {
    path: "activity",
    label: "Activity",
    icon: <Shield size={18} />,
    roles: ["company_admin", "director", "manager"],
  },
  {
    path: "settings",
    label: "Settings",
    icon: <Settings size={18} />,
    roles: ["company_admin", "director", "manager"],
  },
];

function PortalShellInner() {
  const { user, logout } = useAuth();
  const { company, membership, loading, error, companies } = usePortalCompany();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useSidebarCollapsed("infra.portal.sidebar.collapsed");
  const isMobile = useMediaQuery("(max-width: 900px)");
  const [mobileOpen, setMobileOpen] = useState(false);

  const role = membership?.role ?? "office_staff";
  const base = company ? `/portal/${company.slug}` : "/portal";

  const nav = useMemo(
    () =>
      ALL_NAV.filter((item) => {
        if (!item.roles) return true;
        if (user?.isPlatformAdmin) return true;
        return item.roles.includes(role);
      }),
    [role, user?.isPlatformAdmin],
  );

  if (loading) return <LoadingState label="Opening company portal…" />;
  if (error || !company || !user) {
    return <ErrorState title="Portal unavailable" description={error ?? undefined} />;
  }

  const showLabels = isMobile || !collapsed;
  const shellClass = [
    "app-shell",
    "portal-shell",
    !isMobile && collapsed ? "nav-collapsed" : "",
    isMobile && mobileOpen ? "mobile-nav-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <div className="mobile-nav-scrim" onClick={() => setMobileOpen(false)} aria-hidden />
      <div className="mobile-topbar">
        <Button type="button" variant="ghost" size="sm" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
          <Menu size={18} />
        </Button>
        <strong>{company.name}</strong>
      </div>

      <aside className="sidebar" aria-label="Company navigation">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden>
            IN
          </div>
          {showLabels ? (
            <div className="brand-text">
              <span className="brand-name">INFRA</span>
              <span className="brand-context">Company portal</span>
            </div>
          ) : null}
          {!isMobile ? (
            <button
              type="button"
              className="button button-ghost button-small nav-collapse-btn"
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
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

        {showLabels && companies.length > 1 ? (
          <div style={{ padding: "0 12px 12px" }}>
            <label className="muted small" htmlFor="portal-company-switch">
              Company
            </label>
            <select
              id="portal-company-switch"
              className="input"
              value={company.slug}
              onChange={(e) => {
                navigate(`/portal/${e.target.value}/dashboard`);
                setMobileOpen(false);
              }}
              style={{ width: "100%", marginTop: 4 }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : showLabels ? (
          <div style={{ padding: "0 16px 12px" }}>
            <div style={{ fontWeight: 600 }}>{company.name}</div>
            <div className="muted small">
              {company.portalSubdomain
                ? `${company.portalSubdomain}.infra-web.pages.dev`
                : company.slug}
            </div>
          </div>
        ) : null}

        <nav>
          {nav.map((item) => (
            <NavLink
              key={item.path}
              className="nav-link"
              to={`${base}/${item.path}`}
              title={!showLabels ? item.label : undefined}
              onClick={() => setMobileOpen(false)}
            >
              {item.icon}
              <span className="label">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-footer">
          {showLabels ? (
            <>
              <div className="sidebar-footer-meta">
                <div style={{ fontWeight: 600 }}>{user.displayName}</div>
                <div className="muted small">{humanRole(role)}</div>
              </div>
              <div className="sidebar-actions">
                {user.isPlatformAdmin ? (
                  <NavLink to="/" className="button button-ghost button-small">
                    Control plane
                  </NavLink>
                ) : null}
                <Button type="button" variant="secondary" size="sm" onClick={() => void logout()}>
                  Sign out
                </Button>
              </div>
            </>
          ) : (
            <Button type="button" variant="ghost" size="sm" title="Sign out" onClick={() => void logout()}>
              <X size={16} />
            </Button>
          )}
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>
      <ToastHost />
    </div>
  );
}

export default function PortalShell() {
  return (
    <PortalCompanyProvider>
      <PortalShellInner />
    </PortalCompanyProvider>
  );
}

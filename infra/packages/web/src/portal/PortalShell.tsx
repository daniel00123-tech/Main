import { useMemo, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
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
import { usePortalCompany } from "./usePortalCompany";

type NavItem = {
  to: string;
  label: string;
  icon: React.ReactNode;
  roles?: string[];
};

const ALL_NAV: NavItem[] = [
  { to: "/portal/dashboard", label: "Home", icon: <LayoutDashboard size={18} /> },
  { to: "/portal/connectors", label: "Connected systems", icon: <Plug size={18} /> },
  { to: "/portal/ai-connections", label: "AI connections", icon: <Bot size={18} /> },
  {
    to: "/portal/team",
    label: "Team",
    icon: <Users size={18} />,
    roles: ["company_admin", "director", "manager", "supervisor"],
  },
  {
    to: "/portal/usage",
    label: "Usage",
    icon: <ChartColumn size={18} />,
    roles: ["company_admin", "director", "manager", "supervisor", "office_staff"],
  },
  {
    to: "/portal/billing",
    label: "Billing",
    icon: <Wallet size={18} />,
    roles: ["company_admin", "director"],
  },
  {
    to: "/portal/settings",
    label: "Settings",
    icon: <Settings size={18} />,
    roles: ["company_admin", "director", "manager"],
  },
];

export default function PortalShell() {
  const { user, logout } = useAuth();
  const { company, membership, loading, error } = usePortalCompany();
  const [collapsed, setCollapsed] = useSidebarCollapsed("infra.portal.sidebar.collapsed");
  const isMobile = useMediaQuery("(max-width: 900px)");
  const [mobileOpen, setMobileOpen] = useState(false);

  const role = membership?.role ?? "office_staff";
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
              <span className="brand-context">Company portal · {company.name}</span>
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

        <nav>
          {nav.map((item) => (
            <NavLink
              key={item.to}
              className="nav-link"
              to={item.to}
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

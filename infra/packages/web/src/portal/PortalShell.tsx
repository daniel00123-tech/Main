import { useMemo, useState, useEffect, useCallback } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Bot,
  ChartColumn,
  ClipboardList,
  Clock,
  LayoutDashboard,
  LogOut,
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
import { api } from "../api";
import { PortalCompanyProvider, usePortalCompany } from "./usePortalCompany";
import { PortalNotificationBell } from "./PortalNotificationBell";
import { PortalCompanyHomeLink } from "./PortalCompanyHomeLink";

type NavItem = {
  path: string;
  label: string;
  icon: React.ReactNode;
  roles?: string[];
  section?: "main" | "manage" | "account";
  badgeCount?: number;
};

const ALL_NAV: NavItem[] = [
  { path: "dashboard", label: "Overview", icon: <LayoutDashboard size={18} />, section: "main" },
  { path: "connectors", label: "Systems", icon: <Plug size={18} />, section: "main" },
  { path: "ai-connections", label: "AI Access", icon: <Bot size={18} />, section: "main" },
  {
    path: "actions",
    label: "Approvals",
    icon: <ClipboardList size={18} />,
    section: "main",
    roles: ["company_admin", "director", "manager", "supervisor"],
  },
  {
    path: "automations",
    label: "Automations",
    icon: <Clock size={18} />,
    section: "main",
    roles: ["company_admin", "director", "manager", "supervisor"],
  },
  {
    path: "users",
    label: "Users",
    icon: <Users size={18} />,
    section: "manage",
    roles: ["company_admin", "director", "manager", "supervisor"],
  },
  {
    path: "usage",
    label: "Usage",
    icon: <ChartColumn size={18} />,
    section: "manage",
    roles: ["company_admin", "director", "manager", "supervisor", "office_staff"],
  },
  {
    path: "billing",
    label: "Billing",
    icon: <Wallet size={18} />,
    section: "account",
    roles: ["company_admin", "director"],
  },
  {
    path: "activity",
    label: "Activity",
    icon: <Shield size={18} />,
    section: "account",
    roles: ["company_admin", "director", "manager"],
  },
  {
    path: "settings",
    label: "Settings",
    icon: <Settings size={18} />,
    section: "account",
    roles: ["company_admin", "director", "manager"],
  },
];

const SECTION_LABELS: Record<string, string> = {
  manage: "Manage",
  account: "Account",
};

function PortalShellInner() {
  const { user, logout } = useAuth();
  const { company, membership, loading, error, companies } = usePortalCompany();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useSidebarCollapsed("infra.portal.sidebar.collapsed");
  const isMobile = useMediaQuery("(max-width: 900px)");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  const refreshPendingApprovals = useCallback(async () => {
    if (!company) return;
    try {
      const response = await api.listCompanyActions(company.slug);
      const count = response.plans.filter((p) => p.status === "awaiting_approval").length;
      setPendingApprovals(count);
    } catch {
      /* non-blocking */
    }
  }, [company]);

  useEffect(() => {
    void refreshPendingApprovals();
    const timer = window.setInterval(() => void refreshPendingApprovals(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshPendingApprovals]);

  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const role = membership?.role ?? "office_staff";
  const base = company ? `/portal/${company.slug}` : "/portal";

  const nav = useMemo(
    () =>
      ALL_NAV.filter((item) => {
        if (!item.roles) return true;
        if (user?.isPlatformAdmin) return true;
        return item.roles.includes(role);
      }).map((item) =>
        item.path === "actions" ? { ...item, badgeCount: pendingApprovals } : item,
      ),
    [role, user?.isPlatformAdmin, pendingApprovals],
  );

  const navSections = useMemo(() => {
    const sections: Array<{ key: string; items: NavItem[] }> = [];
    let current = "";
    for (const item of nav) {
      const section = item.section ?? "main";
      if (section !== current) {
        sections.push({ key: section, items: [] });
        current = section;
      }
      sections[sections.length - 1]!.items.push(item);
    }
    return sections;
  }, [nav]);

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
      <div
        className="mobile-nav-scrim"
        onClick={() => setMobileOpen(false)}
        aria-hidden={!mobileOpen}
      />
      <div className="mobile-topbar">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={mobileOpen}
          aria-controls="portal-company-navigation"
          onClick={() => setMobileOpen((open) => !open)}
        >
          <Menu size={18} />
        </Button>
        <PortalCompanyHomeLink company={company} className="portal-company-home-link--topbar" />
        <div className="mobile-topbar-actions">
          <PortalNotificationBell variant="header" />
        </div>
      </div>

      <aside
        id="portal-company-navigation"
        className="sidebar"
        aria-label="Company navigation"
        aria-hidden={isMobile && !mobileOpen ? true : undefined}
      >
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
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
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

        {showLabels && (user.isPlatformAdmin || companies.length > 1) ? (
          <div className="portal-company-switch">
            <label className="muted small" htmlFor="portal-company-switch">
              {user.isPlatformAdmin ? "Switch company" : "Company"}
            </label>
            <select
              id="portal-company-switch"
              className="input"
              value={company.slug}
              onChange={(e) => {
                navigate(`/portal/${e.target.value}/dashboard`);
                setMobileOpen(false);
              }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : showLabels ? (
          <div className="portal-sidebar-company">
            <PortalCompanyHomeLink company={company} className="portal-company-home-link--sidebar" />
            <div className="muted small portal-sidebar-company-meta">
              {company.portalSubdomain
                ? `${company.portalSubdomain}.infra-web.pages.dev`
                : company.slug}
            </div>
          </div>
        ) : null}

        <nav>
          {navSections.map((section) => (
            <div key={section.key}>
              {showLabels && section.key !== "main" ? (
                <div className="nav-section-label">{SECTION_LABELS[section.key] ?? section.key}</div>
              ) : null}
              {section.items.map((item) => (
                <NavLink
                  key={item.path}
                  className="nav-link"
                  to={`${base}/${item.path}`}
                  title={!showLabels ? item.label : undefined}
                  onClick={() => setMobileOpen(false)}
                >
                  {item.icon}
                  <span className="label">{item.label}</span>
                  {item.badgeCount && item.badgeCount > 0 ? (
                    <span
                      className="nav-badge"
                      style={{
                        marginLeft: "auto",
                        background: "var(--danger)",
                        color: "#fff",
                        borderRadius: 999,
                        fontSize: 10,
                        minWidth: 18,
                        height: 18,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "0 5px",
                      }}
                    >
                      {item.badgeCount > 9 ? "9+" : item.badgeCount}
                    </span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-notifications">
          <PortalNotificationBell variant="sidebar" />
        </div>

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
                    Admin Control Panel
                  </NavLink>
                ) : null}
                <Button type="button" variant="secondary" size="sm" onClick={() => void logout()}>
                  Sign out
                </Button>
              </div>
            </>
          ) : (
            <div className="sidebar-footer-collapsed">
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
                title="Sign out"
                aria-label="Sign out"
                onClick={() => void logout()}
              >
                <LogOut size={16} />
              </Button>
            </div>
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

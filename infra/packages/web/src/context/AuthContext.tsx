import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api, configureApiAuth, markUserActivity, type SessionUser } from "../api";
import {
  SESSION_EXPIRED_STORAGE_KEY,
  loginPathForLocation,
  sessionPolicyFromUser,
} from "../lib/session-policy";

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function rememberExpiredSession() {
  try {
    sessionStorage.setItem(SESSION_EXPIRED_STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef<SessionUser | null>(null);
  userRef.current = user;

  const refresh = useCallback(async () => {
    try {
      const session = await api.getSession();
      setUser(session);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* cookie may already be gone */
    }
    setUser(null);
  }, []);

  const expireSession = useCallback(async () => {
    if (!userRef.current) return;
    rememberExpiredSession();
    await logout();
  }, [logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    configureApiAuth({
      isAuthenticated: () => userRef.current !== null,
      onUnauthorized: () => {
        rememberExpiredSession();
        setUser(null);
      },
    });
    return () => configureApiAuth({ isAuthenticated: () => false, onUnauthorized: null });
  }, []);

  useEffect(() => {
    if (!user) return;
    const policy = sessionPolicyFromUser(user.session);
    const idleMs = policy.idleTimeoutSeconds * 1000;
    let lastActivity = Date.now();

    const mark = () => {
      lastActivity = Date.now();
      markUserActivity();
    };

    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "scroll",
      "touchstart",
    ];
    for (const event of events) {
      window.addEventListener(event, mark, { passive: true });
    }

    const idleTimer = window.setInterval(() => {
      if (Date.now() - lastActivity >= idleMs) {
        void expireSession();
      }
    }, 15_000);

    const heartbeat = window.setInterval(() => {
      if (Date.now() - lastActivity >= 60_000) return;
      void api.touchSession().catch(() => {
        /* next request or idle timer will reconcile */
      });
    }, 60_000);

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity >= idleMs) {
        void expireSession();
        return;
      }
      mark();
      void api.getSession().then(setUser).catch(() => {
        void expireSession();
      });
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      for (const event of events) {
        window.removeEventListener(event, mark);
      }
      window.clearInterval(idleTimer);
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [user, expireSession]);

  const login = useCallback(async (email: string, password: string) => {
    await api.login(email, password);
    try {
      const session = await api.getSession();
      try {
        sessionStorage.removeItem(SESSION_EXPIRED_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setUser(session);
    } catch {
      setUser(null);
      throw new Error(
        "Sign-in succeeded but the session cookie was not stored. Allow cookies for this site, or try a non-private window.",
      );
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="card muted">Loading session...</div>;
  }

  if (!user) {
    let sessionExpired = false;
    try {
      sessionExpired = sessionStorage.getItem(SESSION_EXPIRED_STORAGE_KEY) === "1";
    } catch {
      sessionExpired = false;
    }
    return (
      <Navigate
        to={loginPathForLocation(location.pathname)}
        replace
        state={{ from: location.pathname, sessionExpired }}
      />
    );
  }

  return <>{children}</>;
}

export function RequirePlatformAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="card muted">Loading session...</div>;
  }

  if (!user?.isPlatformAdmin) {
    return <Navigate to="/portal" replace />;
  }

  return <>{children}</>;
}

export function AdminAuthShell() {
  return (
    <RequireAuth>
      <RequirePlatformAdmin>
        <Outlet />
      </RequirePlatformAdmin>
    </RequireAuth>
  );
}

export function PortalAuthShell() {
  const { user, loading, refresh } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);

  useEffect(() => {
    if (!user || user.memberships.length > 0 || refreshed || refreshing) return;
    // Stale sessions may lack memberships added after login — refresh once.
    setRefreshing(true);
    void refresh().finally(() => {
      setRefreshing(false);
      setRefreshed(true);
    });
  }, [user, refreshed, refreshing, refresh]);

  if (loading || refreshing) {
    return <div className="card muted">Loading session...</div>;
  }

  if (!user) {
    return <Navigate to="/portal/login" replace />;
  }

  // Platform admins can open any company portal for operations without a membership row.
  if (!user.memberships.length && !user.isPlatformAdmin) {
    return (
      <div className="card" style={{ margin: 40, maxWidth: 480 }}>
        <h2>Company portal</h2>
        <p className="muted">
          This account has no company membership. Ask a company administrator to invite you.
        </p>
      </div>
    );
  }

  return <Outlet />;
}

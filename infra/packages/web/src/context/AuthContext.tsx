import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api, type SessionUser } from "../api";

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const session = await api.login(email, password);
    setUser(session);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
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
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
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

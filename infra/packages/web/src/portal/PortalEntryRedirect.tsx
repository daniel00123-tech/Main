import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components";

/** Redirect /portal → first accessible company portal */
export default function PortalEntryRedirect() {
  const { user, loading } = useAuth();
  const [target, setTarget] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const companies = await api.getCompanies();
        const memberIds = new Set(user.memberships.map((m) => m.companyId));
        const preferred =
          companies.find((c) => memberIds.has(c.id)) ??
          (user.isPlatformAdmin ? companies[0] : undefined);
        if (!preferred) {
          if (!cancelled) {
            setFailed(
              "No companies available. Create one from Platform Admin → Companies.",
            );
          }
          return;
        }
        if (!cancelled) setTarget(`/portal/${preferred.slug}/dashboard`);
      } catch (err) {
        if (!cancelled) {
          setFailed(err instanceof Error ? err.message : "Unable to open portal");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  if (loading) return <LoadingState label="Opening company portal…" />;
  if (!user) return <Navigate to="/portal/login" replace />;
  if (failed) return <ErrorState title="Portal unavailable" description={failed} />;
  if (!target) return <LoadingState label="Opening company portal…" />;
  return <Navigate to={target} replace />;
}

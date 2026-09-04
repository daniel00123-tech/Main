import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components";
import { resolvePortalEntryTarget } from "./portal-home";

/** Redirect /portal → company picker (admin / multi-company) or own company Chat. */
export default function PortalEntryRedirect() {
  const { user, loading } = useAuth();
  const [target, setTarget] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    if (user.isPlatformAdmin) {
      setTarget("/portal/select");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const companies = await api.getCompanies();
        const next = resolvePortalEntryTarget({
          isPlatformAdmin: false,
          membershipCompanyIds: user.memberships.map((membership) => membership.companyId),
          companies,
        });
        if (!cancelled) setTarget(next);
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

  if (loading) return <LoadingState label="Opening your company…" />;
  if (!user) return <Navigate to="/portal/login" replace />;
  if (failed) return <ErrorState title="Portal unavailable" description={failed} />;
  if (!target) return <LoadingState label="Opening your company…" />;
  return <Navigate to={target} replace />;
}

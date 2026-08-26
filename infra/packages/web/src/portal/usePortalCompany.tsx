import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import type { Company, CompanyOverview, CompanyRole } from "@infra/shared";

type PortalCompanyContextValue = {
  user: ReturnType<typeof useAuth>["user"];
  membership: { companyId: string; role: CompanyRole } | null;
  company: Company | null;
  overview: CompanyOverview | null;
  loading: boolean;
  error: string | null;
  companies: Company[];
  refresh: () => Promise<void>;
};

const PortalCompanyContext = createContext<PortalCompanyContextValue | null>(
  null,
);

function resolveHostSubdomain(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname.toLowerCase();
  // e.g. caddington.infra-web.pages.dev or caddington.localhost
  const parts = host.split(".");
  if (host === "localhost" || host === "127.0.0.1") return null;
  if (host.endsWith("pages.dev") && parts.length >= 4) {
    // {sub}.{project}.pages.dev
    return parts[0] === "www" ? null : parts[0];
  }
  if (parts.length >= 3) {
    return parts[0] === "www" ? null : parts[0];
  }
  return null;
}

export function PortalCompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { companySlug } = useParams();
  const [company, setCompany] = useState<Company | null>(null);
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const membership = useMemo(() => {
    if (!user || !company) return null;
    const found = user.memberships.find((m) => m.companyId === company.id);
    if (found) return found;
    if (user.isPlatformAdmin) {
      return { companyId: company.id, role: "company_admin" as CompanyRole };
    }
    return null;
  }, [user, company]);

  const refresh = useCallback(async () => {
    if (!user) {
      setLoading(false);
      setError("Authentication required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await api.getCompanies();
      setCompanies(list);

      let matched: Company | undefined;
      const hostSub = resolveHostSubdomain();

      if (companySlug) {
        matched = list.find((c) => c.slug === companySlug);
        if (!matched) {
          // Allow portal subdomain as path alias (e.g. /portal/caddington/...)
          matched = list.find(
            (c) => c.portalSubdomain === companySlug || c.slug === companySlug,
          );
        }
      } else if (hostSub) {
        matched =
          list.find((c) => c.portalSubdomain === hostSub) ??
          list.find((c) => c.slug === hostSub || c.slug.startsWith(`${hostSub}-`));
      }

      if (!matched) {
        // Fallback: first membership company, else first accessible company for admins
        const memberCompanyIds = new Set(user.memberships.map((m) => m.companyId));
        matched =
          list.find((c) => memberCompanyIds.has(c.id)) ??
          (user.isPlatformAdmin ? list[0] : undefined);
      }

      if (!matched) {
        setCompany(null);
        setOverview(null);
        setError(
          user.isPlatformAdmin
            ? "No companies found. Create a company from Platform Admin → Companies."
            : "No company membership found for this account.",
        );
        return;
      }

      if (
        !user.isPlatformAdmin &&
        !user.memberships.some((m) => m.companyId === matched!.id)
      ) {
        setCompany(null);
        setOverview(null);
        setError("Access to this company portal is denied.");
        return;
      }

      const companyOverview = await api.getCompanyOverview(matched.slug);
      setCompany(matched);
      setOverview(companyOverview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load company portal");
      setCompany(null);
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [user, companySlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      membership,
      company,
      overview,
      loading,
      error,
      companies,
      refresh,
    }),
    [user, membership, company, overview, loading, error, companies, refresh],
  );

  return (
    <PortalCompanyContext.Provider value={value}>
      {children}
    </PortalCompanyContext.Provider>
  );
}

export function usePortalCompany() {
  const ctx = useContext(PortalCompanyContext);
  if (!ctx) {
    throw new Error("usePortalCompany must be used within PortalCompanyProvider");
  }
  return ctx;
}

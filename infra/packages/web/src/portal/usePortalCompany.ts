import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import type { Company, CompanyOverview, CompanyRole } from "@infra/shared";

const CADDINGTON_COMPANY_ID = "co_caddington";

export function usePortalCompany() {
  const { user } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adminRole, setAdminRole] = useState<CompanyRole | null>(null);

  const membership = useMemo(() => {
    if (!user?.memberships?.length) return null;
    // Prefer Caddington when present (first operational tenant), else first membership
    const caddington = user.memberships.find(
      (item) => item.companyId === CADDINGTON_COMPANY_ID,
    );
    return caddington ?? user.memberships[0];
  }, [user]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const companies = await api.getCompanies();
        let matched: Company | undefined;

        if (membership) {
          matched = companies.find((item) => item.id === membership.companyId);
        } else if (user?.isPlatformAdmin) {
          // Platform admins without a membership still need a company portal —
          // prefer Caddington Holdings (the live operational tenant).
          matched =
            companies.find((item) => item.id === CADDINGTON_COMPANY_ID) ??
            companies.find((item) => item.slug === "caddington-holdings") ??
            companies[0];
          setAdminRole("company_admin");
        }

        if (!matched) {
          setError(
            user?.isPlatformAdmin
              ? "No companies found. Create Caddington Holdings first."
              : "No company membership found for this account.",
          );
          return;
        }

        const companyOverview = await api.getCompanyOverview(matched.slug);
        setCompany(matched);
        setOverview(companyOverview);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load company portal");
      } finally {
        setLoading(false);
      }
    })();
  }, [membership, user?.isPlatformAdmin]);

  return {
    user,
    membership: membership ??
      (adminRole && company
        ? { companyId: company.id, role: adminRole }
        : null),
    company,
    overview,
    loading,
    error,
  };
}

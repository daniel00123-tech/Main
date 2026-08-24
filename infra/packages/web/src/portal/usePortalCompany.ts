import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import type { Company, CompanyOverview } from "@infra/shared";

export function usePortalCompany() {
  const { user } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [overview, setOverview] = useState<CompanyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const membership = useMemo(() => {
    if (!user || user.isPlatformAdmin) return user?.memberships[0] ?? null;
    return user.memberships[0] ?? null;
  }, [user]);

  useEffect(() => {
    if (!membership) {
      setLoading(false);
      setError("No company membership found for this account.");
      return;
    }

    void (async () => {
      try {
        const companies = await api.getCompanies();
        const matched = companies.find((item) => item.id === membership.companyId);
        if (!matched) {
          setError("Company not found.");
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
  }, [membership]);

  return {
    user,
    membership,
    company,
    overview,
    loading,
    error,
  };
}

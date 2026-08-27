import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Company } from "@infra/shared";
import { api } from "../api";

export type AdminScope =
  | { mode: "platform" }
  | { mode: "company"; companyId: string; companySlug: string; companyName: string };

interface AdminScopeContextValue {
  scope: AdminScope;
  companies: Company[];
  loading: boolean;
  setPlatformScope: () => void;
  setCompanyScope: (company: Pick<Company, "id" | "slug" | "name">) => void;
  companyId: string | undefined;
  companySlug: string | undefined;
  scopeLabel: string;
  scopeSublabel: string;
}

const STORAGE_KEY = "infra.admin.scope";
const RECENT_KEY = "infra.admin.recentCompanies";

const AdminScopeContext = createContext<AdminScopeContextValue | null>(null);

function loadStoredScope(): AdminScope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "platform" };
    const parsed = JSON.parse(raw) as { mode?: string; companySlug?: string };
    if (parsed.mode === "company" && parsed.companySlug) {
      return {
        mode: "company",
        companyId: "",
        companySlug: parsed.companySlug,
        companyName: parsed.companySlug,
      };
    }
  } catch {
    /* ignore */
  }
  return { mode: "platform" };
}

function persistScope(scope: AdminScope) {
  try {
    if (scope.mode === "platform") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "platform" }));
    } else {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ mode: "company", companySlug: scope.companySlug }),
      );
      const recent = [
        scope.companySlug,
        ...loadRecent().filter((s) => s !== scope.companySlug),
      ].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    }
  } catch {
    /* ignore */
  }
}

export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function AdminScopeProvider({ children }: { children: React.ReactNode }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<AdminScope>(() => loadStoredScope());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.getCompanies({ limit: 200 });
        if (cancelled) return;
        setCompanies(list);
        setScope((current) => {
          if (current.mode !== "company") return current;
          const match = list.find((c) => c.slug === current.companySlug);
          if (!match) return { mode: "platform" };
          return {
            mode: "company",
            companyId: match.id,
            companySlug: match.slug,
            companyName: match.name,
          };
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setPlatformScope = useCallback(() => {
    const next: AdminScope = { mode: "platform" };
    setScope(next);
    persistScope(next);
  }, []);

  const setCompanyScope = useCallback(
    (company: Pick<Company, "id" | "slug" | "name">) => {
      const next: AdminScope = {
        mode: "company",
        companyId: company.id,
        companySlug: company.slug,
        companyName: company.name,
      };
      setScope(next);
      persistScope(next);
    },
    [],
  );

  const scopeLabel =
    scope.mode === "platform" ? "INFRA Platform" : scope.companyName;
  const scopeSublabel =
    scope.mode === "platform" ? "All companies" : scope.companySlug;

  const value = useMemo(
    () => ({
      scope,
      companies,
      loading,
      setPlatformScope,
      setCompanyScope,
      companyId: scope.mode === "company" ? scope.companyId : undefined,
      companySlug: scope.mode === "company" ? scope.companySlug : undefined,
      scopeLabel,
      scopeSublabel,
    }),
    [
      scope,
      companies,
      loading,
      setPlatformScope,
      setCompanyScope,
      scopeLabel,
      scopeSublabel,
    ],
  );

  return (
    <AdminScopeContext.Provider value={value}>{children}</AdminScopeContext.Provider>
  );
}

export function useAdminScope() {
  const ctx = useContext(AdminScopeContext);
  if (!ctx) {
    throw new Error("useAdminScope must be used within AdminScopeProvider");
  }
  return ctx;
}

/** Optional hook for pages outside provider (should not happen). */
export function useAdminScopeOptional() {
  return useContext(AdminScopeContext);
}

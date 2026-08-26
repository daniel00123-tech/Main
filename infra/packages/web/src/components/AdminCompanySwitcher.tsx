import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Clock, ExternalLink, Globe } from "lucide-react";
import type { Company } from "@infra/shared";
import { api } from "../api";
import { SearchInput, StatusBadge } from "../components";

const RECENT_KEY = "infra.admin.recentCompanies";

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function rememberRecent(slug: string) {
  const next = [slug, ...loadRecent().filter((s) => s !== slug)].slice(0, 6);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export default function AdminCompanySwitcher() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const list = await api.getCompanies({ q: query.trim() || undefined, limit: 200 });
        if (!cancelled) setCompanies(list);
      } catch {
        if (!cancelled) setCompanies([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const companyBySlug = useMemo(() => new Map(companies.map((c) => [c.slug, c])), [companies]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? companies.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.slug.toLowerCase().includes(q) ||
            c.id.toLowerCase().includes(q),
        )
      : companies;
    return pool.slice(0, 10);
  }, [companies, query]);

  const recentCompanies = recent
    .map((slug) => companyBySlug.get(slug))
    .filter((c): c is Company => Boolean(c));

  function selectCompany(slug: string, destination: "admin" | "portal") {
    rememberRecent(slug);
    setRecent(loadRecent());
    setOpen(false);
    setQuery("");
    navigate(destination === "portal" ? `/portal/${slug}/dashboard` : `/companies/${slug}`);
  }

  return (
    <div ref={containerRef} className="admin-company-switcher">
      <SearchInput
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        placeholder="Find company…"
        className="admin-company-search-input"
        aria-label="Find company"
      />
      {open ? (
        <div className="admin-company-switcher-panel card" role="listbox" aria-label="Company switcher">
          {loading ? (
            <p className="muted small panel-pad">Loading companies…</p>
          ) : (
            <>
              {recentCompanies.length > 0 && !query.trim() ? (
                <div className="panel-section">
                  <div className="panel-section-label">
                    <Clock size={14} aria-hidden /> Recent
                  </div>
                  {recentCompanies.map((company) => (
                    <CompanyOption
                      key={`recent-${company.id}`}
                      company={company}
                      onAdmin={() => selectCompany(company.slug, "admin")}
                      onPortal={() => selectCompany(company.slug, "portal")}
                    />
                  ))}
                </div>
              ) : null}
              <div className="panel-section">
                <div className="panel-section-label">
                  {query.trim() ? "Search results" : "All companies"}
                </div>
                {matches.length === 0 ? (
                  <p className="muted small panel-pad">No companies match.</p>
                ) : (
                  matches.map((company) => (
                    <CompanyOption
                      key={company.id}
                      company={company}
                      onAdmin={() => selectCompany(company.slug, "admin")}
                      onPortal={() => selectCompany(company.slug, "portal")}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CompanyOption({
  company,
  onAdmin,
  onPortal,
}: {
  company: Company;
  onAdmin: () => void;
  onPortal: () => void;
}) {
  return (
    <div className="company-switcher-row">
      <button type="button" className="company-switcher-main" onClick={onAdmin}>
        <Building2 size={16} aria-hidden />
        <span className="company-switcher-text">
          <strong>{company.name}</strong>
          <span className="muted small">{company.slug}</span>
        </span>
        <StatusBadge status={company.status} />
      </button>
      <button
        type="button"
        className="button button-ghost button-small"
        title="Open company portal"
        aria-label={`Open ${company.name} portal`}
        onClick={onPortal}
      >
        <Globe size={14} />
      </button>
      <button
        type="button"
        className="button button-ghost button-small"
        title="Open control centre"
        aria-label={`Open ${company.name} control centre`}
        onClick={onAdmin}
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
}

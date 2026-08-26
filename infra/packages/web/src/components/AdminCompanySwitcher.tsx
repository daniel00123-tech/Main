import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronDown, ExternalLink, Globe, Globe2 } from "lucide-react";
import type { Company } from "@infra/shared";
import { useAdminScope, loadRecent } from "../context/AdminScopeContext";
import { SearchInput, StatusBadge } from "../components";

export default function AdminCompanySwitcher() {
  const navigate = useNavigate();
  const {
    scope,
    companies,
    loading,
    setPlatformScope,
    setCompanyScope,
    scopeLabel,
    scopeSublabel,
  } = useAdminScope();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const containerRef = useRef<HTMLDivElement>(null);

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
    return pool.slice(0, 12);
  }, [companies, query]);

  const recentCompanies = recent
    .map((slug) => companyBySlug.get(slug))
    .filter((c): c is Company => Boolean(c));

  function selectPlatform() {
    setPlatformScope();
    setOpen(false);
    setQuery("");
  }

  function selectCompany(company: Company) {
    setCompanyScope(company);
    setRecent(loadRecent());
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} className="admin-company-switcher">
      <button
        type="button"
        className="admin-company-switcher-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
      >
        {scope.mode === "platform" ? (
          <Globe2 size={16} aria-hidden />
        ) : (
          <Building2 size={16} aria-hidden />
        )}
        <span className="admin-scope-trigger-text">
          <span className="admin-scope-trigger-label">{scopeLabel}</span>
          <span className="admin-scope-trigger-sublabel muted small">{scopeSublabel}</span>
        </span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <div className="admin-company-switcher-panel card" role="listbox" aria-label="Scope selector">
          <div className="panel-pad" style={{ paddingBottom: 8 }}>
            <SearchInput
              value={query}
              onChange={(v) => setQuery(v)}
              placeholder="Search companies…"
              className="admin-company-search-input"
              aria-label="Search companies"
            />
          </div>
          {loading ? (
            <p className="muted small panel-pad">Loading…</p>
          ) : (
            <>
              <div className="panel-section">
                <div className="panel-section-label">Platform</div>
                <button
                  type="button"
                  className={`scope-option ${scope.mode === "platform" ? "scope-option-active" : ""}`}
                  onClick={selectPlatform}
                >
                  <Globe2 size={16} aria-hidden />
                  <span className="company-switcher-text">
                    <strong>INFRA Platform</strong>
                    <span className="muted small">All companies</span>
                  </span>
                  {scope.mode === "platform" ? (
                    <span className="scope-option-check" aria-hidden>
                      ✓
                    </span>
                  ) : null}
                </button>
              </div>
              {recentCompanies.length > 0 && !query.trim() ? (
                <div className="panel-section">
                  <div className="panel-section-label">Recent companies</div>
                  {recentCompanies.map((company) => (
                    <CompanyOption
                      key={`recent-${company.id}`}
                      company={company}
                      active={scope.mode === "company" && scope.companySlug === company.slug}
                      onSelect={() => selectCompany(company)}
                      onAdmin={() => navigate(`/companies/${company.slug}`)}
                      onPortal={() => navigate(`/portal/${company.slug}/dashboard`)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="panel-section">
                <div className="panel-section-label">Companies</div>
                {matches.length === 0 ? (
                  <p className="muted small panel-pad">No companies match.</p>
                ) : (
                  matches.map((company) => (
                    <CompanyOption
                      key={company.id}
                      company={company}
                      active={scope.mode === "company" && scope.companySlug === company.slug}
                      onSelect={() => selectCompany(company)}
                      onAdmin={() => navigate(`/companies/${company.slug}`)}
                      onPortal={() => navigate(`/portal/${company.slug}/dashboard`)}
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
  active,
  onSelect,
  onAdmin,
  onPortal,
}: {
  company: Company;
  active: boolean;
  onSelect: () => void;
  onAdmin: () => void;
  onPortal: () => void;
}) {
  return (
    <div className={`company-switcher-row ${active ? "scope-option-active" : ""}`}>
      <button type="button" className="company-switcher-main" onClick={onSelect}>
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
        title="Open company detail"
        aria-label={`Open ${company.name} detail`}
        onClick={onAdmin}
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
}

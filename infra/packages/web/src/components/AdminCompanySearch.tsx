import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2 } from "lucide-react";
import type { Company } from "@infra/shared";
import { api } from "../api";
import { SearchInput, StatusBadge } from "../components";

export default function AdminCompanySearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const list = await api.getCompanies({ limit: 200 });
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
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies.slice(0, 8);
    return companies
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.slug.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [companies, query]);

  function go(slug: string) {
    setOpen(false);
    setQuery("");
    navigate(`/companies/${slug}`);
  }

  return (
    <div ref={containerRef} className="admin-company-search" style={{ position: "relative", minWidth: 220, flex: 1, maxWidth: 360 }}>
      <SearchInput
        value={query}
        onChange={(v) => {
          setQuery(v);
          setOpen(true);
        }}
        placeholder="Find company…"
        className="admin-company-search-input"
      />
      {open && (query.trim() || matches.length > 0) ? (
        <div
          className="card"
          role="listbox"
          aria-label="Company search results"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 50,
            padding: 8,
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {loading ? (
            <p className="muted small" style={{ margin: 8 }}>
              Loading companies…
            </p>
          ) : matches.length === 0 ? (
            <p className="muted small" style={{ margin: 8 }}>
              No companies match &ldquo;{query}&rdquo;
            </p>
          ) : (
            matches.map((company) => (
              <button
                key={company.id}
                type="button"
                role="option"
                className="button button-ghost"
                style={{
                  width: "100%",
                  justifyContent: "flex-start",
                  gap: 10,
                  marginBottom: 4,
                  textAlign: "left",
                }}
                onClick={() => go(company.slug)}
              >
                <Building2 size={16} aria-hidden />
                <span style={{ flex: 1 }}>
                  <strong>{company.name}</strong>
                  <span className="muted small" style={{ display: "block" }}>
                    {company.slug}
                  </span>
                </span>
                <StatusBadge status={company.status} />
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

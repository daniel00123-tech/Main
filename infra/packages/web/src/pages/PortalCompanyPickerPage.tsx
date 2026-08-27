import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Building2, Globe } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, SearchInput, StatusBadge } from "../components";

/** Platform administrators choose a company before entering the portal. */
export default function PortalCompanyPickerPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [companies, setCompanies] = useState<Awaited<ReturnType<typeof api.getCompanies>>>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!user.isPlatformAdmin) {
      navigate("/portal", { replace: true });
      return;
    }
    void (async () => {
      try {
        setCompanies(await api.getCompanies());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load companies");
      } finally {
        setLoading(false);
      }
    })();
  }, [user, navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q),
    );
  }, [companies, query]);

  if (loading) return <LoadingState label="Loading companies…" />;
  if (error) return <ErrorState title="Unable to open portal" description={error} />;
  if (!user?.isPlatformAdmin) return null;

  return (
    <div className="portal-picker-page">
      <PageHeader
        title="Company portal"
        description="Select a company to open its portal. Platform administrators can switch companies at any time from inside the portal."
      />
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder="Search companies…"
        className="portal-picker-search"
      />
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Building2 size={28} />}
          title="No companies found"
          description="Create a company from the Control Plane first."
          action={
            <Link to="/companies" className="button button-primary">
              Go to Companies
            </Link>
          }
        />
      ) : (
        <div className="portal-picker-grid">
          {filtered.map((company) => (
            <article key={company.id} className="entity-card portal-picker-card">
              <div className="connection-header">
                <h3>{company.name}</h3>
                <StatusBadge status={company.status} />
              </div>
              <p className="muted small">{company.slug}</p>
              <div className="portal-picker-actions">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => navigate(`/portal/${company.slug}/dashboard`)}
                >
                  <Globe size={14} /> Open portal
                </Button>
                <Link to={`/companies/${company.slug}`} className="button button-secondary button-small">
                  Control centre
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

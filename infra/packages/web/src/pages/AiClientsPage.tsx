import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bot } from "lucide-react";
import { CONNECTOR_CATALOGUE } from "@infra/shared";
import { api } from "../api";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SearchInput,
  StatusBadge,
  FilterBar,
} from "../components";
import { formatRelativeTime } from "../lib/format";

type AiRow = {
  id: string;
  clientType: string;
  displayName: string;
  status: string;
  companyName: string;
  companySlug: string;
  gatewayEndpoint?: string;
  lastUsedAt?: string | null;
  source: "live" | "catalogue";
};

const AI_CHANNELS = CONNECTOR_CATALOGUE.filter((c) => c.integrationType === "ai_channel");

export default function AiClientsPage() {
  const [rows, setRows] = useState<AiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const companies = await api.getCompanies();
      const live: AiRow[] = [];
      await Promise.all(
        companies.map(async (company) => {
          try {
            const connections = await api.getAiConnections(company.slug);
            for (const conn of connections) {
              live.push({
                id: conn.id,
                clientType: conn.clientType,
                displayName: conn.displayName || conn.clientType,
                status: conn.status,
                companyName: company.name,
                companySlug: company.slug,
                gatewayEndpoint: conn.gatewayEndpoint,
                lastUsedAt: conn.lastUsedAt,
                source: "live",
              });
            }
          } catch {
            /* company may not expose AI connections to this session */
          }
        }),
      );

      if (live.length === 0) {
        // Show catalogue channels as available (not connected) — truthful, not mock activity
        setRows(
          AI_CHANNELS.map((channel) => ({
            id: `catalogue-${channel.slug}`,
            clientType: channel.slug,
            displayName: channel.name,
            status: channel.catalogueStatus === "coming_soon" ? "coming_soon" : "available",
            companyName: "Any company",
            companySlug: "",
            source: "catalogue" as const,
          })),
        );
      } else {
        // Merge: live connections + catalogue channels not yet represented
        const present = new Set(live.map((r) => r.clientType.toLowerCase()));
        const extras = AI_CHANNELS.filter((c) => !present.has(c.slug.toLowerCase()) && !present.has(c.name.toLowerCase())).map(
          (channel) => ({
            id: `catalogue-${channel.slug}`,
            clientType: channel.slug,
            displayName: channel.name,
            status: channel.catalogueStatus === "coming_soon" ? "coming_soon" : "available",
            companyName: "Catalogue",
            companySlug: "",
            source: "catalogue" as const,
          }),
        );
        setRows([...live, ...extras]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load AI clients");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.displayName.toLowerCase().includes(q) ||
        r.companyName.toLowerCase().includes(q) ||
        r.clientType.toLowerCase().includes(q),
    );
  }, [rows, query]);

  if (loading) return <LoadingState label="Loading AI clients…" />;
  if (error) {
    return <ErrorState title="Unable to load AI clients" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="AI Clients"
        description="How staff access company systems through AI assistants and channels."
      />

      <FilterBar>
        <SearchInput value={query} onChange={setQuery} placeholder="Search AI clients…" className="grow" />
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="No AI clients yet"
          description="Connect ChatGPT or Claude from a company portal to give authorised staff access."
        />
      ) : (
        <div className="connector-grid">
          {filtered.map((row) => (
            <article key={row.id} className="connector-card" style={{ minHeight: 180 }}>
              <div className="connector-card-top">
                <div className="connector-logo" aria-hidden>
                  <Bot size={22} color="#111" />
                </div>
                <StatusBadge status={row.status} />
              </div>
              <h3>{row.displayName}</h3>
              <p>
                {row.companySlug ? (
                  <Link to={`/companies/${row.companySlug}`}>{row.companyName}</Link>
                ) : (
                  row.companyName
                )}
              </p>
              <div className="muted small">
                {row.lastUsedAt
                  ? `Last activity ${formatRelativeTime(row.lastUsedAt)}`
                  : row.source === "catalogue"
                    ? "Not connected to a company yet"
                    : "No recent activity"}
              </div>
              <div className="connector-card-actions">
                {row.companySlug ? (
                  <Link to="/portal/ai-connections" className="button button-primary button-small">
                    {row.clientType === "chatgpt"
                      ? "Reconnect / new token"
                      : "Open company portal"}
                  </Link>
                ) : (
                  <span className="muted small">Connect from a company portal</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

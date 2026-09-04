import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  DataCard,
  EmptyState,
  ErrorState,
  FilterBar,
  LoadingState,
  PageHeader,
  Select,
  StatusBadge,
} from "../components";

export default function DailyImprovementPage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [channel, setChannel] = useState("");
  const [provider, setProvider] = useState("");
  const [severity, setSeverity] = useState("");
  const [capability, setCapability] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getDailyImprovement>> | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.getDailyImprovement({
          tenant: scopeCompanyId || undefined,
          channel: channel || undefined,
          provider: provider || undefined,
          severity: severity || undefined,
          capability: capability || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load daily improvement");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [scopeCompanyId, channel, provider, severity, capability]);

  if (loading) return <LoadingState label="Loading daily improvement…" />;
  if (error) return <ErrorState title="Unable to load daily improvement" description={error} onRetry={() => void load()} />;

  const jobs = data?.engineeringQueue ?? [];
  const deployments = data?.deployments ?? [];
  const clusters = data?.clusters ?? [];

  return (
    <>
      <PageHeader
        title="Daily improvement"
        description="Platform-wide quality, clusters, and automatic engineering. The 17:00 report is informational — there is no approve or deploy button."
        actions={
          <Link className="button button-secondary button-small" to="/quality">
            Quality issues
          </Link>
        }
      />
      <div className="grid gap-4 md:grid-cols-4">
        <DataCard title="Today's interactions" metric={String(data?.todayInteractions ?? 0)} />
        <DataCard title="Quality score" metric={data?.qualityScore == null ? "n/a" : String(data.qualityScore)} />
        <DataCard title="Open clusters" metric={String(clusters.length)} />
        <DataCard title="Engineering jobs" metric={String(jobs.length)} />
      </div>
      <FilterBar className="filter-bar-mobile-stack">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="portal_chat">Portal Chat</option>
          <option value="chatgpt">ChatGPT MCP</option>
        </Select>
        <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">All providers</option>
          <option value="openai">OpenAI</option>
          <option value="workers-ai">Cloudflare</option>
        </Select>
        <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>
          <option value="CRITICAL">CRITICAL</option>
          <option value="HIGH">HIGH</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="LOW">LOW</option>
        </Select>
        <Select value={capability} onChange={(e) => setCapability(e.target.value)}>
          <option value="">All capabilities</option>
          <option value="MIXED_MULTI_TOOL">MIXED_MULTI_TOOL</option>
          <option value="XERO_EXACT_TOOL_SELECTION">XERO_EXACT_TOOL_SELECTION</option>
          <option value="CROSS_TENANT_RISK">CROSS_TENANT_RISK</option>
        </Select>
      </FilterBar>
      <h2 className="mt-6 text-lg font-semibold">Failure clusters</h2>
      {clusters.length === 0 ? (
        <EmptyState icon={<Activity size={28} />} title="No clusters yet" description="The 16:30 QA window groups repeating defects across tenants." />
      ) : (
        <div className="mt-3 space-y-2">
          {clusters.map((cluster) => (
            <div key={cluster.id} className="rounded-lg border border-stone-200 p-3">
              <div className="flex items-center justify-between gap-3">
                <strong>{cluster.title}</strong>
                <StatusBadge status={cluster.severity.toLowerCase()} />
              </div>
              <p className="text-sm text-stone-600">
                {cluster.clusterKey} · {cluster.interactionCount} interactions · {cluster.tenantCount} tenants · {cluster.status}
              </p>
            </div>
          ))}
        </div>
      )}
      <h2 className="mt-6 text-lg font-semibold">Engineering queue</h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-stone-600">No automatic engineering jobs queued.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {jobs.map((job) => (
            <li key={String(job.id)} className="rounded-lg border border-stone-200 p-3 text-sm">
              <strong>{String(job.title ?? job.cluster_key)}</strong> · {String(job.severity)} · {String(job.status)}
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-6 text-lg font-semibold">Deployments and rollbacks</h2>
      {deployments.length === 0 ? (
        <p className="text-sm text-stone-600">No automatic deployments recorded yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {deployments.map((row) => (
            <li key={String(row.id)} className="rounded-lg border border-stone-200 p-3 text-sm">
              {String(row.sha ?? "unknown SHA")} · {String(row.verification_status)}
              {row.rollback_at ? " · ROLLED BACK" : ""}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

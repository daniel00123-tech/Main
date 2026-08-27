import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  EmptyState,
  KeyValue,
  LoadingState,
  MetricCard,
  MetricGrid,
  Notice,
  SectionCard,
  StatusBadge,
} from "../../components";
import { api } from "../../api";
import { formatRelativeTime } from "../../lib/format";

type Props = {
  companySlug: string;
};

export function Microsoft365AdminPanel({ companySlug }: Props) {
  const [dashboard, setDashboard] = useState<Awaited<ReturnType<typeof api.getMicrosoftDashboard>> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDashboard(await api.getMicrosoftDashboard(companySlug));
    } catch {
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [companySlug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function rediscover() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.discoverMicrosoftSources(companySlug);
      setMessage(`Rediscovered ${result.discovered} sources.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading Microsoft 365…" />;

  const health = dashboard?.health;
  const configured = health?.credentials.configured ?? false;

  return (
    <SectionCard
      title="Microsoft 365"
      description="Platform operator view — auth health, sources, and sync state. No secrets shown."
    >
      {message ? <Notice tone="info">{message}</Notice> : null}

      <MetricGrid cols={4}>
        <MetricCard
          label="Auth mode"
          value={String(health?.credentials.authMode ?? "unknown")}
          hint={configured ? "Credentials configured" : "Awaiting secrets"}
        />
        <MetricCard
          label="Graph health"
          value={health?.graph?.ok ? "OK" : configured ? "Error" : "Not tested"}
          hint={health?.graph?.message ?? "—"}
        />
        <MetricCard
          label="OneDrive"
          value={`${dashboard?.summary.onedrive.included ?? 0}/${dashboard?.summary.onedrive.total ?? 0} included`}
          hint={`${dashboard?.summary.onedrive.indexed ?? 0} indexed`}
        />
        <MetricCard
          label="SharePoint"
          value={`${dashboard?.summary.sharepoint.included ?? 0}/${dashboard?.summary.sharepoint.total ?? 0} included`}
          hint={`${dashboard?.summary.sharepoint.indexed ?? 0} indexed`}
        />
      </MetricGrid>

      <div className="kv-stack" style={{ marginTop: 16 }}>
        <KeyValue
          label="Tenant ID"
          value={health?.credentials.tenantIdMasked ?? "Not configured"}
          mono
        />
        <KeyValue
          label="Knowledge bridge"
          value={health?.knowledgeBridgeConfigured ? "Configured" : "Missing CADDINGTON_ADMIN_TOKEN"}
        />
        <KeyValue label="Outlook" value="Requires Mail.Read application permission" />
      </div>

      {!configured ? (
        <div style={{ marginTop: 16 }}>
          <Notice tone="warning">
            Microsoft credentials are not configured on infra-api. Daniel must set MICROSOFT_TENANT_ID,
            MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and CADDINGTON_ADMIN_TOKEN via wrangler secrets.
          </Notice>
        </div>
      ) : null}

      {health?.graph && !health.graph.ok ? (
        <div style={{ marginTop: 16 }}>
          <Notice tone="danger">{health.graph.message}</Notice>
        </div>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
        <Button type="button" variant="primary" size="sm" disabled={busy || !configured} onClick={() => void rediscover()}>
          Rediscover sources
        </Button>
        <Link to={`/portal/${companySlug}/microsoft-365`} className="button button-secondary button-small">
          Open portal dashboard
        </Link>
      </div>

      {!dashboard || dashboard.sources.length === 0 ? (
        <EmptyState
          title="No Microsoft sources"
          description="Run discovery after credentials are configured."
        />
      ) : (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Inclusion</th>
                <th>Folder scope</th>
                <th>Sync</th>
                <th>Indexed</th>
                <th>Queue</th>
                <th>Last sync</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <strong>{source.displayName}</strong>
                    {source.ownerUpn ? <div className="muted small">{source.ownerUpn}</div> : null}
                  </td>
                  <td>{source.sourceType}</td>
                  <td>
                    <StatusBadge status={source.inclusionStatus} />
                  </td>
                  <td className="muted small">
                    {source.folderScopeMode === "all"
                      ? source.sourceType === "onedrive"
                        ? "Entire OneDrive"
                        : "Whole source"
                      : source.folderScopeMode === "include_paths" && (source.folderIncludePaths?.length ?? 0) > 0
                        ? `Include: ${source.folderIncludePaths!.join(", ")}`
                        : source.folderScopeMode === "exclude_paths" &&
                            (source.folderExcludePaths?.length ?? 0) > 0
                          ? `Exclude: ${source.folderExcludePaths!.join(", ")}`
                          : "Whole source"}
                  </td>
                  <td>
                    <StatusBadge status={source.syncStatus} />
                  </td>
                  <td>{source.itemsIndexed}</td>
                  <td className="muted small">
                    {(source.queueStats?.pending ?? 0) > 0
                      ? `${source.queueStats!.pending} pending`
                      : (source.queueStats?.byStatus?.failed ?? 0) > 0
                        ? `${source.queueStats!.byStatus!.failed} failed`
                        : "—"}
                  </td>
                  <td className="muted small">
                    {source.lastSyncAt ? formatRelativeTime(source.lastSyncAt) : "—"}
                  </td>
                  <td className="muted small">{source.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

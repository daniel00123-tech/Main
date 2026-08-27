import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  SectionCard,
  StatusBadge,
  useIsMobile,
} from "../components";
import { api } from "../api";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

type MicrosoftSource = Awaited<ReturnType<typeof api.getMicrosoftDashboard>>["sources"][number];

function inclusionLabel(status: string): string {
  if (status === "included") return "Included";
  if (status === "excluded") return "Excluded";
  return "Available";
}

export default function PortalMicrosoft365Page() {
  const { company, membership, user, loading, error } = usePortalCompany();
  const [dashboard, setDashboard] = useState<Awaited<ReturnType<typeof api.getMicrosoftDashboard>> | null>(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [byoTenantId, setByoTenantId] = useState("");
  const [byoClientId, setByoClientId] = useState("");
  const [byoClientSecret, setByoClientSecret] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();

  const canManage =
    user?.isPlatformAdmin ||
    membership?.role === "company_admin" ||
    membership?.role === "director";

  const load = useCallback(async () => {
    if (!company) return;
    setDashLoading(true);
    try {
      setDashboard(await api.getMicrosoftDashboard(company.slug));
    } finally {
      setDashLoading(false);
    }
  }, [company]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const ms = searchParams.get("microsoft");
    if (!ms) return;
    if (ms === "connected") {
      setMessage(`Microsoft 365 connected (tenant ${searchParams.get("tenant") ?? "bound"}).`);
    } else if (ms === "error") {
      setMessage(`Microsoft connection failed: ${searchParams.get("reason") ?? "unknown error"}.`);
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const onedriveSources = useMemo(() => {
    const list = dashboard?.sources.filter((s) => s.sourceType === "onedrive") ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        (s.ownerDisplayName ?? "").toLowerCase().includes(q),
    );
  }, [dashboard, filter]);

  const sharepointSources = useMemo(() => {
    const list = dashboard?.sources.filter((s) => s.sourceType === "sharepoint") ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) => s.displayName.toLowerCase().includes(q));
  }, [dashboard, filter]);

  async function connectMicrosoft(authMode: "company_app" | "platform_multitenant") {
    if (!company) return;
    setBusy(true);
    setMessage(null);
    try {
      const started = await api.startMicrosoftOAuth(company.slug, {
        authMode,
        instanceId: dashboard?.instanceId ?? undefined,
      });
      window.location.assign(started.authorizationUrl);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to start Microsoft connection");
      setBusy(false);
    }
  }

  async function saveByoCredentials() {
    if (!company) return;
    setBusy(true);
    setMessage(null);
    try {
      let instanceId = dashboard?.instanceId ?? undefined;
      if (!instanceId) {
        const created = await api.setupConnector(company.slug, "conn_microsoft_365", {
          name: "Microsoft 365",
        });
        instanceId = created.id;
      }
      await api.saveConnectorCredentials(company.slug, instanceId, {
        credentials: {
          tenantId: byoTenantId.trim(),
          clientId: byoClientId.trim(),
          clientSecret: byoClientSecret.trim(),
        },
      });
      setByoClientSecret("");
      setMessage("Entra app credentials stored securely. Click Connect to grant admin consent.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Unable to save credentials");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!company || !dashboard?.instanceId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.testConnectorConnection(company.slug, dashboard.instanceId);
      setMessage(result.message ?? "Connection test completed.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Connection test failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnectMicrosoft() {
    if (!company || !dashboard?.instanceId) return;
    if (!window.confirm("Disconnect Microsoft 365 for this company? Sync will stop until reconnected.")) return;
    setBusy(true);
    try {
      await api.disconnectConnector(company.slug, dashboard.instanceId);
      setMessage("Microsoft 365 disconnected.");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  async function discover(includeAllOneDrives: boolean, includeAllSharePoint: boolean) {
    if (!company) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.discoverMicrosoftSources(company.slug, {
        includeAllOneDrives,
        includeAllSharePoint,
      });
      setMessage(`Discovered ${result.discovered} sources (${result.onedrive} OneDrive, ${result.sharepoint} SharePoint).`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleInclusion(source: MicrosoftSource) {
    if (!company) return;
    const next =
      source.inclusionStatus === "included"
        ? "excluded"
        : source.inclusionStatus === "excluded"
          ? "available"
          : "included";
    if (
      next === "included" &&
      !window.confirm(`Include "${source.displayName}" in company knowledge? Files from this source will be indexed.`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.setMicrosoftSourceInclusion(company.slug, source.id, next);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function syncSource(source: MicrosoftSource) {
    if (!company) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.syncMicrosoftSource(company.slug, source.id);
      const syncNote =
        result.queued > 0
          ? `${result.queued} files queued for background indexing (${result.skipped} skipped unchanged).`
          : `Synced ${source.displayName}: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed.`;
      setMessage(syncNote);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function editFolderScope(source: MicrosoftSource) {
    if (!company) return;
    const current = (source.folderIncludePaths ?? []).join(", ");
    const input = window.prompt(
      `Included folder paths for "${source.displayName}" (comma-separated). Leave empty for whole source.`,
      current,
    );
    if (input === null) return;
    const includePaths = input
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      await api.setMicrosoftSourceFolderScope(company.slug, source.id, {
        mode: includePaths.length > 0 ? "include_paths" : "all",
        includePaths,
      });
      setMessage(`Updated folder scope for ${source.displayName}.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Folder scope update failed");
    } finally {
      setBusy(false);
    }
  }

  function folderScopeSummary(source: MicrosoftSource): string {
    if (source.folderScopeMode === "all" && source.inclusionStatus === "included") {
      return source.sourceType === "onedrive" ? "Entire OneDrive" : "Whole source";
    }
    if (source.folderScopeMode === "include_paths" && (source.folderIncludePaths?.length ?? 0) > 0) {
      return `Folders: ${source.folderIncludePaths!.join(", ")}`;
    }
    if (source.folderScopeMode === "exclude_paths" && (source.folderExcludePaths?.length ?? 0) > 0) {
      return `Excluding: ${source.folderExcludePaths!.join(", ")}`;
    }
    return source.inclusionStatus === "included" ? "Whole source" : "—";
  }

  function queueSummary(source: MicrosoftSource): string | null {
    const stats = source.queueStats;
    if (!stats) return null;
    const pending = stats.pending ?? 0;
    if (pending > 0) {
      const indexed = stats.byStatus?.indexed ?? 0;
      const queued = stats.byStatus?.queued ?? 0;
      const processing = stats.byStatus?.processing ?? 0;
      return `Processing: ${indexed} indexed, ${queued} queued, ${processing} active`;
    }
    if ((stats.byStatus?.failed ?? 0) > 0 || (stats.byStatus?.dead_letter ?? 0) > 0) {
      return `${(stats.byStatus?.failed ?? 0) + (stats.byStatus?.dead_letter ?? 0)} failed`;
    }
    return null;
  }

  function renderSourceActions(source: MicrosoftSource) {
    if (!canManage) return null;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void toggleInclusion(source)}>
          {source.inclusionStatus === "included" ? "Exclude" : "Include"}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void editFolderScope(source)}>
          Folders
        </Button>
        {source.inclusionStatus === "included" ? (
          <Button type="button" size="sm" variant="primary" disabled={busy} onClick={() => void syncSource(source)}>
            Sync now
          </Button>
        ) : null}
      </div>
    );
  }

  if (loading || dashLoading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load Microsoft 365" description={error ?? undefined} />;
  }

  const configured = dashboard?.health.connected ?? dashboard?.health.credentials.configured ?? false;
  const authMode = dashboard?.health.authMode ?? null;
  const tenantMasked = dashboard?.health.tenantIdMasked ?? dashboard?.health.credentials.tenantIdMasked;

  return (
    <>
      <PortalPageHeader
        title="Microsoft 365"
        description="OneDrive and SharePoint for company knowledge. Outlook mail onboarding is out of scope for this sprint."
        actions={
          <Link to={`/portal/${company.slug}/connectors`} className="button button-secondary button-small">
            All connections
          </Link>
        }
      />

      {canManage ? (
        <SectionCard title="Connect Microsoft 365">
          <div className="stack" style={{ gap: 12 }}>
            <div className="muted small">
              Connection:{" "}
              {configured ? (
                <>
                  Connected · {authMode ?? "unknown"} · tenant {tenantMasked ?? "—"}
                </>
              ) : (
                "Not connected"
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void connectMicrosoft("company_app")}
              >
                Connect (BYO Entra app)
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void connectMicrosoft("platform_multitenant")}
              >
                Connect (INFRA SaaS app)
              </Button>
              {dashboard?.instanceId ? (
                <>
                  <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void testConnection()}>
                    Test connection
                  </Button>
                  {authMode !== "platform_legacy" ? (
                    <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void disconnectMicrosoft()}>
                      Disconnect
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
            <Notice tone="info">
              BYO Entra app: register an application in your tenant with application permissions
              Files.Read.All, Sites.Read.All, and User.Read.All (not Mail.Read). Store credentials
              below, then grant admin consent. INFRA SaaS app requires operator Entra configuration first.
            </Notice>
            <div className="stack" style={{ gap: 8, maxWidth: 480 }}>
              <label className="small muted">Entra tenant ID</label>
              <input className="input" value={byoTenantId} onChange={(e) => setByoTenantId(e.target.value)} />
              <label className="small muted">Application (client) ID</label>
              <input className="input" value={byoClientId} onChange={(e) => setByoClientId(e.target.value)} />
              <label className="small muted">Client secret</label>
              <input
                className="input"
                type="password"
                value={byoClientSecret}
                onChange={(e) => setByoClientSecret(e.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || !byoTenantId.trim() || !byoClientId.trim() || !byoClientSecret.trim()}
                onClick={() => void saveByoCredentials()}
              >
                Save Entra app credentials
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {!configured ? (
        <Notice tone="warning">
          Microsoft 365 is not connected for this company yet. Company administrators can connect using
          BYO Entra app credentials or the INFRA SaaS application once operator Entra configuration is complete.
        </Notice>
      ) : null}

      {dashboard?.health.graph && !dashboard.health.graph.ok ? (
        <Notice tone="danger">{dashboard.health.graph.message}</Notice>
      ) : null}

      {message ? <Notice tone="info">{message}</Notice> : null}

      <SectionCard title="Components">
        <div className="microsoft-component-list">
          <div className="microsoft-component-row">
            <span>OneDrive</span>
            <StatusBadge status={configured ? "connected" : "requires_authentication"} />
          </div>
          <div className="microsoft-component-row">
            <span>SharePoint</span>
            <StatusBadge status={configured ? "connected" : "requires_authentication"} />
          </div>
          <div className="microsoft-component-row">
            <span>Outlook Shared Mailboxes</span>
            <StatusBadge status="requires_additional_permission" />
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          OneDrive and SharePoint use app-only Microsoft Graph authentication for background sync.
          Outlook requires additional Mail.Read application permission (not yet enabled).
        </p>
      </SectionCard>

      {canManage ? (
        <SectionCard title="Discovery &amp; bulk actions">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button type="button" variant="primary" size="sm" disabled={busy || !configured} onClick={() => void discover(false, false)}>
              Discover sources
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !configured}
              onClick={() => {
                if (
                  window.confirm(
                    "Include ALL discovered OneDrive sources? This may ingest employees' private work files into company knowledge.",
                  )
                ) {
                  void discover(true, false);
                }
              }}
            >
              Include all OneDrives
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !configured}
              onClick={() => {
                if (window.confirm("Include ALL discovered SharePoint sites and libraries?")) {
                  void discover(false, true);
                }
              }}
            >
              Include all SharePoint
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="OneDrive"
        description={`${dashboard?.summary.onedrive.included ?? 0} included · ${dashboard?.summary.onedrive.indexed ?? 0} files indexed`}
      >
        <input
          className="input"
          placeholder="Filter drives…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ marginBottom: 12, maxWidth: isMobile ? "100%" : 320 }}
        />
        {onedriveSources.length === 0 ? (
          <EmptyState title="No OneDrive sources discovered" description="Run discovery when credentials are configured." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Owner / drive</th>
                  {!isMobile ? <th>Status</th> : null}
                  <th>Inclusion</th>
                  {!isMobile ? <th>Scope</th> : null}
                  <th>Indexed</th>
                  {!isMobile ? <th>Sync state</th> : null}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {onedriveSources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <strong>{source.displayName}</strong>
                      {source.ownerUpn ? (
                        <div className="muted small">{source.ownerUpn}</div>
                      ) : null}
                    </td>
                    {!isMobile ? (
                      <td>
                        <StatusBadge status={source.syncStatus} />
                      </td>
                    ) : null}
                    <td>{inclusionLabel(source.inclusionStatus)}</td>
                    {!isMobile ? <td className="muted small">{folderScopeSummary(source)}</td> : null}
                    <td>{source.itemsIndexed}</td>
                    {!isMobile ? (
                      <td className="muted small">{queueSummary(source) ?? (source.syncStatus === "syncing" ? "Sync in progress…" : "—")}</td>
                    ) : null}
                    <td>{renderSourceActions(source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="SharePoint"
        description={`${dashboard?.summary.sharepoint.included ?? 0} included · ${dashboard?.summary.sharepoint.indexed ?? 0} files indexed`}
      >
        {sharepointSources.length === 0 ? (
          <EmptyState title="No SharePoint sources discovered" description="Run discovery when credentials are configured." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Site / library</th>
                  {!isMobile ? <th>Status</th> : null}
                  <th>Inclusion</th>
                  {!isMobile ? <th>Scope</th> : null}
                  <th>Indexed</th>
                  {!isMobile ? <th>Sync state</th> : null}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sharepointSources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <strong>{source.displayName}</strong>
                      {source.pathOrUrl ? (
                        <div className="muted small">{source.pathOrUrl}</div>
                      ) : null}
                    </td>
                    {!isMobile ? (
                      <td>
                        <StatusBadge status={source.syncStatus} />
                      </td>
                    ) : null}
                    <td>{inclusionLabel(source.inclusionStatus)}</td>
                    {!isMobile ? <td className="muted small">{folderScopeSummary(source)}</td> : null}
                    <td>{source.itemsIndexed}</td>
                    {!isMobile ? (
                      <td className="muted small">{queueSummary(source) ?? (source.syncStatus === "syncing" ? "Sync in progress…" : "—")}</td>
                    ) : null}
                    <td>{renderSourceActions(source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Outlook Shared Mailboxes">
        <Notice tone="info">
          Outlook shared mailbox ingestion is prepared but requires Daniel to add Mail.Read
          application permission in Entra. No mailboxes will be indexed until that permission is
          granted and mailboxes are explicitly configured.
        </Notice>
      </SectionCard>
    </>
  );
}

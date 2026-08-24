import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import {
  AdvancedDetails,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  StatusBadge,
  toast,
} from "../components";
import { api } from "../api";
import { formatRelativeTime } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalAiConnectionsPage() {
  const { company, loading, error } = usePortalCompany();
  const [connections, setConnections] = useState<
    Awaited<ReturnType<typeof api.getAiConnections>>
  >([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [tokenReveal, setTokenReveal] = useState<{
    clientType: string;
    token: string;
    endpoint: string;
    mcpEndpoint: string;
  } | null>(null);

  async function refresh() {
    if (!company) return;
    setConnections(await api.getAiConnections(company.slug));
  }

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Unable to load AI connections");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  async function connect(clientType: string) {
    if (!company) return;
    setBusyType(clientType);
    setTokenReveal(null);
    try {
      const result = await api.connectAiClient(company.slug, clientType);
      setTokenReveal({
        clientType,
        token: result.token,
        endpoint: result.gatewayEndpoint,
        mcpEndpoint:
          result.mcpEndpoint ??
          "https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp",
      });
      toast(`${clientType} connected`);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setLoadError(message);
      toast(message, "error");
    } finally {
      setBusyType(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load AI connections" description={error ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="AI connections"
        description="Give authorised staff access to company systems through ChatGPT, Claude, and other AI clients."
      />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

      {tokenReveal ? (
        <Notice tone="success">
          <strong>{tokenReveal.clientType} connected</strong>
          <p style={{ margin: "8px 0" }}>
            Copy this access token now — it will not be shown again.
          </p>
          <code className="mono" style={{ display: "block", wordBreak: "break-all" }}>
            {tokenReveal.token}
          </code>
          <p style={{ margin: "12px 0 8px" }}>
            Point ChatGPT at the <strong>INFRA MCP endpoint</strong> (not the company MCP URL):
          </p>
          <code className="mono" style={{ display: "block", wordBreak: "break-all" }}>
            {tokenReveal.mcpEndpoint}
          </code>
          <AdvancedDetails label="REST execute endpoint">
            <code className="mono">{tokenReveal.endpoint}</code>
          </AdvancedDetails>
        </Notice>
      ) : null}

      {connections.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="No AI connections"
          description="Connect ChatGPT or Claude to give authorised staff access to company systems."
        />
      ) : (
        <div className="connector-grid">
          {connections.map((conn) => (
            <article key={conn.id} className="connector-card" style={{ minHeight: 180 }}>
              <div className="connection-header">
                <h3 style={{ margin: 0 }}>{conn.displayName}</h3>
                <StatusBadge status={conn.status} />
              </div>
              {conn.setupNotes ? <p className="muted small">{conn.setupNotes}</p> : null}
              <div className="muted small">
                {conn.lastUsedAt
                  ? `Last activity ${formatRelativeTime(conn.lastUsedAt)}`
                  : "No recent activity"}
              </div>
              <div className="connector-card-actions">
                <Button
                  type="button"
                  variant={conn.status === "connected" ? "secondary" : "primary"}
                  size="sm"
                  disabled={
                    conn.status === "coming_soon" ||
                    conn.status === "connected" ||
                    busyType === conn.clientType
                  }
                  loading={busyType === conn.clientType}
                  onClick={() => void connect(conn.clientType)}
                >
                  {conn.status === "coming_soon"
                    ? "Coming soon"
                    : conn.status === "connected"
                      ? "Connected"
                      : "Connect"}
                </Button>
              </div>
              {conn.mcpEndpoint || conn.gatewayEndpoint ? (
                <AdvancedDetails label="Connection endpoints">
                  {conn.mcpEndpoint ? (
                    <>
                      <div className="muted small">INFRA MCP (required for ChatGPT metering)</div>
                      <code className="mono small">{conn.mcpEndpoint}</code>
                    </>
                  ) : null}
                  {conn.gatewayEndpoint ? (
                    <>
                      <div className="muted small" style={{ marginTop: 8 }}>
                        REST execute
                      </div>
                      <code className="mono small">{conn.gatewayEndpoint}</code>
                    </>
                  ) : null}
                  <p className="muted small" style={{ marginTop: 8 }}>
                    Do not point ChatGPT at the company MCP URL directly — that bypasses INFRA
                    metering and permissions.
                  </p>
                </AdvancedDetails>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import { PageHeader, SectionCard, StatusBadge, ErrorState, LoadingState } from "../components";
import { api } from "../api";
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
        setLoadError(err instanceof Error ? err.message : "Failed to load AI connections");
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
      });
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusyType(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || loadError || !company) {
    return <ErrorState message={error ?? loadError ?? "AI connections unavailable"} />;
  }

  return (
    <>
      <PageHeader
        title="AI Connections"
        subtitle="Connect ChatGPT or Claude to INFRA (not directly to your MCP) so requests are permissioned, metered, and audited."
      />

      <div className="stack">
        {connections.map((conn) => (
          <div key={conn.id} className="card connection-card">
            <div className="connection-header">
              <h3>{conn.displayName}</h3>
              <StatusBadge
                value={
                  conn.status === "connected"
                    ? "healthy"
                    : conn.status === "coming_soon"
                      ? "draft"
                      : "registered"
                }
              />
            </div>
            <p className="muted">{conn.setupNotes}</p>
            {conn.gatewayEndpoint ? (
              <p className="mono small muted">{conn.gatewayEndpoint}</p>
            ) : null}
            <button
              className="button button-primary"
              type="button"
              disabled={
                conn.status === "coming_soon" ||
                conn.status === "connected" ||
                busyType === conn.clientType
              }
              onClick={() => void connect(conn.clientType)}
            >
              {conn.status === "coming_soon"
                ? "Coming soon"
                : conn.status === "connected"
                  ? "Connected"
                  : busyType === conn.clientType
                    ? "Generating..."
                    : "Generate INFRA connection"}
            </button>
          </div>
        ))}
      </div>

      {tokenReveal ? (
        <SectionCard title="Save this credential now">
          <p className="warning-text">
            This token is shown once. Configure {tokenReveal.clientType} to call the INFRA
            gateway with Bearer auth — do not point it at your company MCP directly.
          </p>
          <p className="mono" style={{ wordBreak: "break-all" }}>
            Endpoint: {tokenReveal.endpoint}
          </p>
          <p className="mono" style={{ wordBreak: "break-all" }}>
            Token: {tokenReveal.token}
          </p>
        </SectionCard>
      ) : null}

      <SectionCard title="How routing works">
        <p className="muted">
          AI Client → INFRA Gateway → identity → tenant → permission → credit check → MCP →
          response → metering → audit.
        </p>
      </SectionCard>
    </>
  );
}

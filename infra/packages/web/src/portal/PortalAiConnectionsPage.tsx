import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  StatusBadge,
} from "../components";
import { api } from "../api";
import { formatRelativeTime, humanClient } from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

type AiConnection = Awaited<ReturnType<typeof api.getAiConnections>>[number];

function channelStatus(conn: AiConnection): { status: string; label: string } {
  if (conn.status === "coming_soon") return { status: "coming_soon", label: "Coming soon" };
  if (conn.userConnection?.status === "connected") return { status: "connected", label: "Connected" };
  if (conn.companyApproved) return { status: "healthy", label: "Approved by your company" };
  if (conn.tokenStatus === "Active") return { status: "connected", label: "Connected" };
  return { status: "not_configured", label: "Not approved" };
}

export default function PortalAiConnectionsPage() {
  const { company, loading, error, membership, user } = usePortalCompany();
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);
  const canManage = Boolean(
    user?.isPlatformAdmin || membership?.role === "company_admin" || membership?.role === "director",
  );

  async function refresh() {
    if (!company) return;
    setConnections(await api.getAiConnections(company.slug));
  }

  useEffect(() => {
    if (!company) return;
    void (async () => {
      try {
        setLoadError(null);
        await refresh();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Unable to load AI connections");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  const ordered = useMemo(() => {
    const rank = (type: string) => (type === "chatgpt" ? 0 : type === "claude" ? 1 : 2);
    const visible = canManage
      ? connections
      : connections.filter((item) => item.companyApproved || item.status === "coming_soon");
    return [...visible].sort((a, b) => rank(a.clientType) - rank(b.clientType));
  }, [canManage, connections]);

  async function approve(clientType: string) {
    if (!company) return;
    setBusyType(`approve-${clientType}`);
    setLoadError(null);
    try {
      await api.approveAiChannel(company.slug, clientType);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to approve channel";
      setLoadError(message);
    } finally {
      setBusyType(null);
    }
  }

  async function revokeCompany(clientType: string) {
    if (!company) return;
    setBusyType(`revoke-company-${clientType}`);
    setLoadError(null);
    try {
      await api.revokeCompanyAiChannel(company.slug, clientType);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to disable channel";
      setLoadError(message);
    } finally {
      setBusyType(null);
    }
  }

  async function connect(clientType: string) {
    if (!company) return;
    setBusyType(clientType);
    setLoadError(null);
    try {
      await api.connectUserAiChannel(company.slug, clientType);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setLoadError(message);
    } finally {
      setBusyType(null);
    }
  }

  async function disconnect(clientType: string) {
    if (!company) return;
    setBusyType(`revoke-${clientType}`);
    setLoadError(null);
    try {
      await api.disconnectUserAiChannel(company.slug, clientType);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Disconnect failed";
      setLoadError(message);
    } finally {
      setBusyType(null);
    }
  }

  if (loading || !company) return <LoadingState label="Loading AI access…" />;
  if (error) {
    return <ErrorState title="Unable to load AI access" description={error} />;
  }

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="AI Access"
        description={
          canManage
            ? "Approve company AI channels. People then connect their own identity."
            : "Connect your own approved AI account. Your company controls which channels are available."
        }
      />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

      {ordered.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="No AI channels available"
          description="Your company has not approved an AI channel yet."
        />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {ordered.map((conn) => {
            const { status, label } = channelStatus(conn);
            const comingSoon = conn.status === "coming_soon";
            const userConnected = conn.userConnection?.status === "connected";
            return (
              <article
                key={conn.id}
                className={`ai-connection-card${userConnected ? " connected" : ""}`}
              >
                <div className="connection-header">
                  <div>
                    <h3 style={{ margin: 0 }}>{conn.displayName}</h3>
                    <p className="muted small" style={{ margin: "4px 0 0" }}>
                      {userConnected && conn.userConnection?.connectedAs
                        ? `Connected as ${conn.userConnection.connectedAs}`
                        : conn.companyApproved
                          ? "Approved by your company"
                          : canManage
                            ? "Company approval required before people can connect"
                            : "Waiting for company approval"}
                    </p>
                  </div>
                  <StatusBadge status={status} label={label} />
                </div>
                {canManage ? (
                  <p className="muted small">
                    {conn.connectedUserCount ?? 0} user{(conn.connectedUserCount ?? 0) === 1 ? "" : "s"} connected
                    {conn.approvedAt ? ` · Approved ${formatRelativeTime(conn.approvedAt)}` : ""}
                  </p>
                ) : null}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {comingSoon ? (
                    <Button type="button" variant="secondary" size="sm" disabled>
                      Coming soon
                    </Button>
                  ) : (
                    <>
                      {canManage ? (
                        conn.companyApproved ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            loading={busyType === `revoke-company-${conn.clientType}`}
                            onClick={() => void revokeCompany(conn.clientType)}
                          >
                            Disable for company
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            loading={busyType === `approve-${conn.clientType}`}
                            onClick={() => void approve(conn.clientType)}
                          >
                            Approve {humanClient(conn.clientType)}
                          </Button>
                        )
                      ) : null}
                      {conn.companyApproved && userConnected ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          loading={busyType === `revoke-${conn.clientType}`}
                          onClick={() => void disconnect(conn.clientType)}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                      {conn.companyApproved && !userConnected ? (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          loading={busyType === conn.clientType}
                          onClick={() => void connect(conn.clientType)}
                        >
                          Connect
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

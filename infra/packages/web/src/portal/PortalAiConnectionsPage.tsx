import { useEffect, useMemo, useState } from "react";
import { Bot, Copy, Check } from "lucide-react";
import {
  AdvancedDetails,
  Button,
  CollapsibleBlock,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Modal,
  Notice,
  StatusBadge,
  toast,
  useIsMobile,
} from "../components";
import { api, infraMcpUrl } from "../api";
import { formatRelativeTime, humanClient, humanConnectorPurpose, humanScope } from "../lib/format";
import { PortalPageHeader } from "./components";
import { usePortalCompany } from "./usePortalCompany";

const DEFAULT_MCP_URL = infraMcpUrl();

type AiConnection = Awaited<ReturnType<typeof api.getAiConnections>>[number];

async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`);
    return true;
  } catch {
    toast(`Unable to copy ${label}`, "error");
    return false;
  }
}

function connectionStatus(conn: AiConnection): { status: string; label: string } {
  if (conn.status === "coming_soon") return { status: "coming_soon", label: "Coming soon" };
  if (conn.tokenStatus === "Active") return { status: "connected", label: "Connected" };
  if (conn.tokenStatus === "Revoked") return { status: "warning", label: "Needs reconnection" };
  if (conn.status === "error") return { status: "failed", label: "Error" };
  return { status: "not_configured", label: "Not connected" };
}

export default function PortalAiConnectionsPage() {
  const { company, loading, error } = usePortalCompany();
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [manageType, setManageType] = useState<string | null>(null);
  const [tokenReveal, setTokenReveal] = useState<{
    clientType: string;
    mcpEndpoint: string;
    authorizationEndpoint?: string;
  } | null>(null);
  const isMobile = useIsMobile();

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
    return [...connections].sort((a, b) => rank(a.clientType) - rank(b.clientType));
  }, [connections]);

  const activeConn = ordered.find((c) => c.clientType === manageType) ?? null;

  async function connect(clientType: string) {
    if (!company) return;
    setBusyType(clientType);
    setTokenReveal(null);
    setLoadError(null);
    try {
      const result = await api.connectAiClient(company.slug, clientType);
      setTokenReveal({
        clientType,
        mcpEndpoint: result.mcpEndpoint ?? DEFAULT_MCP_URL,
        authorizationEndpoint: result.authorizationEndpoint,
      });
      toast(
        result.authMethod === "infra_oauth"
          ? "INFRA OAuth connection ready"
          : "Connection ready — copy your token now",
      );
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setLoadError(message);
      toast(message, "error");
    } finally {
      setBusyType(null);
    }
  }

  async function revoke(clientType: string) {
    if (!company) return;
    setBusyType(`revoke-${clientType}`);
    setLoadError(null);
    try {
      await api.revokeAiClient(company.slug, clientType);
      setTokenReveal(null);
      setManageType(null);
      toast(`${humanClient(clientType)} disconnected`);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Disconnect failed";
      setLoadError(message);
      toast(message, "error");
    } finally {
      setBusyType(null);
    }
  }

  async function handleCopy(key: string, value: string, label: string) {
    const ok = await copyText(value, label);
    if (ok) {
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    }
  }

  const connectedCount = ordered.filter((c) => c.tokenStatus === "Active").length;
  const needsAttention = ordered.some(
    (c) => c.tokenStatus === "Revoked" || c.status === "error",
  );

  if (loading || !company) return <LoadingState label="Loading AI access…" />;
  if (error) {
    return <ErrorState title="Unable to load AI access" description={error} />;
  }

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="AI Access"
        description="Connect your own ChatGPT account through INFRA. Company Admin controls roles and policy — you do not need to be an administrator to connect."
      />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

      <div className="portal-ai-summary card">
        <div className="portal-ai-summary-row">
          <span className="muted small">Status</span>
          <strong>
            {connectedCount > 0
              ? needsAttention
                ? "Attention needed"
                : "Ready"
              : "Not connected"}
          </strong>
        </div>
        <div className="portal-ai-summary-row">
          <span className="muted small">Connected</span>
          <strong>
            {connectedCount} of {ordered.filter((c) => c.status !== "coming_soon").length}
          </strong>
        </div>
      </div>

      {tokenReveal ? (
        <Notice tone="success">
          <strong>{humanClient(tokenReveal.clientType)} INFRA connection ready</strong>
          <p style={{ margin: "8px 0" }}>
            In ChatGPT, add a custom MCP connector using OAuth. Sign in with your INFRA
            account (or continue an existing portal session) and click Allow. Microsoft
            sign-in is not required.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void handleCopy("mcp-token", tokenReveal.mcpEndpoint, "Connection URL")}
            >
              {copiedKey === "mcp-token" ? <Check size={14} /> : <Copy size={14} />}
              Copy MCP URL
            </Button>
            {tokenReveal.authorizationEndpoint ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  void handleCopy("oauth", tokenReveal.authorizationEndpoint ?? "", "OAuth URL")
                }
              >
                {copiedKey === "oauth" ? <Check size={14} /> : <Copy size={14} />}
                Copy INFRA OAuth URL
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}

      {ordered.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="No AI connections"
          description="Connect ChatGPT to start using your company systems through INFRA."
          action={
            <Button type="button" variant="primary" onClick={() => void connect("chatgpt")}>
              Connect ChatGPT
            </Button>
          }
        />
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {ordered.map((conn) => {
            const { status, label } = connectionStatus(conn);
            const comingSoon = conn.status === "coming_soon";
            const connected = conn.tokenStatus === "Active";
            return (
              <article
                key={conn.id}
                className={`ai-connection-card${connected ? " connected" : ""}`}
              >
                <div className="connection-header">
                  <div>
                    <h3 style={{ margin: 0 }}>{conn.displayName}</h3>
                    <p className="muted small" style={{ margin: "4px 0 0" }}>
                      {humanConnectorPurpose(conn.clientType)}
                    </p>
                  </div>
                  <StatusBadge status={status} label={label} />
                </div>
                {connected && conn.lastUsedAt ? (
                  <p className="muted small">Last used {formatRelativeTime(conn.lastUsedAt)}</p>
                ) : null}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {comingSoon ? (
                    <Button type="button" variant="secondary" size="sm" disabled>
                      Coming soon
                    </Button>
                  ) : connected ? (
                    <>
                      <Button type="button" variant="primary" size="sm" onClick={() => setManageType(conn.clientType)}>
                        Manage
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busyType === conn.clientType}
                        loading={busyType === conn.clientType}
                        onClick={() => void connect(conn.clientType)}
                      >
                        Reconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={busyType === conn.clientType}
                      loading={busyType === conn.clientType}
                      onClick={() => void connect(conn.clientType)}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <CollapsibleBlock title="How to connect ChatGPT" summary="Setup steps">
        <ol className="stack" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
          <li>Click <strong>Connect</strong> on the ChatGPT card and copy the MCP URL</li>
          <li>In ChatGPT, add a custom MCP connector and choose <strong>OAuth</strong></li>
          <li>Sign in with your INFRA company account, or continue if you are already signed in, then click Allow</li>
          <li>Do not sign in with Microsoft to use INFRA. Microsoft 365 stays a company data connector only</li>
          <li>Start a new conversation and try a knowledge search. Usage is attributed to you and this company</li>
        </ol>
      </CollapsibleBlock>

      <Modal
        open={Boolean(activeConn)}
        onClose={() => setManageType(null)}
        title={activeConn ? `${activeConn.displayName} connection` : "Manage connection"}
        description="Manage your AI connection. Technical setup details are available below."
        footer={
          activeConn && activeConn.tokenStatus === "Active" ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={busyType === `revoke-${activeConn.clientType}`}
              onClick={() => void revoke(activeConn.clientType)}
            >
              Disconnect
            </Button>
          ) : null
        }
      >
        {activeConn ? (
          <>
            <KeyValue label="Status" value={<StatusBadge {...connectionStatus(activeConn)} />} />
            <KeyValue
              label="Last activity"
              value={activeConn.lastUsedAt ? formatRelativeTime(activeConn.lastUsedAt) : "No activity yet"}
            />
            <KeyValue label="Company" value={activeConn.companyName ?? company.name} />
            <AdvancedDetails label="Technical details">
              <KeyValue label="Connection method" value={activeConn.connectionMethod ?? "Secure INFRA connection"} />
              <KeyValue
                label="Connection URL"
                value={
                  <code className="mono small" style={{ wordBreak: "break-all" }}>
                    {activeConn.mcpEndpoint ?? DEFAULT_MCP_URL}
                  </code>
                }
              />
              {activeConn.serviceIdentityName ? (
                <KeyValue label="Service identity" value={activeConn.serviceIdentityName} mono />
              ) : null}
              {activeConn.scopes && activeConn.scopes.length > 0 ? (
                <div>
                  <div className="muted small" style={{ marginBottom: 8 }}>
                    What this connection can do
                  </div>
                  <ul className="plain-list">
                    {activeConn.scopes.map((scope) => (
                      <li key={scope} className="small">
                        {humanScope(scope)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void handleCopy("manage-url", activeConn.mcpEndpoint ?? DEFAULT_MCP_URL, "Connection URL")
                  }
                >
                  Copy connection URL
                </Button>
                {!isMobile ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={busyType === activeConn.clientType}
                    onClick={() => void connect(activeConn.clientType)}
                  >
                    Show connection details
                  </Button>
                ) : null}
              </div>
            </AdvancedDetails>
          </>
        ) : null}
      </Modal>
    </div>
  );
}

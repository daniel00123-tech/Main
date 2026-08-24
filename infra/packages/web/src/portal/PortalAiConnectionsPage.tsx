import { useEffect, useMemo, useState } from "react";
import { Bot, Copy, Check } from "lucide-react";
import {
  AdvancedDetails,
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
  toast,
} from "../components";
import { api } from "../api";
import { formatRelativeTime } from "../lib/format";
import { usePortalCompany } from "./usePortalCompany";

const INFRA_MCP = "https://infra-api.daniel-dwyer123.workers.dev/api/gateway/v1/mcp";

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

function statusLabel(conn: AiConnection): string {
  if (conn.status === "coming_soon") return "Coming soon";
  if (conn.status === "connected" && conn.tokenStatus === "Active") return "Connected";
  if (conn.status === "connected" && conn.tokenStatus === "Revoked") return "Needs reconnection";
  if (conn.status === "ready_to_connect") return "Not connected";
  if (conn.status === "error") return "Error";
  return conn.status.replace(/_/g, " ");
}

export default function PortalAiConnectionsPage() {
  const { company, loading, error } = usePortalCompany();
  const [connections, setConnections] = useState<AiConnection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [tokenReveal, setTokenReveal] = useState<{
    clientType: string;
    token: string;
    endpoint: string;
    mcpEndpoint: string;
  } | null>(null);
  const [testResult, setTestResult] = useState<{
    clientType: string;
    status: string;
    message: string;
  } | null>(null);

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
    const rank = (type: string) =>
      type === "chatgpt" ? 0 : type === "claude" ? 1 : 2;
    return [...connections].sort(
      (a, b) => rank(a.clientType) - rank(b.clientType),
    );
  }, [connections]);

  async function connect(clientType: string) {
    if (!company) return;
    setBusyType(clientType);
    setTokenReveal(null);
    setLoadError(null);
    try {
      const result = await api.connectAiClient(company.slug, clientType);
      setTokenReveal({
        clientType,
        token: result.token,
        endpoint: result.gatewayEndpoint,
        mcpEndpoint: result.mcpEndpoint ?? INFRA_MCP,
      });
      toast("Token issued — copy it now; it will not be shown again");
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
      toast(`${clientType} token revoked`);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Revoke failed";
      setLoadError(message);
      toast(message, "error");
    } finally {
      setBusyType(null);
    }
  }

  async function testConnection(clientType: string) {
    if (!company) return;
    setBusyType(`test-${clientType}`);
    setTestResult(null);
    setLoadError(null);
    try {
      const result = await api.testAiClient(company.slug, clientType);
      const status = String(result.status ?? "FAILED");
      const message = String(result.message ?? "Test completed");
      setTestResult({ clientType, status, message });
      toast(
        status === "HEALTHY" ? "Connection healthy" : message,
        status === "HEALTHY" ? "success" : "error",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test failed";
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

  if (loading) return <LoadingState label="Loading AI connections…" />;
  if (error || !company) {
    return <ErrorState title="Unable to load AI connections" description={error ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="AI connections"
        description={`${company.name} · connect AI clients through the INFRA MCP gateway`}
      />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

      {tokenReveal ? (
        <Notice tone="success">
          <strong>ChatGPT connection ready</strong>
          <p style={{ margin: "8px 0" }}>
            Copy this token now. For security, INFRA will not display it again.
          </p>
          <div className="muted small">INFRA MCP URL</div>
          <code className="mono" style={{ display: "block", wordBreak: "break-all" }}>
            {tokenReveal.mcpEndpoint}
          </code>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            style={{ marginTop: 8 }}
            onClick={() => void handleCopy("mcp-token", tokenReveal.mcpEndpoint, "INFRA MCP URL")}
          >
            {copiedKey === "mcp-token" ? <Check size={14} /> : <Copy size={14} />}
            Copy URL
          </Button>

          <div className="muted small" style={{ marginTop: 16 }}>
            Bearer token
          </div>
          <code className="mono" style={{ display: "block", wordBreak: "break-all" }}>
            {tokenReveal.token}
          </code>
          <Button
            type="button"
            variant="primary"
            size="sm"
            style={{ marginTop: 8 }}
            onClick={() => void handleCopy("token", tokenReveal.token, "Bearer token")}
          >
            {copiedKey === "token" ? <Check size={14} /> : <Copy size={14} />}
            Copy Token
          </Button>
        </Notice>
      ) : null}

      {testResult ? (
        <Notice
          tone={
            testResult.status === "HEALTHY"
              ? "success"
              : testResult.status === "DEGRADED"
                ? "warning"
                : "danger"
          }
        >
          <strong>
            Test · {testResult.clientType}: {testResult.status}
          </strong>
          <p style={{ margin: "8px 0 0" }}>{testResult.message}</p>
        </Notice>
      ) : null}

      {ordered.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="No AI connections"
          description="Generate a ChatGPT token to connect this company through INFRA."
          action={
            <Button type="button" variant="primary" onClick={() => void connect("chatgpt")}>
              Generate Token
            </Button>
          }
        />
      ) : (
        <div className="connector-grid" style={{ marginBottom: 24 }}>
          {ordered.map((conn) => {
            const isChatgpt = conn.clientType === "chatgpt";
            const comingSoon = conn.status === "coming_soon";
            const hasToken = conn.tokenStatus === "Active";
            const primaryLabel = comingSoon
              ? "Coming soon"
              : hasToken
                ? "Reconnect / New Token"
                : "Generate Token";

            return (
              <article
                key={conn.id}
                className="connector-card"
                style={{
                  minHeight: isChatgpt ? 280 : 160,
                  outline: isChatgpt ? "2px solid var(--accent, #1a5cff)" : undefined,
                }}
              >
                <div className="connection-header">
                  <h3 style={{ margin: 0 }}>{conn.displayName}</h3>
                  <StatusBadge status={conn.status} label={statusLabel(conn)} />
                </div>

                <div className="kv-stack" style={{ marginTop: 12 }}>
                  <KeyValue label="Connection method" value={conn.connectionMethod ?? "INFRA MCP Gateway"} />
                  <KeyValue label="Company" value={conn.companyName ?? company.name} />
                  <KeyValue
                    label="MCP endpoint"
                    value={
                      <code className="mono small" style={{ wordBreak: "break-all" }}>
                        {conn.mcpEndpoint ?? INFRA_MCP}
                      </code>
                    }
                  />
                  {isChatgpt || conn.status === "connected" ? (
                    <>
                      <KeyValue
                        label="Service identity"
                        value={conn.serviceIdentityName ?? "Not generated yet"}
                      />
                      <KeyValue
                        label="Scopes"
                        value={
                          conn.scopes && conn.scopes.length > 0
                            ? conn.scopes.join(", ")
                            : "—"
                        }
                      />
                      <KeyValue label="Token status" value={conn.tokenStatus ?? "Not Generated"} />
                      <KeyValue
                        label="Last used"
                        value={
                          conn.lastUsedAt ? formatRelativeTime(conn.lastUsedAt) : "No activity yet"
                        }
                      />
                    </>
                  ) : null}
                </div>

                <div
                  className="connector-card-actions"
                  style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}
                >
                  <Button
                    type="button"
                    variant={isChatgpt ? "primary" : "secondary"}
                    size="sm"
                    disabled={comingSoon || busyType === conn.clientType}
                    loading={busyType === conn.clientType}
                    onClick={() => void connect(conn.clientType)}
                  >
                    {primaryLabel}
                  </Button>
                  {!comingSoon && hasToken ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busyType === `test-${conn.clientType}`}
                        loading={busyType === `test-${conn.clientType}`}
                        onClick={() => void testConnection(conn.clientType)}
                      >
                        Test Connection
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busyType === `revoke-${conn.clientType}`}
                        loading={busyType === `revoke-${conn.clientType}`}
                        onClick={() => void revoke(conn.clientType)}
                      >
                        Revoke
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <SectionCard title="Setup help" description="Secondary instructions for connecting ChatGPT.">
        <ol className="stack" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
          <li>
            Click <strong>Generate Token</strong> or <strong>Reconnect / New Token</strong> on the
            ChatGPT card above
          </li>
          <li>Copy the Bearer token (shown once) and the INFRA MCP URL</li>
          <li>
            In ChatGPT Connectors / MCPs, remove any direct{" "}
            <code className="mono">caddington-mcp…</code> URL
          </li>
          <li>
            Add only this INFRA endpoint with the Bearer token:
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, alignItems: "center" }}>
              <code className="mono" style={{ wordBreak: "break-all" }}>
                {INFRA_MCP}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void handleCopy("mcp-setup", INFRA_MCP, "INFRA MCP URL")}
              >
                {copiedKey === "mcp-setup" ? <Check size={14} /> : <Copy size={14} />}
                Copy URL
              </Button>
            </div>
          </li>
          <li>Start a brand-new ChatGPT conversation, then test a knowledge search</li>
        </ol>
        <AdvancedDetails label="Why INFRA MCP only?">
          <p className="muted small" style={{ margin: 0 }}>
            Direct company MCP access is locked (401). ChatGPT must use the INFRA MCP URL or usage
            and billing will not record.
          </p>
        </AdvancedDetails>
      </SectionCard>
    </>
  );
}

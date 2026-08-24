import { useEffect, useMemo, useState } from "react";
import { Bot, Copy, Check } from "lucide-react";
import {
  AdvancedDetails,
  Button,
  EmptyState,
  ErrorState,
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

export default function PortalAiConnectionsPage() {
  const { company, loading, error } = usePortalCompany();
  const [connections, setConnections] = useState<
    Awaited<ReturnType<typeof api.getAiConnections>>
  >([]);
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

  const chatgpt = ordered.find((c) => c.clientType === "chatgpt");

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
      toast(
        clientType === "chatgpt"
          ? "ChatGPT token issued — copy the INFRA MCP URL and token below"
          : `${clientType} connected`,
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

  if (loading) return <LoadingState />;
  if (error || !company) {
    return <ErrorState title="Unable to load AI connections" description={error ?? undefined} />;
  }

  return (
    <>
      <PageHeader
        title="AI connections"
        description={`${company.name} company portal · connect ChatGPT through INFRA only`}
      />

      <SectionCard
        title="ChatGPT setup"
        description="Self-serve path: generate a token here, then paste the INFRA MCP URL into ChatGPT."
      >
        <ol className="stack" style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)" }}>
          <li>
            Click <strong>Generate / Reconnect token</strong> on ChatGPT below
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
      </SectionCard>

      <Notice tone="warning">
        <strong>Mandatory routing</strong>
        <p style={{ margin: "8px 0 0" }}>
          Direct company MCP access is locked (401). ChatGPT must use the INFRA MCP URL above or
          usage and billing will not record.
        </p>
      </Notice>

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}

      {tokenReveal ? (
        <Notice tone="success">
          <strong>
            {tokenReveal.clientType === "chatgpt" ? "ChatGPT" : tokenReveal.clientType} token ready
          </strong>
          <p style={{ margin: "8px 0" }}>
            Copy this access token now — it will not be shown again. Paste it as the Bearer / auth
            token in ChatGPT with the INFRA MCP URL.
          </p>

          <div className="muted small">Bearer token</div>
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
            Copy Bearer token
          </Button>

          <div className="muted small" style={{ marginTop: 16 }}>
            INFRA MCP URL (only allowed endpoint)
          </div>
          <code className="mono" style={{ display: "block", wordBreak: "break-all" }}>
            {tokenReveal.mcpEndpoint}
          </code>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            style={{ marginTop: 8 }}
            onClick={() =>
              void handleCopy("mcp-token", tokenReveal.mcpEndpoint, "INFRA MCP URL")
            }
          >
            {copiedKey === "mcp-token" ? <Check size={14} /> : <Copy size={14} />}
            Copy INFRA MCP URL
          </Button>

          <AdvancedDetails label="REST execute endpoint (optional)">
            <code className="mono">{tokenReveal.endpoint}</code>
          </AdvancedDetails>
        </Notice>
      ) : null}

      {testResult ? (
        <Notice tone={testResult.status === "HEALTHY" ? "success" : testResult.status === "DEGRADED" ? "warning" : "danger"}>
          <strong>Test · {testResult.clientType}: {testResult.status}</strong>
          <p style={{ margin: "8px 0 0" }}>{testResult.message}</p>
        </Notice>
      ) : null}

      {ordered.length === 0 ? (
        <EmptyState
          icon={<Bot size={28} />}
          title="No AI connections"
          description="Connect ChatGPT or Claude to give authorised staff access to company systems."
          action={
            <Button type="button" variant="primary" onClick={() => void connect("chatgpt")}>
              Generate ChatGPT token
            </Button>
          }
        />
      ) : (
        <div className="connector-grid">
          {ordered.map((conn) => {
            const isChatgpt = conn.clientType === "chatgpt";
            const primaryLabel =
              conn.status === "coming_soon"
                ? "Coming soon"
                : conn.status === "connected"
                  ? "Generate / Reconnect token"
                  : "Generate token";
            return (
              <article
                key={conn.id}
                className="connector-card"
                style={{
                  minHeight: 180,
                  outline: isChatgpt ? "2px solid var(--accent, #1a5cff)" : undefined,
                }}
              >
                <div className="connection-header">
                  <h3 style={{ margin: 0 }}>{conn.displayName}</h3>
                  <StatusBadge status={conn.status} />
                </div>
                {isChatgpt ? (
                  <p className="muted small">
                    Primary connector for {company.name}. Issues a Bearer token for the INFRA MCP
                    URL only.
                  </p>
                ) : conn.setupNotes ? (
                  <p className="muted small">{conn.setupNotes}</p>
                ) : null}
                <div className="muted small">
                  {conn.lastUsedAt
                    ? `Last activity ${formatRelativeTime(conn.lastUsedAt)}`
                    : "No recent activity through INFRA"}
                </div>
                <div className="connector-card-actions" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <Button
                    type="button"
                    variant={isChatgpt ? "primary" : conn.status === "connected" ? "secondary" : "primary"}
                    size="sm"
                    disabled={conn.status === "coming_soon" || busyType === conn.clientType}
                    loading={busyType === conn.clientType}
                    onClick={() => void connect(conn.clientType)}
                  >
                    {primaryLabel}
                  </Button>
                  {conn.status === "connected" ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busyType === `test-${conn.clientType}`}
                        loading={busyType === `test-${conn.clientType}`}
                        onClick={() => void testConnection(conn.clientType)}
                      >
                        Test connection
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
                {conn.mcpEndpoint || conn.gatewayEndpoint ? (
                  <AdvancedDetails label="Connection endpoints">
                    {conn.mcpEndpoint ? (
                      <>
                        <div className="muted small">INFRA MCP (required)</div>
                        <code className="mono small">{conn.mcpEndpoint}</code>
                      </>
                    ) : null}
                    <p className="muted small" style={{ marginTop: 8 }}>
                      Direct company MCP is locked. Only this INFRA URL will search, meter, and bill.
                    </p>
                  </AdvancedDetails>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {!chatgpt && ordered.length > 0 ? (
        <Notice tone="info">
          ChatGPT connector shell missing —{" "}
          <Button type="button" variant="secondary" size="sm" onClick={() => void connect("chatgpt")}>
            Create ChatGPT connector
          </Button>
        </Notice>
      ) : null}
    </>
  );
}

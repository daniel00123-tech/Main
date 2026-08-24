import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Network } from "lucide-react";
import type { Company, McpEnvironment } from "@infra/shared";
import { api, type McpExecuteResult } from "../api";
import { useAuth } from "../context/AuthContext";
import {
  AdvancedDetails,
  Button,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  toast,
  formatDate,
} from "../components";
import { formatRelativeTime } from "../lib/format";

interface McpRow extends McpEnvironment {
  companyName?: string;
  companySlug?: string;
}

const DEFAULT_TEST_TOOL = "search_company_knowledge";
const DEFAULT_TEST_QUERY = "What does the company annual leave policy say?";

export default function McpEnvironmentsPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<McpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [selectedMcpId, setSelectedMcpId] = useState("");
  const [toolName, setToolName] = useState(DEFAULT_TEST_TOOL);
  const [query, setQuery] = useState(DEFAULT_TEST_QUERY);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<McpExecuteResult | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [mcpList, companies] = await Promise.all([
        api.getMcpEnvironments(),
        api.getCompanies(),
      ]);
      const companyById = new Map(companies.map((c: Company) => [c.id, c]));
      const mapped = mcpList.map((mcp) => {
        const company = companyById.get(mcp.companyId);
        return { ...mcp, companyName: company?.name, companySlug: company?.slug };
      });
      setRows(mapped);
      setSelectedMcpId((current) => current || mapped[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load AI gateways");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!selectedMcpId || !user?.isPlatformAdmin) return;
    void (async () => {
      try {
        const tools = await api.getMcpAllowedTools(selectedMcpId);
        const names = tools.map((t) => t.toolName);
        setAllowedTools(names);
        setToolName((current) => (names.includes(current) ? current : names[0] ?? DEFAULT_TEST_TOOL));
      } catch {
        setAllowedTools([DEFAULT_TEST_TOOL]);
      }
    })();
  }, [selectedMcpId, user?.isPlatformAdmin]);

  async function runHealthCheck(id: string) {
    setCheckingId(id);
    try {
      await api.runMcpHealthCheck(id);
      toast("Health check completed");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Health check failed", "error");
    } finally {
      setCheckingId(null);
    }
  }

  async function runTestExecute() {
    if (!selectedMcpId) return;
    setExecuting(true);
    setExecuteError(null);
    setExecuteResult(null);
    try {
      const args =
        toolName === "search_company_knowledge"
          ? { query, topK: 5 }
          : toolName === "get_knowledge_document"
            ? { documentRef: query }
            : {};
      const result = await api.executeMcpTool(selectedMcpId, toolName, args);
      setExecuteResult(result);
      toast("Test request completed");
      await load();
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setExecuting(false);
    }
  }

  if (loading) return <LoadingState label="Loading AI gateways…" />;
  if (error && rows.length === 0) {
    return <ErrorState title="Unable to load AI gateways" description={error} onRetry={() => void load()} />;
  }

  return (
    <>
      <PageHeader
        title="AI Gateways"
        description="Company AI connection environments. Health and diagnostics for platform administrators."
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Network size={28} />}
          title="No AI gateways registered"
          description="Gateways appear here once a company MCP environment is registered."
        />
      ) : (
        <div className="grid grid-2" style={{ marginBottom: 24 }}>
          {rows.map((mcp) => (
            <article key={mcp.id} className="entity-card">
              <div className="connection-header">
                <div>
                  <h3>{mcp.name}</h3>
                  <p className="muted small" style={{ margin: "4px 0 0" }}>
                    {mcp.companySlug ? (
                      <Link to={`/companies/${mcp.companySlug}`}>{mcp.companyName}</Link>
                    ) : (
                      mcp.companyName
                    )}
                  </p>
                </div>
                <StatusBadge status={mcp.status} />
              </div>

              <div className="grid grid-3" style={{ margin: "12px 0" }}>
                <div>
                  <div className="muted small">Last check</div>
                  <div>{formatRelativeTime(mcp.lastHealthCheckAt)}</div>
                </div>
                <div>
                  <div className="muted small">Latency</div>
                  <div>{mcp.lastLatencyMs != null ? `${mcp.lastLatencyMs}ms` : "—"}</div>
                </div>
                <div>
                  <div className="muted small">Knowledge</div>
                  <div>
                    {mcp.knowledgeDocumentCount != null
                      ? `${mcp.knowledgeDocumentCount} docs`
                      : "—"}
                  </div>
                </div>
              </div>

              {mcp.status === "unreachable" || mcp.status === "degraded" ? (
                <div className="error-box" style={{ marginBottom: 12 }}>
                  {mcp.lastError || mcp.healthMessage || "Gateway needs attention"}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={checkingId === mcp.id}
                  onClick={() => void runHealthCheck(mcp.id)}
                >
                  Check health
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedMcpId(mcp.id)}
                >
                  Select for test
                </Button>
              </div>

              <AdvancedDetails label="Technical details">
                <KeyValue label="Environment ID" value={mcp.id} mono />
                <KeyValue label="Endpoint" value={mcp.endpointUrl} mono />
                <KeyValue label="Version" value={mcp.mcpVersion ?? "—"} />
                <KeyValue label="Transport" value={mcp.transport} />
                <KeyValue label="Last check" value={formatDate(mcp.lastHealthCheckAt)} />
                {mcp.capabilities?.length ? (
                  <KeyValue label="Capabilities" value={mcp.capabilities.join(", ")} />
                ) : null}
              </AdvancedDetails>
            </article>
          ))}
        </div>
      )}

      {user?.isPlatformAdmin ? (
        <SectionCard
          title="Platform test"
          description="Run an allowlisted read-only tool against a selected gateway."
        >
          <div className="form-grid" style={{ maxWidth: 560 }}>
            <label>
              Gateway
              <select value={selectedMcpId} onChange={(e) => setSelectedMcpId(e.target.value)}>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tool
              <select value={toolName} onChange={(e) => setToolName(e.target.value)}>
                {(allowedTools.length ? allowedTools : [DEFAULT_TEST_TOOL]).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Query / document ref
              <input value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {executeError ? <div className="error-box">{executeError}</div> : null}
            <Button type="button" variant="primary" loading={executing} onClick={() => void runTestExecute()}>
              Run test
            </Button>
          </div>
          {executeResult ? (
            <AdvancedDetails label="Result details">
              <KeyValue label="Correlation ID" value={executeResult.correlationId} mono />
              <KeyValue label="Latency" value={`${executeResult.latencyMs}ms`} />
              <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
                {JSON.stringify(executeResult.result, null, 2)}
              </pre>
            </AdvancedDetails>
          ) : null}
        </SectionCard>
      ) : null}
    </>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type McpExecuteResult } from "../api";
import type { Company, McpEnvironment } from "@infra/shared";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
  formatDate,
} from "../components";
import { useAuth } from "../context/AuthContext";

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

  const [selectedMcpId, setSelectedMcpId] = useState<string>("");
  const [toolName, setToolName] = useState(DEFAULT_TEST_TOOL);
  const [query, setQuery] = useState(DEFAULT_TEST_QUERY);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeResult, setExecuteResult] = useState<McpExecuteResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [mcpList, companies] = await Promise.all([
          api.getMcpEnvironments(),
          api.getCompanies(),
        ]);
        const companyById = new Map(companies.map((company: Company) => [company.id, company]));
        const mapped = mcpList.map((mcp) => {
          const company = companyById.get(mcp.companyId);
          return {
            ...mcp,
            companyName: company?.name,
            companySlug: company?.slug,
          };
        });
        setRows(mapped);
        setSelectedMcpId((current) => current || mapped[0]?.id || "");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load MCP environments");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedMcpId || !user?.isPlatformAdmin) return;
    void (async () => {
      try {
        const tools = await api.getMcpAllowedTools(selectedMcpId);
        const names = tools.map((tool) => tool.toolName);
        setAllowedTools(names);
        setToolName((current) =>
          names.includes(current) ? current : names[0] ?? DEFAULT_TEST_TOOL,
        );
      } catch {
        setAllowedTools([DEFAULT_TEST_TOOL]);
      }
    })();
  }, [selectedMcpId, user?.isPlatformAdmin]);

  async function runHealthCheck(id: string) {
    setCheckingId(id);
    setError(null);
    try {
      await api.runMcpHealthCheck(id);
      const refreshed = await api.getMcpEnvironments();
      setRows((current) =>
        current.map((row) => {
          const next = refreshed.find((item) => item.id === row.id);
          return next ? { ...row, ...next } : row;
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Health check failed");
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
      const refreshed = await api.getMcpEnvironments();
      setRows((current) =>
        current.map((row) => {
          const next = refreshed.find((item) => item.id === row.id);
          return next ? { ...row, ...next } : row;
        }),
      );
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : "MCP execution failed");
    } finally {
      setExecuting(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error && rows.length === 0) return <ErrorState message={error} />;

  return (
    <>
      <PageHeader
        title="MCP Environments"
        subtitle="Registered company MCP environments. Health checks and Test MCP require authenticated access."
      />
      {error ? <div className="error-box">{error}</div> : null}
      <div className="card" style={{ marginBottom: 24 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Version</th>
              <th>Status</th>
              <th>Knowledge</th>
              <th>Last check</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((mcp) => (
              <tr key={mcp.id}>
                <td>
                  {mcp.companySlug ? (
                    <Link to={`/companies/${mcp.companySlug}`}>{mcp.companyName}</Link>
                  ) : (
                    mcp.companyName
                  )}
                </td>
                <td>{mcp.name}</td>
                <td className="mono">{mcp.endpointUrl}</td>
                <td>{mcp.mcpVersion ?? "—"}</td>
                <td>
                  <StatusBadge value={mcp.status} />
                </td>
                <td>
                  {mcp.knowledgeDocumentCount != null
                    ? `${mcp.knowledgeDocumentCount} docs`
                    : "—"}
                </td>
                <td>{formatDate(mcp.lastHealthCheckAt)}</td>
                <td>
                  <button
                    className="button button-small"
                    type="button"
                    disabled={checkingId === mcp.id}
                    onClick={() => void runHealthCheck(mcp.id)}
                  >
                    {checkingId === mcp.id ? "Checking..." : "Health check"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {user?.isPlatformAdmin ? (
        <SectionCard title="Test MCP / Test Connection">
          <p className="muted">
            Platform admin only. Executes an allowlisted read-only tool on a registered MCP
            environment — not an open proxy.
          </p>
          <div className="stack" style={{ maxWidth: 720, marginTop: 16 }}>
            <label>
              MCP environment
              <select
                value={selectedMcpId}
                onChange={(e) => setSelectedMcpId(e.target.value)}
              >
                {rows.map((mcp) => (
                  <option key={mcp.id} value={mcp.id}>
                    {mcp.companyName} — {mcp.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tool
              <select value={toolName} onChange={(e) => setToolName(e.target.value)}>
                {(allowedTools.length ? allowedTools : [DEFAULT_TEST_TOOL]).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            {toolName === "search_company_knowledge" ||
            toolName === "get_knowledge_document" ? (
              <label>
                {toolName === "search_company_knowledge" ? "Question" : "Document ref"}
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            ) : null}
            <button
              className="button button-primary"
              type="button"
              disabled={executing || !selectedMcpId}
              onClick={() => void runTestExecute()}
            >
              {executing ? "Executing..." : "Run test"}
            </button>
          </div>

          {executeError ? <div className="error-box" style={{ marginTop: 16 }}>{executeError}</div> : null}

          {executeResult ? (
            <div style={{ marginTop: 16 }}>
              <p className="muted small">
                Correlation: {executeResult.correlationId} · Latency:{" "}
                {executeResult.latencyMs} ms · Auth configured:{" "}
                {executeResult.authConfigured ? "yes" : "no (optional)"}
              </p>
              <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>
                {typeof executeResult.result === "string"
                  ? executeResult.result
                  : JSON.stringify(executeResult.result, null, 2)}
              </pre>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </>
  );
}

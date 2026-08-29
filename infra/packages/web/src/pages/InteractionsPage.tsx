import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  KeyValue,
  LoadingState,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
  formatDate,
} from "../components";

export default function InteractionsPage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [channel, setChannel] = useState("");
  const [success, setSuccess] = useState("");
  const [tool, setTool] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.getInteractionHistory>>["items"]>([]);
  const [selected, setSelected] = useState<Awaited<ReturnType<typeof api.getInteractionDetail>> | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getInteractionHistory({
        companyId: scopeCompanyId || undefined,
        channel: channel || undefined,
        success: success || undefined,
        tool: tool || undefined,
      });
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load interactions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [scopeCompanyId, channel, success, tool]);

  async function openDetail(id: string) {
    try {
      setSelected(await api.getInteractionDetail(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open interaction");
    }
  }

  if (loading) return <LoadingState label="Loading interactions…" />;
  if (error) return <ErrorState title="Unable to load interactions" description={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader
        title="Interactions"
        description="Super-admin conversation and tool history. Bodies are redacted of secrets and access is logged."
      />
      <FilterBar>
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="chatgpt_mcp">ChatGPT MCP</option>
          <option value="claude_mcp">Claude MCP</option>
          <option value="portal">Portal</option>
          <option value="api">API</option>
          <option value="automation">Automation</option>
          <option value="whatsapp">WhatsApp (future)</option>
        </Select>
        <Select value={success} onChange={(e) => setSuccess(e.target.value)}>
          <option value="">All outcomes</option>
          <option value="true">Success</option>
          <option value="false">Failure</option>
        </Select>
        <SearchInput value={tool} onChange={setTool} placeholder="Filter by tool…" />
      </FilterBar>
      {items.length === 0 ? (
        <EmptyState
          icon={<MessageSquare size={28} />}
          title="No interactions"
          description="Gateway and MCP traffic will appear here as an adapter over existing audit records."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Company</th>
                <th>User</th>
                <th>Channel</th>
                <th>Label</th>
                <th>Status</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} onClick={() => void openDetail(row.id)} style={{ cursor: "pointer" }}>
                  <td className="muted small">{formatDate(row.createdAt)}</td>
                  <td>{row.companyName ?? row.companyId}</td>
                  <td>{row.userEmail ?? row.userName}</td>
                  <td>{row.channel}</td>
                  <td>{row.label}</td>
                  <td>
                    <StatusBadge status={row.success ? "healthy" : "failed"} />
                  </td>
                  <td>{row.latencyMs == null ? "—" : `${row.latencyMs} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.label ?? "Interaction"}>
        {selected ? (
          <>
            <KeyValue label="Channel" value={selected.channel} />
            <KeyValue label="User" value={selected.userEmail ?? selected.userName ?? "—"} />
            <KeyValue label="Company" value={selected.companyName ?? "—"} />
            <KeyValue label="Status" value={selected.status} />
            <KeyValue
              label="Latency"
              value={selected.timing.latencyMs == null ? "—" : `${selected.timing.latencyMs} ms`}
            />
            <KeyValue
              label="Provider cost"
              value={
                selected.providerCost.known
                  ? `${selected.providerCost.providerCostCents ?? 0}p`
                  : "Unknown / estimated only"
              }
            />
            <KeyValue label="Trace" value={selected.traceIds.interactionId} />
            <h3>Tools</h3>
            <ul>
              {selected.tools.map((toolRow, index) => (
                <li key={`${toolRow.name}-${index}`}>
                  {toolRow.name ?? toolRow.action} — {toolRow.success ? "ok" : "failed"}
                </li>
              ))}
            </ul>
            <h3>Quality flags</h3>
            {selected.qualityFlags.length === 0 ? (
              <p className="muted small">None</p>
            ) : (
              <ul>
                {selected.qualityFlags.map((flag) => (
                  <li key={flag.id}>
                    {flag.category} ({flag.severity}, ×{flag.occurrenceCount})
                  </li>
                ))}
              </ul>
            )}
            <h3>Request</h3>
            <pre className="mono small">{JSON.stringify(selected.request, null, 2)}</pre>
            <h3>Response</h3>
            <pre className="mono small">{JSON.stringify(selected.response, null, 2)}</pre>
          </>
        ) : null}
      </Drawer>
    </>
  );
}

import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  CollapsibleBlock,
  DataCard,
  Drawer,
  EmptyState,
  ErrorState,
  FilterBar,
  KeyValue,
  LoadingState,
  MobileRecordList,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
  formatDate,
} from "../components";

function channelLabel(channel: string): string {
  switch (channel) {
    case "chatgpt_mcp":
      return "ChatGPT";
    case "claude_mcp":
      return "Claude";
    case "whatsapp":
      return "WhatsApp";
    case "automation":
      return "Automation";
    case "portal":
      return "Portal";
    case "api":
      return "API";
    default:
      return channel;
  }
}

export default function InteractionsPage() {
  const { companyId: scopeCompanyId } = useAdminScope();
  const [channel, setChannel] = useState("");
  const [success, setSuccess] = useState("");
  const [query, setQuery] = useState("");
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
        tool: query.trim() || undefined,
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
  }, [scopeCompanyId, channel, success]);

  const visible = items.filter((row) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [row.companyName, row.userEmail, row.userName, row.label, row.channel, ...(row.tools ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  async function openDetail(id: string) {
    try {
      setSelected(await api.getInteractionDetail(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open interaction");
    }
  }

  if (loading) return <LoadingState label="Loading conversations…" />;
  if (error) return <ErrorState title="Unable to load interactions" description={error} onRetry={() => void load()} />;

  return (
    <>
      <PageHeader
        title="Interactions"
        description="What people asked Infra, what happened, and whether it succeeded."
      />
      <FilterBar className="filter-bar-mobile-stack">
        <SearchInput value={query} onChange={setQuery} placeholder="Search users, companies, tools or messages…" />
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">All channels</option>
          <option value="chatgpt_mcp">ChatGPT</option>
          <option value="claude_mcp">Claude</option>
          <option value="portal">Portal</option>
          <option value="api">API</option>
          <option value="automation">Automation</option>
          <option value="whatsapp">WhatsApp</option>
        </Select>
        <Select value={success} onChange={(e) => setSuccess(e.target.value)}>
          <option value="">All outcomes</option>
          <option value="true">Succeeded</option>
          <option value="false">Failed</option>
        </Select>
      </FilterBar>
      {visible.length === 0 ? (
        <EmptyState
          icon={<MessageSquare size={28} />}
          title="No interactions in this view"
          description="This page shows conversations once people use ChatGPT, Claude, the portal, or automations. An empty list can simply mean a quiet period."
        />
      ) : (
        <>
          <div className="mobile-cards">
            <MobileRecordList>
              {visible.map((row) => (
                <DataCard
                  key={row.id}
                  title={row.userName || row.userEmail || "Unknown user"}
                  subtitle={[row.companyName, channelLabel(row.channel)].filter(Boolean).join(" · ")}
                  status={<StatusBadge status={row.success ? "healthy" : "failed"} />}
                  metric={row.label}
                  timestamp={formatDate(row.createdAt)}
                  onClick={() => void openDetail(row.id)}
                />
              ))}
            </MobileRecordList>
          </div>
          <div className="table-wrap desktop-table">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Company</th>
                  <th>Channel</th>
                  <th>What happened</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id} onClick={() => void openDetail(row.id)} style={{ cursor: "pointer" }}>
                    <td className="muted small">{formatDate(row.createdAt)}</td>
                    <td>
                      <strong>{row.userName || "Unknown user"}</strong>
                      <div className="muted small">{row.userEmail}</div>
                    </td>
                    <td>{row.companyName ?? "—"}</td>
                    <td>{channelLabel(row.channel)}</td>
                    <td>{row.label}</td>
                    <td>
                      <StatusBadge status={row.success ? "healthy" : "failed"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.label ?? "Interaction"}>
        {selected ? (
          <>
            <KeyValue label="User" value={selected.userName ?? selected.userEmail ?? "—"} />
            <KeyValue label="Company" value={selected.companyName ?? "—"} />
            <KeyValue label="Channel" value={channelLabel(selected.channel)} />
            <KeyValue label="Outcome" value={selected.status === "error" ? "Failed" : "Succeeded"} />
            <h3>User request</h3>
            <pre className="mono small">{JSON.stringify(selected.request, null, 2)}</pre>
            <h3>Infra response</h3>
            <pre className="mono small">{JSON.stringify(selected.response, null, 2)}</pre>
            <h3>Tools used</h3>
            {selected.tools.length === 0 ? (
              <p className="muted small">None recorded</p>
            ) : (
              <ul>
                {selected.tools.map((toolRow, index) => (
                  <li key={`${toolRow.name}-${index}`}>
                    {toolRow.name ?? toolRow.action} — {toolRow.success ? "succeeded" : "failed"}
                  </li>
                ))}
              </ul>
            )}
            <KeyValue
              label="Timing"
              value={selected.timing.latencyMs == null ? "—" : `${selected.timing.latencyMs} ms`}
            />
            <KeyValue
              label="Cost"
              value={
                selected.providerCost.known
                  ? `Serving cost recorded`
                  : "Serving cost not measured for this interaction"
              }
            />
            <h3>Quality flags</h3>
            {selected.qualityFlags.length === 0 ? (
              <p className="muted small">No quality issues on this interaction</p>
            ) : (
              <ul>
                {selected.qualityFlags.map((flag) => (
                  <li key={flag.id}>
                    {flag.category} ({flag.severity})
                  </li>
                ))}
              </ul>
            )}
            <CollapsibleBlock title="Technical details">
              <KeyValue label="Interaction ID" value={selected.traceIds.interactionId} mono />
              <KeyValue
                label="Request IDs"
                value={selected.traceIds.requestIds.join(", ") || "—"}
                mono
              />
            </CollapsibleBlock>
          </>
        ) : null}
      </Drawer>
    </>
  );
}

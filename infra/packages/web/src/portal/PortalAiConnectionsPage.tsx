import { PageHeader, SectionCard, StatusBadge } from "../components";

const AI_CLIENTS = [
  {
    client: "ChatGPT",
    status: "not_via_infra" as const,
    description:
      "Not connected through INFRA yet. Any existing direct ChatGPT → company MCP link is unchanged.",
    action: "Gateway routing coming later",
  },
  {
    client: "Claude",
    status: "not_via_infra" as const,
    description:
      "Not connected through INFRA yet. Claude will use the same INFRA gateway path once AI-client routing is enabled.",
    action: "Gateway routing coming later",
  },
  {
    client: "WhatsApp",
    status: "coming_soon" as const,
    description: "Messaging channel for company AI access. Not available in this phase.",
    action: "Coming soon",
  },
];

export default function PortalAiConnectionsPage() {
  return (
    <>
      <PageHeader
        title="AI Connections"
        subtitle="Staff-facing AI clients that will connect through INFRA to your company MCP and tools."
      />

      <div className="stack">
        {AI_CLIENTS.map((conn) => (
          <div key={conn.client} className="card connection-card">
            <div className="connection-header">
              <h3>{conn.client}</h3>
              <StatusBadge
                value={conn.status === "coming_soon" ? "draft" : "registered"}
              />
            </div>
            <p className="muted">{conn.description}</p>
            <button className="button" type="button" disabled>
              {conn.action}
            </button>
          </div>
        ))}
      </div>

      <SectionCard title="How this works">
        <p className="muted">
          AI clients (ChatGPT, Claude, WhatsApp) are different from business connectors
          (Google Drive, BigChange, Xero). Clients talk to INFRA; INFRA checks identity,
          permissions, and metering, then calls your company MCP and connectors.
        </p>
        <p className="muted">
          This phase proves INFRA can execute MCP tools itself. AI-client gateway routing
          is intentionally not enabled yet.
        </p>
      </SectionCard>
    </>
  );
}

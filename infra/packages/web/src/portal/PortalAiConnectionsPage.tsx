import { EL_AI_CONNECTIONS } from "./mock-data";
import { PageHeader, SectionCard, StatusBadge } from "../components";

export default function PortalAiConnectionsPage() {
  return (
    <>
      <PageHeader
        title="AI Connections"
        subtitle="Connect staff-facing AI clients to your company MCP, tools, and knowledge."
      />

      <div className="stack">
        {EL_AI_CONNECTIONS.map((conn) => (
          <div key={conn.client} className="card connection-card">
            <div className="connection-header">
              <h3>{conn.client}</h3>
              <StatusBadge
                value={
                  conn.status === "not_connected"
                    ? "draft"
                    : conn.status === "planned"
                      ? "registered"
                      : "draft"
                }
              />
            </div>
            <p className="muted">{conn.description}</p>
            {conn.v1Note ? <p className="small muted">{conn.v1Note}</p> : null}
            <button className="button" type="button" disabled={conn.status !== "not_connected"}>
              {conn.action}
            </button>
          </div>
        ))}
      </div>

      <SectionCard title="How staff access works">
        <p className="muted">
          John Smith (employee) does not use this portal for day-to-day AI work. He uses
          ChatGPT or Claude as normal. INFRA sits behind those clients — enforcing EL
          permissions, routing to BigChange/knowledge tools, and metering usage.
        </p>
        <p className="muted">
          Charlie (Owner) adds John here, assigns a role, and John&apos;s AI client
          access is scoped to what his role allows.
        </p>
      </SectionCard>
    </>
  );
}

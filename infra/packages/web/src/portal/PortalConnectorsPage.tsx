import { EL_CONNECTORS } from "./mock-data";
import { PageHeader, SectionCard, StatusBadge } from "../components";

export default function PortalConnectorsPage() {
  return (
    <>
      <PageHeader
        title="Connectors"
        subtitle="Business systems connected to your company AI environment. Credentials stay isolated to EL Business."
      />

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>System</th>
              <th>Category</th>
              <th>Status</th>
              <th>Capabilities</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {EL_CONNECTORS.map((c) => (
              <tr key={c.id}>
                <td>
                  <div>{c.name}</div>
                  {c.primary ? (
                    <span className="muted">Primary connector</span>
                  ) : null}
                </td>
                <td>{c.category}</td>
                <td>
                  <StatusBadge value="draft" />
                  <span className="muted" style={{ marginLeft: 8 }}>
                    Not connected
                  </span>
                </td>
                <td>{c.capabilities.join(", ")}</td>
                <td>
                  <button className="button" type="button" disabled={!c.v2Available}>
                    {c.v2Action}
                  </button>
                  <div className="muted small">{c.v1Note}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionCard title="How connections work">
        <div className="grid grid-2">
          <div>
            <h4>v0.1 — Developer setup</h4>
            <p className="muted">
              Platform team (via Cursor/INFRA admin) configures BigChange, Xero, and
              knowledge sources in the background. Once connected, this page updates
              automatically to show status, health, and last sync.
            </p>
          </div>
          <div>
            <h4>v0.2 — Self-service</h4>
            <p className="muted">
              Owners click &quot;Connect now&quot;, enter credentials securely (never
              stored in browser), and the connector activates. Staff permissions are
              enforced server-side regardless of AI client.
            </p>
          </div>
        </div>
      </SectionCard>
    </>
  );
}

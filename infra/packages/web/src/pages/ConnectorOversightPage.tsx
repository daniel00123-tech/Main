import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";

type OversightRow = Awaited<ReturnType<typeof api.getConnectorOversight>>[number];

export default function ConnectorOversightPage() {
  const [rows, setRows] = useState<OversightRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows(await api.getConnectorOversight());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load connectors");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <LoadingState label="Loading connector oversight…" />;
  if (error) return <ErrorState title="Unable to load connectors" description={error} />;

  return (
    <>
      <PageHeader
        title="Connector oversight"
        description="Control-plane status across tenants. Secret values are never shown."
      />
      <SectionCard title="Instances" description="Auth health and sync health are separate.">
        {rows.length === 0 ? (
          <EmptyState
            title="No connector instances"
            description="New companies start with an empty catalogue. Nothing is copied from another tenant."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Connector</th>
                  <th>Auth</th>
                  <th>Sync</th>
                  <th>Last sync</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.connectorInstanceId}>
                    <td>
                      <Link to={`/companies/${row.companySlug}`}>{row.companyName}</Link>
                      <div className="muted small">{row.companyStatus}</div>
                    </td>
                    <td>
                      <strong>{row.name}</strong>
                      <div className="muted small">{row.managedBy ?? "infra"}</div>
                    </td>
                    <td>
                      <StatusBadge status={row.authStatus} />
                    </td>
                    <td>
                      <StatusBadge status={row.syncHealth} />
                    </td>
                    <td className="muted">{row.lastSyncAt ?? "Unavailable"}</td>
                    <td className="muted">{row.lastErrorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}

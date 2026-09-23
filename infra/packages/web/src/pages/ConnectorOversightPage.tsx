import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAdminScope } from "../context/AdminScopeContext";
import {
  DataCard,
  EmptyState,
  ErrorState,
  LoadingState,
  MobileRecordList,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";

type OversightRow = Awaited<ReturnType<typeof api.getConnectorOversight>>[number];

export default function ConnectorOversightPage() {
  const { companySlug: scopeCompanySlug } = useAdminScope();
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

  const visibleRows = scopeCompanySlug
    ? rows.filter((r) => r.companySlug === scopeCompanySlug)
    : rows;

  return (
    <>
      <PageHeader
        title="Connector oversight"
        description="Control-plane status across tenants. Secret values are never shown."
      />
      <SectionCard title="Instances" description="Auth health and sync health are separate.">
        {visibleRows.length === 0 ? (
          <EmptyState
            title="No connector instances"
            description="This page lists company connections. It is empty until a company connects a system."
          />
        ) : (
          <>
          <div className="mobile-cards">
            <MobileRecordList>
              {visibleRows.map((row) => (
                <DataCard
                  key={row.connectorInstanceId}
                  title={row.name}
                  subtitle={row.companyName}
                  status={<StatusBadge status={row.authStatus} />}
                  metric={row.syncHealth}
                  timestamp={row.lastSyncAt ?? "No successful sync yet"}
                >
                  {row.lastErrorMessage ? (
                    <p className="muted small" style={{ margin: "8px 0 0" }}>{row.lastErrorMessage}</p>
                  ) : null}
                </DataCard>
              ))}
            </MobileRecordList>
          </div>
          <div className="desktop-table table-wrap">
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
                {visibleRows.map((row) => (
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
          </>
        )}
      </SectionCard>
    </>
  );
}

import { CONNECTOR_CATALOGUE } from "@infra/shared";
import { Plug } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalConnectorsPage() {
  const { company, overview, loading, error } = usePortalCompany();

  if (loading) return <LoadingState />;
  if (error || !company || !overview) {
    return <ErrorState title="Unable to load connected systems" description={error ?? undefined} />;
  }

  const catalogueById = new Map(CONNECTOR_CATALOGUE.map((item) => [item.id, item]));
  const instances = overview.connectorInstances;

  return (
    <>
      <PageHeader
        title="Connected systems"
        description={`Business systems linked to ${company.name}.`}
      />

      {instances.length === 0 ? (
        <EmptyState
          icon={<Plug size={28} />}
          title="No systems connected"
          description="When integrations are connected for your company, they will appear here."
        />
      ) : (
        <div className="connector-grid">
          {instances.map((connector) => {
            const definition = catalogueById.get(connector.connectorDefinitionId);
            const connected = connector.status !== "draft" && connector.status !== "disabled";
            return (
              <article key={connector.id} className="connector-card" style={{ minHeight: 160 }}>
                <div className="connection-header">
                  <h3 style={{ margin: 0 }}>{connector.name}</h3>
                  <StatusBadge
                    status={connected ? connector.status : "not_configured"}
                    label={connected ? undefined : "Not connected"}
                  />
                </div>
                <p className="muted small">
                  {definition?.description ?? "Business system integration"}
                </p>
                <div className="muted small">
                  Health:{" "}
                  {connector.status === "draft"
                    ? "Not configured"
                    : connector.healthStatus}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <SectionCard title="About connections" description="How INFRA keeps access safe.">
        <p className="muted" style={{ margin: 0 }}>
          Connected systems are reached through INFRA with your role permissions. Staff never need
          direct credentials for each system. Ask an administrator if you need a new integration.
        </p>
      </SectionCard>
    </>
  );
}

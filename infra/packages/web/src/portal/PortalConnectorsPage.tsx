import { useMemo, useState } from "react";
import { CONNECTOR_CATALOGUE } from "@infra/shared";
import { Plug } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import { ConnectorSetupPanel } from "../components/connectors/ConnectorSetupPanel";
import { ConnectorLogo } from "../components/connectors/ConnectorLogo";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalConnectorsPage() {
  const { company, overview, loading, error } = usePortalCompany();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const selected = useMemo(
    () => CONNECTOR_CATALOGUE.find((item) => item.slug === selectedSlug) ?? null,
    [selectedSlug],
  );

  if (loading) return <LoadingState />;
  if (error || !company || !overview) {
    return <ErrorState title="Unable to load connected systems" description={error ?? undefined} />;
  }

  const catalogueById = new Map(CONNECTOR_CATALOGUE.map((item) => [item.id, item]));
  const instances = overview.connectorInstances;
  const knowledge = overview.knowledgeStatus === "configured";
  const gdrive = instances.find((item) => item.connectorDefinitionId === "conn_google_drive");
  const mcp = overview.mcpEnvironments[0];

  return (
    <>
      <PageHeader
        title="Connectors"
        description={`Business systems and channels for ${company.name}.`}
      />

      {gdrive ? (
        <SectionCard
          title="Google Drive"
          description="INFRA shows metadata reported by the company Business MCP. The document corpus stays in the company MCP."
        >
          <div className="connection-header">
            <div>
              <strong>{gdrive.name}</strong>
              <div className="muted small">
                {knowledge
                  ? `${mcp?.knowledgeDocumentCount ?? 0} documents reported by the company MCP`
                  : "Registered on the company MCP. Knowledge is not configured or not reported."}
              </div>
              <div className="muted small">
                Last sync: {mcp?.lastSyncAt ?? gdrive.lastSyncAt ?? "not reported to INFRA"}
              </div>
            </div>
            <StatusBadge
              status={knowledge ? "configured" : "not_configured"}
              label={knowledge ? "Reported by company MCP" : "Not configured"}
            />
          </div>
        </SectionCard>
      ) : null}

      {instances.length === 0 ? (
        <EmptyState
          icon={<Plug size={28} />}
          title="No systems configured"
          description="Choose a connector from the catalogue. Secrets cannot be submitted until secure storage is enabled."
        />
      ) : (
        <div className="connector-grid">
          {instances.map((connector) => {
            const definition = catalogueById.get(connector.connectorDefinitionId);
            return (
              <article key={connector.id} className="connector-card" style={{ minHeight: 160 }}>
                <div className="connection-header">
                  <h3 style={{ margin: 0 }}>{connector.name}</h3>
                  <StatusBadge
                    status={connector.status === "draft" ? "not_configured" : connector.status}
                    label={connector.status === "draft" ? "Not configured" : undefined}
                  />
                </div>
                <p className="muted small">
                  {definition?.description ?? "Business system integration"}
                </p>
                <div className="muted small">
                  Health: {connector.healthStatus === "unknown" ? "Not reported" : connector.healthStatus}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <SectionCard title="Catalogue" description="Shared connector types. Availability is honest.">
        <div className="connector-grid">
          {CONNECTOR_CATALOGUE.filter((item) => item.integrationType === "business_system").map(
            (item) => (
              <article key={item.id} className="connector-card">
                <div className="connection-header">
                  <ConnectorLogo slug={item.slug} name={item.name} />
                  <StatusBadge
                    status={item.catalogueStatus}
                    label={
                      item.availabilityLabel === "available_now"
                        ? "Available now"
                        : item.availabilityLabel === "requires_setup"
                          ? "Requires setup"
                          : "Coming soon"
                    }
                  />
                </div>
                <h3 style={{ margin: "12px 0 6px" }}>{item.name}</h3>
                <p className="muted small">{item.description}</p>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  onClick={() => setSelectedSlug(item.slug)}
                >
                  Setup contract
                </button>
              </article>
            ),
          )}
        </div>
      </SectionCard>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelectedSlug(null)}
        title={selected?.name ?? "Connector"}
        description={selected?.setupInstructions}
      >
        {selected ? <ConnectorSetupPanel connector={selected} /> : null}
      </Modal>
    </>
  );
}

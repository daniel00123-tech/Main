import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CONNECTOR_CATALOGUE,
  taxonomyForConnector,
  taxonomyLabel,
} from "@infra/shared";
import { Plug } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "../components";
import { ConnectorSetupPanel } from "../components/connectors/ConnectorSetupPanel";
import { ConnectorLogo } from "../components/connectors/ConnectorLogo";
import { usePortalCompany } from "./usePortalCompany";

export default function PortalConnectorsPage() {
  const { company, overview, loading, error, refresh } = usePortalCompany();
  const [searchParams] = useSearchParams();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const xeroReturn = searchParams.get("xero");

  useEffect(() => {
    if (xeroReturn) setSelectedSlug("xero");
  }, [xeroReturn]);

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
  const mcp = overview.mcpEnvironments[0];
  const gdrive = instances.find((item) => item.connectorDefinitionId === "conn_google_drive");
  const knowledgeSource = overview.knowledgeSources?.find(
    (item) => item.kind === "google_drive",
  );
  const documentCount =
    knowledgeSource?.documentCount ?? mcp?.knowledgeDocumentCount ?? null;
  const chunkCount = knowledgeSource?.chunkCount ?? mcp?.knowledgeChunkCount ?? null;
  const lastSync = knowledgeSource?.lastSyncAt ?? gdrive?.lastSyncAt ?? mcp?.lastSyncAt ?? null;

  const businessCatalogue = CONNECTOR_CATALOGUE.filter(
    (item) => item.integrationType === "business_system",
  );
  const groups = new Map<string, typeof businessCatalogue>();
  for (const item of businessCatalogue) {
    const key = taxonomyForConnector(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return (
    <>
      <PageHeader
        title="Connectors"
        description={`Business systems for ${company.name}. AI clients are listed under AI Connections.`}
      />
      {xeroReturn === "connected" ? (
        <Notice tone="success">Xero is connected. Tokens are stored encrypted and are never shown.</Notice>
      ) : null}
      {xeroReturn === "select_org" ? (
        <Notice tone="info">Choose the Xero organisation in the Xero setup panel to finish connecting.</Notice>
      ) : null}
      {xeroReturn === "error" ? (
        <Notice tone="danger">Xero authorisation did not complete. You can try Connect Xero again.</Notice>
      ) : null}

      {gdrive ? (
        <SectionCard
          title="Google Drive"
          description="INFRA is not OAuth-connected to Drive. The document corpus stays on the company Business MCP."
        >
          <div className="connection-header">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <ConnectorLogo slug="google-drive" name="Google Drive" />
                <div>
                  <strong>Google Drive</strong>
                  <div className="muted small">
                    Managed by: {company.name} Business MCP
                  </div>
                </div>
              </div>
              <div className="kv-stack" style={{ marginTop: 16 }}>
                <KeyValue
                  label="Status"
                  value={<StatusBadge status={gdrive.healthStatus === "healthy" ? "healthy" : gdrive.status} />}
                />
                <KeyValue
                  label="Knowledge"
                  value={
                    documentCount != null
                      ? `${documentCount} documents${chunkCount != null ? ` · ${chunkCount} chunks` : ""}`
                      : "Not reported"
                  }
                />
                <KeyValue label="Last sync" value={lastSync ?? "Unavailable"} />
                <KeyValue label="Capabilities" value="Read · Search · Sync" />
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {instances.filter((item) => item.connectorDefinitionId !== "conn_google_drive").length === 0 &&
      !gdrive ? (
        <EmptyState
          icon={<Plug size={28} />}
          title="No systems configured"
          description="Choose a connector from the catalogue. Secrets are stored only after secure encryption is configured."
        />
      ) : (
        <div className="connector-grid" style={{ margin: "16px 0 24px" }}>
          {instances
            .filter((item) => item.connectorDefinitionId !== "conn_google_drive")
            .map((connector) => {
              const definition = catalogueById.get(connector.connectorDefinitionId);
              return (
                <article key={connector.id} className="connector-card" style={{ minHeight: 160 }}>
                  <div className="connection-header">
                    <h3 style={{ margin: 0 }}>{connector.name}</h3>
                    <StatusBadge
                      status={connector.status === "draft" ? "not_configured" : connector.status}
                    />
                  </div>
                  <p className="muted small">
                    {definition?.description ?? "Business system integration"}
                  </p>
                  <div className="muted small">
                    Auth: {connector.authStatus ?? "Not configured"} · Sync:{" "}
                    {connector.lastSyncAt ?? "Unavailable"}
                  </div>
                </article>
              );
            })}
        </div>
      )}

      {[...groups.entries()].map(([taxonomy, items]) => (
        <SectionCard
          key={taxonomy}
          title={taxonomyLabel(taxonomy as Parameters<typeof taxonomyLabel>[0])}
          description={
            taxonomy === "knowledge_sources"
              ? "Document sources that feed company knowledge search."
              : undefined
          }
        >
          <div className="connector-grid">
            {items.map((item) => {
              const instance = instances.find((row) => row.connectorDefinitionId === item.id);
              return (
                <article key={item.id} className="connector-card">
                  <div className="connection-header">
                    <ConnectorLogo slug={item.slug} name={item.name} />
                    <StatusBadge
                      status={
                        instance
                          ? instance.status === "draft"
                            ? "not_configured"
                            : instance.status
                          : item.catalogueStatus
                      }
                      label={
                        instance
                          ? instance.status === "healthy"
                            ? "Connected"
                            : undefined
                          : item.availabilityLabel === "available_now"
                            ? "Available"
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
                    {instance ? "View setup" : "Connect"}
                  </button>
                </article>
              );
            })}
          </div>
        </SectionCard>
      ))}

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelectedSlug(null)}
        title={selected?.name ?? "Connector"}
        description={selected?.setupInstructions}
      >
        {selected ? (
          <ConnectorSetupPanel
            connector={selected}
            companySlug={company.slug}
            instance={instances.find((row) => row.connectorDefinitionId === selected.id) ?? null}
            onChanged={async () => {
              await refresh();
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

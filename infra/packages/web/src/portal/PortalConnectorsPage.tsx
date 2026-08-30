import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CONNECTOR_CATALOGUE,
  connectorOverviewDescription,
  deriveConnectorCustomerHealth,
  isCustomerConnectedConnector,
  taxonomyForConnector,
} from "@infra/shared";
import { Plug } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  FilterChip,
  KeyValue,
  LoadingState,
  Modal,
  Notice,
  SearchInput,
  SectionCard,
  StatusBadge,
  useIsMobile,
} from "../components";
import { ConnectorSetupPanel } from "../components/connectors/ConnectorSetupPanel";
import { ConnectorSetupWizard } from "../components/connectors/ConnectorSetupWizard";
import { ConnectorLogo } from "../components/connectors/ConnectorLogo";
import {
  customerTaxonomyLabel,
  formatRelativeTime,
  humanConnectorPurpose,
} from "../lib/format";
import { CompactList, IntegrationRow, PortalPageHeader, SegmentedControl } from "./components";
import { usePortalCompany } from "./usePortalCompany";

type ViewFilter = "connected" | "available" | "attention";

function instanceStatus(instance: Parameters<typeof deriveConnectorCustomerHealth>[0]) {
  return deriveConnectorCustomerHealth(instance).badgeStatus;
}

function instanceStatusLabel(instance: Parameters<typeof deriveConnectorCustomerHealth>[0]) {
  return deriveConnectorCustomerHealth(instance).label;
}

function needsAttention(instance: Parameters<typeof deriveConnectorCustomerHealth>[0]) {
  const label = deriveConnectorCustomerHealth(instance).label;
  return label === "Attention needed" || label === "Error";
}

export default function PortalConnectorsPage() {
  const { company, overview, loading, error, refresh } = usePortalCompany();
  const [searchParams] = useSearchParams();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewFilter>("connected");
  const [category, setCategory] = useState("all");
  const isMobile = useIsMobile();
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
    return <ErrorState title="Unable to load connections" description={error ?? undefined} />;
  }

  const catalogueById = new Map(CONNECTOR_CATALOGUE.map((item) => [item.id, item]));
  const instances = overview.connectorInstances;
  const businessCatalogue = CONNECTOR_CATALOGUE.filter(
    (item) => item.integrationType === "business_system" && !item.parentConnectorId,
  );

  const connectedItems = useMemo(() => {
    return instances.filter(isCustomerConnectedConnector).map((instance) => {
      const definition = catalogueById.get(instance.connectorDefinitionId);
      return { instance, definition, kind: "instance" as const };
    });
  }, [instances, catalogueById]);

  const availableItems = useMemo(() => {
    const connectedIds = new Set(instances.map((i) => i.connectorDefinitionId));
    return businessCatalogue
      .filter((item) => !connectedIds.has(item.id) || instances.find((i) => i.connectorDefinitionId === item.id)?.status === "draft")
      .map((definition) => ({
        definition,
        instance: instances.find((i) => i.connectorDefinitionId === definition.id) ?? null,
        kind: "catalogue" as const,
      }));
  }, [businessCatalogue, instances]);

  const attentionItems = connectedItems.filter(({ instance }) => needsAttention(instance));

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const item of businessCatalogue) {
      set.add(taxonomyForConnector(item));
    }
    return ["all", ...Array.from(set).sort()];
  }, [businessCatalogue]);

  const filteredConnected = connectedItems.filter(({ instance, definition }) => {
    const q = query.trim().toLowerCase();
    const name = instance.name.toLowerCase();
    const tax = definition ? taxonomyForConnector(definition) : "";
    if (category !== "all" && tax !== category) return false;
    if (!q) return true;
    return name.includes(q) || (definition?.name.toLowerCase().includes(q) ?? false);
  });

  const filteredAvailable = availableItems.filter(({ definition }) => {
    const q = query.trim().toLowerCase();
    const tax = taxonomyForConnector(definition);
    if (category !== "all" && tax !== category) return false;
    if (!q) return true;
    return definition.name.toLowerCase().includes(q) || definition.description.toLowerCase().includes(q);
  });

  const filteredAttention = attentionItems.filter(({ instance, definition }) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return instance.name.toLowerCase().includes(q) || (definition?.name.toLowerCase().includes(q) ?? false);
  });

  return (
    <div className="portal-page">
      <PortalPageHeader
        title="Connections"
        description="Business systems linked to your company."
      />

      {xeroReturn === "connected" ? (
        <Notice tone="success">Xero is connected successfully.</Notice>
      ) : null}
      {xeroReturn === "select_org" ? (
        <Notice tone="info">Choose your Xero organisation to finish connecting.</Notice>
      ) : null}
      {xeroReturn === "error" ? (
        <Notice tone="danger">Xero authorisation did not complete. Try connecting again.</Notice>
      ) : null}

      <div className="connections-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Search connections…" />
        <SegmentedControl
          value={view}
          onChange={setView}
          options={[
            { id: "connected", label: "Connected", count: connectedItems.length },
            { id: "available", label: "Available", count: availableItems.length },
            { id: "attention", label: "Needs attention", count: attentionItems.length },
          ]}
        />
      </div>

      <FilterBar className="connections-toolbar">
        <FilterChip active={category === "all"} onClick={() => setCategory("all")}>
          All categories
        </FilterChip>
        {categories.filter((c) => c !== "all").map((cat) => (
          <FilterChip key={cat} active={category === cat} onClick={() => setCategory(cat)}>
            {customerTaxonomyLabel(cat)}
          </FilterChip>
        ))}
      </FilterBar>

      <SectionCard
        title={
          view === "connected"
            ? "Your systems"
            : view === "attention"
              ? "Needs attention"
              : "Add another system"
        }
        description={
          view === "available"
            ? "Browse integrations by category. Select one to connect."
            : undefined
        }
      >
        {view === "connected" && filteredConnected.length === 0 ? (
          <EmptyState
            icon={<Plug size={28} />}
            title="No systems connected yet"
            description="Connect accounting, documents, or field service tools to get started."
            action={
              <Button type="button" variant="primary" onClick={() => setView("available")}>
                Browse available
              </Button>
            }
          />
        ) : view === "attention" && filteredAttention.length === 0 ? (
          <EmptyState title="Nothing needs attention" description="All connected systems look healthy." />
        ) : view === "available" && filteredAvailable.length === 0 ? (
          <EmptyState
            title="No integrations match your search"
            description="Try a different search term or category."
            action={
              query ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              ) : (
                <Button type="button" variant="secondary" size="sm" onClick={() => setCategory("all")}>
                  Show all categories
                </Button>
              )
            }
          />
        ) : view === "connected" ? (
          <CompactList>
            {filteredConnected.map(({ instance, definition }) => (
              <IntegrationRow
                key={instance.id}
                icon={
                  definition ? (
                    <ConnectorLogo slug={definition.slug} name={definition.name} />
                  ) : undefined
                }
                name={instance.name}
                purpose={connectorOverviewDescription(instance.connectorDefinitionId)}
                status={instanceStatus(instance)}
                statusLabel={instanceStatusLabel(instance)}
                onClick={() => definition && setSelectedSlug(definition.slug)}
                action={
                  <Button type="button" variant="secondary" size="sm" onClick={() => definition && setSelectedSlug(definition.slug)}>
                    Manage
                  </Button>
                }
              />
            ))}
          </CompactList>
        ) : view === "attention" ? (
          <CompactList>
            {filteredAttention.map(({ instance, definition }) => (
              <IntegrationRow
                key={instance.id}
                icon={definition ? <ConnectorLogo slug={definition.slug} name={definition.name} /> : undefined}
                name={instance.name}
                purpose="This connection needs review"
                status="warning"
                statusLabel="Needs attention"
                onClick={() => definition && setSelectedSlug(definition.slug)}
              />
            ))}
          </CompactList>
        ) : (
          <div className="product-grid">
            {filteredAvailable.map(({ definition, instance }) => {
              const comingSoon =
                definition.catalogueStatus === "coming_soon" ||
                definition.catalogueStatus === "planned" ||
                definition.catalogueStatus === "deferred";
              const taxonomy = taxonomyForConnector(definition);
              return (
                <article key={definition.id} className="product-card">
                  <div className="product-card-header">
                    <ConnectorLogo slug={definition.slug} name={definition.name} />
                    <StatusBadge
                      status={
                        comingSoon
                          ? definition.catalogueStatus === "deferred"
                            ? "deferred"
                            : "coming_soon"
                          : instance
                            ? "not_configured"
                            : "available"
                      }
                    />
                  </div>
                  <h4 style={{ margin: 0 }}>{definition.name}</h4>
                  <p className="muted small">{humanConnectorPurpose(definition.slug, definition.description)}</p>
                  <div className="muted small">{customerTaxonomyLabel(taxonomy)}</div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={comingSoon}
                    onClick={() => {
                      if (definition.slug === "microsoft-365") {
                        window.location.assign(`/portal/${company.slug}/microsoft-365`);
                        return;
                      }
                      setSelectedSlug(definition.slug);
                    }}
                  >
                    {comingSoon
                      ? definition.catalogueStatus === "deferred"
                        ? "Deferred"
                        : definition.catalogueStatus === "planned"
                          ? "Coming later"
                          : "Coming soon"
                      : instance
                        ? "View setup"
                        : "Connect"}
                  </Button>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>

      {!isMobile && view === "available" ? (
        <SectionCard title="Browse by category" description="Collapsible categories for larger catalogues.">
          {[...new Set(businessCatalogue.map((item) => taxonomyForConnector(item)))].map((taxonomy) => {
            const items = businessCatalogue.filter((item) => taxonomyForConnector(item) === taxonomy);
            const visible = category === "all" || category === taxonomy;
            if (!visible) return null;
            return (
              <details key={taxonomy} className="collapsible-block" style={{ marginBottom: 8 }}>
                <summary>
                  <span>{customerTaxonomyLabel(taxonomy)}</span>
                  <span className="collapsible-summary">{items.length} integrations</span>
                </summary>
                <div className="collapsible-body">
                  <CompactList>
                    {items.map((item) => {
                      const instance = instances.find((row) => row.connectorDefinitionId === item.id);
                      return (
                        <IntegrationRow
                          key={item.id}
                          icon={<ConnectorLogo slug={item.slug} name={item.name} />}
                          name={item.name}
                          purpose={humanConnectorPurpose(item.slug, item.description)}
                          status={instance ? instanceStatus(instance) : item.catalogueStatus}
                          onClick={() => setSelectedSlug(item.slug)}
                        />
                      );
                    })}
                  </CompactList>
                </div>
              </details>
            );
          })}
        </SectionCard>
      ) : null}

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelectedSlug(null)}
        title={selected?.name ?? "Connection"}
        description={selected ? humanConnectorPurpose(selected.slug, selected.description) : undefined}
      >
        {selected ? (
          <>
            <div className="kv-stack" style={{ marginBottom: 16 }}>
              <KeyValue label="Category" value={customerTaxonomyLabel(taxonomyForConnector(selected))} />
              {instances.find((row) => row.connectorDefinitionId === selected.id) ? (
                <>
                  <KeyValue
                    label="Status"
                    value={
                      <StatusBadge
                        status={instanceStatus(
                          instances.find((row) => row.connectorDefinitionId === selected.id)!,
                        )}
                      />
                    }
                  />
                  <KeyValue
                    label="Last sync"
                    value={
                      formatRelativeTime(
                        instances.find((row) => row.connectorDefinitionId === selected.id)?.lastSyncAt,
                      ) === "—"
                        ? "Unavailable"
                        : formatRelativeTime(
                            instances.find((row) => row.connectorDefinitionId === selected.id)?.lastSyncAt,
                          )
                    }
                  />
                </>
              ) : null}
            </div>
            <ConnectorSetupWizard
              connector={selected}
              companySlug={company.slug}
              onAction={async () => {
                await refresh();
              }}
            />
            <ConnectorSetupPanel
              connector={selected}
              companySlug={company.slug}
              instance={instances.find((row) => row.connectorDefinitionId === selected.id) ?? null}
              onChanged={async () => {
                await refresh();
              }}
            />
          </>
        ) : null}
      </Modal>
    </div>
  );
}

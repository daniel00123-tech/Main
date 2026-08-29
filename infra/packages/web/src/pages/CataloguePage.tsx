import { useMemo, useState } from "react";
import type { ConnectorCategory } from "@infra/shared";
import { CONNECTOR_CATALOGUE } from "@infra/shared";
import { PageHeader } from "../components";
import {
  ConnectorCard,
  ConnectorDetailModal,
  filterConnectors,
  type CatalogueFilter,
} from "../components/connectors";

const FILTERS: Array<{ id: CatalogueFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "product_ready", label: "In catalogue" },
  { id: "available", label: "Available" },
  { id: "coming_soon", label: "Coming Soon" },
];

const CATEGORY_FILTERS: Array<{ id: ConnectorCategory | "all"; label: string }> =
  [
    { id: "all", label: "All categories" },
    { id: "cloud_storage", label: "Knowledge Sources" },
    { id: "field_service", label: "Field Service / CRM" },
    { id: "accounting", label: "Accounting & Finance" },
    { id: "helpdesk", label: "Customer Support" },
    { id: "email", label: "Productivity" },
    { id: "ai_assistant", label: "AI Connections" },
    { id: "messaging", label: "Communication Channels" },
    { id: "api", label: "Custom Integrations" },
  ];

export default function CataloguePage() {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<CatalogueFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<ConnectorCategory | "all">(
    "all",
  );
  const [selected, setSelected] = useState<
    (typeof CONNECTOR_CATALOGUE)[number] | null
  >(null);

  const filtered = useMemo(
    () =>
      filterConnectors(
        CONNECTOR_CATALOGUE,
        query,
        statusFilter,
        categoryFilter,
      ),
    [query, statusFilter, categoryFilter],
  );

  const businessCount = CONNECTOR_CATALOGUE.filter(
    (c) => c.integrationType === "business_system",
  ).length;
  const channelCount = CONNECTOR_CATALOGUE.filter(
    (c) => c.integrationType === "ai_channel",
  ).length;
  const activeCount = CONNECTOR_CATALOGUE.filter(
    (c) => c.catalogueStatus === "active",
  ).length;

  return (
    <>
      <PageHeader
        title="Connectors"
        description="Connect business systems and the AI channels staff use."
      />

      <div className="connector-marketplace-stats">
        <div className="connector-stat">
          <span className="connector-stat-value">{CONNECTOR_CATALOGUE.length}</span>
          <span className="connector-stat-label">
            <span className="stat-label-full">Integrations</span>
            <span className="stat-label-short">Apps</span>
          </span>
        </div>
        <div className="connector-stat">
          <span className="connector-stat-value">{businessCount}</span>
          <span className="connector-stat-label">
            <span className="stat-label-full">Business systems</span>
            <span className="stat-label-short">Systems</span>
          </span>
        </div>
        <div className="connector-stat">
          <span className="connector-stat-value">{channelCount}</span>
          <span className="connector-stat-label">
            <span className="stat-label-full">AI &amp; channels</span>
            <span className="stat-label-short">Channels</span>
          </span>
        </div>
        <div className="connector-stat">
          <span className="connector-stat-value">{activeCount}</span>
          <span className="connector-stat-label">
            <span className="stat-label-full">Product-ready</span>
            <span className="stat-label-short">Ready</span>
          </span>
        </div>
      </div>

      <div className="connector-marketplace-controls card">
        <div className="connector-search-wrap">
          <span className="connector-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            className="connector-search-input"
            placeholder="Search connectors..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search connectors"
          />
        </div>

        <div className="connector-filter-row">
          <div className="connector-filter-group">
            {FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={`connector-filter-chip ${
                  statusFilter === filter.id ? "active" : ""
                }`}
                aria-pressed={statusFilter === filter.id}
                onClick={() => setStatusFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <select
            className="connector-category-select"
            value={categoryFilter}
            onChange={(event) =>
              setCategoryFilter(event.target.value as ConnectorCategory | "all")
            }
            aria-label="Filter by category"
          >
            {CATEGORY_FILTERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card empty-state">
          No connectors match your search or filters.
        </div>
      ) : (
        <div className="connector-grid">
          {filtered.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              onOpen={setSelected}
            />
          ))}
        </div>
      )}

      <ConnectorDetailModal connector={selected} onClose={() => setSelected(null)} />
    </>
  );
}

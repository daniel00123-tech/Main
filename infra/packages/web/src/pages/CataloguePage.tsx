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
  { id: "connected", label: "Connected" },
  { id: "available", label: "Available" },
  { id: "coming_soon", label: "Coming Soon" },
];

const CATEGORY_FILTERS: Array<{ id: ConnectorCategory | "all"; label: string }> =
  [
    { id: "all", label: "All categories" },
    { id: "cloud_storage", label: "Cloud Storage" },
    { id: "field_service", label: "Field Service" },
    { id: "accounting", label: "Accounting" },
    { id: "helpdesk", label: "Helpdesk" },
    { id: "email", label: "Email" },
    { id: "ai_assistant", label: "AI Assistant" },
    { id: "messaging", label: "Messaging" },
    { id: "api", label: "API" },
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
        subtitle="Integration marketplace for business systems and AI channels. Each company receives isolated connector instances with separate credentials."
      />

      <div className="connector-marketplace-stats">
        <div className="connector-stat">
          <span className="connector-stat-value">{CONNECTOR_CATALOGUE.length}</span>
          <span className="connector-stat-label">Integrations</span>
        </div>
        <div className="connector-stat">
          <span className="connector-stat-value">{businessCount}</span>
          <span className="connector-stat-label">Business systems</span>
        </div>
        <div className="connector-stat">
          <span className="connector-stat-value">{channelCount}</span>
          <span className="connector-stat-label">AI &amp; channels</span>
        </div>
        <div className="connector-stat">
          <span className="connector-stat-value">{activeCount}</span>
          <span className="connector-stat-label">Active</span>
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

      <div className="card connector-marketplace-note">
        <p className="muted">
          Business-system connectors bring data and actions into company MCP
          environments. AI and messaging connectors are interfaces through which
          staff reach those environments — permissions are enforced server-side by
          INFRA, not by the channel itself.
        </p>
        <p className="muted">
          Personal Gmail, personal Outlook, and personal calendars are out of scope.
        </p>
      </div>

      <ConnectorDetailModal connector={selected} onClose={() => setSelected(null)} />
    </>
  );
}

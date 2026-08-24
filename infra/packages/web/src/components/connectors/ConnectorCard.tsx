import type { ConnectorDefinition } from "@infra/shared";
import { CapabilityChip } from "./CapabilityChip";
import { ConnectorCategoryBadge } from "./ConnectorCategory";
import { ConnectorLogo } from "./ConnectorLogo";
import { ConnectorStatus } from "./ConnectorStatus";
import {
  getConnectorAction,
  getConnectorActionLabel,
  SYNC_MODE_LABELS,
} from "./catalogue-utils";

interface ConnectorCardProps {
  connector: ConnectorDefinition;
  onOpen: (connector: ConnectorDefinition) => void;
}

export function ConnectorCard({ connector, onOpen }: ConnectorCardProps) {
  const action = getConnectorAction(connector.catalogueStatus);
  const actionLabel = getConnectorActionLabel(connector.catalogueStatus);
  const isInteractive = action !== "coming_soon";

  return (
    <article
      className={`connector-card ${connector.catalogueStatus === "active" ? "connector-card-active" : ""}`}
    >
      <div className="connector-card-header">
        <ConnectorLogo slug={connector.slug} name={connector.name} />
        <div className="connector-card-title-block">
          <h3 className="connector-card-title">{connector.name}</h3>
          <ConnectorCategoryBadge category={connector.category} />
        </div>
        <ConnectorStatus status={connector.catalogueStatus} />
      </div>

      <p className="connector-card-description">{connector.description}</p>

      <div className="connector-card-section">
        <div className="connector-card-section-label">Capabilities</div>
        <div className="connector-card-chips">
          {connector.capabilities.map((capability) => (
            <CapabilityChip key={capability} capability={capability} />
          ))}
        </div>
      </div>

      {connector.integrationType === "business_system" ? (
        <div className="connector-card-section">
          <div className="connector-card-section-label">Sync</div>
          <div className="connector-card-chips connector-card-chips-muted">
            {connector.supportedSyncModes.map((mode) => (
              <span key={mode} className="sync-chip">
                {SYNC_MODE_LABELS[mode]}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="connector-card-section">
          <div className="connector-card-section-label">Type</div>
          <span className="sync-chip">AI &amp; channel interface</span>
        </div>
      )}

      <div className="connector-card-footer">
        <button
          type="button"
          className={`button connector-card-button ${
            action === "manage"
              ? "button-primary"
              : action === "connect"
                ? ""
                : "connector-card-button-disabled"
          }`}
          onClick={() => onOpen(connector)}
        >
          {actionLabel}
        </button>
        {isInteractive ? (
          <button
            type="button"
            className="button button-small connector-card-link"
            onClick={() => onOpen(connector)}
          >
            Details
          </button>
        ) : null}
      </div>
    </article>
  );
}

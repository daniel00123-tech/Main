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
  const syncLabel =
    connector.integrationType === "business_system"
      ? connector.supportedSyncModes
          .slice(0, 3)
          .map((mode) => SYNC_MODE_LABELS[mode])
          .join(" · ")
      : "AI & channel interface";

  return (
    <article
      className={`connector-card ${
        connector.catalogueStatus === "active" ? "connector-card-active" : ""
      }`}
      onClick={() => onOpen(connector)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(connector);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="connector-card-top">
        <ConnectorLogo slug={connector.slug} name={connector.name} />
        <div className="connector-card-heading">
          <div className="connector-card-title-row">
            <h3 className="connector-card-title">{connector.name}</h3>
            <ConnectorStatus status={connector.catalogueStatus} />
          </div>
          <ConnectorCategoryBadge category={connector.category} />
        </div>
      </div>

      <p className="connector-card-description">{connector.description}</p>

      <div className="connector-card-chips">
        {connector.capabilities.slice(0, 4).map((capability) => (
          <CapabilityChip key={capability} capability={capability} />
        ))}
      </div>

      <div className="connector-card-meta">{syncLabel}</div>

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
          onClick={(event) => {
            event.stopPropagation();
            onOpen(connector);
          }}
        >
          {actionLabel}
        </button>
      </div>
    </article>
  );
}

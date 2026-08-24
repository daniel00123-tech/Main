import type { ConnectorDefinition } from "@infra/shared";
import { ConnectorCategoryBadge } from "./ConnectorCategory";
import { ConnectorLogo } from "./ConnectorLogo";
import { ConnectorStatus } from "./ConnectorStatus";
import {
  CAPABILITY_LABELS,
  CATEGORY_LABELS,
  getConnectorActionLabel,
  getDevelopmentStatusMessage,
  SYNC_MODE_LABELS,
} from "./catalogue-utils";

interface ConnectorDetailModalProps {
  connector: ConnectorDefinition | null;
  onClose: () => void;
}

export function ConnectorDetailModal({
  connector,
  onClose,
}: ConnectorDetailModalProps) {
  if (!connector) return null;

  const actionLabel = getConnectorActionLabel(connector.catalogueStatus);

  return (
    <div className="connector-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="connector-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connector-modal-title"
      >
        <button
          type="button"
          className="connector-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>

        <div className="connector-modal-header">
          <ConnectorLogo slug={connector.slug} name={connector.name} />
          <div>
            <h2 id="connector-modal-title">{connector.name}</h2>
            <div className="connector-modal-meta">
              <ConnectorCategoryBadge category={connector.category} />
              <ConnectorStatus status={connector.catalogueStatus} />
              <span className="connector-modal-type">
                {connector.integrationType === "ai_channel"
                  ? "AI & channel interface"
                  : "Business system & data"}
              </span>
            </div>
          </div>
        </div>

        <p className="connector-modal-description">{connector.description}</p>

        <div className="connector-modal-grid">
          <div>
            <h4>Expected capabilities</h4>
            <ul className="connector-modal-list">
              {connector.capabilities.map((cap) => (
                <li key={cap}>{CAPABILITY_LABELS[cap]}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>
              {connector.integrationType === "business_system"
                ? "Sync modes"
                : "Integration model"}
            </h4>
            <ul className="connector-modal-list">
              {connector.integrationType === "business_system"
                ? connector.supportedSyncModes.map((mode) => (
                    <li key={mode}>{SYNC_MODE_LABELS[mode]}</li>
                  ))
                : (
                    <li>
                      Users interact through this channel; company MCP enforces
                      permissions server-side.
                    </li>
                  )}
            </ul>
          </div>
        </div>

        <div className="connector-modal-status-box">
          <h4>Development status</h4>
          <p>{getDevelopmentStatusMessage(connector)}</p>
          <p className="muted">
            Category: {CATEGORY_LABELS[connector.category]}
          </p>
        </div>

        <div className="connector-modal-footer">
          {connector.catalogueStatus === "active" ? (
            <p className="muted">
              Manage company connector instances from the company detail view. The
              existing Caddington Google Drive integration remains operational via
              the external MCP environment.
            </p>
          ) : connector.catalogueStatus === "available" ? (
            <p className="muted">
              Self-service connection is not enabled yet. INFRA will register and
              monitor instances once credentials are configured through the platform.
            </p>
          ) : (
            <p className="muted">
              This integration is not yet available for connection. Check back as
              INFRA rollout continues.
            </p>
          )}
          <button type="button" className="button button-primary" onClick={onClose}>
            {actionLabel === "Coming Soon" ? "Close" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

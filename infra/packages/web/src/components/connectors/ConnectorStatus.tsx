import type { ConnectorCatalogueStatus } from "@infra/shared";
import { STATUS_LABELS } from "./catalogue-utils";

const STATUS_CLASS: Record<ConnectorCatalogueStatus, string> = {
  active: "connector-status-active",
  available: "connector-status-available",
  coming_soon: "connector-status-coming-soon",
  planned: "connector-status-coming-soon",
  deferred: "connector-status-draft",
  draft: "connector-status-draft",
};

export function ConnectorStatus({ status }: { status: ConnectorCatalogueStatus }) {
  return (
    <span className={`connector-status ${STATUS_CLASS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

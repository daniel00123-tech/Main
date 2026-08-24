import type { ConnectorCapability } from "@infra/shared";
import { CAPABILITY_LABELS } from "./catalogue-utils";

export function CapabilityChip({ capability }: { capability: ConnectorCapability }) {
  return <span className="capability-chip">{CAPABILITY_LABELS[capability]}</span>;
}

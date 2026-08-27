import type { CapabilityDefinition, ConnectorCapability, CapabilityRiskClass } from "../types";

/** Default risk class mapping per capability (spec-aligned). */
export const CAPABILITY_RISK_MAP: Record<ConnectorCapability, CapabilityRiskClass> = {
  read: "low_risk",
  search: "low_risk",
  analyse: "low_risk",
  index: "low_risk",
  export: "low_risk",
  live_query: "low_risk",
  sync: "write",
  webhook: "write",
  create: "write",
  update: "write",
  batch: "batch_write",
  delete: "delete",
  send: "external_send",
};

export function getCapabilityDefinitions(
  capabilities: ConnectorCapability[],
): CapabilityDefinition[] {
  return capabilities.map((capability) => ({
    capability,
    riskClass: CAPABILITY_RISK_MAP[capability] ?? "high_risk",
  }));
}

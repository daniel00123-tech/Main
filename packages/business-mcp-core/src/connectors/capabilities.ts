import type {
  ConnectorCapability,
  ConnectorCapabilityDescriptor,
  RiskClassification,
} from "./types";

const DEFAULT_RISK: Record<ConnectorCapability, RiskClassification> = {
  READ: "LOW_RISK",
  SEARCH: "LOW_RISK",
  ANALYSE: "LOW_RISK",
  CREATE: "WRITE",
  UPDATE: "WRITE",
  DELETE: "DELETE",
  SEND: "EXTERNAL_SEND",
  BATCH: "BATCH_WRITE",
  SYNC: "LOW_RISK",
  WEBHOOK: "LOW_RISK",
};

export function describeCapability(
  capability: ConnectorCapability,
  enabled = false
): ConnectorCapabilityDescriptor {
  return {
    capability,
    risk: DEFAULT_RISK[capability],
    enabled,
  };
}

export function readOnlyCapabilities(): ConnectorCapabilityDescriptor[] {
  return [
    describeCapability("READ", true),
    describeCapability("SEARCH", true),
    describeCapability("ANALYSE", true),
    describeCapability("SYNC", true),
  ];
}

export function isWriteCapability(capability: ConnectorCapability): boolean {
  return ["CREATE", "UPDATE", "DELETE", "SEND", "BATCH"].includes(capability);
}

export function isHighRisk(risk: RiskClassification): boolean {
  return (
    risk === "DELETE" ||
    risk === "EXTERNAL_SEND" ||
    risk === "FINANCIAL_ACTION" ||
    risk === "HIGH_RISK" ||
    risk === "BATCH_WRITE"
  );
}

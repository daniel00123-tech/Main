import type {
  NormalisedDocument,
  SourceDocumentCandidate,
} from "../knowledge/normalised-document";

export type ConnectorCapability =
  | "READ"
  | "SEARCH"
  | "ANALYSE"
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "SEND"
  | "BATCH"
  | "SYNC"
  | "WEBHOOK";

export type RiskClassification =
  | "LOW_RISK"
  | "WRITE"
  | "DELETE"
  | "BATCH_WRITE"
  | "EXTERNAL_SEND"
  | "FINANCIAL_ACTION"
  | "HIGH_RISK";

export type ConnectorLifecycleStatus =
  | "not_configured"
  | "configured"
  | "active"
  | "disabled"
  | "error";

export type AccessLevel = "none" | "metadata" | "read" | "create" | "update" | "delete";

export type SendLevel = "none" | "draft" | "send";

export interface ConnectorCapabilityDescriptor {
  capability: ConnectorCapability;
  risk: RiskClassification;
  enabled: boolean;
}

export interface ConnectorDefinition {
  connectorType: string;
  connectorVersion: string;
  company: string;
  label: string;
  category: string;
  enabled: boolean;
  status: ConnectorLifecycleStatus;
  authenticationConfigured: boolean;
  scopes?: string[];
  capabilities: ConnectorCapabilityDescriptor[];
  readLevel: AccessLevel;
  writeLevel: AccessLevel;
  sendLevel: SendLevel;
  batchCapable: boolean;
  lastSuccessfulConnection?: string;
  lastSync?: string;
  lastError?: string;
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

export interface DocumentSourceConnector {
  readonly connectorType: string;
  readonly connectorVersion: string;
  getStatus(): Promise<ConnectorDefinition>;
  scanChanges(): Promise<SourceDocumentCandidate[]>;
  fetchDocument(sourceDocumentId: string): Promise<NormalisedDocument>;
}

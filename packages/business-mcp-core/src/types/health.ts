import type { DatabaseSummaryTable } from "./company-config";

export type OverallHealthStatus = "healthy" | "degraded" | "unhealthy";

export type ComponentStatus =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "not_configured";

export interface DbHealth {
  connected: boolean;
  latencyMs?: number;
  error?: string;
}

export interface StorageHealth {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

export interface VectorizeHealth {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

/** Knowledge pipeline lifecycle — distinct from generic component health. */
export type KnowledgePipelineStatus =
  | "not_configured"
  | "configured"
  | "syncing"
  | "indexed"
  | "error";

/** Structured-data framework vs live business data connection. */
export type StructuredDataFrameworkStatus = "configured" | "not_configured";
export type StructuredDataDataStatus = "not_connected" | "empty" | "populated";

export interface KnowledgeHealthSummary {
  /** Pipeline status (not_configured → configured → syncing → indexed | error). */
  status: KnowledgePipelineStatus;
  documents: number;
  indexed: number;
  lastIndexedAt: string | null;
}

export interface StructuredDataHealthSummary {
  /**
   * Backward-compatible summary status. Mirrors `frameworkStatus` when provided.
   * Prefer `frameworkStatus` + `dataStatus` for new consumers.
   */
  status: ComponentStatus;
  frameworkStatus?: StructuredDataFrameworkStatus;
  /** Whether real operational business data is connected/populated. */
  dataStatus?: StructuredDataDataStatus;
  mode: "warehouse" | "live_api" | "not_configured";
  tables: number;
  records: number;
  /** Operational/business rows excluding framework-only metadata tables. */
  operationalRecords?: number;
}

export interface ConnectorHealthSummary {
  type: string;
  status: ComponentStatus | "disabled" | "configured" | "active" | "error";
  enabled: boolean;
  version?: string;
}

export interface QueueHealthSummary {
  status: ComponentStatus;
}

export interface LivenessHealthResponse {
  ok: boolean;
  company: string;
  environment: string;
  service: string;
  status: OverallHealthStatus;
  mcpVersion: string;
  coreVersion: string;
  timestamp: string;
}

export interface ExtendedHealthResponse extends LivenessHealthResponse {
  knowledge: KnowledgeHealthSummary;
  structuredData: StructuredDataHealthSummary;
  connectors: ConnectorHealthSummary[];
  queues: QueueHealthSummary;
  recentErrors: string[];
  capabilities: string[];
  database?: DbHealth;
  storage?: StorageHealth;
  vectorize?: VectorizeHealth;
  tables?: DatabaseSummaryTable[];
}

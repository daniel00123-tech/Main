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

export interface KnowledgeHealthSummary {
  status: ComponentStatus;
  documents: number;
  indexed: number;
  lastIndexedAt: string | null;
}

export interface StructuredDataHealthSummary {
  status: ComponentStatus;
  mode: "warehouse" | "live_api" | "not_configured";
  tables: number;
  records: number;
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

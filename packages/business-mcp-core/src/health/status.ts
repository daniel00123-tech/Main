import type { CompanyIdentity, McpVersionInfo } from "../types/company-config";
import type {
  ConnectorHealthSummary,
  DbHealth,
  ExtendedHealthResponse,
  KnowledgeHealthSummary,
  LivenessHealthResponse,
  OverallHealthStatus,
  QueueHealthSummary,
  StorageHealth,
  StructuredDataDataStatus,
  StructuredDataFrameworkStatus,
  StructuredDataHealthSummary,
  VectorizeHealth,
} from "../types/health";
import type { DatabaseSummaryTable } from "../types/company-config";
import { computeOverallHealth } from "./probes";

export function resolveStructuredDataDataStatus(input: {
  frameworkConfigured: boolean;
  operationalRecords: number;
}): StructuredDataDataStatus {
  if (!input.frameworkConfigured) return "not_connected";
  if (input.operationalRecords > 0) return "populated";
  return "empty";
}

export function buildStructuredDataHealthSummary(input: {
  frameworkConfigured: boolean;
  mode: StructuredDataHealthSummary["mode"];
  tables: number;
  records: number;
  operationalRecords: number;
}): StructuredDataHealthSummary {
  const frameworkStatus: StructuredDataFrameworkStatus = input.frameworkConfigured
    ? "configured"
    : "not_configured";
  const dataStatus = resolveStructuredDataDataStatus({
    frameworkConfigured: input.frameworkConfigured,
    operationalRecords: input.operationalRecords,
  });

  return {
    status: frameworkStatus === "configured" ? "healthy" : "not_configured",
    frameworkStatus,
    dataStatus,
    mode: input.mode,
    tables: input.tables,
    records: input.records,
    operationalRecords: input.operationalRecords,
  };
}

export interface BuildLivenessHealthOptions {
  identity: CompanyIdentity;
  versions: McpVersionInfo;
  status?: OverallHealthStatus;
  timestamp?: string;
}

export function buildLivenessHealthResponse(
  options: BuildLivenessHealthOptions
): LivenessHealthResponse {
  return {
    ok: (options.status ?? "healthy") !== "unhealthy",
    company: options.identity.company,
    environment: options.identity.environment,
    service: options.identity.serviceName,
    status: options.status ?? "healthy",
    mcpVersion: options.versions.mcpVersion,
    coreVersion: options.versions.coreVersion,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
}

export interface BuildExtendedHealthOptions {
  identity: CompanyIdentity;
  versions: McpVersionInfo;
  status?: OverallHealthStatus;
  database?: DbHealth;
  storage?: StorageHealth;
  vectorize?: VectorizeHealth;
  knowledge?: Partial<KnowledgeHealthSummary>;
  structuredData?: Partial<StructuredDataHealthSummary>;
  connectors?: ConnectorHealthSummary[];
  queues?: QueueHealthSummary;
  recentErrors?: string[];
  capabilities?: string[];
  tables?: DatabaseSummaryTable[];
  timestamp?: string;
}

export function buildExtendedHealthResponse(
  options: BuildExtendedHealthOptions
): ExtendedHealthResponse {
  const liveness = buildLivenessHealthResponse({
    identity: options.identity,
    versions: options.versions,
    status: options.status,
    timestamp: options.timestamp,
  });

  return {
    ...liveness,
    knowledge: {
      status: options.knowledge?.status ?? "not_configured",
      documents: options.knowledge?.documents ?? 0,
      indexed: options.knowledge?.indexed ?? 0,
      lastIndexedAt: options.knowledge?.lastIndexedAt ?? null,
    },
    structuredData: {
      status: options.structuredData?.status ?? "not_configured",
      frameworkStatus: options.structuredData?.frameworkStatus,
      dataStatus: options.structuredData?.dataStatus,
      mode: options.structuredData?.mode ?? "not_configured",
      tables: options.structuredData?.tables ?? 0,
      records: options.structuredData?.records ?? 0,
      operationalRecords: options.structuredData?.operationalRecords,
    },
    connectors: options.connectors ?? [],
    queues: options.queues ?? { status: "not_configured" },
    recentErrors: options.recentErrors ?? [],
    capabilities: options.capabilities ?? ["READ"],
    database: options.database,
    storage: options.storage,
    vectorize: options.vectorize,
    tables: options.tables,
  };
}

export function overallStatusFromBindings(input: {
  database?: DbHealth;
  storage?: StorageHealth;
  vectorize?: VectorizeHealth;
  knowledgeConfigured?: boolean;
}): OverallHealthStatus {
  const components: Array<{ healthy: boolean }> = [
    { healthy: input.database?.connected ?? false },
  ];

  if (input.knowledgeConfigured) {
    components.push({ healthy: input.storage?.available ?? false });
    components.push({ healthy: input.vectorize?.available ?? false });
  }

  return computeOverallHealth(components);
}

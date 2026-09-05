/**
 * Safe production lineage metadata. No secrets.
 * Generated at deploy time so operators can tell a full superstack from a partial Worker.
 */

import { GENERATED_PRODUCTION_LINEAGE } from "../generated/production-lineage";

export const PRODUCTION_LINEAGE_ID = "elvex-b8da-superstack";

export const PRODUCTION_SUPERSTACK_CAPABILITIES = [
  "whatsapp_webhook",
  "oauth_discovery",
  "mcp_gateway",
  "portal_chat_api",
  "xero_read_injection",
  "outlook_read_path",
  "rbac",
  "usage_recording",
  "quality_route",
  "openai_provider",
  "cloudflare_provider",
  "tenant_registry",
  "tool_registry",
  "failure_telemetry",
  "daily_improvement_loop",
  "outlook_attachment_ingest",
  "openai_pa_request_brain",
  "knowledge_intake_landing_zone",
  "mailbox_ingestion_default_include",
  "mailbox_scan_failed_semantics",
  "business_data_warehouse",
  "attachment_intake_standard",
  "microsoft_tenant_native_identity",
  "microsoft_sync_report_plain_english",
] as const;

export type ProductionLineage = {
  gitSha: string;
  branch: string;
  generatedAt: string;
  lineage: typeof PRODUCTION_LINEAGE_ID;
  capabilities: readonly string[];
  complete: boolean;
};

export function readGeneratedLineage(): ProductionLineage {
  const gitSha = GENERATED_PRODUCTION_LINEAGE.gitSha || "unknown";
  return {
    gitSha,
    branch: GENERATED_PRODUCTION_LINEAGE.branch || "unknown",
    generatedAt: GENERATED_PRODUCTION_LINEAGE.generatedAt || "",
    lineage: PRODUCTION_LINEAGE_ID,
    capabilities: PRODUCTION_SUPERSTACK_CAPABILITIES,
    complete: gitSha !== "unknown",
  };
}

export function publicProductionLineage(now = new Date()): ProductionLineage & { timestamp: string } {
  return {
    ...readGeneratedLineage(),
    timestamp: now.toISOString(),
  };
}

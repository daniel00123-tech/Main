import type { UsageBreakdownRow } from "@infra/shared";

export type AiChannel =
  | "chatgpt"
  | "claude"
  | "whatsapp"
  | "portal"
  | "portal_chat"
  | "automation"
  | "service";

export function normalizeSourceClient(
  raw: string | null | undefined,
  fallback: AiChannel = "portal",
): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (value.includes("chatgpt") || value === "openai") return "chatgpt";
  if (value.includes("claude")) return "claude";
  if (value.includes("whatsapp")) return "whatsapp";
  if (value === "portal_chat" || value.includes("portal_chat") || value.includes("portal-chat")) {
    return "portal_chat";
  }
  if (value.includes("portal") || value === "infra-gateway" || value === "infra-mcp") {
    return value === "infra-mcp" || value === "infra-gateway" ? value : "portal";
  }
  if (value.includes("automation") || value.includes("action-engine")) return "automation";
  return value;
}

export function connectorFamilyFromAction(
  action?: string | null,
  toolName?: string | null,
): string {
  const blob = `${action ?? ""} ${toolName ?? ""}`.toLowerCase();
  if (blob.includes("xero")) return "xero";
  if (blob.includes("outlook") || blob.includes("mail.") || blob.includes("mailbox")) {
    return "microsoft";
  }
  if (blob.includes("microsoft") || blob.includes("onedrive") || blob.includes("sharepoint")) {
    return "microsoft";
  }
  if (blob.includes("knowledge") || blob.includes("search") || blob.includes("fetch")) {
    return "knowledge";
  }
  if (blob.includes("bigchange")) return "bigchange";
  if (blob.includes("commusoft")) return "commusoft";
  if (blob.includes("health") || blob.includes("system.")) return "system";
  return "other";
}

export async function resolveConnectorInstanceId(
  db: D1Database,
  companyId: string,
  action?: string | null,
  toolName?: string | null,
): Promise<string | null> {
  const family = connectorFamilyFromAction(action, toolName);
  if (family === "system" || family === "other" || family === "knowledge") return null;
  const like =
    family === "microsoft"
      ? "%microsoft%"
      : family === "xero"
        ? "%xero%"
        : `%${family}%`;
  const row = await db
    .prepare(
      `SELECT id FROM connector_instances
       WHERE company_id = ? AND (
         lower(definition_id) LIKE ? OR lower(id) LIKE ? OR lower(display_name) LIKE ?
       )
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(companyId, like, like, like)
    .first();
  return row?.id ? String(row.id) : null;
}

export function emptyBreakdown(key: string, label: string): UsageBreakdownRow {
  return {
    key,
    label,
    requests: 0,
    successful: 0,
    failed: 0,
    denied: 0,
    billable: 0,
    nonBillable: 0,
    chargeCents: 0,
  };
}

export function accumulateBreakdown(
  map: Map<string, UsageBreakdownRow>,
  key: string,
  label: string,
  input: { success: boolean; denied: boolean; billable: boolean; chargeCents: number },
) {
  const row = map.get(key) ?? emptyBreakdown(key, label);
  row.requests += 1;
  if (input.denied) row.denied += 1;
  else if (input.success) row.successful += 1;
  else row.failed += 1;
  if (input.billable) row.billable += 1;
  else row.nonBillable += 1;
  row.chargeCents += input.chargeCents;
  map.set(key, row);
}

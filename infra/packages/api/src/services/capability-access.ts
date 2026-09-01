import {
  actionForProtectedCapability,
  buildStructuredPermissionDenial,
  capabilityFromAction,
  inferProtectedCapabilityFromQuery,
  isKnowledgeDiscoveryTool,
  mailboxForCapability,
  userFacingNotConnectedMessage,
  userFacingTechnicalFailureMessage,
  type CapabilityAccessOutcome,
  type ProtectedCapability,
  type StructuredCapabilityDenial,
} from "@infra/shared";
import type { SessionUser } from "../auth/session";
import { evaluateActionPermission } from "../permissions/service";

const CONNECTOR_DEFINITIONS: Record<ProtectedCapability, string[]> = {
  xero: ["conn_xero"],
  finance_mailbox: ["conn_outlook_shared", "conn_microsoft_365"],
  info_mailbox: ["conn_outlook_shared", "conn_microsoft_365"],
  payments: ["conn_xero"],
  admin: [],
  restricted_knowledge: [],
};

export async function isCapabilityConnected(
  db: D1Database,
  companyId: string,
  capability: ProtectedCapability,
): Promise<boolean> {
  const defs = CONNECTOR_DEFINITIONS[capability];
  if (defs.length === 0) return true;
  const rows = await db
    .prepare(
      `SELECT connector_definition_id
       FROM connector_instances
       WHERE company_id = ?
         AND auth_status = 'connected'
         AND COALESCE(status, '') NOT IN ('disabled', 'draft', 'archived')`,
    )
    .bind(companyId)
    .all();
  const connected = new Set(
    (rows.results ?? []).map((row) => String(row.connector_definition_id)),
  );
  return defs.some((id) => connected.has(id));
}

export async function companyDisplayName(db: D1Database, companyId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT name, trading_name FROM companies WHERE id = ?`)
    .bind(companyId)
    .first();
  const trading = row?.trading_name ? String(row.trading_name).trim() : "";
  const name = row?.name ? String(row.name).trim() : "";
  return trading || name || "this company";
}

export async function structuredPermissionDenial(
  db: D1Database,
  input: {
    companyId: string;
    capability: ProtectedCapability;
    role?: string | null;
  },
): Promise<StructuredCapabilityDenial> {
  const [connected, companyName] = await Promise.all([
    isCapabilityConnected(db, input.companyId, input.capability),
    companyDisplayName(db, input.companyId),
  ]);
  return buildStructuredPermissionDenial({
    capability: input.capability,
    connected,
    role: input.role,
    companyName,
  });
}

export function resolveProtectedCapability(input: {
  action?: string | null;
  toolName?: string | null;
  mailboxAddress?: string | null;
  query?: string | null;
}): ProtectedCapability | null {
  return (
    capabilityFromAction(input) ??
    inferProtectedCapabilityFromQuery(input.query)
  );
}

export async function denyKnowledgeQueryIfProtected(
  db: D1Database,
  user: SessionUser,
  companyId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Promise<StructuredCapabilityDenial | null> {
  if (!isKnowledgeDiscoveryTool(toolName)) return null;
  const query = typeof args?.query === "string" ? args.query : null;
  const inferred = inferProtectedCapabilityFromQuery(query);
  if (!inferred) return null;

  const mailbox = mailboxForCapability(inferred);
  const decision = await evaluateActionPermission(
    db,
    user,
    companyId,
    actionForProtectedCapability(inferred) as never,
    { toolName, mailboxAddress: mailbox },
  );
  if (decision.allowed) return null;
  return structuredPermissionDenial(db, {
    companyId,
    capability: inferred,
    role: decision.role,
  });
}

export function mapExecutionOutcome(input: {
  capability: ProtectedCapability | null;
  connected: boolean | null;
  httpStatus: number;
  error?: string | null;
  code?: string | null;
}): { outcome: CapabilityAccessOutcome; message: string } | null {
  if (!input.capability) return null;
  const code = (input.code ?? "").toUpperCase();
  const lower = (input.error ?? "").toLowerCase();
  if (
    code.includes("NOT_CONNECTED") ||
    lower.includes("is not connected") ||
    lower.includes("isn't connected")
  ) {
    return {
      outcome: "not_connected",
      message: userFacingNotConnectedMessage(input.capability),
    };
  }
  if (input.httpStatus >= 500 || code.includes("FAILED") || code.includes("UNAVAILABLE") || code.includes("TIMEOUT")) {
    return {
      outcome: "technical_failure",
      message: userFacingTechnicalFailureMessage(input.capability),
    };
  }
  return null;
}

export function xeroResultLooksEmpty(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const row = result as Record<string, unknown>;
  const summary = row.summary && typeof row.summary === "object" ? (row.summary as Record<string, unknown>) : null;
  if (summary && Number(summary.transactionCount ?? -1) === 0) return true;
  if (Array.isArray(row.transactions) && row.transactions.length === 0 && Array.isArray(row.invoices) && row.invoices.length === 0) {
    return true;
  }
  if (Array.isArray(row.customers) && row.customers.length === 0) return true;
  if (Array.isArray(row.invoices) && row.invoices.length === 0 && !summary) return true;
  if (Array.isArray(row.payments) && row.payments.length === 0) return true;
  return false;
}

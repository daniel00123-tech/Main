import {
  actionForProtectedCapability,
  buildStructuredPermissionDenial,
  businessToolForIntent,
  capabilityFromAction,
  extractIntentText,
  inferProtectedCapabilityFromQuery,
  isKnowledgeDiscoveryTool,
  mailboxForCapability,
  resolveBusinessSystemIntent,
  userFacingNotConnectedMessage,
  userFacingTechnicalFailureMessage,
  type CapabilityAccessOutcome,
  type CompanyConnectorHint,
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

export type KnowledgeBusinessSystemPreflight =
  | { kind: "knowledge" }
  | {
      kind: "permission_denied";
      capability: ProtectedCapability;
      denial: StructuredCapabilityDenial;
    }
  | {
      kind: "not_connected";
      capability: ProtectedCapability;
      message: string;
    }
  | {
      kind: "reroute";
      capability: ProtectedCapability;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: "no_business_tool";
      capability: ProtectedCapability | null;
      connectorDefinitionId: string;
      message: string;
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

async function loadCompanyConnectors(db: D1Database, companyId: string): Promise<CompanyConnectorHint[]> {
  const rows = await db
    .prepare(
      `SELECT connector_definition_id, name, status, auth_status
       FROM connector_instances
       WHERE company_id = ?`,
    )
    .bind(companyId)
    .all();
  return (rows.results ?? []).map((row) => ({
    definitionId: String(row.connector_definition_id),
    name: row.name ? String(row.name) : null,
    connected: String(row.auth_status ?? "") === "connected",
  }));
}

function connectorLabel(definitionId: string): string {
  if (definitionId === "conn_xero") return "Xero";
  if (definitionId === "conn_outlook_shared" || definitionId === "conn_microsoft_365") return "Outlook";
  if (definitionId === "conn_bigchange") return "BigChange";
  if (definitionId === "conn_commusoft") return "Commusoft";
  return definitionId.replace(/^conn_/, "");
}

/**
 * Knowledge tools are classified only after business-system intent.
 * Explicit named-connector + data/action requests never fall through to
 * company knowledge, even when ChatGPT picked search/database_summary.
 */
export async function evaluateKnowledgeBusinessSystemPreflight(
  db: D1Database,
  user: SessionUser,
  companyId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Promise<KnowledgeBusinessSystemPreflight> {
  if (!isKnowledgeDiscoveryTool(toolName)) return { kind: "knowledge" };

  const query = extractIntentText(args);
  const connectors = await loadCompanyConnectors(db, companyId);
  const intent = resolveBusinessSystemIntent(query, { connectors });
  if (!intent) return { kind: "knowledge" };

  const companyName = await companyDisplayName(db, companyId);

  if (!intent.capability) {
    return {
      kind: "no_business_tool",
      capability: null,
      connectorDefinitionId: intent.connectorDefinitionId,
      message: `${connectorLabel(intent.connectorDefinitionId)} is connected for ${companyName}, but this client cannot query it directly. Ask through WhatsApp or the portal, or ask an INFRA administrator.`,
    };
  }

  const connected = await isCapabilityConnected(db, companyId, intent.capability);
  if (!connected && intent.capability !== "admin" && intent.capability !== "restricted_knowledge") {
    return {
      kind: "not_connected",
      capability: intent.capability,
      message: userFacingNotConnectedMessage(intent.capability, companyName),
    };
  }

  const mailbox = mailboxForCapability(intent.capability);
  const decision = await evaluateActionPermission(
    db,
    user,
    companyId,
    actionForProtectedCapability(intent.capability) as never,
    { toolName, mailboxAddress: mailbox },
  );
  if (!decision.allowed) {
    return {
      kind: "permission_denied",
      capability: intent.capability,
      denial: await structuredPermissionDenial(db, {
        companyId,
        capability: intent.capability,
        role: decision.role,
      }),
    };
  }

  const tool = businessToolForIntent(intent, query);
  if (!tool) {
    return {
      kind: "no_business_tool",
      capability: intent.capability,
      connectorDefinitionId: intent.connectorDefinitionId,
      message: `${connectorLabel(intent.connectorDefinitionId)} is connected for ${companyName}, but this client cannot query it directly. Ask through WhatsApp or the portal, or ask an INFRA administrator.`,
    };
  }

  return {
    kind: "reroute",
    capability: intent.capability,
    toolName: tool.toolName,
    arguments: tool.arguments,
  };
}

export async function denyKnowledgeQueryIfProtected(
  db: D1Database,
  user: SessionUser,
  companyId: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Promise<StructuredCapabilityDenial | null> {
  const result = await evaluateKnowledgeBusinessSystemPreflight(db, user, companyId, toolName, args);
  return result.kind === "permission_denied" ? result.denial : null;
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
  if (Number(row.invoice_count ?? -1) === 0 && Number(row.sales_total ?? 0) === 0) return true;
  if (Array.isArray(row.transactions) && row.transactions.length === 0 && Array.isArray(row.invoices) && row.invoices.length === 0) {
    return true;
  }
  if (Array.isArray(row.customers) && row.customers.length === 0) return true;
  if (Array.isArray(row.invoices) && row.invoices.length === 0 && !summary) return true;
  if (Array.isArray(row.payments) && row.payments.length === 0) return true;
  return false;
}

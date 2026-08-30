import {
  elvexCan,
  isElvexCompany,
  mapActionToElvexCapability,
  type ElvexCapability,
  type ToolAction,
} from "@infra/shared";
import type { SessionUser } from "../auth/session";
import { getUserById, toSessionUser } from "../auth/users";
import { evaluateActionPermission, type PermissionDecision } from "../permissions/service";
import { recordAuditEvent } from "./control-plane";
import type { ServiceIdentityRecord } from "./service-identities";

export type BoundUserResolution =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "unknown_identity" | "disabled_user" | "no_membership" | "disabled_membership"; detail: string };

export async function resolveBoundUserForCompany(
  db: D1Database,
  input: { boundUserId: string | null | undefined; companyId: string },
): Promise<BoundUserResolution> {
  if (!input.boundUserId) {
    return { ok: false, reason: "unknown_identity", detail: "No individual identity is bound to this AI connection" };
  }
  const user = await getUserById(db, input.boundUserId);
  if (!user) {
    return { ok: false, reason: "unknown_identity", detail: "Authenticated identity is not an INFRA user" };
  }
  if (user.status !== "active") {
    return { ok: false, reason: "disabled_user", detail: "INFRA user is disabled" };
  }
  const membership = await db
    .prepare(`SELECT role, status FROM company_memberships WHERE company_id = ? AND user_id = ?`)
    .bind(input.companyId, user.id)
    .first<{ role?: string; status?: string }>();
  if (!membership) {
    return {
      ok: false,
      reason: "no_membership",
      detail: "Microsoft tenant membership alone does not grant INFRA access",
    };
  }
  if (membership.status !== "active") {
    return { ok: false, reason: "disabled_membership", detail: "Company membership is disabled" };
  }
  return { ok: true, user: await toSessionUser(db, user) };
}

export function resolveToolCapability(
  toolName: string,
  args?: Record<string, unknown>,
): ElvexCapability | "engineer_or_company" | null {
  const mailbox = typeof args?.mailbox === "string" ? args.mailbox.toLowerCase() : "";
  if (mailbox.includes("finance@") || toolName.toLowerCase().includes("finance")) {
    if (toolName.includes("send") || toolName.includes("write") || toolName.includes("manage")) {
      return "mail.finance.write";
    }
    if (toolName.startsWith("search_") || toolName.startsWith("get_") || toolName.includes("mail") || toolName.includes("outlook")) {
      return "mail.finance.read";
    }
  }
  const mappedTool: Record<string, ElvexCapability | "engineer_or_company"> = {
    search_company_knowledge: "engineer_or_company",
    get_knowledge_document: "engineer_or_company",
    search_elvex_email: "mail.info.read",
    get_elvex_email: "mail.info.read",
    send_elvex_email: "mail.info.write",
    manage_elvex_email: "mail.info.write",
    search_xero_invoices: "xero.sales.read",
    analyse_xero_sales: "xero.sales.read",
    search_xero_bills: "xero.finance.read",
    get_xero_financial_summary: "xero.finance.read",
    create_xero_draft_invoice: "xero.draft.write",
  };
  if (mappedTool[toolName]) return mappedTool[toolName];
  return mapActionToElvexCapability(toolName);
}

export async function evaluateBoundUserGatewayPermission(
  db: D1Database,
  input: {
    companyId: string;
    companySlug?: string | null;
    identity: ServiceIdentityRecord;
    action: ToolAction | string;
    toolName: string;
    args?: Record<string, unknown>;
  },
): Promise<PermissionDecision & { resolution?: BoundUserResolution }> {
  const resolution = await resolveBoundUserForCompany(db, {
    boundUserId: input.identity.boundUserId,
    companyId: input.companyId,
  });
  if (!resolution.ok) {
    const decision: PermissionDecision = {
      allowed: false,
      action: input.action as ToolAction,
      companyId: input.companyId,
      role: null,
      riskClass: "high_risk",
      reason: resolution.detail,
    };
    await recordAuditEvent(db, {
      companyId: input.companyId,
      eventType: "rbac.sensitive_denial",
      actor: input.identity.name,
      resourceType: "action",
      resourceId: input.toolName,
      detail: { reason: resolution.reason, toolName: input.toolName },
    });
    return { ...decision, resolution };
  }

  const capability = resolveToolCapability(input.toolName, input.args);
  const elvexCompany = isElvexCompany({ id: input.companyId, slug: input.companySlug });
  if (elvexCompany && capability && capability !== "engineer_or_company") {
    const role = resolution.user.memberships.find((item) => item.companyId === input.companyId)?.role ?? null;
    const allowed = elvexCan(role, capability);
    if (!allowed) {
      await recordAuditEvent(db, {
        companyId: input.companyId,
        eventType: "rbac.sensitive_denial",
        actor: resolution.user.email,
        resourceType: "action",
        resourceId: input.toolName,
        detail: { capability, role, toolName: input.toolName },
      });
      return {
        allowed: false,
        action: input.action as ToolAction,
        companyId: input.companyId,
        role,
        riskClass: "high_risk",
        reason: `Elvex RBAC does not grant ${capability}`,
        resolution,
      };
    }
  }

  const decision = await evaluateActionPermission(
    db,
    resolution.user,
    input.companyId,
    input.action as ToolAction,
  );
  if (!decision.allowed) {
    await recordAuditEvent(db, {
      companyId: input.companyId,
      eventType: "rbac.sensitive_denial",
      actor: resolution.user.email,
      resourceType: "action",
      resourceId: input.toolName,
      detail: { reason: decision.reason, toolName: input.toolName },
    });
  }
  return { ...decision, resolution };
}

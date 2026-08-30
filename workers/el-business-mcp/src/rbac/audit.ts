import { ELVEX_COMPANY_ID } from "./actor";
import type { AuthorizationDecision } from "./authorize";
import { isSensitiveCapability } from "./authorize";

export async function recordPermissionAudit(
  db: D1Database | undefined,
  decision: AuthorizationDecision,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!db) return;
  const shouldLog =
    extra.force === true ||
    decision.decision === "deny" && isSensitiveCapability(decision.capability) ||
    extra.eventType === "role.changed" ||
    extra.eventType === "admin.access" ||
    extra.eventType === "classification.changed" ||
    extra.eventType === "payment.info.access" ||
    (decision.decision === "allow" &&
      (decision.capability.startsWith("mail.finance.") ||
        decision.capability === "xero.draft.write" ||
        decision.capability === "knowledge.restricted.read" ||
        decision.capability === "payment.info.access" ||
        decision.capability.startsWith("admin.")));
  if (!shouldLog) return;

  try {
    await db
      .prepare(
        `INSERT INTO permission_audit_log (
           id, company_id, actor_id, actor_role, principal_type, capability, resource,
           decision, reason, correlation_id, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        decision.companyId || ELVEX_COMPANY_ID,
        decision.actorId,
        decision.role,
        decision.principalType,
        decision.capability,
        decision.resource,
        decision.decision,
        decision.reason,
        typeof extra.correlationId === "string" ? extra.correlationId : null,
        JSON.stringify({
          identityBound: decision.identityBound,
          confirmationRequired: decision.confirmationRequired,
          eventType: extra.eventType ?? `permission.${decision.decision}`,
        })
      )
      .run();
  } catch {
    // Audit must never break the request path.
  }
}

export async function listPermissionAudit(
  db: D1Database,
  limit = 50
): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(
      `SELECT id, company_id, actor_id, actor_role, principal_type, capability, resource,
              decision, reason, correlation_id, created_at
       FROM permission_audit_log
       WHERE company_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(ELVEX_COMPANY_ID, Math.min(Math.max(limit, 1), 200))
    .all();
  return (result.results ?? []) as Array<Record<string, unknown>>;
}

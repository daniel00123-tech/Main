import type { Env } from "../env";
import { getRequestActor } from "./context";
import { can, type AuthorizationDecision, type ResourceContext } from "./authorize";
import { recordPermissionAudit } from "./audit";
import { AuthorizationError } from "./errors";
import { mailboxCapabilities, calendarCapabilities } from "./mailbox";
import { xeroCapabilityForTool } from "./xero";
import type { ElvexCapability } from "./capabilities";

export function denyPayload(decision: AuthorizationDecision): {
  error: string;
  code: string;
  capability: string;
  decision: "deny";
  identityBound: boolean;
} {
  return {
    error: decision.reason,
    code: "EL_RBAC_DENIED",
    capability: decision.capability,
    decision: "deny",
    identityBound: decision.identityBound,
  };
}

export async function authorize(
  env: Env,
  capability: string,
  resourceContext: ResourceContext = {}
): Promise<AuthorizationDecision> {
  const actor = getRequestActor();
  const decision = can(actor, capability, resourceContext);
  await recordPermissionAudit(env.EL_BUSINESS_DATA, decision, {
    correlationId: actor.correlationId,
  });
  return decision;
}

export async function requireCapability(
  env: Env,
  capability: string,
  resourceContext: ResourceContext = {}
): Promise<AuthorizationDecision> {
  const decision = await authorize(env, capability, resourceContext);
  if (!decision.allowed) {
    throw new AuthorizationError(
      decision.reason,
      "EL_RBAC_DENIED",
      403,
      decision.capability,
      decision.resource ?? undefined
    );
  }
  return decision;
}

export async function requireMailbox(
  env: Env,
  mailbox: string,
  action: "read" | "write"
): Promise<AuthorizationDecision> {
  const capability = mailboxCapabilities(mailbox, action);
  if (!capability) {
    const actor = getRequestActor();
    const reason = `Mailbox '${mailbox}' is not an approved EL shared mailbox and cannot be used to bypass RBAC.`;
    await recordPermissionAudit(
      env.EL_BUSINESS_DATA,
      {
        ...can(actor, "mail.info.read", { mailbox }),
        allowed: false,
        decision: "deny",
        reason,
        resource: mailbox,
      },
      { force: true, eventType: "mailbox.denied", correlationId: actor.correlationId }
    );
    throw new AuthorizationError(reason, "EL_RBAC_MAILBOX_DENIED", 403, "mail.info.read", mailbox);
  }
  return requireCapability(env, capability, { mailbox });
}

export async function requireCalendar(
  env: Env,
  mailbox: string,
  action: "read" | "write"
): Promise<AuthorizationDecision> {
  const capability = calendarCapabilities(mailbox, action);
  if (!capability) {
    throw new AuthorizationError(
      `Calendar '${mailbox}' is not an approved EL shared mailbox.`,
      "EL_RBAC_CALENDAR_DENIED",
      403,
      "calendar.info.read",
      mailbox
    );
  }
  return requireCapability(env, capability, { mailbox });
}

export async function requireXeroTool(
  env: Env,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<AuthorizationDecision> {
  const capability: ElvexCapability | null = xeroCapabilityForTool(toolName, args);
  if (!capability) {
    throw new AuthorizationError(
      `Xero tool '${toolName}' is not registered for RBAC (fail closed).`,
      "EL_RBAC_XERO_UNREGISTERED",
      403,
      "xero.finance.read",
      toolName
    );
  }
  return requireCapability(env, capability, { xeroTool: toolName, xeroReport: String(args.report ?? "") || null });
}

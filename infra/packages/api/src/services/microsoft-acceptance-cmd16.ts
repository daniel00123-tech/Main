/**
 * CMD16 — Outlook Shared Mailbox READ Alpha acceptance (permission boundary probe).
 */

import type { Env } from "../env";
import { assessOutlookPermissions } from "./microsoft-outlook-permissions";
import { discoverOutlookMailboxes } from "./microsoft-outlook-mailbox";
import { assessOutlookNotificationArchitecture } from "./microsoft-outlook-notifications";

const PILOT_COMPANY_ID = "co_caddington";

async function resolveConnectorInstance(env: Env, companyId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = 'conn_microsoft_365' LIMIT 1`,
  )
    .bind(companyId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function runCmd16OutlookAlphaAcceptance(env: Env): Promise<Record<string, unknown>> {
  const connectorInstanceId = await resolveConnectorInstance(env, PILOT_COMPANY_ID);
  const permissions = await assessOutlookPermissions(env, {
    companyId: PILOT_COMPANY_ID,
    connectorInstanceId: connectorInstanceId ?? undefined,
  });

  let discovery: Awaited<ReturnType<typeof discoverOutlookMailboxes>> | null = null;
  if (connectorInstanceId) {
    discovery = await discoverOutlookMailboxes(env, {
      companyId: PILOT_COMPANY_ID,
      connectorInstanceId,
      actor: "cmd16-outlook-alpha",
    });
  }

  const notifications = assessOutlookNotificationArchitecture();

  const classification = permissions.adminConsentRequired
    ? "OUTLOOK READ ALPHA — AWAITING ADMIN CONSENT"
    : discovery?.verdict === "DISCOVERY_COMPLETE"
      ? "OUTLOOK READ ALPHA — READY FOR PILOT MAILBOX SELECTION"
      : "OUTLOOK READ ALPHA — PARTIAL";

  return {
    command: "CMD16",
    pilotCompanyId: PILOT_COMPANY_ID,
    connectorInstanceId,
    permissions,
    discovery,
    notifications,
    liveReadStopped: permissions.adminConsentRequired,
    classification,
    verdict: classification,
  };
}

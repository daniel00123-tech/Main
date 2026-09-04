/**
 * Scheduled Microsoft 365 background sync for included sources.
 */

import type { Env } from "../env";
import { syncMicrosoftSource, listMicrosoftSources } from "./microsoft-sync";
import { microsoftAppConfigured } from "./microsoft-auth";
import {
  ensureConnectorMicrosoftTenant,
  provisionMicrosoftGraphSubscriptionsForIncludedSources,
  renewExpiringMicrosoftGraphSubscriptions,
} from "./microsoft-graph-subscriptions";
import { provisionOutlookMailboxGraphSubscriptions } from "./microsoft-outlook-notifications";
import { syncOutlookMailbox } from "./microsoft-outlook-sync";
import {
  ingestApprovedOutlookAttachments,
  MAILBOX_INGEST_MAX_LOOKBACK_MS,
} from "./outlook-attachment-ingest";

export async function runMicrosoftScheduledSync(env: Env): Promise<{
  companies: number;
  sourcesSynced: number;
  errors: string[];
  graphSubscriptions: Awaited<ReturnType<typeof provisionMicrosoftGraphSubscriptionsForIncludedSources>>;
  graphRenewals: Awaited<ReturnType<typeof renewExpiringMicrosoftGraphSubscriptions>>;
}> {
  if (!microsoftAppConfigured(env)) {
    return {
      companies: 0,
      sourcesSynced: 0,
      errors: ["Microsoft not configured"],
      graphSubscriptions: { created: 0, skipped: 0, failed: 0, errors: [] },
      graphRenewals: { renewed: 0, cutover: 0, failed: 0, errors: [] },
    };
  }

  const graphSubscriptions = await provisionMicrosoftGraphSubscriptionsForIncludedSources(env);
  const outlookGraphSubscriptions = await provisionOutlookMailboxGraphSubscriptions(env);
  const graphRenewals = await renewExpiringMicrosoftGraphSubscriptions(env);
  try {
    const { processDueOcrCandidates } = await import("./ocr/backfill");
    await processDueOcrCandidates(env, { limit: 2 });
  } catch {
    // OCR backfill is best-effort and must not block Microsoft sync.
  }

  const companies = await env.DB.prepare(
    `SELECT DISTINCT company_id, connector_instance_id FROM microsoft_connector_sources WHERE inclusion_status = 'included'`,
  ).all<{ company_id: string; connector_instance_id: string }>();

  let sourcesSynced = 0;
  const errors: string[] = [
    ...graphSubscriptions.errors,
    ...outlookGraphSubscriptions.errors,
    ...graphRenewals.errors,
  ];

  for (const row of companies.results ?? []) {
    await ensureConnectorMicrosoftTenant(env, {
      companyId: row.company_id,
      connectorInstanceId: row.connector_instance_id,
    });

    const sources = await listMicrosoftSources(env.DB, row.company_id, row.connector_instance_id);
    for (const source of sources.filter((s) => s.inclusionStatus === "included")) {
      try {
        if (source.sourceType === "outlook_shared") {
          await syncOutlookMailbox(env, {
            companyId: row.company_id,
            connectorInstanceId: row.connector_instance_id,
            sourceId: source.id,
            actor: "system:microsoft-scheduler",
            useDelta: true,
            maxMessages: 100,
          });
        } else {
          await syncMicrosoftSource(env, {
            companyId: row.company_id,
            connectorInstanceId: row.connector_instance_id,
            sourceId: source.id,
            actor: "system:microsoft-scheduler",
            useDelta: true,
            maxFiles: 100,
          });
        }
        sourcesSynced++;
      } catch (err) {
        errors.push(
          `${source.displayName}: ${err instanceof Error ? err.message : "sync failed"}`,
        );
      }
    }
  }

  const registryCompanies = await env.DB.prepare(
    `SELECT DISTINCT company_id FROM company_mailbox_registry WHERE enabled_for_attachment_ingestion = 1`,
  ).all<{ company_id: string }>();
  const windowTo = new Date();
  const windowFrom = new Date(windowTo.getTime() - MAILBOX_INGEST_MAX_LOOKBACK_MS);
  for (const row of registryCompanies.results ?? []) {
    if (row.company_id === "co_caddington" || row.company_id === "co_ht") continue;
    try {
      await ingestApprovedOutlookAttachments(env, {
        companyId: row.company_id,
        windowFrom,
        windowTo,
        actor: "system:microsoft-scheduler",
        useMailboxCheckpoints: true,
      });
      sourcesSynced++;
    } catch (err) {
      errors.push(
        `mailbox-registry ${row.company_id}: ${err instanceof Error ? err.message : "attachment ingest failed"}`,
      );
    }
  }

  return {
    companies: new Set((companies.results ?? []).map((r) => r.company_id)).size,
    sourcesSynced,
    errors,
    graphSubscriptions,
    graphRenewals,
  };
}

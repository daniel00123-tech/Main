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
      graphRenewals: { renewed: 0, failed: 0, errors: [] },
    };
  }

  const graphSubscriptions = await provisionMicrosoftGraphSubscriptionsForIncludedSources(env);
  const graphRenewals = await renewExpiringMicrosoftGraphSubscriptions(env);

  const companies = await env.DB.prepare(
    `SELECT DISTINCT company_id, connector_instance_id FROM microsoft_connector_sources WHERE inclusion_status = 'included'`,
  ).all<{ company_id: string; connector_instance_id: string }>();

  let sourcesSynced = 0;
  const errors: string[] = [...graphSubscriptions.errors, ...graphRenewals.errors];

  for (const row of companies.results ?? []) {
    await ensureConnectorMicrosoftTenant(env, {
      companyId: row.company_id,
      connectorInstanceId: row.connector_instance_id,
    });

    const sources = await listMicrosoftSources(env.DB, row.company_id, row.connector_instance_id);
    for (const source of sources.filter((s) => s.inclusionStatus === "included")) {
      try {
        await syncMicrosoftSource(env, {
          companyId: row.company_id,
          connectorInstanceId: row.connector_instance_id,
          sourceId: source.id,
          actor: "system:microsoft-scheduler",
          useDelta: true,
          maxFiles: 100,
        });
        sourcesSynced++;
      } catch (err) {
        errors.push(
          `${source.displayName}: ${err instanceof Error ? err.message : "sync failed"}`,
        );
      }
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

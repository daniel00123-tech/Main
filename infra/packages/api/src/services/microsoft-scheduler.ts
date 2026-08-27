/**
 * Scheduled Microsoft 365 background sync for included sources.
 */

import type { Env } from "../env";
import { syncMicrosoftSource, listMicrosoftSources } from "./microsoft-sync";
import { microsoftAppConfigured } from "./microsoft-auth";

export async function runMicrosoftScheduledSync(env: Env): Promise<{
  companies: number;
  sourcesSynced: number;
  errors: string[];
}> {
  if (!microsoftAppConfigured(env)) {
    return { companies: 0, sourcesSynced: 0, errors: ["Microsoft not configured"] };
  }

  const companies = await env.DB.prepare(
    `SELECT DISTINCT company_id, connector_instance_id FROM microsoft_connector_sources WHERE inclusion_status = 'included'`,
  ).all<{ company_id: string; connector_instance_id: string }>();

  let sourcesSynced = 0;
  const errors: string[] = [];

  for (const row of companies.results ?? []) {
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
  };
}

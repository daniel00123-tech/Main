/**
 * Seed draft connector placeholders for productised connectors when MCP registers.
 */

import { newId, nowIso } from "../../db/mappers";
import { listProductisationProfiles } from "./profiles";

export async function ensureConnectorPlaceholders(
  db: D1Database,
  input: { companyId: string; actor?: string },
): Promise<string[]> {
  const created: string[] = [];
  const now = nowIso();

  for (const profile of listProductisationProfiles()) {
    const existing = await db
      .prepare(
        `SELECT id FROM connector_instances WHERE company_id = ? AND connector_definition_id = ? LIMIT 1`,
      )
      .bind(input.companyId, profile.definitionId)
      .first<{ id: string }>();

    if (existing?.id) continue;

    const id = newId("ci");
    await db
      .prepare(
        `INSERT INTO connector_instances (
          id, company_id, connector_definition_id, name, status, config_json, sync_settings_json,
          data_environment_id, health_status, managed_by, auth_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', '{}', ?, NULL, 'unknown', ?, 'not_configured', ?, ?)`,
      )
      .bind(
        id,
        input.companyId,
        profile.definitionId,
        profile.slug === "xero"
          ? "Xero"
          : profile.slug === "microsoft-365"
            ? "Microsoft 365"
            : "Google Drive",
        JSON.stringify({ enabled: false, mode: "scheduled", schedule: null }),
        profile.managedBy === "company_mcp" ? "company_mcp" : "infra",
        now,
        now,
      )
      .run();
    created.push(id);
  }

  return created;
}

import type { Env } from "../../env";
import { publicProductionLineage } from "../production-lineage";
import { resolveBrainPolicy } from "../intelligence/brain-policy";
import { listCompanyMailboxRegistry } from "../mailbox-registry";
import { getKnowledgeIntakeTarget } from "../knowledge-intake";
import { listAutomationDefinitions } from "../automation-engine/store";
import { createD1WarehouseRepository } from "../warehouse/store";
import { warehouseControlCentreView } from "../warehouse/status";
import { EL_CUSTOMER_REQUEST_PRICE_CENTS, EL_PRICING_RULE_ID } from "../el-customer-billing";
import { EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID } from "../daily-improvement/constants";

const COMPANIES = ["co_el", "co_caddington", "co_ht"] as const;

export async function collectLiveInventory(env: Env): Promise<Record<string, unknown>> {
  const lineage = publicProductionLineage();
  const repo = createD1WarehouseRepository(env.DB);
  const warehouse = await warehouseControlCentreView(repo, "co_el");
  const knowledge = await getKnowledgeIntakeTarget(env.DB, "co_el").catch(() => null);
  const mailboxes = await listCompanyMailboxRegistry(env.DB, "co_el").catch(() => []);
  const automations = await listAutomationDefinitions(env.DB, "co_el").catch(() => []);
  const knowledgeActivity = automations.find((row) => row.id === EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID) ?? null;

  const roles = await env.DB.prepare(
    `SELECT lower(u.email) AS email, m.role AS role, m.status AS status
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = 'co_el' AND m.status = 'active' AND u.status = 'active'
     ORDER BY m.role, u.email`,
  )
    .all<{ email: string; role: string; status: string }>()
    .catch(() => ({ results: [] as Array<{ email: string; role: string; status: string }> }));

  const pricing = await env.DB.prepare(
    `SELECT id, company_id, amount_cents, currency, status FROM pricing_rules WHERE id = ? LIMIT 1`,
  )
    .bind(EL_PRICING_RULE_ID)
    .first<Record<string, unknown>>()
    .catch(() => null);

  const openai = Object.fromEntries(
    COMPANIES.map((companyId) => [
      companyId,
      {
        whatsapp: resolveBrainPolicy({ env, companyId, channel: "whatsapp" }),
        portal: resolveBrainPolicy({ env, companyId, channel: "portal_chat" }),
        chatgpt: resolveBrainPolicy({ env, companyId, channel: "chatgpt" }),
      },
    ]),
  );

  return {
    collectedAt: new Date().toISOString(),
    worker: {
      gitSha: lineage.gitSha,
      branch: lineage.branch,
      lineage: lineage.lineage,
      capabilities: lineage.capabilities,
    },
    openai,
    warehouse: {
      status: warehouse.status,
      completeness: warehouse.completeness,
      health: warehouse.health,
      lastSuccessfulSync: warehouse.lastSuccessfulSync,
      records: warehouse.records,
      monthsComplete: warehouse.monthsComplete,
      monthsPartial: warehouse.monthsPartial,
      checkpoint: warehouse.checkpoint,
      contactsStatus: warehouse.contactsStatus,
    },
    knowledgeIntake: knowledge
      ? {
          status: knowledge.status,
          provider: knowledge.provider,
          lastError: knowledge.last_error,
          hasSite: Boolean(knowledge.site_id),
          hasDrive: Boolean(knowledge.drive_id),
        }
      : null,
    mailboxes: mailboxes.map((row) => ({
      address: row.mailbox_address,
      type: row.mailbox_type,
      search: row.enabled_for_mail_search,
      ingest: row.enabled_for_attachment_ingestion,
      status: row.status,
    })),
    pricing: {
      ruleId: EL_PRICING_RULE_ID,
      liveCents: EL_CUSTOMER_REQUEST_PRICE_CENTS,
      row: pricing,
    },
    automations: automations.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
      schedule: row.schedule,
      nextRunAt: row.nextRunAt,
    })),
    knowledgeActivity: knowledgeActivity
      ? {
          id: knowledgeActivity.id,
          status: knowledgeActivity.status,
          timezone: knowledgeActivity.timezone,
          schedule: knowledgeActivity.schedule,
        }
      : { id: EL_KNOWLEDGE_ACTIVITY_AUTOMATION_ID, status: "MISSING" },
    roles: roles.results ?? [],
  };
}

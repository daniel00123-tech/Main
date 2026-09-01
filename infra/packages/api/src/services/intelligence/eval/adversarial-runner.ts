import type { SessionUser } from "../../../auth/session.js";
import type { Env } from "../../../env.js";
import { executeWhatsAppIntelligence } from "../../whatsapp-intelligence.js";
import { emptyEntityMemory, type WhatsAppEntityMemory } from "../../whatsapp-entities.js";
import { listConnectedConnectorIds } from "../../whatsapp-capabilities.js";
import { buildConversationState } from "../state.js";
import { runIntelligenceTurn } from "../orchestrator.js";
import type { IntelligenceDocumentRef, IntelligenceRuntime, IntelligenceToolResult } from "../types.js";
import { policyCompleter, mockedToolRuntime } from "./harness.js";
import {
  ADVERSARIAL_SUITE_VERSION,
  FALLBACK_ADAPTERS,
  instantiateScenarios,
  instantiateTwentyTurn,
  type AdversarialScenario,
  type TenantSubjectAdapter,
} from "./adversarial-scenarios.js";
import {
  scoreTurn,
  summariseCaptures,
  type AdversarialSummary,
  type AdversarialTurnCapture,
  type TransportLabel,
} from "./adversarial-score.js";

export type AdversarialMode = "offline" | "persist";

export type TenantProfile = {
  tenant: "caddington" | "elvex";
  companyId: string;
  companyName: string;
  companySlug: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: string | null;
  mobileE164: string | null;
  whatsappAuthorised: boolean;
  connectors: string[];
  adapter: TenantSubjectAdapter;
  elAuthGap: boolean;
  notes: string[];
};

export type AdversarialRunResult = {
  version: string;
  mode: AdversarialMode;
  transport: TransportLabel;
  startedAt: string;
  finishedAt: string;
  tenants: TenantProfile[];
  rows: AdversarialTurnCapture[];
  summary: AdversarialSummary;
  perTenant: Record<string, AdversarialSummary>;
  twentyTurn?: Record<string, AdversarialTurnCapture[]>;
};

const CADDINGTON_SLUGS = ["caddington", "caddington-holdings"];
const ELVEX_SLUGS = ["elvex", "el", "el-business", "elvex-property", "elvexpropertyservices"];
const WILLIAM_E164 = "+447933229445";
const DAN_E164 = "+447932609444";

export async function runAdversarialSuite(input: {
  env?: Env;
  mode: AdversarialMode;
  includeTwentyTurn?: boolean;
  transport?: TransportLabel;
}): Promise<AdversarialRunResult> {
  const startedAt = new Date().toISOString();
  const transport: TransportLabel = input.transport ?? (input.mode === "persist" ? "GATED" : "OFFLINE");
  const tenants =
    input.mode === "persist" && input.env
      ? await resolveLiveTenants(input.env)
      : [offlineProfile("caddington"), offlineProfile("elvex")];

  const rows: AdversarialTurnCapture[] = [];
  const twentyTurn: Record<string, AdversarialTurnCapture[]> = {};

  for (const tenant of tenants) {
    const scenarios = instantiateScenarios(tenant.adapter);
    for (const scenario of scenarios) {
      const captured = await runScenario({
        env: input.env,
        mode: input.mode,
        tenant,
        scenario,
        transport,
      });
      rows.push(...captured);
    }
    if (input.includeTwentyTurn) {
      twentyTurn[tenant.tenant] = await runScript({
        env: input.env,
        mode: input.mode,
        tenant,
        texts: instantiateTwentyTurn(tenant.adapter),
        scenario: scenarios[0]!,
        transport,
        prefix: "adv20",
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const perTenant: Record<string, AdversarialSummary> = {};
  for (const tenant of tenants) {
    perTenant[tenant.tenant] = summariseCaptures(rows.filter((row) => row.tenant === tenant.tenant));
  }
  return {
    version: ADVERSARIAL_SUITE_VERSION,
    mode: input.mode,
    transport,
    startedAt,
    finishedAt,
    tenants,
    rows,
    summary: summariseCaptures(rows),
    perTenant,
    twentyTurn: input.includeTwentyTurn ? twentyTurn : undefined,
  };
}

async function runScenario(input: {
  env?: Env;
  mode: AdversarialMode;
  tenant: TenantProfile;
  scenario: AdversarialScenario;
  transport: TransportLabel;
}): Promise<AdversarialTurnCapture[]> {
  const texts = input.scenario.turns?.length ? input.scenario.turns : [input.scenario.text];
  return runScript({ ...input, texts, prefix: input.scenario.id });
}

async function runScript(input: {
  env?: Env;
  mode: AdversarialMode;
  tenant: TenantProfile;
  scenario: AdversarialScenario;
  texts: string[];
  transport: TransportLabel;
  prefix: string;
}): Promise<AdversarialTurnCapture[]> {
  const out: AdversarialTurnCapture[] = [];
  let memory = seedMemory(input.scenario.seed, input.tenant.adapter);
  const priorTurns: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (let i = 0; i < input.texts.length; i += 1) {
    const text = input.texts[i]!;
    const started = Date.now();
    let result;
    let toolError: string | null = null;
    if (input.mode === "persist" && input.env && input.tenant.userId) {
      const sessionUser = sessionFromTenant(input.tenant);
      const answer = await executeWhatsAppIntelligence(input.env, {
        companyId: input.tenant.companyId,
        sessionUser,
        originalText: text,
        memory,
        priorTurns,
        interactionId: `adv-${input.tenant.tenant}-${input.prefix}-${i}`,
        connectors: input.tenant.connectors,
      });
      result = answer.intelligence ?? {
        kind: answer.outcome === "clarification_requested" ? "clarify" : "answer",
        text: answer.reply,
        confidence: "partial" as const,
        offerSearchOther: false,
        toolCalls: answer.toolName
          ? [{ name: answer.toolName, ok: answer.outcome === "answered", latencyMs: answer.latencyMs, data: null }]
          : [],
        currentDocument: memory.lastDocument
          ? { id: memory.lastDocument.id, title: memory.lastDocument.title, url: memory.lastDocument.url }
          : null,
        evidenceDocumentIds: [],
        clarification: answer.outcome === "clarification_requested",
        citeSource: false,
        modelRounds: [],
        totalModelMs: 0,
        totalToolMs: 0,
        provider: "none" as const,
        model: null,
        estimatedCostUsd: 0,
        route: answer.plan.skipTools ? "FAST_LOCAL" : "INTELLIGENT",
        scope: undefined,
      };
      memory = answer.entities;
      toolError = answer.outcome === "tool_failed" ? "tool_failed" : null;
    } else {
      const state = stateFromMemory(text, input.tenant, memory, priorTurns);
      result = await runIntelligenceTurn({
        text,
        state,
        runtime: tenantAwareRuntime(input.tenant),
        completer: policyCompleter(),
        channel: "whatsapp",
      });
      if (result.currentDocument) {
        memory = {
          ...memory,
          lastDocument: {
            id: result.currentDocument.id,
            title: result.currentDocument.title,
            url: result.currentDocument.url ?? "",
            excerpt: result.text.slice(0, 200),
          },
          lastAnswerText: result.text,
          currentScope: result.scope ?? memory.currentScope,
          lastAnswerTopic: result.lastAnswerTopic ?? memory.lastAnswerTopic,
          lastUserIntent: result.lastUserIntent ?? memory.lastUserIntent,
          lastSuccessfulTool: result.toolCalls.find((call) => call.ok)?.name ?? memory.lastSuccessfulTool,
        };
      } else {
        memory = {
          ...memory,
          lastAnswerText: result.text,
          currentScope: result.scope ?? memory.currentScope,
          lastAnswerTopic: result.lastAnswerTopic ?? memory.lastAnswerTopic,
          lastUserIntent: result.lastUserIntent ?? memory.lastUserIntent,
        };
      }
    }
      priorTurns.push({ role: "user", text });
    priorTurns.push({ role: "assistant", text: result.text });
    out.push(
      scoreTurn({
        scenario: input.scenario,
        tenant: input.tenant.tenant,
        text,
        turnIndex: i,
        result,
        latencyMs: Date.now() - started || result.totalModelMs,
        transport: input.transport,
        permission: input.tenant.role,
        metered: input.mode === "persist",
        toolError: toolError,
      }),
    );
  }
  return out;
}

export async function resolveLiveTenants(env: Env): Promise<TenantProfile[]> {
  const companies = await env.DB.prepare(
    `SELECT id, name, slug, status FROM companies
     WHERE COALESCE(status, 'active') NOT IN ('suspended', 'closed', 'archived')
     ORDER BY name ASC`,
  )
    .all<{ id: string; name: string; slug: string; status: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; name: string; slug: string; status: string }> }));

  const rows = companies.results ?? [];
  const caddington = pickCompany(rows, CADDINGTON_SLUGS, /caddington/i);
  const elvex = pickCompany(rows, ELVEX_SLUGS, /elvex|^el\b/i);
  const profiles: TenantProfile[] = [];
  if (caddington) profiles.push(await hydrateTenant(env, "caddington", caddington));
  else profiles.push({ ...offlineProfile("caddington"), notes: ["company row not found in D1"] });
  if (elvex) profiles.push(await hydrateTenant(env, "elvex", elvex));
  else profiles.push({ ...offlineProfile("elvex"), notes: ["company row not found in D1"] });
  return profiles;
}

async function hydrateTenant(
  env: Env,
  tenant: "caddington" | "elvex",
  company: { id: string; name: string; slug: string },
): Promise<TenantProfile> {
  const notes: string[] = [];
  const users = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.mobile_e164, u.is_platform_admin, m.role
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ? AND m.status = 'active' AND u.status = 'active'
     ORDER BY CASE WHEN u.mobile_e164 IS NOT NULL AND u.mobile_e164 != '' THEN 0 ELSE 1 END,
              CASE WHEN m.role IN ('owner', 'admin') THEN 0 ELSE 1 END`,
  )
    .bind(company.id)
    .all<{
      id: string;
      email: string;
      display_name: string;
      mobile_e164: string | null;
      is_platform_admin: number;
      role: string;
    }>()
    .catch(() => ({ results: [] as Array<{ id: string; email: string; display_name: string; mobile_e164: string | null; is_platform_admin: number; role: string }> }));

  const candidates = users.results ?? [];
  let chosen = candidates.find((row) => normalizeE164(row.mobile_e164) === DAN_E164 && tenant === "caddington") ?? null;
  if (!chosen && tenant === "elvex") {
    const william = candidates.find((row) => normalizeE164(row.mobile_e164) === WILLIAM_E164);
    const directorWhatsApp = candidates.find(
      (row) =>
        row.mobile_e164 &&
        normalizeE164(row.mobile_e164) !== WILLIAM_E164 &&
        /director|company_admin|manager/i.test(row.role),
    );
    const otherWhatsApp = candidates.find(
      (row) => row.mobile_e164 && normalizeE164(row.mobile_e164) !== WILLIAM_E164,
    );
    chosen = directorWhatsApp ?? otherWhatsApp ?? candidates.find((row) => !row.mobile_e164) ?? null;
    if (william && !chosen) {
      notes.push("William is a member but is not treated as the Elvex WhatsApp UAT identity");
      chosen = william;
    }
    if (directorWhatsApp) {
      notes.push("Elvex persist identity is a WhatsApp-linked director/admin; no unsolicited Meta send");
    }
  }
  if (!chosen) chosen = candidates[0] ?? null;
  if (!chosen) notes.push("no active membership");

  const connectors = await listConnectedConnectorIds(env, company.id);
  const elAuthGap = tenant === "elvex" && !String(env.EL_MCP_AUTH_TOKEN ?? "").trim();
  if (elAuthGap) notes.push("EL_MCP_AUTH_TOKEN missing on infra-api — score as EL connector/auth gap");

  const adapter = await discoverAdapter(env, tenant, company.id, chosen);
  const mobile = chosen?.mobile_e164 ? normalizeE164(chosen.mobile_e164) : null;
  const whatsappAuthorised =
    tenant === "caddington"
      ? mobile === DAN_E164
      : Boolean(mobile && mobile !== WILLIAM_E164);
  if (tenant === "elvex" && !whatsappAuthorised) {
    notes.push("No authorised Elvex WhatsApp UAT identity distinct from the prior wrong-tenant probe; persist-inclusive only");
  }

  return {
    tenant,
    companyId: company.id,
    companyName: company.name,
    companySlug: company.slug,
    userId: chosen?.id ?? null,
    email: chosen?.email ?? null,
    displayName: chosen?.display_name ?? null,
    role: chosen?.role ?? null,
    mobileE164: mobile,
    whatsappAuthorised,
    connectors,
    adapter,
    elAuthGap,
    notes,
  };
}

async function discoverAdapter(
  env: Env,
  tenant: "caddington" | "elvex",
  companyId: string,
  user: { id: string; email: string; display_name: string; role: string } | null,
): Promise<TenantSubjectAdapter> {
  const fallback = FALLBACK_ADAPTERS[tenant];
  if (!user) return fallback;
  try {
    const titles = await env.DB.prepare(
      `SELECT title FROM knowledge_documents
       WHERE company_id = ? AND COALESCE(status, 'ready') NOT IN ('deleted', 'purged')
       ORDER BY updated_at DESC LIMIT 12`,
    )
      .bind(companyId)
      .all<{ title: string }>();
    const clean = (titles.results ?? [])
      .map((row) => String(row.title ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").trim())
      .filter((title) => title.length >= 4 && title.length <= 48);
    const unique = [...new Set(clean)];
    if (unique.length >= 2) {
      return {
        ...fallback,
        primary: unique[0]!.toLowerCase(),
        alt: unique[1]!.toLowerCase(),
        unknown: fallback.unknown,
        source: "live_index",
      };
    }
  } catch {
    // knowledge_documents may not exist or may be named differently — keep fallback subjects.
  }
  return fallback;
}

function pickCompany(
  rows: Array<{ id: string; name: string; slug: string }>,
  slugs: string[],
  nameRe: RegExp,
): { id: string; name: string; slug: string } | null {
  return (
    rows.find((row) => slugs.includes(String(row.slug ?? "").toLowerCase())) ??
    rows.find((row) => nameRe.test(`${row.name} ${row.slug}`)) ??
    null
  );
}

function offlineProfile(tenant: "caddington" | "elvex"): TenantProfile {
  const adapter = FALLBACK_ADAPTERS[tenant];
  return {
    tenant,
    companyId: tenant === "caddington" ? "co_caddington" : "co_elvex",
    companyName: tenant === "caddington" ? "Caddington" : "Elvex",
    companySlug: adapter.companySlug,
    userId: tenant === "caddington" ? "user_cadd_admin" : "user_elvex_admin",
    email: tenant === "caddington" ? "dan@example.test" : "ops@example.test",
    displayName: tenant === "caddington" ? "Dan Hold" : "Elvex Ops",
    role: "admin",
    mobileE164: tenant === "caddington" ? DAN_E164 : null,
    whatsappAuthorised: tenant === "caddington",
    connectors: ["conn_microsoft_365", "conn_xero", "conn_google_drive"],
    adapter,
    elAuthGap: false,
    notes: ["offline profile"],
  };
}

function sessionFromTenant(tenant: TenantProfile): SessionUser {
  return {
    userId: tenant.userId || `user_${tenant.tenant}`,
    email: tenant.email || `${tenant.tenant}@example.test`,
    displayName: tenant.displayName || tenant.companyName,
    isPlatformAdmin: false,
    memberships: [{ companyId: tenant.companyId, role: (tenant.role as SessionUser["memberships"][0]["role"]) || "company_admin" }],
  };
}

function seedMemory(seed: AdversarialScenario["seed"], adapter: TenantSubjectAdapter): WhatsAppEntityMemory {
  const primary = doc(adapter.primary, "doc_primary");
  const alt = doc(adapter.alt, "doc_alt");
  if (seed === "none") return emptyEntityMemory();
  if (seed === "primary_open") {
    return {
      lastDocument: primary,
      recentDocuments: [primary],
      lastAnswerText: `I have the ${adapter.primary} open.`,
      currentScope: "CURRENT_DOCUMENT",
      lastAnswerTopic: "document",
      lastUserIntent: "current_document",
    };
  }
  if (seed === "alt_open") {
    return {
      lastDocument: alt,
      recentDocuments: [alt],
      lastAnswerText: `I have the ${adapter.alt} open.`,
      currentScope: "CURRENT_DOCUMENT",
      lastAnswerTopic: "document",
      lastUserIntent: "current_document",
    };
  }
  if (seed === "primary_then_alt") {
    return {
      lastDocument: alt,
      recentDocuments: [primary],
      lastAnswerText: `I switched to the ${adapter.alt}.`,
      currentScope: "CURRENT_DOCUMENT",
      lastAnswerTopic: "document",
      lastUserIntent: "document_switch",
    };
  }
  if (seed === "index_then_followup") {
    return {
      lastAnswerText: "There are 12 indexed documents.",
      currentScope: "SYSTEM_META",
      lastAnswerTopic: "index_stats",
      lastUserIntent: "index_followup",
      lastSuccessfulTool: "get_document_index_stats",
    };
  }
  if (seed === "finance_then_followup") {
    return {
      lastAnswerText: "Sales this month are on the connected finance system.",
      currentScope: "BUSINESS_SYSTEM",
      currentBusinessSystem: "xero",
      lastAnswerTopic: "finance",
      lastUserIntent: "finance",
      lastSuccessfulTool: "xero_sales_summary",
    };
  }
  return emptyEntityMemory();
}

function doc(title: string, id: string) {
  return {
    id,
    title,
    url: `https://files.example.test/${id}`,
    excerpt: `${title} covers the recorded duties and dates.`,
  };
}

function stateFromMemory(
  text: string,
  tenant: TenantProfile,
  memory: WhatsAppEntityMemory,
  turns: Array<{ role: "user" | "assistant"; text: string }>,
) {
  const current: IntelligenceDocumentRef | null = memory.lastDocument
    ? { id: memory.lastDocument.id, title: memory.lastDocument.title, url: memory.lastDocument.url }
    : null;
  return buildConversationState({
    userText: text,
    currentDocument: current,
    entities: (memory.recentDocuments ?? []).map((row) => ({ id: row.id, title: row.title, url: row.url })),
    recentTurns: turns,
    companyId: tenant.companyId,
    companyName: tenant.companyName,
    role: tenant.role,
    connectors: tenant.connectors,
    permittedTools: [],
    currentScope: (memory.currentScope as never) ?? null,
    currentBusinessSystem: memory.currentBusinessSystem ?? null,
    lastSuccessfulTool: memory.lastSuccessfulTool ?? null,
    lastAnswerTopic: memory.lastAnswerTopic ?? null,
    lastUserIntent: memory.lastUserIntent ?? null,
    lastAnswerText: memory.lastAnswerText ?? null,
    userCorrection: /\b(not what i meant|wrong file)\b/i.test(text),
    recentDocuments: (memory.recentDocuments ?? []).map((row) => ({ id: row.id, title: row.title, url: row.url })),
  });
}

function tenantAwareRuntime(tenant: TenantProfile): IntelligenceRuntime {
  const base = mockedToolRuntime();
  return {
    async executeTool(call): Promise<IntelligenceToolResult> {
      if (tenant.elAuthGap && tenant.tenant === "elvex" && !call.name.startsWith("get_")) {
        return {
          name: call.name,
          ok: false,
          latencyMs: 4,
          data: { error: "EL_MCP_AUTH_TOKEN missing" },
          error: "EL_MCP_AUTH_TOKEN_missing",
        };
      }
      return base.executeTool(call);
    },
  };
}

function normalizeE164(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("44")) return `+${digits}`;
  if (digits.startsWith("0")) return `+44${digits.slice(1)}`;
  return `+${digits}`;
}

export function sanitizeReport(result: AdversarialRunResult): AdversarialRunResult {
  return {
    ...result,
    tenants: result.tenants.map((tenant) => ({
      ...tenant,
      email: tenant.email ? redactEmail(tenant.email) : null,
      mobileE164: tenant.mobileE164 ? redactMobile(tenant.mobileE164) : null,
    })),
    rows: result.rows.map((row) => ({
      ...row,
      reply: row.reply.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"),
    })),
  };
}

function redactEmail(email: string): string {
  const [user, host] = email.split("@");
  return `${(user ?? "u").slice(0, 2)}…@${host ?? "redacted"}`;
}

function redactMobile(e164: string): string {
  return `${e164.slice(0, 5)}…${e164.slice(-2)}`;
}

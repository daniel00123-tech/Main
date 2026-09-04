/**
 * EL Business commercial billing: £0.03 per genuine top-level customer request.
 *
 * Company-scoped to co_el. Caddington / HT / global TEST tool rules are unchanged.
 * Child tool/provider rows stay auditable and must not debit the wallet.
 */

import { newId, nowIso } from "../db/mappers";
import { appendLedgerEntry, getWalletBalance } from "./ledger";
import {
  calculateChargeCents,
  resolvePricingPolicy,
  resolvePricingRule,
} from "./pricing";
import {
  allocateDebitCreditClasses,
  consumePromotionalGrants,
} from "./promotional-grants";
import { markUsageSettled, recordUsageEvent } from "./usage";
import { persistInteraction, refreshInteractionTotals } from "./interactions";
import { companyUsesRequestLevelPricing } from "./customer-request-pricing";

export const EL_COMPANY_ID = "co_el";
export const EL_CUSTOMER_REQUEST_ACTION = "customer.request";
export const EL_CUSTOMER_REQUEST_PRICE_CENTS = 3;
export const EL_CUSTOMER_REQUEST_CURRENCY = "GBP";
export const EL_PRICING_POLICY_ID = "policy_el_customer_request";
export const EL_PRICING_RULE_ID = "price_el_customer_request";
export const EL_REQUEST_USAGE_PREFIX = "elreq_";
export const CHATGPT_TOOL_BURST_MS = 20_000;

export type ElTrafficClass =
  | "CUSTOMER_REQUEST"
  | "TEST"
  | "SHADOW"
  | "QUALITY"
  | "INTERNAL"
  | "AUTOMATION"
  | "HEALTH";

export type ElRequestChannel =
  | "whatsapp"
  | "portal_chat"
  | "chatgpt"
  | "claude"
  | "other";

export type ElSettleOutcome =
  | "completed"
  | "no_result"
  | "permission_denied"
  | "provider_failure"
  | "upstream_failure"
  | "accepted";

export type ElTrafficInput = {
  trafficClass?: string | null;
  sourceClient?: string | null;
  userAgent?: string | null;
  skipUsageRecording?: boolean;
  shadow?: boolean;
  automation?: boolean;
  health?: boolean;
  quality?: boolean;
  wamid?: string | null;
  chargeable?: boolean | null;
  actorEmail?: string | null;
  toolName?: string | null;
  action?: string | null;
};

export type ElCustomerRequestInput = {
  companyId: string;
  requestId: string;
  userId?: string | null;
  actorEmail?: string | null;
  sourceClient: string;
  channel?: ElRequestChannel | null;
  conversationId?: string | null;
  trafficClass?: ElTrafficClass | string | null;
  outcome?: ElSettleOutcome | string | null;
  summary?: string | null;
  metadata?: Record<string, unknown>;
};

export type ElSettleResult = {
  companyId: string;
  requestId: string;
  trafficClass: ElTrafficClass;
  charged: boolean;
  alreadySettled: boolean;
  skipped: boolean;
  reason: string;
  insufficientCredit: boolean;
  customerChargeCents: number;
  usageRecordId: string | null;
  ledgerEntryId: string | null;
  balanceBeforeCents: number | null;
  balanceAfterCents: number | null;
};

const TRUSTED_REQUEST_ID = /^(int|pint|creq)_[a-zA-Z0-9_-]{6,128}$/;

const INTERNAL_SOURCE_CLIENTS = new Set([
  "automation-engine",
  "automation-knowledge-ingestion",
  "quality_loop",
  "infra-document-catalogue",
  "infra-xero",
  "infra-outlook",
  "infra-ask-document",
  "infra-internal",
  "el-knowledge-onedrive-diagnostic",
  "e2e-probe",
  "health",
]);

export function isElCompany(companyId?: string | null): boolean {
  return companyId === EL_COMPANY_ID;
}

export function isLiveElBillingEnv(env?: { ENVIRONMENT?: string } | null): boolean {
  const value = String(env?.ENVIRONMENT ?? "").toLowerCase();
  return value === "production" || value === "prod";
}

export function isTrustedElRequestId(value?: string | null): boolean {
  return Boolean(value && TRUSTED_REQUEST_ID.test(value.trim()));
}

export function usageRequestIdForElRequest(requestId: string): string {
  return `${EL_REQUEST_USAGE_PREFIX}${requestId}`;
}

export function channelFromSourceClient(sourceClient?: string | null): ElRequestChannel {
  const source = String(sourceClient ?? "").toLowerCase();
  if (source === "whatsapp") return "whatsapp";
  if (source === "portal_chat" || source === "portal") return "portal_chat";
  if (source === "chatgpt") return "chatgpt";
  if (source === "claude") return "claude";
  return "other";
}

export function classifyElTraffic(input: ElTrafficInput): ElTrafficClass {
  if (input.chargeable === true) return "CUSTOMER_REQUEST";
  if (input.chargeable === false) return "TEST";

  const explicit = String(input.trafficClass ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (
    explicit === "CUSTOMER_REQUEST" ||
    explicit === "TEST" ||
    explicit === "SHADOW" ||
    explicit === "QUALITY" ||
    explicit === "INTERNAL" ||
    explicit === "AUTOMATION" ||
    explicit === "HEALTH"
  ) {
    return explicit;
  }

  if (input.shadow) return "SHADOW";
  if (input.quality) return "QUALITY";
  if (input.automation) return "AUTOMATION";
  if (input.health) return "HEALTH";
  if (input.skipUsageRecording) return "INTERNAL";

  const ua = input.userAgent ?? "";
  if (
    /InfraAcceptance|WhatsAppQA|QualityLoop|infra-health|ELBillingSuite/i.test(ua)
  ) {
    return "TEST";
  }

  const wamid = input.wamid ?? "";
  if (
    wamid.startsWith("wamid.uat.") ||
    wamid.startsWith("wamid.v42persist.") ||
    wamid.startsWith("wamid.test.")
  ) {
    return "TEST";
  }

  const source = String(input.sourceClient ?? "").toLowerCase();
  if (/shadow/.test(source)) return "SHADOW";
  if (/quality[_-]?loop|auditor/.test(source)) return "QUALITY";
  if (/automation/.test(source)) return "AUTOMATION";
  if (/health|probe/.test(source)) return "HEALTH";
  if (INTERNAL_SOURCE_CLIENTS.has(source) || /acceptance|diagnostic|internal/.test(source)) {
    return "INTERNAL";
  }

  const actor = input.actorEmail ?? "";
  if (/^system:|^svc_|acceptance|probe|quality-loop/i.test(actor)) return "INTERNAL";

  const action = `${input.action ?? ""} ${input.toolName ?? ""}`.toLowerCase();
  if (action.includes("system.health") || action.includes("system_health")) {
    return "HEALTH";
  }

  return "CUSTOMER_REQUEST";
}

export function shouldChargeElCustomerRequest(
  companyId: string | null | undefined,
  trafficClass: ElTrafficClass,
): boolean {
  return companyUsesRequestLevelPricing(companyId) && trafficClass === "CUSTOMER_REQUEST";
}

export function elChildUsageShouldDebit(): boolean {
  return false;
}

export function isElChildUsageRow(input: {
  companyId?: string | null;
  action?: string | null;
  parentRequestId?: string | null;
  customerChargeCents?: number | null;
}): boolean {
  if (!isElCompany(input.companyId)) return false;
  if (!input.parentRequestId) return false;
  if (input.action === EL_CUSTOMER_REQUEST_ACTION) return false;
  return (input.customerChargeCents ?? 0) === 0;
}

export async function ensureElCustomerPricing(db: D1Database): Promise<{
  policyId: string;
  ruleId: string;
  activatedAt: string;
  created: boolean;
}> {
  const now = nowIso();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS el_customer_requests (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        user_id TEXT,
        actor_email TEXT,
        channel TEXT NOT NULL,
        conversation_id TEXT,
        source_client TEXT,
        traffic_class TEXT NOT NULL,
        outcome TEXT,
        settled INTEGER NOT NULL DEFAULT 0,
        charge_cents INTEGER,
        usage_record_id TEXT,
        ledger_entry_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      )`,
    )
    .run()
    .catch(() => undefined);

  const existing = await db
    .prepare(`SELECT id, effective_from FROM pricing_policies WHERE id = ?`)
    .bind(EL_PRICING_POLICY_ID)
    .first<{ id: string; effective_from: string }>();

  await db
    .prepare(
      `INSERT OR IGNORE INTO pricing_policies (
        id, company_id, target_margin_bps, minimum_charge_cents, currency,
        is_test_config, enabled, label, effective_from, effective_to, created_at, updated_at
      ) VALUES (?, ?, 6000, ?, 'GBP', 0, 1, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      EL_PRICING_POLICY_ID,
      EL_COMPANY_ID,
      EL_CUSTOMER_REQUEST_PRICE_CENTS,
      "EL Business: £0.03 per customer request",
      existing?.effective_from ?? now,
      existing?.effective_from ?? now,
      now,
    )
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO pricing_rules (
        id, company_id, action, pricing_mode, fixed_charge_cents, markup_percent,
        minimum_charge_cents, charge_on_failure, is_billable, label, is_test_config,
        enabled, created_at, updated_at, target_margin_bps, version_label, effective_from
      ) VALUES (?, ?, ?, 'fixed', ?, NULL, ?, 1, 1, ?, 0, 1, ?, ?, 6000, 'el-request-v1', ?)`,
    )
    .bind(
      EL_PRICING_RULE_ID,
      EL_COMPANY_ID,
      EL_CUSTOMER_REQUEST_ACTION,
      EL_CUSTOMER_REQUEST_PRICE_CENTS,
      EL_CUSTOMER_REQUEST_PRICE_CENTS,
      "EL Business: 3p per genuine customer request",
      existing?.effective_from ?? now,
      now,
      existing?.effective_from ?? now,
    )
    .run();

  const policy = await db
    .prepare(`SELECT effective_from FROM pricing_policies WHERE id = ?`)
    .bind(EL_PRICING_POLICY_ID)
    .first<{ effective_from: string }>();

  return {
    policyId: EL_PRICING_POLICY_ID,
    ruleId: EL_PRICING_RULE_ID,
    activatedAt: String(policy?.effective_from ?? existing?.effective_from ?? now),
    created: !existing,
  };
}

export async function resolveElCustomerRequestId(
  db: D1Database,
  input: {
    companyId: string;
    userId?: string | null;
    sourceClient: string;
    explicitId?: string | null;
    interactionId?: string | null;
    parentRequestId?: string | null;
    conversationId?: string | null;
    mcpSessionId?: string | null;
    trafficClass: ElTrafficClass;
    nowMs?: number;
  },
): Promise<{ requestId: string; reused: boolean }> {
  const explicit =
    cleanRequestId(input.explicitId) ??
    cleanRequestId(input.parentRequestId) ??
    (isTrustedElRequestId(input.interactionId) ? input.interactionId!.trim() : null);
  if (explicit) {
    await touchElCustomerRequest(db, {
      requestId: explicit,
      companyId: input.companyId,
      userId: input.userId,
      sourceClient: input.sourceClient,
      conversationId: input.conversationId,
      trafficClass: input.trafficClass,
    });
    return { requestId: explicit, reused: false };
  }

  const channel = channelFromSourceClient(input.sourceClient);
  const nowMs = input.nowMs ?? Date.now();
  const conversationKey = input.conversationId?.trim() || input.mcpSessionId?.trim() || null;

  if (channel === "chatgpt" && conversationKey) {
    const latest = await db
      .prepare(
        `SELECT id, last_activity_at FROM el_customer_requests
         WHERE company_id = ? AND channel = 'chatgpt'
           AND conversation_id = ?
           AND (? IS NULL OR user_id = ?)
         ORDER BY last_activity_at DESC LIMIT 1`,
      )
      .bind(input.companyId, conversationKey, input.userId ?? null, input.userId ?? null)
      .first<{ id: string; last_activity_at: string }>();
    if (latest) {
      const last = Date.parse(String(latest.last_activity_at));
      if (Number.isFinite(last) && nowMs - last <= CHATGPT_TOOL_BURST_MS) {
        await db
          .prepare(
            `UPDATE el_customer_requests SET last_activity_at = ? WHERE id = ?`,
          )
          .bind(new Date(nowMs).toISOString(), latest.id)
          .run();
        return { requestId: String(latest.id), reused: true };
      }
    }
  }

  const requestId = newId("creq");
  await touchElCustomerRequest(db, {
    requestId,
    companyId: input.companyId,
    userId: input.userId,
    sourceClient: input.sourceClient,
    conversationId: conversationKey,
    trafficClass: input.trafficClass,
    createdAt: new Date(nowMs).toISOString(),
  });
  return { requestId, reused: false };
}

export async function checkElCustomerRequestCredit(
  db: D1Database,
  companyId: string,
): Promise<{ ok: boolean; balanceCents: number; requiredCents: number }> {
  const wallet = await getWalletBalance(db, companyId);
  return {
    ok: wallet.balanceCents >= EL_CUSTOMER_REQUEST_PRICE_CENTS,
    balanceCents: wallet.balanceCents,
    requiredCents: EL_CUSTOMER_REQUEST_PRICE_CENTS,
  };
}

export async function settleElCustomerRequest(
  db: D1Database,
  input: ElCustomerRequestInput,
): Promise<ElSettleResult> {
  const trafficClass = classifyElTraffic({
    trafficClass: input.trafficClass,
    sourceClient: input.sourceClient,
    actorEmail: input.actorEmail,
  });
  const requestId = input.requestId.trim();
  const empty: ElSettleResult = {
    companyId: input.companyId,
    requestId,
    trafficClass,
    charged: false,
    alreadySettled: false,
    skipped: true,
    reason: "not_chargeable",
    insufficientCredit: false,
    customerChargeCents: 0,
    usageRecordId: null,
    ledgerEntryId: null,
    balanceBeforeCents: null,
    balanceAfterCents: null,
  };

  if (!isElCompany(input.companyId)) {
    return { ...empty, reason: "not_el_company" };
  }
  if (!shouldChargeElCustomerRequest(input.companyId, trafficClass)) {
    return { ...empty, reason: `traffic_class_${trafficClass}` };
  }
  if (!requestId) {
    return { ...empty, reason: "missing_request_id" };
  }

  await ensureElCustomerPricing(db);
  const usageKey = usageRequestIdForElRequest(requestId);
  const existingUsage = await db
    .prepare(`SELECT id, ledger_entry_id, customer_charge_cents FROM usage_records WHERE request_id = ? LIMIT 1`)
    .bind(usageKey)
    .first<{ id: string; ledger_entry_id: string | null; customer_charge_cents: number | null }>();
  if (existingUsage) {
    const wallet = await getWalletBalance(db, input.companyId);
    return {
      companyId: input.companyId,
      requestId,
      trafficClass,
      charged: false,
      alreadySettled: true,
      skipped: false,
      reason: "already_settled",
      insufficientCredit: false,
      customerChargeCents: Number(existingUsage.customer_charge_cents ?? EL_CUSTOMER_REQUEST_PRICE_CENTS),
      usageRecordId: String(existingUsage.id),
      ledgerEntryId: existingUsage.ledger_entry_id ? String(existingUsage.ledger_entry_id) : null,
      balanceBeforeCents: wallet.balanceCents,
      balanceAfterCents: wallet.balanceCents,
    };
  }

  const credit = await checkElCustomerRequestCredit(db, input.companyId);
  if (!credit.ok) {
    return {
      ...empty,
      skipped: false,
      reason: "insufficient_credit",
      insufficientCredit: true,
      customerChargeCents: EL_CUSTOMER_REQUEST_PRICE_CENTS,
      balanceBeforeCents: credit.balanceCents,
      balanceAfterCents: credit.balanceCents,
    };
  }

  const policy = await resolvePricingPolicy(db, input.companyId);
  const rule = await resolvePricingRule(db, input.companyId, EL_CUSTOMER_REQUEST_ACTION);
  const charge = calculateChargeCents(rule, {
    success: true,
    underlyingCostCents: null,
    costBasis: "unknown",
    policy,
  });
  const chargeCents = charge.customerChargeCents ?? EL_CUSTOMER_REQUEST_PRICE_CENTS;
  const channel = input.channel ?? channelFromSourceClient(input.sourceClient);
  const sourceClient = input.sourceClient || channel;

  await persistInteraction(db, {
    id: requestId,
    companyId: input.companyId,
    actorType: input.userId ? "user" : "service",
    actorId: input.userId ?? input.actorEmail ?? "el-customer",
    clientKind: sourceClient,
    label: input.summary ?? "Customer request",
    sourcedFrom: "generated",
  }).catch(() => undefined);

  const usage = await recordUsageEvent(db, {
    companyId: input.companyId,
    userId: input.userId ?? null,
    actorEmail: input.actorEmail ?? null,
    resourceType: "customer_request",
    resourceId: requestId,
    toolName: EL_CUSTOMER_REQUEST_ACTION,
    action: EL_CUSTOMER_REQUEST_ACTION,
    quantity: 1,
    unit: "customer_request",
    success: input.outcome !== "provider_failure" && input.outcome !== "upstream_failure",
    sourceClient,
    requestId: usageKey,
    interactionId: requestId,
    parentRequestId: requestId,
    charge,
    customerChargeCents: chargeCents,
    settlementStatus: "unsettled",
    metadata: {
      trafficClass,
      channel,
      outcome: input.outcome ?? "accepted",
      summary: input.summary ?? null,
      conversationId: input.conversationId ?? null,
      pricingPolicyId: EL_PRICING_POLICY_ID,
      commercialModel: "el_customer_request_3p",
      ...(input.metadata ?? {}),
    },
  });

  if (usage.alreadyExists) {
    const wallet = await getWalletBalance(db, input.companyId);
    return {
      companyId: input.companyId,
      requestId,
      trafficClass,
      charged: false,
      alreadySettled: true,
      skipped: false,
      reason: "already_settled",
      insufficientCredit: false,
      customerChargeCents: chargeCents,
      usageRecordId: usage.id,
      ledgerEntryId: null,
      balanceBeforeCents: wallet.balanceCents,
      balanceAfterCents: wallet.balanceCents,
    };
  }

  const balanceBefore = await getWalletBalance(db, input.companyId);
  let allocation = { promotionalCents: 0, paidCents: chargeCents };
  try {
    allocation = await allocateDebitCreditClasses(db, input.companyId, chargeCents);
  } catch {
    allocation = { promotionalCents: 0, paidCents: chargeCents };
  }

  const ledger = await appendLedgerEntry(db, {
    companyId: input.companyId,
    entryType: "usage_debit",
    amountCents: -chargeCents,
    referenceType: "el_customer_request",
    referenceId: requestId,
    description: `${humanChannel(sourceClient)} · Customer request`,
    metadata: {
      interactionId: requestId,
      parentRequestId: requestId,
      trafficClass,
      channel,
      pricingLabel: charge.pricingLabel,
      pricingRuleId: charge.pricingRuleId,
      balanceBeforeCents: balanceBefore.balanceCents,
      promotionalCentsUsed: allocation.promotionalCents,
      paidCentsUsed: allocation.paidCents,
      commercialModel: "el_customer_request_3p",
    },
    createdBy: input.actorEmail ?? "el-customer-billing",
  });

  if (ledger.alreadyExists) {
    await markUsageSettled(db, usage.id, ledger.entry.id).catch(() => undefined);
    return {
      companyId: input.companyId,
      requestId,
      trafficClass,
      charged: false,
      alreadySettled: true,
      skipped: false,
      reason: "already_settled",
      insufficientCredit: false,
      customerChargeCents: chargeCents,
      usageRecordId: usage.id,
      ledgerEntryId: ledger.entry.id,
      balanceBeforeCents: balanceBefore.balanceCents,
      balanceAfterCents: ledger.entry.balanceAfterCents,
    };
  }

  if (allocation.promotionalCents > 0) {
    await consumePromotionalGrants(db, input.companyId, allocation.promotionalCents).catch(
      () => undefined,
    );
  }
  await markUsageSettled(db, usage.id, ledger.entry.id);
  await refreshInteractionTotals(db, requestId).catch(() => undefined);
  await touchElCustomerRequest(db, {
    requestId,
    companyId: input.companyId,
    userId: input.userId,
    actorEmail: input.actorEmail,
    sourceClient,
    conversationId: input.conversationId,
    trafficClass,
    settled: true,
    chargeCents,
    usageRecordId: usage.id,
    ledgerEntryId: ledger.entry.id,
    outcome: input.outcome ?? "accepted",
  });

  return {
    companyId: input.companyId,
    requestId,
    trafficClass,
    charged: true,
    alreadySettled: false,
    skipped: false,
    reason: "settled",
    insufficientCredit: false,
    customerChargeCents: chargeCents,
    usageRecordId: usage.id,
    ledgerEntryId: ledger.entry.id,
    balanceBeforeCents: balanceBefore.balanceCents,
    balanceAfterCents: ledger.entry.balanceAfterCents,
  };
}

export async function recordElChildUsage(
  db: D1Database,
  input: {
    companyId: string;
    parentRequestId: string;
    userId?: string | null;
    actorEmail?: string | null;
    sourceClient: string;
    toolName?: string | null;
    action?: string | null;
    success?: boolean;
    durationMs?: number | null;
    requestId?: string | null;
    correlationId?: string | null;
    underlyingCostCents?: number | null;
    underlyingCostMicros?: number | null;
    costBasis?: "actual" | "estimated" | "unknown";
    settlementStatus?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  return recordUsageEvent(db, {
    companyId: input.companyId,
    userId: input.userId ?? null,
    actorEmail: input.actorEmail ?? null,
    resourceType: "gateway",
    resourceId: input.toolName ?? input.action ?? null,
    toolName: input.toolName ?? null,
    action: input.action ?? null,
    success: input.success !== false,
    durationMs: input.durationMs ?? null,
    sourceClient: input.sourceClient,
    requestId: input.requestId ?? null,
    correlationId: input.correlationId ?? null,
    interactionId: input.parentRequestId,
    parentRequestId: input.parentRequestId,
    customerChargeCents: null,
    underlyingCostCents: input.underlyingCostCents ?? null,
    settlementStatus: input.settlementStatus ?? "zero_charge",
    charge: {
      billable: false,
      customerChargeCents: null,
      calculatedSellingCents: null,
      minimumChargeApplied: false,
      underlyingCostCents: input.underlyingCostCents ?? null,
      underlyingCostMicros: input.underlyingCostMicros ?? null,
      estimatedCostMicros: null,
      costBasis: input.costBasis ?? "unknown",
      targetMarginBps: null,
      actualMarginBps: null,
      grossProfitCents: null,
      pricingLabel: "el_child_observability",
      pricingRuleId: null,
      rateCardId: null,
      rateCardVersion: null,
      isTestConfig: false,
    },
    metadata: {
      parentRequestId: input.parentRequestId,
      commercialSettlement: "parent_customer_request",
      ...(input.metadata ?? {}),
    },
  });
}

function cleanRequestId(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0") return null;
  return isTrustedElRequestId(trimmed) ? trimmed : null;
}

function humanChannel(source: string): string {
  switch (source) {
    case "whatsapp":
      return "WhatsApp";
    case "portal_chat":
    case "portal":
      return "Portal Chat";
    case "chatgpt":
      return "ChatGPT";
    default:
      return source;
  }
}

async function touchElCustomerRequest(
  db: D1Database,
  input: {
    requestId: string;
    companyId: string;
    userId?: string | null;
    actorEmail?: string | null;
    sourceClient: string;
    conversationId?: string | null;
    trafficClass: ElTrafficClass;
    settled?: boolean;
    chargeCents?: number;
    usageRecordId?: string | null;
    ledgerEntryId?: string | null;
    outcome?: string | null;
    createdAt?: string;
  },
) {
  const now = input.createdAt ?? nowIso();
  const channel = channelFromSourceClient(input.sourceClient);
  await db
    .prepare(
      `INSERT INTO el_customer_requests (
         id, company_id, user_id, actor_email, channel, conversation_id, source_client,
         traffic_class, outcome, settled, charge_cents, usage_record_id, ledger_entry_id,
         created_at, last_activity_at, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
       ON CONFLICT(id) DO UPDATE SET
         last_activity_at = excluded.last_activity_at,
         settled = CASE WHEN excluded.settled = 1 THEN 1 ELSE el_customer_requests.settled END,
         charge_cents = COALESCE(excluded.charge_cents, el_customer_requests.charge_cents),
         usage_record_id = COALESCE(excluded.usage_record_id, el_customer_requests.usage_record_id),
         ledger_entry_id = COALESCE(excluded.ledger_entry_id, el_customer_requests.ledger_entry_id),
         outcome = COALESCE(excluded.outcome, el_customer_requests.outcome)`,
    )
    .bind(
      input.requestId,
      input.companyId,
      input.userId ?? null,
      input.actorEmail ?? null,
      channel,
      input.conversationId ?? null,
      input.sourceClient,
      input.trafficClass,
      input.outcome ?? null,
      input.settled ? 1 : 0,
      input.chargeCents ?? null,
      input.usageRecordId ?? null,
      input.ledgerEntryId ?? null,
      now,
      now,
    )
    .run()
    .catch(() => undefined);
}

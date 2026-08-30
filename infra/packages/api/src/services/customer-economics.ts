import { AZURE_READ_USD_PER_PAGE } from "@infra/shared";

/** Published Stripe UK standard card rate — used only as an estimate. */
export const STRIPE_UK_PERCENT_BPS = 150;
export const STRIPE_UK_FIXED_CENTS = 20;

/** Conservative GBP per USD used only when converting estimated Azure USD. */
export const DEFAULT_USD_GBP_RATE = 0.79;

export type EconomicsPeriodPreset = "current_month" | "previous_month" | "custom";

export type CostClassification =
  | "ocr"
  | "ai_model"
  | "stripe_fees"
  | "cloudflare"
  | "other";

export type CostBasisLabel = "actual" | "estimated" | "unknown";

export interface DateRange {
  from: string;
  to: string;
  preset: EconomicsPeriodPreset;
}

export interface EconomicsFilters {
  companyId?: string;
  provider?: string;
  service?: string;
  from?: string;
  to?: string;
  preset?: EconomicsPeriodPreset;
}

export interface CompanyEconomicsRow {
  companyId: string;
  companyName: string;
  companySlug: string;
  cashCollectedCents: number;
  usageChargeCents: number;
  creditsRefundsCents: number;
  revenueCents: number;
  revenueBasis: "usage_charges";
  cashBasisNote: string;
  directCostCents: number;
  directCostKnown: boolean;
  grossProfitCents: number | null;
  grossMarginPercent: number | null;
  activeUsers: number;
  costPerActiveUserCents: number | null;
  revenuePerActiveUserCents: number | null;
  ocrCostCents: number;
  aiModelCostCents: number;
  cloudflareCostCents: number;
  stripeFeeCents: number;
  otherAttributableCostCents: number;
  unattributedCostCents: number;
  period: DateRange;
}

export interface UserEconomicsRow {
  userId: string | null;
  actorLabel: string;
  attributed: boolean;
  usageCount: number;
  interactionCount: number;
  usageChargeCents: number;
  directCostCents: number;
  providers: string[];
  features: string[];
}

export interface ProviderCostBreakdown {
  provider: string;
  service: string;
  classification: CostClassification;
  costBasis: CostBasisLabel;
  usageQuantity: number;
  usageUnit: string;
  costCents: number;
  eventCount: number;
}

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function resolveEconomicsPeriod(
  filters: EconomicsFilters,
  now = new Date(),
): DateRange {
  const preset = filters.preset ?? (filters.from && filters.to ? "custom" : "current_month");
  if (preset === "custom" && filters.from && filters.to) {
    return { from: filters.from, to: filters.to, preset };
  }
  if (preset === "previous_month") {
    const startThis = startOfUtcMonth(now);
    const startPrev = new Date(Date.UTC(startThis.getUTCFullYear(), startThis.getUTCMonth() - 1, 1));
    return {
      from: startPrev.toISOString(),
      to: startThis.toISOString(),
      preset,
    };
  }
  return {
    from: startOfUtcMonth(now).toISOString(),
    to: now.toISOString(),
    preset: "current_month",
  };
}

export function estimateStripeFeeCents(grossAmountCents: number): number {
  if (!Number.isFinite(grossAmountCents) || grossAmountCents <= 0) return 0;
  return Math.round((grossAmountCents * STRIPE_UK_PERCENT_BPS) / 10000) + STRIPE_UK_FIXED_CENTS;
}

export function usdToGbpCents(usd: number, gbpPerUsd = DEFAULT_USD_GBP_RATE): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * gbpPerUsd * 100);
}

export function ocrCostCentsFromUsage(input: {
  quantity?: number | null;
  unit?: string | null;
  metadata?: Record<string, unknown>;
  underlyingCostCents?: number | null;
  estimatedCostMicros?: number | null;
}): { cents: number; basis: CostBasisLabel } {
  if (input.underlyingCostCents != null && Number.isFinite(input.underlyingCostCents)) {
    return { cents: Math.round(input.underlyingCostCents), basis: "actual" };
  }
  if (input.estimatedCostMicros != null && Number.isFinite(input.estimatedCostMicros)) {
    return { cents: Math.round(input.estimatedCostMicros / 10_000), basis: "estimated" };
  }
  const estimatedUsd = Number(input.metadata?.estimatedUsd);
  if (Number.isFinite(estimatedUsd) && estimatedUsd > 0) {
    return { cents: usdToGbpCents(estimatedUsd), basis: "estimated" };
  }
  const pages =
    input.unit === "pages" && Number(input.quantity) > 0
      ? Number(input.quantity)
      : Number(input.metadata?.pageCount ?? 0);
  if (pages > 0) {
    return { cents: usdToGbpCents(pages * AZURE_READ_USD_PER_PAGE), basis: "estimated" };
  }
  return { cents: 0, basis: "unknown" };
}

export function classifyUsageResource(input: {
  resourceType?: string | null;
  toolName?: string | null;
  action?: string | null;
  unit?: string | null;
}): { classification: CostClassification; provider: string; service: string } {
  const resource = String(input.resourceType ?? "").toLowerCase();
  const tool = String(input.toolName ?? "").toLowerCase();
  const action = String(input.action ?? "").toLowerCase();
  const hay = `${resource} ${tool} ${action} ${input.unit ?? ""}`;

  if (resource === "knowledge_ocr" || hay.includes("ocr") || hay.includes("document_intelligence")) {
    return { classification: "ocr", provider: "azure", service: "document_intelligence" };
  }
  if (hay.includes("openai") || hay.includes("anthropic") || hay.includes("model") || hay.includes("token")) {
    return { classification: "ai_model", provider: "ai", service: "model" };
  }
  if (hay.includes("cloudflare") || hay.includes("workers") || hay.includes("r2") || hay.includes("vectorize")) {
    return { classification: "cloudflare", provider: "cloudflare", service: "platform" };
  }
  if (hay.includes("stripe")) {
    return { classification: "stripe_fees", provider: "stripe", service: "payments" };
  }
  if (resource === "whatsapp" || hay.includes("whatsapp")) {
    if (hay.includes("conversation") || action.includes("whatsapp.conversation") || action.includes("whatsapp.ack")) {
      return { classification: "other", provider: "infra", service: "whatsapp_conversation" };
    }
    if (hay.includes("tool_mcp") || hay.includes("search_company") || hay.includes("xero_")) {
      return { classification: "other", provider: "infra", service: "whatsapp_tool_mcp" };
    }
    return { classification: "other", provider: "meta", service: "whatsapp_transport" };
  }
  return { classification: "other", provider: resource || "unknown", service: tool || action || resource || "usage" };
}

export function attributableCostCents(input: {
  costBasis?: string | null;
  underlyingCostCents?: number | null;
  estimatedCostMicros?: number | null;
  classification: CostClassification;
  quantity?: number | null;
  unit?: string | null;
  metadata?: Record<string, unknown>;
}): { cents: number; basis: CostBasisLabel } {
  if (input.classification === "ocr") {
    return ocrCostCentsFromUsage(input);
  }
  if (input.costBasis === "actual" && input.underlyingCostCents != null) {
    return { cents: Math.round(input.underlyingCostCents), basis: "actual" };
  }
  if (input.costBasis === "estimated") {
    if (input.underlyingCostCents != null) {
      return { cents: Math.round(input.underlyingCostCents), basis: "estimated" };
    }
    if (input.estimatedCostMicros != null) {
      return { cents: Math.round(input.estimatedCostMicros / 10_000), basis: "estimated" };
    }
  }
  return { cents: 0, basis: input.costBasis === "unknown" ? "unknown" : "unknown" };
}

export function computeMargin(revenueCents: number, directCostCents: number): {
  grossProfitCents: number;
  grossMarginPercent: number | null;
} {
  const grossProfitCents = revenueCents - directCostCents;
  if (revenueCents <= 0) {
    return { grossProfitCents, grossMarginPercent: null };
  }
  return {
    grossProfitCents,
    grossMarginPercent: Math.round((grossProfitCents / revenueCents) * 10000) / 100,
  };
}

export function perActiveUser(amountCents: number, activeUsers: number): number | null {
  if (activeUsers <= 0) return null;
  return Math.round(amountCents / activeUsers);
}

type UsageAggRow = {
  company_id: string;
  company_name: string;
  company_slug: string;
  user_id: string | null;
  actor_email: string | null;
  resource_type: string | null;
  tool_name: string | null;
  action: string | null;
  unit: string | null;
  quantity: number | null;
  customer_charge_cents: number | null;
  underlying_cost_cents: number | null;
  estimated_cost_micros: number | null;
  cost_basis: string | null;
  metadata_json: string | null;
  interaction_id: string | null;
  recorded_at: string;
};

function parseMetadata(raw: string | null): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function matchesProviderFilter(
  classified: { provider: string; service: string; classification: CostClassification },
  filters: EconomicsFilters,
): boolean {
  if (filters.provider && classified.provider !== filters.provider && classified.classification !== filters.provider) {
    return false;
  }
  if (filters.service && classified.service !== filters.service && classified.classification !== filters.service) {
    return false;
  }
  return true;
}

export async function listCustomerEconomics(
  db: D1Database,
  filters: EconomicsFilters = {},
): Promise<{ period: DateRange; companies: CompanyEconomicsRow[] }> {
  const period = resolveEconomicsPeriod(filters);
  const companies = await db
    .prepare(
      `SELECT id, name, slug FROM companies
       WHERE (? IS NULL OR id = ?)
       ORDER BY name ASC`,
    )
    .bind(filters.companyId ?? null, filters.companyId ?? null)
    .all<{ id: string; name: string; slug: string }>();

  const usage = await db
    .prepare(
      `SELECT u.company_id, c.name AS company_name, c.slug AS company_slug,
              u.user_id, u.actor_email, u.resource_type, u.tool_name, u.action,
              u.unit, u.quantity, u.customer_charge_cents, u.underlying_cost_cents,
              u.estimated_cost_micros, u.cost_basis, u.metadata_json, u.interaction_id,
              u.recorded_at
       FROM usage_records u
       JOIN companies c ON c.id = u.company_id
       WHERE u.recorded_at >= ? AND u.recorded_at < ?
         AND (? IS NULL OR u.company_id = ?)`,
    )
    .bind(period.from, period.to, filters.companyId ?? null, filters.companyId ?? null)
    .all<UsageAggRow>();

  const ledger = await db
    .prepare(
      `SELECT company_id, entry_type, amount_cents
       FROM ledger_entries
       WHERE created_at >= ? AND created_at < ?
         AND (? IS NULL OR company_id = ?)`,
    )
    .bind(period.from, period.to, filters.companyId ?? null, filters.companyId ?? null)
    .all<{ company_id: string; entry_type: string; amount_cents: number }>();

  const stripe = await db
    .prepare(
      `SELECT company_id, amount_cents, status
       FROM stripe_checkout_sessions
       WHERE COALESCE(credited_at, completed_at, created_at) >= ?
         AND COALESCE(credited_at, completed_at, created_at) < ?
         AND status IN ('credited', 'completed', 'paid')
         AND (? IS NULL OR company_id = ?)`,
    )
    .bind(period.from, period.to, filters.companyId ?? null, filters.companyId ?? null)
    .all<{ company_id: string; amount_cents: number; status: string }>();

  const byCompany = new Map<string, CompanyEconomicsRow>();
  for (const company of companies.results ?? []) {
    byCompany.set(company.id, emptyCompanyRow(company, period));
  }

  for (const row of usage.results ?? []) {
    const classified = classifyUsageResource(row);
    if (!matchesProviderFilter(classified, filters)) continue;
    const current = byCompany.get(row.company_id) ?? emptyCompanyRow({
      id: row.company_id,
      name: row.company_name,
      slug: row.company_slug,
    }, period);
    const cost = attributableCostCents({
      ...row,
      classification: classified.classification,
      metadata: parseMetadata(row.metadata_json),
    });
    current.usageChargeCents += Number(row.customer_charge_cents ?? 0);
    current.directCostCents += cost.cents;
    if (cost.basis !== "unknown" && cost.cents > 0) current.directCostKnown = true;
    if (classified.classification === "ocr") current.ocrCostCents += cost.cents;
    else if (classified.classification === "ai_model") current.aiModelCostCents += cost.cents;
    else if (classified.classification === "cloudflare") current.cloudflareCostCents += cost.cents;
    else current.otherAttributableCostCents += cost.cents;
    if (!row.user_id) current.unattributedCostCents += cost.cents;
    byCompany.set(row.company_id, current);
  }

  for (const row of ledger.results ?? []) {
    const current = byCompany.get(row.company_id);
    if (!current) continue;
    const amount = Number(row.amount_cents ?? 0);
    if (row.entry_type === "top_up") current.cashCollectedCents += amount;
    if (
      row.entry_type === "refund" ||
      row.entry_type === "manual_credit" ||
      row.entry_type === "promotional_credit" ||
      row.entry_type === "adjustment"
    ) {
      current.creditsRefundsCents += amount;
    }
  }

  for (const row of stripe.results ?? []) {
    const current = byCompany.get(row.company_id);
    if (!current) continue;
    const fee = estimateStripeFeeCents(Number(row.amount_cents ?? 0));
    current.stripeFeeCents += fee;
    current.directCostCents += fee;
    current.directCostKnown = true;
    current.unattributedCostCents += fee;
  }

  const activeUsers = await db
    .prepare(
      `SELECT company_id, COUNT(DISTINCT COALESCE(user_id, actor_email)) AS active_users
       FROM usage_records
       WHERE recorded_at >= ? AND recorded_at < ?
         AND success = 1
         AND (? IS NULL OR company_id = ?)
       GROUP BY company_id`,
    )
    .bind(period.from, period.to, filters.companyId ?? null, filters.companyId ?? null)
    .all<{ company_id: string; active_users: number }>();

  for (const row of activeUsers.results ?? []) {
    const current = byCompany.get(row.company_id);
    if (current) current.activeUsers = Number(row.active_users ?? 0);
  }

  const companiesOut = [...byCompany.values()].map((row) => {
    row.revenueCents = row.usageChargeCents;
    const margin = computeMargin(row.revenueCents, row.directCostCents);
    row.grossProfitCents = margin.grossProfitCents;
    row.grossMarginPercent = margin.grossMarginPercent;
    row.costPerActiveUserCents = perActiveUser(row.directCostCents, row.activeUsers);
    row.revenuePerActiveUserCents = perActiveUser(row.revenueCents, row.activeUsers);
    return row;
  });

  return { period, companies: companiesOut };
}

export async function getCompanyEconomicsDetail(
  db: D1Database,
  companyId: string,
  filters: EconomicsFilters = {},
): Promise<{
  period: DateRange;
  company: CompanyEconomicsRow | null;
  providers: ProviderCostBreakdown[];
  users: UserEconomicsRow[];
  trend: Array<{ day: string; revenueCents: number; directCostCents: number }>;
}> {
  const { period, companies } = await listCustomerEconomics(db, { ...filters, companyId });
  const company = companies[0] ?? null;
  if (!company) {
    return { period, company: null, providers: [], users: [], trend: [] };
  }

  const usage = await db
    .prepare(
      `SELECT user_id, actor_email, resource_type, tool_name, action, unit, quantity,
              customer_charge_cents, underlying_cost_cents, estimated_cost_micros,
              cost_basis, metadata_json, interaction_id, recorded_at
       FROM usage_records
       WHERE company_id = ? AND recorded_at >= ? AND recorded_at < ?`,
    )
    .bind(companyId, period.from, period.to)
    .all<UsageAggRow>();

  const stripe = await db
    .prepare(
      `SELECT amount_cents, COALESCE(credited_at, completed_at, created_at) AS at
       FROM stripe_checkout_sessions
       WHERE company_id = ?
         AND COALESCE(credited_at, completed_at, created_at) >= ?
         AND COALESCE(credited_at, completed_at, created_at) < ?
         AND status IN ('credited', 'completed', 'paid')`,
    )
    .bind(companyId, period.from, period.to)
    .all<{ amount_cents: number; at: string }>();

  const providerMap = new Map<string, ProviderCostBreakdown>();
  const userMap = new Map<string, UserEconomicsRow & { interactions: Set<string> }>();
  const trendMap = new Map<string, { day: string; revenueCents: number; directCostCents: number }>();

  for (const row of usage.results ?? []) {
    const classified = classifyUsageResource(row);
    if (!matchesProviderFilter(classified, filters)) continue;
    const cost = attributableCostCents({
      ...row,
      classification: classified.classification,
      metadata: parseMetadata(row.metadata_json),
    });
    const key = `${classified.provider}:${classified.service}:${classified.classification}`;
    const existing = providerMap.get(key) ?? {
      provider: classified.provider,
      service: classified.service,
      classification: classified.classification,
      costBasis: cost.basis,
      usageQuantity: 0,
      usageUnit: row.unit ?? "request",
      costCents: 0,
      eventCount: 0,
    };
    existing.usageQuantity += Number(row.quantity ?? 1);
    existing.costCents += cost.cents;
    existing.eventCount += 1;
    if (cost.basis === "actual") existing.costBasis = "actual";
    else if (existing.costBasis === "unknown" && cost.basis === "estimated") existing.costBasis = "estimated";
    providerMap.set(key, existing);

    const userKey = row.user_id ?? (row.actor_email ? `email:${row.actor_email}` : "unattributed");
    const user = userMap.get(userKey) ?? {
      userId: row.user_id,
      actorLabel: row.actor_email ?? (row.user_id ? row.user_id : "Company-level (unattributed)"),
      attributed: Boolean(row.user_id),
      usageCount: 0,
      interactionCount: 0,
      usageChargeCents: 0,
      directCostCents: 0,
      providers: [],
      features: [],
      interactions: new Set<string>(),
    };
    user.usageCount += 1;
    user.usageChargeCents += Number(row.customer_charge_cents ?? 0);
    user.directCostCents += cost.cents;
    if (classified.provider && !user.providers.includes(classified.provider)) {
      user.providers.push(classified.provider);
    }
    const feature = row.tool_name ?? row.action ?? row.resource_type ?? "usage";
    if (feature && !user.features.includes(feature)) user.features.push(feature);
    if (row.interaction_id) user.interactions.add(row.interaction_id);
    userMap.set(userKey, user);

    const day = String(row.recorded_at).slice(0, 10);
    const trend = trendMap.get(day) ?? { day, revenueCents: 0, directCostCents: 0 };
    trend.revenueCents += Number(row.customer_charge_cents ?? 0);
    trend.directCostCents += cost.cents;
    trendMap.set(day, trend);
  }

  if (providerMap.size === 0 || (filters.provider && filters.provider !== "stripe")) {
    // still record stripe fees when no provider filter or stripe selected
  }
  if (!filters.provider || filters.provider === "stripe" || filters.service === "payments") {
    let stripeCost = 0;
    for (const row of stripe.results ?? []) {
      const fee = estimateStripeFeeCents(Number(row.amount_cents ?? 0));
      stripeCost += fee;
      const day = String(row.at).slice(0, 10);
      const trend = trendMap.get(day) ?? { day, revenueCents: 0, directCostCents: 0 };
      trend.directCostCents += fee;
      trendMap.set(day, trend);
    }
    if (stripeCost > 0) {
      providerMap.set("stripe:payments:stripe_fees", {
        provider: "stripe",
        service: "payments",
        classification: "stripe_fees",
        costBasis: "estimated",
        usageQuantity: stripe.results?.length ?? 0,
        usageUnit: "payment",
        costCents: stripeCost,
        eventCount: stripe.results?.length ?? 0,
      });
    }
  }

  const users = [...userMap.values()].map((row) => ({
    userId: row.userId,
    actorLabel: row.actorLabel,
    attributed: row.attributed,
    usageCount: row.usageCount,
    interactionCount: row.interactions.size,
    usageChargeCents: row.usageChargeCents,
    directCostCents: row.directCostCents,
    providers: row.providers,
    features: row.features,
  }));

  return {
    period,
    company,
    providers: [...providerMap.values()].sort((a, b) => b.costCents - a.costCents),
    users: users.sort((a, b) => b.directCostCents - a.directCostCents),
    trend: [...trendMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

function emptyCompanyRow(
  company: { id: string; name: string; slug: string },
  period: DateRange,
): CompanyEconomicsRow {
  return {
    companyId: company.id,
    companyName: company.name,
    companySlug: company.slug,
    cashCollectedCents: 0,
    usageChargeCents: 0,
    creditsRefundsCents: 0,
    revenueCents: 0,
    revenueBasis: "usage_charges",
    cashBasisNote:
      "Revenue is recognised usage charges from the existing wallet model. Cash collected is Stripe/wallet top-ups in the same period and is shown separately — not mixed into margin.",
    directCostCents: 0,
    directCostKnown: false,
    grossProfitCents: 0,
    grossMarginPercent: null,
    activeUsers: 0,
    costPerActiveUserCents: null,
    revenuePerActiveUserCents: null,
    ocrCostCents: 0,
    aiModelCostCents: 0,
    cloudflareCostCents: 0,
    stripeFeeCents: 0,
    otherAttributableCostCents: 0,
    unattributedCostCents: 0,
    period,
  };
}

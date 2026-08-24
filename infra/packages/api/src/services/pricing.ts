/**
 * Commercial pricing engine.
 *
 * Gross margin (not markup):
 *   customer_charge = underlying_cost / (1 - target_margin)
 * At 60% target margin: charge = cost / 0.40
 *
 * Wallet ledger uses whole cents. Underlying costs may use micros
 * (1_000_000 micros = £1.00) so sub-penny provider costs are retained.
 */

import { newId, nowIso } from "../db/mappers";

export type PricingMode =
  | "fixed"
  | "cost_plus"
  | "percent_markup"
  | "target_margin"
  | "free";

export type CostBasis = "actual" | "estimated" | "unknown";

export interface PricingRule {
  id: string;
  companyId: string | null;
  action: string;
  pricingMode: PricingMode;
  fixedChargeCents: number | null;
  markupPercent: number | null;
  targetMarginBps: number | null;
  minimumChargeCents: number;
  chargeOnFailure: boolean;
  isBillable: boolean;
  label: string | null;
  isTestConfig: boolean;
  enabled: boolean;
  rateCardId: string | null;
  versionLabel: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface PricingPolicy {
  id: string;
  companyId: string | null;
  targetMarginBps: number;
  minimumChargeCents: number;
  currency: string;
  isTestConfig: boolean;
  enabled: boolean;
  label: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ChargeResult {
  billable: boolean;
  customerChargeCents: number | null;
  calculatedSellingCents: number | null;
  minimumChargeApplied: boolean;
  underlyingCostCents: number | null;
  underlyingCostMicros: number | null;
  estimatedCostMicros: number | null;
  costBasis: CostBasis;
  targetMarginBps: number | null;
  actualMarginBps: number | null;
  grossProfitCents: number | null;
  pricingLabel: string | null;
  pricingRuleId: string | null;
  rateCardId: string | null;
  rateCardVersion: string | null;
  isTestConfig: boolean;
}

export const MICROS_PER_CURRENCY_UNIT = 1_000_000;
export const MICROS_PER_CENT = 10_000; // £0.01 = 10_000 micros
export const DEFAULT_TARGET_MARGIN_BPS = 6000; // 60%
export const DEFAULT_MINIMUM_CHARGE_CENTS = 1;

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function rowToPricing(row: Record<string, unknown>): PricingRule {
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    action: String(row.action),
    pricingMode: String(row.pricing_mode) as PricingMode,
    fixedChargeCents:
      row.fixed_charge_cents == null ? null : Number(row.fixed_charge_cents),
    markupPercent:
      row.markup_percent == null ? null : Number(row.markup_percent),
    targetMarginBps:
      row.target_margin_bps == null ? null : Number(row.target_margin_bps),
    minimumChargeCents: Number(row.minimum_charge_cents ?? 0),
    chargeOnFailure: asBool(row.charge_on_failure),
    isBillable: asBool(row.is_billable),
    label: row.label ? String(row.label) : null,
    isTestConfig: asBool(row.is_test_config),
    enabled: asBool(row.enabled),
    rateCardId: row.rate_card_id ? String(row.rate_card_id) : null,
    versionLabel: row.version_label ? String(row.version_label) : null,
    effectiveFrom: row.effective_from ? String(row.effective_from) : null,
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
  };
}

function rowToPolicy(row: Record<string, unknown>): PricingPolicy {
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : null,
    targetMarginBps: Number(row.target_margin_bps ?? DEFAULT_TARGET_MARGIN_BPS),
    minimumChargeCents: Number(
      row.minimum_charge_cents ?? DEFAULT_MINIMUM_CHARGE_CENTS,
    ),
    currency: String(row.currency ?? "GBP"),
    isTestConfig: asBool(row.is_test_config),
    enabled: asBool(row.enabled),
    label: row.label ? String(row.label) : null,
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
  };
}

export function microsToCentsRoundedUp(micros: number): number {
  if (micros <= 0) return 0;
  return Math.ceil(micros / MICROS_PER_CENT);
}

export function centsToMicros(cents: number): number {
  return Math.round(cents * MICROS_PER_CENT);
}

/**
 * customer_charge = cost / (1 - margin)
 * Uses integer ceil to whole cents for wallet settlement.
 */
export function chargeFromTargetMargin(
  underlyingCostMicros: number,
  targetMarginBps: number,
): number {
  if (underlyingCostMicros <= 0) return 0;
  const keptBps = 10_000 - targetMarginBps;
  if (keptBps <= 0 || keptBps > 10_000) {
    throw new Error("target_margin_bps must be between 0 and 9999");
  }
  // charge_micros = cost_micros * 10000 / keptBps
  const chargeMicros = Math.ceil((underlyingCostMicros * 10_000) / keptBps);
  return microsToCentsRoundedUp(chargeMicros);
}

export function actualMarginBps(
  customerChargeCents: number,
  underlyingCostMicros: number,
): number | null {
  if (customerChargeCents <= 0) return null;
  const chargeMicros = centsToMicros(customerChargeCents);
  const profitMicros = chargeMicros - underlyingCostMicros;
  return Math.round((profitMicros * 10_000) / chargeMicros);
}

export async function resolvePricingPolicy(
  db: D1Database,
  companyId: string,
): Promise<PricingPolicy> {
  const companyPolicy = await db
    .prepare(
      `SELECT * FROM pricing_policies
       WHERE enabled = 1 AND company_id = ?
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .bind(companyId)
    .first();
  if (companyPolicy) return rowToPolicy(companyPolicy);

  const globalPolicy = await db
    .prepare(
      `SELECT * FROM pricing_policies
       WHERE enabled = 1 AND company_id IS NULL
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .first();
  if (globalPolicy) return rowToPolicy(globalPolicy);

  // Safe in-memory default when migration/seed not yet applied
  return {
    id: "policy_default_memory",
    companyId: null,
    targetMarginBps: DEFAULT_TARGET_MARGIN_BPS,
    minimumChargeCents: DEFAULT_MINIMUM_CHARGE_CENTS,
    currency: "GBP",
    isTestConfig: true,
    enabled: true,
    label: "Default 60% GM / 1p minimum (in-memory)",
    effectiveFrom: nowIso(),
    effectiveTo: null,
  };
}

export async function resolvePricingRule(
  db: D1Database,
  companyId: string,
  action: string,
): Promise<PricingRule | null> {
  const now = nowIso();
  const companyRule = await db
    .prepare(
      `SELECT * FROM pricing_rules
       WHERE enabled = 1 AND action = ? AND company_id = ?
         AND (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to IS NULL OR effective_to > ?)
       LIMIT 1`,
    )
    .bind(action, companyId, now, now)
    .first();
  if (companyRule) return rowToPricing(companyRule);

  const globalRule = await db
    .prepare(
      `SELECT * FROM pricing_rules
       WHERE enabled = 1 AND action = ? AND company_id IS NULL
         AND (effective_from IS NULL OR effective_from <= ?)
         AND (effective_to IS NULL OR effective_to > ?)
       LIMIT 1`,
    )
    .bind(action, now, now)
    .first();
  return globalRule ? rowToPricing(globalRule) : null;
}

export function calculateChargeCents(
  rule: PricingRule | null,
  input: {
    success: boolean;
    underlyingCostCents?: number | null;
    underlyingCostMicros?: number | null;
    estimatedCostMicros?: number | null;
    costBasis?: CostBasis;
    policy?: PricingPolicy | null;
  },
): ChargeResult {
  const policy = input.policy ?? null;
  const minCharge =
    rule?.minimumChargeCents ??
    policy?.minimumChargeCents ??
    DEFAULT_MINIMUM_CHARGE_CENTS;
  const targetMargin =
    rule?.targetMarginBps ??
    policy?.targetMarginBps ??
    DEFAULT_TARGET_MARGIN_BPS;

  const microsFromCents =
    input.underlyingCostCents == null
      ? null
      : centsToMicros(input.underlyingCostCents);
  const underlyingMicros =
    input.underlyingCostMicros ?? microsFromCents ?? null;
  const estimatedMicros = input.estimatedCostMicros ?? null;
  const costBasis: CostBasis =
    input.costBasis ??
    (underlyingMicros != null
      ? "actual"
      : estimatedMicros != null
        ? "estimated"
        : "unknown");

  const empty = (billable: boolean): ChargeResult => ({
    billable,
    customerChargeCents: null,
    calculatedSellingCents: null,
    minimumChargeApplied: false,
    underlyingCostCents:
      underlyingMicros == null ? null : microsToCentsRoundedUp(underlyingMicros),
    underlyingCostMicros: underlyingMicros,
    estimatedCostMicros: estimatedMicros,
    costBasis,
    targetMarginBps: targetMargin,
    actualMarginBps: null,
    grossProfitCents: null,
    pricingLabel: rule?.label ?? null,
    pricingRuleId: rule?.id ?? null,
    rateCardId: rule?.rateCardId ?? null,
    rateCardVersion: rule?.versionLabel ?? null,
    isTestConfig: rule?.isTestConfig ?? policy?.isTestConfig ?? true,
  });

  if (!rule || !rule.isBillable) {
    return empty(false);
  }

  if (!input.success && !rule.chargeOnFailure) {
    return empty(false);
  }

  let calculated = 0;
  const costForMargin = underlyingMicros ?? estimatedMicros;

  switch (rule.pricingMode) {
    case "fixed":
      calculated = rule.fixedChargeCents ?? 0;
      break;
    case "cost_plus":
      calculated =
        (costForMargin == null ? 0 : microsToCentsRoundedUp(costForMargin)) +
        (rule.fixedChargeCents ?? 0);
      break;
    case "percent_markup":
      calculated = Math.ceil(
        (costForMargin == null ? 0 : microsToCentsRoundedUp(costForMargin)) *
          (1 + (rule.markupPercent ?? 0) / 100),
      );
      break;
    case "target_margin":
      if (costForMargin == null || costForMargin <= 0) {
        // No measurable cost → do not invent; fall back to minimum only when fixed test rate absent
        calculated = rule.fixedChargeCents ?? 0;
      } else {
        calculated = chargeFromTargetMargin(costForMargin, targetMargin);
      }
      break;
    case "free":
      calculated = 0;
      break;
    default:
      calculated = rule.fixedChargeCents ?? 0;
  }

  const calculatedSellingCents = calculated;
  const minimumApplied = calculated > 0 && calculated < minCharge;
  const charge = calculated <= 0 ? 0 : Math.max(calculated, minCharge);

  const costCentsForProfit =
    underlyingMicros == null ? null : Math.round(underlyingMicros / MICROS_PER_CENT);
  const grossProfit =
    charge > 0 && costCentsForProfit != null ? charge - costCentsForProfit : null;
  const margin =
    charge > 0 && underlyingMicros != null
      ? actualMarginBps(charge, underlyingMicros)
      : null;

  return {
    billable: charge > 0,
    customerChargeCents: charge > 0 ? charge : null,
    calculatedSellingCents,
    minimumChargeApplied: minimumApplied,
    underlyingCostCents:
      underlyingMicros == null ? null : microsToCentsRoundedUp(underlyingMicros),
    underlyingCostMicros: underlyingMicros,
    estimatedCostMicros: estimatedMicros,
    costBasis,
    targetMarginBps: targetMargin,
    actualMarginBps: margin,
    grossProfitCents: grossProfit,
    pricingLabel: rule.label,
    pricingRuleId: rule.id,
    rateCardId: rule.rateCardId,
    rateCardVersion: rule.versionLabel,
    isTestConfig: rule.isTestConfig,
  };
}

export async function listPricingRules(db: D1Database, companyId?: string) {
  const result = companyId
    ? await db
        .prepare(
          `SELECT * FROM pricing_rules
           WHERE company_id IS NULL OR company_id = ?
           ORDER BY action ASC`,
        )
        .bind(companyId)
        .all()
    : await db
        .prepare(`SELECT * FROM pricing_rules ORDER BY action ASC`)
        .all();
  return (result.results ?? []).map((row) => rowToPricing(row));
}

export async function listPricingPolicies(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT * FROM pricing_policies ORDER BY company_id IS NOT NULL, effective_from DESC`,
    )
    .all();
  return (result.results ?? []).map((row) => rowToPolicy(row));
}

export async function ensureDefaultPricing(db: D1Database) {
  const now = nowIso();

  await db
    .prepare(
      `INSERT OR IGNORE INTO pricing_policies (
        id, company_id, target_margin_bps, minimum_charge_cents, currency,
        is_test_config, enabled, label, effective_from, effective_to, created_at, updated_at
      ) VALUES (
        'policy_platform_default', NULL, ?, ?, 'GBP', 1, 1,
        'Platform default: 60% target GM, £0.01 minimum',
        ?, NULL, ?, ?
      )`,
    )
    .bind(
      DEFAULT_TARGET_MARGIN_BPS,
      DEFAULT_MINIMUM_CHARGE_CENTS,
      now,
      now,
      now,
    )
    .run();

  // Keep TEST fixed 1p for knowledge.search until real provider costs are configured.
  // Commercial target_margin mode is available for when underlying costs exist.
  const defaults: Array<{
    id: string;
    action: string;
    mode: PricingMode;
    fixed: number | null;
    billable: number;
    label: string;
    min: number;
  }> = [
    {
      id: "price_knowledge_search",
      action: "knowledge.search",
      mode: "fixed",
      fixed: 1,
      billable: 1,
      label: "TEST: knowledge.search = 1p (until provider cost configured)",
      min: 1,
    },
    {
      id: "price_knowledge_read",
      action: "knowledge.read",
      mode: "fixed",
      fixed: 1,
      billable: 1,
      label: "TEST: knowledge.read = 1p (until provider cost configured)",
      min: 1,
    },
    {
      id: "price_system_health",
      action: "system.health",
      mode: "free",
      fixed: 0,
      billable: 0,
      label: "system.health non-billable",
      min: 0,
    },
  ];

  for (const item of defaults) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO pricing_rules (
          id, company_id, action, pricing_mode, fixed_charge_cents, markup_percent,
          minimum_charge_cents, charge_on_failure, is_billable, label, is_test_config,
          enabled, created_at, updated_at, target_margin_bps, version_label, effective_from
        ) VALUES (?, NULL, ?, ?, ?, NULL, ?, 0, ?, ?, 1, 1, ?, ?, ?, 'v1', ?)`,
      )
      .bind(
        item.id,
        item.action,
        item.mode,
        item.fixed,
        item.min,
        item.billable,
        item.label,
        now,
        now,
        DEFAULT_TARGET_MARGIN_BPS,
        now,
      )
      .run();
  }
}

export async function seedPricingId() {
  return newId("price");
}

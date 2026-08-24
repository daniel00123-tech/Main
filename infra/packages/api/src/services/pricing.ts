import { newId, nowIso } from "../db/mappers";

export type PricingMode = "fixed" | "cost_plus" | "percent_markup" | "free";

export interface PricingRule {
  id: string;
  companyId: string | null;
  action: string;
  pricingMode: PricingMode;
  fixedChargeCents: number | null;
  markupPercent: number | null;
  minimumChargeCents: number;
  chargeOnFailure: boolean;
  isBillable: boolean;
  label: string | null;
  isTestConfig: boolean;
  enabled: boolean;
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
    minimumChargeCents: Number(row.minimum_charge_cents ?? 0),
    chargeOnFailure: Boolean(row.charge_on_failure),
    isBillable: Boolean(row.is_billable),
    label: row.label ? String(row.label) : null,
    isTestConfig: Boolean(row.is_test_config),
    enabled: Boolean(row.enabled),
  };
}

export async function resolvePricingRule(
  db: D1Database,
  companyId: string,
  action: string,
): Promise<PricingRule | null> {
  const companyRule = await db
    .prepare(
      `SELECT * FROM pricing_rules
       WHERE enabled = 1 AND action = ? AND company_id = ?
       LIMIT 1`,
    )
    .bind(action, companyId)
    .first();
  if (companyRule) return rowToPricing(companyRule);

  const globalRule = await db
    .prepare(
      `SELECT * FROM pricing_rules
       WHERE enabled = 1 AND action = ? AND company_id IS NULL
       LIMIT 1`,
    )
    .bind(action)
    .first();
  return globalRule ? rowToPricing(globalRule) : null;
}

export function calculateChargeCents(
  rule: PricingRule | null,
  input: {
    success: boolean;
    underlyingCostCents?: number | null;
  },
): {
  billable: boolean;
  customerChargeCents: number | null;
  underlyingCostCents: number | null;
  pricingLabel: string | null;
  isTestConfig: boolean;
} {
  if (!rule || !rule.isBillable) {
    return {
      billable: false,
      customerChargeCents: null,
      underlyingCostCents: input.underlyingCostCents ?? null,
      pricingLabel: rule?.label ?? null,
      isTestConfig: rule?.isTestConfig ?? true,
    };
  }

  if (!input.success && !rule.chargeOnFailure) {
    return {
      billable: false,
      customerChargeCents: null,
      underlyingCostCents: input.underlyingCostCents ?? null,
      pricingLabel: rule.label,
      isTestConfig: rule.isTestConfig,
    };
  }

  const underlying = input.underlyingCostCents ?? null;
  let charge = 0;

  switch (rule.pricingMode) {
    case "fixed":
      charge = rule.fixedChargeCents ?? 0;
      break;
    case "cost_plus":
      charge = (underlying ?? 0) + (rule.fixedChargeCents ?? 0);
      break;
    case "percent_markup":
      charge = Math.ceil(
        (underlying ?? 0) * (1 + (rule.markupPercent ?? 0) / 100),
      );
      break;
    case "free":
      charge = 0;
      break;
    default:
      charge = rule.fixedChargeCents ?? 0;
  }

  charge = Math.max(charge, rule.minimumChargeCents);

  return {
    billable: charge > 0,
    customerChargeCents: charge,
    underlyingCostCents: underlying,
    pricingLabel: rule.label,
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

export async function ensureDefaultPricing(db: D1Database) {
  const now = nowIso();
  const defaults: Array<{
    id: string;
    action: string;
    fixed: number;
    billable: number;
    label: string;
  }> = [
    {
      id: "price_knowledge_search",
      action: "knowledge.search",
      fixed: 1,
      billable: 1,
      label: "TEST: knowledge.search = 1p",
    },
    {
      id: "price_knowledge_read",
      action: "knowledge.read",
      fixed: 1,
      billable: 1,
      label: "TEST: knowledge.read = 1p",
    },
    {
      id: "price_system_health",
      action: "system.health",
      fixed: 0,
      billable: 0,
      label: "TEST: system.health non-billable",
    },
  ];

  for (const item of defaults) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO pricing_rules (
          id, company_id, action, pricing_mode, fixed_charge_cents, markup_percent,
          minimum_charge_cents, charge_on_failure, is_billable, label, is_test_config,
          enabled, created_at, updated_at
        ) VALUES (?, NULL, ?, 'fixed', ?, NULL, 0, 0, ?, ?, 1, 1, ?, ?)`,
      )
      .bind(item.id, item.action, item.fixed, item.billable, item.label, now, now)
      .run();
  }
}

export async function seedPricingId() {
  return newId("price");
}

import { newId, nowIso } from "../db/mappers";
import { recordAuditEvent } from "./control-plane";
import {
  DEFAULT_MINIMUM_CHARGE_CENTS,
  DEFAULT_TARGET_MARGIN_BPS,
  calculateChargeCents,
  listPricingPolicies,
  resolvePricingRule,
  type PricingPolicy,
} from "./pricing";

export async function createPricingPolicyVersion(
  db: D1Database,
  input: {
    companyId: string | null;
    targetMarginBps: number;
    minimumChargeCents: number;
    label: string;
    actor: string;
    effectiveFrom?: string;
  },
): Promise<PricingPolicy> {
  if (input.targetMarginBps < 0 || input.targetMarginBps >= 10_000) {
    throw new Error("targetMarginBps must be between 0 and 9999");
  }
  if (input.minimumChargeCents < 0) {
    throw new Error("minimumChargeCents must be >= 0");
  }

  const effectiveFrom = input.effectiveFrom ?? nowIso();
  const now = nowIso();

  if (input.companyId) {
    await db
      .prepare(
        `UPDATE pricing_policies SET enabled = 0, effective_to = ?, updated_at = ?
         WHERE company_id = ? AND enabled = 1`,
      )
      .bind(effectiveFrom, now, input.companyId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE pricing_policies SET enabled = 0, effective_to = ?, updated_at = ?
         WHERE company_id IS NULL AND enabled = 1`,
      )
      .bind(effectiveFrom, now)
      .run();
  }

  const id = newId("policy");
  await db
    .prepare(
      `INSERT INTO pricing_policies (
        id, company_id, target_margin_bps, minimum_charge_cents, currency,
        is_test_config, enabled, label, effective_from, effective_to, created_at, updated_at, margin_basis
      ) VALUES (?, ?, ?, ?, 'GBP', 0, 1, ?, ?, NULL, ?, ?, 'gross_margin')`,
    )
    .bind(
      id,
      input.companyId,
      input.targetMarginBps,
      input.minimumChargeCents,
      input.label,
      effectiveFrom,
      now,
      now,
    )
    .run();

  await recordAuditEvent(db, {
    companyId: input.companyId,
    eventType: "pricing.changed",
    actor: input.actor,
    resourceType: "pricing_policy",
    resourceId: id,
    detail: {
      targetMarginBps: input.targetMarginBps,
      minimumChargeCents: input.minimumChargeCents,
      companyId: input.companyId,
      label: input.label,
    },
  });

  const policies = await listPricingPolicies(db);
  const created = policies.find((p) => p.id === id);
  if (!created) throw new Error("Failed to load created pricing policy");
  return created;
}

export async function previewPricingCharge(
  db: D1Database,
  input: {
    companyId?: string | null;
    action: string;
    underlyingCostMicros?: number | null;
    underlyingCostCents?: number | null;
  },
) {
  const rule = input.companyId
    ? await resolvePricingRule(db, input.companyId, input.action)
    : null;

  const policies = await listPricingPolicies(db);
  const policy =
    policies.find((p) => p.enabled && p.companyId === (input.companyId ?? null)) ??
    policies.find((p) => p.enabled && !p.companyId) ??
    null;

  if (!input.companyId && !rule) {
    const globalRule = await db
      .prepare(
        `SELECT * FROM pricing_rules WHERE enabled = 1 AND action = ? AND company_id IS NULL LIMIT 1`,
      )
      .bind(input.action)
      .first();
    const resolvedRule = globalRule
      ? {
          id: String(globalRule.id),
          companyId: null,
          action: String(globalRule.action),
          pricingMode: String(globalRule.pricing_mode) as "fixed",
          fixedChargeCents: Number(globalRule.fixed_charge_cents ?? 0),
          markupPercent: null,
          targetMarginBps: null,
          minimumChargeCents: Number(globalRule.minimum_charge_cents ?? 1),
          chargeOnFailure: false,
          isBillable: true,
          label: globalRule.label ? String(globalRule.label) : null,
          isTestConfig: false,
          enabled: true,
          rateCardId: null,
          versionLabel: null,
          effectiveFrom: null,
          effectiveTo: null,
          marginBasis: "gross_margin" as const,
          costCategory: null,
        }
      : null;
    const charge = calculateChargeCents(resolvedRule, {
      success: true,
      policy,
      underlyingCostMicros: input.underlyingCostMicros ?? null,
      underlyingCostCents: input.underlyingCostCents ?? null,
      costBasis:
        input.underlyingCostMicros != null || input.underlyingCostCents != null
          ? "actual"
          : "unknown",
    });
    return formatPreview(input.action, policy, charge);
  }

  const charge = calculateChargeCents(rule, {
    success: true,
    policy,
    underlyingCostMicros: input.underlyingCostMicros ?? null,
    underlyingCostCents: input.underlyingCostCents ?? null,
    costBasis:
      input.underlyingCostMicros != null || input.underlyingCostCents != null
        ? "actual"
        : "unknown",
  });

  return formatPreview(input.action, policy, charge);
}

function formatPreview(
  action: string,
  policy: PricingPolicy | null,
  charge: ReturnType<typeof calculateChargeCents>,
) {
  return {
    action,
    underlyingCostCents: charge.underlyingCostCents,
    underlyingCostMicros: charge.underlyingCostMicros,
    targetMarginBps: charge.targetMarginBps,
    calculatedPriceCents: charge.calculatedSellingCents,
    minimumChargeCents: policy?.minimumChargeCents ?? DEFAULT_MINIMUM_CHARGE_CENTS,
    finalCustomerChargeCents: charge.customerChargeCents,
    minimumApplied: charge.minimumChargeApplied,
    pricingRuleId: charge.pricingRuleId,
    pricingLabel: charge.pricingLabel,
  };
}

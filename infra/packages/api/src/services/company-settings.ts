import { nowIso } from "../db/mappers";
import { syncLowBalanceThreshold } from "./wallet-metrics";

export type CompanySettings = {
  companyId: string;
  name: string;
  tradingName: string | null;
  logoUrl: string | null;
  primaryContactName: string | null;
  primaryEmail: string | null;
  billingEmail: string | null;
  telephone: string | null;
  timezone: string | null;
  country: string | null;
  lowBalanceThresholdCents: number;
  autoTopUp: {
    enabled: boolean;
    thresholdCents: number | null;
    amountCents: number | null;
    paymentMethodReady: boolean;
  };
  notifications: {
    lowBalanceEmail: boolean;
    usageAlerts: boolean;
  };
  /**
   * Company-scoped Getting Started dismissal. A company_admin or director
   * dismisses the checklist for every user of this company only.
   * Once set it is not resurrected.
   */
  gettingStartedDismissedAt: string | null;
};

export type CompanySettingsPatch = {
  name?: string;
  tradingName?: string | null;
  logoUrl?: string | null;
  primaryContactName?: string | null;
  primaryEmail?: string | null;
  billingEmail?: string | null;
  telephone?: string | null;
  timezone?: string | null;
  lowBalanceThresholdCents?: number;
  notifications?: {
    lowBalanceEmail?: boolean;
    usageAlerts?: boolean;
  };
  /** Persist company-scoped Getting Started dismissal. `false` is ignored. */
  gettingStartedDismissed?: boolean;
};

export function normalizeLogoUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.length > 2048) {
    throw new Error("LOGO_URL_TOO_LONG");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("LOGO_URL_INVALID");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("LOGO_URL_MUST_BE_HTTPS");
  }
  return trimmed;
}

function parseConfigJson(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge settings patches into companies.config_json.
 * Getting Started dismissal is company-scoped, idempotent, and never cleared here.
 */
export function applyCompanySettingsConfigPatch(
  config: Record<string, unknown>,
  patch: CompanySettingsPatch,
  now: string,
): Record<string, unknown> {
  const next = { ...config };
  if (patch.notifications) {
    next.notifications = {
      ...(next.notifications as Record<string, unknown> | undefined),
      ...patch.notifications,
    };
  }
  if (
    patch.gettingStartedDismissed === true &&
    typeof next.gettingStartedDismissedAt !== "string"
  ) {
    next.gettingStartedDismissedAt = now;
  }
  return next;
}

export async function getCompanySettings(
  db: D1Database,
  companyId: string,
): Promise<CompanySettings | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.name, c.trading_name, c.logo_url, c.primary_contact_name, c.primary_email,
              c.billing_email, c.telephone, c.timezone, c.country, c.config_json,
              COALESCE(ccs.low_balance_threshold_cents, 500) AS low_balance_threshold_cents,
              COALESCE(ccs.auto_top_up_enabled, 0) AS auto_top_up_enabled,
              ccs.auto_top_up_threshold_cents,
              ccs.auto_top_up_amount_cents,
              ppa.auto_top_up_enabled AS ppa_auto_enabled,
              ppa.auto_top_up_threshold_cents AS ppa_auto_threshold,
              ppa.auto_top_up_amount_cents AS ppa_auto_amount,
              ppa.payment_method_status,
              ppa.payment_method_brand,
              ppa.payment_method_last4,
              ppa.payment_method_exp_month,
              ppa.payment_method_exp_year
       FROM companies c
       LEFT JOIN company_commercial_settings ccs ON ccs.company_id = c.id
       LEFT JOIN payment_provider_accounts ppa
         ON ppa.company_id = c.id AND ppa.provider = 'stripe'
       WHERE c.id = ?`,
    )
    .bind(companyId)
    .first();

  if (!row) return null;

  const config = parseConfigJson(row.config_json);
  const notifications = (config.notifications ?? {}) as Record<string, unknown>;
  const dismissedAt =
    typeof config.gettingStartedDismissedAt === "string"
      ? config.gettingStartedDismissedAt
      : null;

  return {
    companyId: String(row.id),
    name: String(row.name),
    tradingName: row.trading_name ? String(row.trading_name) : null,
    logoUrl: row.logo_url ? String(row.logo_url) : null,
    primaryContactName: row.primary_contact_name ? String(row.primary_contact_name) : null,
    primaryEmail: row.primary_email ? String(row.primary_email) : null,
    billingEmail: row.billing_email ? String(row.billing_email) : null,
    telephone: row.telephone ? String(row.telephone) : null,
    timezone: row.timezone ? String(row.timezone) : null,
    country: row.country ? String(row.country) : null,
    lowBalanceThresholdCents: Number(row.low_balance_threshold_cents ?? 500),
    autoTopUp: {
      enabled: Boolean(Number(row.auto_top_up_enabled ?? row.ppa_auto_enabled ?? 0)),
      thresholdCents:
        row.auto_top_up_threshold_cents != null
          ? Number(row.auto_top_up_threshold_cents)
          : row.ppa_auto_threshold != null
            ? Number(row.ppa_auto_threshold)
            : null,
      amountCents:
        row.auto_top_up_amount_cents != null
          ? Number(row.auto_top_up_amount_cents)
          : row.ppa_auto_amount != null
            ? Number(row.ppa_auto_amount)
            : null,
      paymentMethodReady: String(row.payment_method_status ?? "") === "active",
    },
    notifications: {
      lowBalanceEmail: notifications.lowBalanceEmail !== false,
      usageAlerts: notifications.usageAlerts !== false,
    },
    gettingStartedDismissedAt: dismissedAt,
  };
}

export async function updateCompanySettings(
  db: D1Database,
  companyId: string,
  patch: CompanySettingsPatch,
): Promise<CompanySettings> {
  const existing = await db
    .prepare(`SELECT config_json FROM companies WHERE id = ?`)
    .bind(companyId)
    .first();
  if (!existing) throw new Error("COMPANY_NOT_FOUND");

  const config = applyCompanySettingsConfigPatch(
    parseConfigJson(existing.config_json),
    patch,
    nowIso(),
  );

  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [nowIso()];

  if (patch.name != null) {
    sets.push("name = ?");
    binds.push(patch.name.trim());
  }
  if (patch.logoUrl !== undefined) {
    sets.push("logo_url = ?");
    binds.push(normalizeLogoUrl(patch.logoUrl) ?? null);
  }
  if (patch.tradingName !== undefined) {
    sets.push("trading_name = ?");
    binds.push(patch.tradingName);
  }
  if (patch.primaryContactName !== undefined) {
    sets.push("primary_contact_name = ?");
    binds.push(patch.primaryContactName);
  }
  if (patch.primaryEmail !== undefined) {
    sets.push("primary_email = ?");
    binds.push(patch.primaryEmail);
  }
  if (patch.billingEmail !== undefined) {
    sets.push("billing_email = ?");
    binds.push(patch.billingEmail);
  }
  if (patch.telephone !== undefined) {
    sets.push("telephone = ?");
    binds.push(patch.telephone);
  }
  if (patch.timezone !== undefined) {
    sets.push("timezone = ?");
    binds.push(patch.timezone);
  }
  sets.push("config_json = ?");
  binds.push(JSON.stringify(config));
  binds.push(companyId);

  await db
    .prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  if (patch.lowBalanceThresholdCents != null) {
    if (patch.lowBalanceThresholdCents < 100 || patch.lowBalanceThresholdCents > 100000) {
      throw new Error("LOW_BALANCE_THRESHOLD_OUT_OF_RANGE");
    }
    await syncLowBalanceThreshold(db, companyId, patch.lowBalanceThresholdCents);
  }

  const updated = await getCompanySettings(db, companyId);
  if (!updated) throw new Error("COMPANY_NOT_FOUND");
  return updated;
}

export type AutoTopUpPatch = {
  enabled: boolean;
  thresholdCents: number;
  amountCents: number;
};

export async function updateAutoTopUpSettings(
  db: D1Database,
  companyId: string,
  patch: AutoTopUpPatch,
): Promise<CompanySettings> {
  if (patch.thresholdCents < 100 || patch.thresholdCents > 50000) {
    throw new Error("AUTO_TOPUP_THRESHOLD_OUT_OF_RANGE");
  }
  if (![1000, 2500, 5000, 10000, 50000].includes(patch.amountCents)) {
    throw new Error("AUTO_TOPUP_AMOUNT_INVALID");
  }

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO company_commercial_settings (
        company_id, currency, target_gross_margin_percent, minimum_charge_cents,
        monthly_platform_fee_cents, included_credit_cents, low_balance_threshold_cents,
        auto_top_up_enabled, auto_top_up_threshold_cents, auto_top_up_amount_cents,
        billing_status, pricing_plan, updated_at
      ) VALUES (?, 'GBP', 60, 1, 0, 0, 500, ?, ?, ?, 'active', 'standard', ?)
      ON CONFLICT(company_id) DO UPDATE SET
        auto_top_up_enabled = excluded.auto_top_up_enabled,
        auto_top_up_threshold_cents = excluded.auto_top_up_threshold_cents,
        auto_top_up_amount_cents = excluded.auto_top_up_amount_cents,
        updated_at = excluded.updated_at`,
    )
    .bind(
      companyId,
      patch.enabled ? 1 : 0,
      patch.thresholdCents,
      patch.amountCents,
      now,
    )
    .run();

  await db
    .prepare(
      `UPDATE payment_provider_accounts
       SET auto_top_up_enabled = ?, auto_top_up_threshold_cents = ?,
           auto_top_up_amount_cents = ?, updated_at = ?
       WHERE company_id = ? AND provider = 'stripe'`,
    )
    .bind(patch.enabled ? 1 : 0, patch.thresholdCents, patch.amountCents, now, companyId)
    .run();

  const updated = await getCompanySettings(db, companyId);
  if (!updated) throw new Error("COMPANY_NOT_FOUND");
  return updated;
}

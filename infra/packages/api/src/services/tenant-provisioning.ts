import type { Company, CreateCompanyInput } from "@infra/shared";
import {
  DEFAULT_COMPANY_CURRENCY,
  DEFAULT_TEST_OPENING_CREDIT_CENTS,
  GATEWAY_ALLOWED_STATUSES,
  LEGACY_PORTAL_BASE_DOMAIN,
  isReservedProductionHost,
  slugifyCompanyName as sharedSlugify,
  validateCompanySlug,
} from "@infra/shared";
import { newId, nowIso, rowToCompany } from "../db/mappers";
import { createMembership, getUserByEmail, createUser } from "../auth/users";
import { createPasswordSetupToken } from "../auth/password-setup";
import { appendLedgerEntry } from "./ledger";
import { recordAuditEvent } from "./control-plane";
import { ensurePaymentProviderAccount } from "./payment-providers";

const DEFAULT_PORTAL_BASE_DOMAIN = LEGACY_PORTAL_BASE_DOMAIN;

const DEFAULT_MODULES = ["knowledge", "chatgpt", "claude", "whatsapp"] as const;

export function slugifyCompanyName(value: string): string {
  return sharedSlugify(value);
}

export function portalHostnameFor(
  subdomain: string,
  baseDomain = DEFAULT_PORTAL_BASE_DOMAIN,
): string {
  return `${subdomain}.${baseDomain}`;
}

export async function getCompanyByPortalHostname(
  db: D1Database,
  hostname: string,
): Promise<Company | null> {
  const host = hostname.trim().toLowerCase().split(":")[0];
  const row = await db
    .prepare("SELECT * FROM companies WHERE lower(portal_hostname) = ?")
    .bind(host)
    .first();
  if (row) return rowToCompany(row);

  // Support {subdomain}.infra-web.pages.dev style hosts even if hostname column lags.
  // Never treat app/api/mcp/root infrastack.app hosts as a company subdomain.
  const parts = host.split(".");
  if (parts.length >= 3 && !isReservedProductionHost(host)) {
    const subdomain = parts[0];
    const bySub = await db
      .prepare("SELECT * FROM companies WHERE lower(portal_subdomain) = ?")
      .bind(subdomain)
      .first();
    if (bySub) return rowToCompany(bySub);
  }
  return null;
}

export async function getCompanyByPortalSubdomain(
  db: D1Database,
  subdomain: string,
): Promise<Company | null> {
  const row = await db
    .prepare("SELECT * FROM companies WHERE lower(portal_subdomain) = ?")
    .bind(subdomain.trim().toLowerCase())
    .first();
  return row ? rowToCompany(row) : null;
}

async function slugIsTaken(db: D1Database, slug: string): Promise<boolean> {
  const existing = await db
    .prepare("SELECT id FROM companies WHERE slug = ?")
    .bind(slug)
    .first();
  return Boolean(existing);
}

async function ensureUniqueSlug(
  db: D1Database,
  base: string,
  explicit: boolean,
): Promise<string> {
  const validated = validateCompanySlug(base);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  if (!(await slugIsTaken(db, validated.slug))) {
    return validated.slug;
  }
  if (explicit) {
    throw new Error(`Slug "${validated.slug}" is already in use`);
  }
  let n = 2;
  while (n < 100) {
    const candidate = `${validated.slug}-${n}`.slice(0, 48);
    const again = validateCompanySlug(candidate);
    if (again.ok && !(await slugIsTaken(db, again.slug))) {
      return again.slug;
    }
    n += 1;
  }
  throw new Error("Unable to allocate a unique company slug");
}

async function ensureUniqueSubdomain(
  db: D1Database,
  base: string,
): Promise<string> {
  let candidate = base || "company";
  let n = 2;
  while (true) {
    const existing = await db
      .prepare("SELECT id FROM companies WHERE portal_subdomain = ?")
      .bind(candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}${n}`.slice(0, 40);
    n += 1;
  }
}

async function ensureDefaultAiConnections(
  db: D1Database,
  companyId: string,
  now: string,
) {
  const shells = [
    {
      clientType: "chatgpt",
      displayName: "ChatGPT",
      status: "ready_to_connect",
      notes:
        "Generate a service identity token, then configure ChatGPT to call the INFRA MCP facade with the Bearer token.",
    },
    {
      clientType: "claude",
      displayName: "Claude",
      status: "coming_soon",
      notes: "Claude connector is coming soon.",
    },
    {
      clientType: "whatsapp",
      displayName: "WhatsApp",
      status: "coming_soon",
      notes: "WhatsApp channel gateway is planned for a later phase.",
    },
  ];

  for (const shell of shells) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ai_client_connections
          (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '/api/gateway/v1/mcp', ?, ?, ?)`,
      )
      .bind(
        newId("ai"),
        companyId,
        shell.clientType,
        shell.displayName,
        shell.status,
        shell.notes,
        now,
        now,
      )
      .run();
  }
}

async function ensureModules(
  db: D1Database,
  companyId: string,
  modules: string[],
  now: string,
) {
  for (const moduleKey of modules) {
    const status =
      moduleKey === "chatgpt" || moduleKey === "knowledge"
        ? "available"
        : moduleKey === "claude" || moduleKey === "whatsapp"
          ? "available"
          : "available";
    await db
      .prepare(
        `INSERT OR IGNORE INTO company_modules
          (id, company_id, module_key, status, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      )
      .bind(newId("mod"), companyId, moduleKey, status, now, now)
      .run();
  }
}

/**
 * Provision a logical tenant inside the shared INFRA control plane.
 * Does NOT create per-tenant Workers/D1 databases.
 */
export async function provisionCompany(
  db: D1Database,
  input: CreateCompanyInput,
  actorEmail: string,
  options?: {
    portalBaseDomain?: string;
    /** Stable id such as co_ht — used only when unused. */
    preferredId?: string;
    openingCreditDescription?: string;
    openingCreditMetadata?: Record<string, unknown>;
  },
): Promise<{
  company: Company;
  adminInvite?: {
    userId: string;
    email: string;
    setupToken: string;
    expiresAt: string;
  };
}> {
  const legalName = input.legalName?.trim();
  if (!legalName) {
    throw new Error("Company legal name is required");
  }

  const tradingName = (input.tradingName ?? legalName).trim();
  const explicitSlug = Boolean(input.slug?.trim());
  const baseSlug = slugifyCompanyName(input.slug?.trim() || tradingName || legalName);
  const baseSub =
    slugifyCompanyName(input.portalSubdomain?.trim() || baseSlug) || "company";

  const now = nowIso();
  const slug = await ensureUniqueSlug(db, baseSlug, explicitSlug);
  const portalSubdomain = await ensureUniqueSubdomain(db, baseSub);
  const portalHostname = portalHostnameFor(
    portalSubdomain,
    options?.portalBaseDomain ?? DEFAULT_PORTAL_BASE_DOMAIN,
  );
  let companyId = newId("co");
  const preferredId = options?.preferredId?.trim();
  if (preferredId && /^co_[a-z0-9_]+$/.test(preferredId)) {
    const taken = await db
      .prepare("SELECT id FROM companies WHERE id = ?")
      .bind(preferredId)
      .first();
    if (!taken) companyId = preferredId;
  }
  const currency = (input.currency ?? DEFAULT_COMPANY_CURRENCY).toUpperCase();
  const openingCreditCents = Math.max(
    0,
    Math.floor(input.openingCreditCents ?? DEFAULT_TEST_OPENING_CREDIT_CENTS),
  );
  const modules = input.modules?.length
    ? input.modules
    : [...DEFAULT_MODULES];

  await db
    .prepare(
      `INSERT INTO companies (
        id, slug, name, status, primary_domain, notes,
        trading_name, company_number, country, timezone,
        primary_contact_name, primary_email, billing_email, telephone, logo_url,
        portal_subdomain, portal_hostname, provisioned_at,
        currency, billing_mode, mcp_onboarding_status, branding_json, config_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'onboarding', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'not_provisioned', '{}', '{}', ?, ?)`,
    )
    .bind(
      companyId,
      slug,
      legalName,
      input.primaryDomain?.trim() || null,
      input.notes?.trim() || null,
      tradingName,
      input.companyNumber?.trim() || null,
      input.country?.trim() || "GB",
      input.timezone?.trim() || "Europe/London",
      input.primaryContactName?.trim() || null,
      input.primaryEmail?.trim().toLowerCase() || null,
      input.billingEmail?.trim().toLowerCase() ||
        input.primaryEmail?.trim().toLowerCase() ||
        null,
      input.telephone?.trim() || null,
      input.logoUrl?.trim() || null,
      portalSubdomain,
      portalHostname,
      now,
      currency,
      now,
      now,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO credit_balances
        (company_id, balance_cents, currency, low_balance_threshold_cents, updated_at)
       VALUES (?, 0, ?, 500, ?)`,
    )
    .bind(companyId, currency, now)
    .run();

  await db
    .prepare(
      `INSERT INTO company_commercial_settings (
        company_id, currency, target_gross_margin_percent, minimum_charge_cents,
        monthly_platform_fee_cents, included_credit_cents, low_balance_threshold_cents,
        auto_top_up_enabled, billing_status, pricing_plan, updated_at
      ) VALUES (?, ?, 60, 1, 0, ?, 500, 0, 'active', 'standard', ?)`,
    )
    .bind(companyId, currency, openingCreditCents, now)
    .run();

  await ensureModules(db, companyId, modules, now);
  await ensureDefaultAiConnections(db, companyId, now);

  await ensurePaymentProviderAccount(db, companyId, "stripe");

  if (openingCreditCents > 0) {
    await appendLedgerEntry(db, {
      companyId,
      entryType: "promotional_credit",
      amountCents: openingCreditCents,
      currency,
      referenceType: "provisioning",
      referenceId: `opening_${companyId}`,
      description:
        options?.openingCreditDescription ??
        `Opening TEST credit for ${legalName}`,
      createdBy: actorEmail,
      metadata: {
        provisioned: true,
        creditClass: "test",
        ...(options?.openingCreditMetadata ?? {}),
      },
    });
  }

  let adminInvite:
    | {
        userId: string;
        email: string;
        setupToken: string;
        expiresAt: string;
      }
    | undefined;

  if (input.adminEmail?.trim()) {
    const email = input.adminEmail.trim().toLowerCase();
    let user = await getUserByEmail(db, email);
    if (!user) {
      // Temporary random password — admin completes setup via invite token
      const temp = `Tmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}!`;
      user = await createUser(db, {
        email,
        displayName: input.adminDisplayName?.trim() || tradingName,
        password: temp,
        isPlatformAdmin: false,
      });
    }
    const existingMembership = await db
      .prepare(
        `SELECT id FROM company_memberships WHERE user_id = ? AND company_id = ?`,
      )
      .bind(user.id, companyId)
      .first();
    if (!existingMembership) {
      await createMembership(db, {
        userId: user.id,
        companyId,
        role: "company_admin",
      });
    }
    const setup = await createPasswordSetupToken(db, user.id, "password_setup");
    adminInvite = {
      userId: user.id,
      email,
      setupToken: setup.token,
      expiresAt: setup.expiresAt,
    };
  }

  await db
    .prepare(
      `UPDATE companies
       SET status = 'onboarding',
           primary_admin_user_id = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(adminInvite?.userId ?? null, now, companyId)
    .run();

  await recordAuditEvent(db, {
    companyId,
    eventType: "company.created",
    actor: actorEmail,
    resourceType: "company",
    resourceId: companyId,
    detail: {
      slug,
      portalSubdomain,
      portalHostname,
      openingCreditCents,
      creditClass: openingCreditCents > 0 ? "test" : null,
      modules,
      mcpProvisioned: false,
    },
  });

  const company = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!company) throw new Error("Failed to load provisioned company");

  return { company: rowToCompany(company), adminInvite };
}

export async function setCompanyLifecycleStatus(
  db: D1Database,
  companyId: string,
  status: "onboarding" | "active" | "suspended" | "archived" | "closed",
  actorEmail: string,
  reason?: string,
): Promise<Company> {
  const now = nowIso();
  const company = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!company) throw new Error("Company not found");

  let eventType:
    | "company.updated"
    | "company.suspended"
    | "company.reactivated"
    | "company.archived" = "company.updated";

  if (status === "suspended") {
    await db
      .prepare(
        `UPDATE companies SET status = 'suspended', suspended_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, companyId)
      .run();
    await db
      .prepare(
        `UPDATE service_identities SET status = 'disabled', updated_at = ? WHERE company_id = ? AND status = 'active'`,
      )
      .bind(now, companyId)
      .run();
    eventType = "company.suspended";
  } else if (status === "archived" || status === "closed") {
    await db
      .prepare(
        `UPDATE companies SET status = ?, archived_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(status, now, now, now, companyId)
      .run();
    await db
      .prepare(
        `UPDATE service_identities SET status = 'disabled', updated_at = ? WHERE company_id = ?`,
      )
      .bind(now, companyId)
      .run();
    eventType = "company.archived";
  } else {
    await db
      .prepare(
        `UPDATE companies
         SET status = ?, suspended_at = NULL, closed_at = NULL, archived_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .bind(status, now, companyId)
      .run();
    if (String(company.status) === "suspended") {
      eventType = "company.reactivated";
    }
  }

  await recordAuditEvent(db, {
    companyId,
    eventType,
    actor: actorEmail,
    resourceType: "company",
    resourceId: companyId,
    detail: {
      status,
      previousStatus: company.status,
      ...(reason ? { reason } : {}),
    },
  });

  const row = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!row) throw new Error("Company not found after update");
  return rowToCompany(row);
}

export async function deleteCompanyIfSafe(
  db: D1Database,
  companyId: string,
  actorEmail: string,
): Promise<
  | { ok: true }
  | { ok: false; message: string; code: string }
> {
  const company = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!company) {
    return { ok: false, message: "Company not found", code: "NOT_FOUND" };
  }

  const [ledgerRow, usageRow, balanceRow] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM ledger_entries WHERE company_id = ?`,
      )
      .bind(companyId)
      .first(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM usage_records WHERE company_id = ?`,
      )
      .bind(companyId)
      .first(),
    db
      .prepare(
        `SELECT balance_cents FROM credit_balances WHERE company_id = ?`,
      )
      .bind(companyId)
      .first(),
  ]);

  const ledgerCount = Number(ledgerRow?.count ?? 0);
  const usageCount = Number(usageRow?.count ?? 0);
  const balanceCents = Number(balanceRow?.balance_cents ?? 0);

  if (ledgerCount > 0) {
    return {
      ok: false,
      message:
        "This company has financial ledger history. Archive it instead of deleting.",
      code: "HAS_LEDGER",
    };
  }
  if (usageCount > 0) {
    return {
      ok: false,
      message:
        "This company has usage history. Archive it instead of deleting.",
      code: "HAS_USAGE",
    };
  }
  if (balanceCents !== 0) {
    return {
      ok: false,
      message: "This company has a non-zero wallet balance.",
      code: "HAS_BALANCE",
    };
  }

  const now = nowIso();
  await recordAuditEvent(db, {
    companyId: null,
    eventType: "company.updated",
    actor: actorEmail,
    resourceType: "company",
    resourceId: companyId,
    detail: {
      action: "deleted",
      companyName: String(company.name),
      companySlug: String(company.slug),
      deletedAt: now,
    },
  });

  const tables = [
    "company_memberships",
    "service_identities",
    "connector_instances",
    "mcp_environments",
    "company_modules",
    "company_commercial_settings",
    "ai_client_connections",
    "credit_balances",
    "attention_dismissals",
  ];
  for (const table of tables) {
    await db
      .prepare(`DELETE FROM ${table} WHERE company_id = ?`)
      .bind(companyId)
      .run();
  }
  await db.prepare(`DELETE FROM companies WHERE id = ?`).bind(companyId).run();

  return { ok: true };
}

export async function assertCompanyAcceptsGateway(
  db: D1Database,
  companyId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: 403 }> {
  const company = await db
    .prepare("SELECT status FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!company) {
    return { ok: false, error: "Company not found", status: 403 };
  }
  const status = String(company.status);
  if (status === "suspended") {
    return {
      ok: false,
      error: "Company is suspended — gateway requests are blocked",
      status: 403,
    };
  }
  if (!GATEWAY_ALLOWED_STATUSES.has(status)) {
    return {
      ok: false,
      error: `Company status '${status}' does not allow gateway requests`,
      status: 403,
    };
  }
  return { ok: true };
}

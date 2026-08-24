import type { Company, CreateCompanyInput } from "@infra/shared";
import { newId, nowIso, rowToCompany } from "../db/mappers";
import { createMembership, getUserByEmail, createUser } from "../auth/users";
import { createPasswordSetupToken } from "../auth/password-setup";
import { appendLedgerEntry } from "./ledger";
import { recordAuditEvent } from "./control-plane";

const DEFAULT_PORTAL_BASE_DOMAIN = "infra-web.pages.dev";

const DEFAULT_MODULES = ["knowledge", "chatgpt", "claude", "whatsapp"] as const;

export function slugifyCompanyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
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

  // Support {subdomain}.infra-web.pages.dev style hosts even if hostname column lags
  const parts = host.split(".");
  if (parts.length >= 3) {
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

async function ensureUniqueSlug(db: D1Database, base: string): Promise<string> {
  let candidate = base || "company";
  let n = 2;
  while (true) {
    const existing = await db
      .prepare("SELECT id FROM companies WHERE slug = ?")
      .bind(candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${n}`.slice(0, 56);
    n += 1;
  }
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
  options?: { portalBaseDomain?: string },
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
  const baseSlug = slugifyCompanyName(input.slug?.trim() || tradingName || legalName);
  const baseSub =
    slugifyCompanyName(input.portalSubdomain?.trim() || baseSlug.split("-")[0] || baseSlug) ||
    "company";

  const now = nowIso();
  const slug = await ensureUniqueSlug(db, baseSlug);
  const portalSubdomain = await ensureUniqueSubdomain(db, baseSub);
  const portalHostname = portalHostnameFor(
    portalSubdomain,
    options?.portalBaseDomain ?? DEFAULT_PORTAL_BASE_DOMAIN,
  );
  const companyId = newId("co");
  const currency = (input.currency ?? "GBP").toUpperCase();
  const openingCreditCents = Math.max(0, Math.floor(input.openingCreditCents ?? 0));
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
        created_at, updated_at
      ) VALUES (?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  if (openingCreditCents > 0) {
    await appendLedgerEntry(db, {
      companyId,
      entryType: "promotional_credit",
      amountCents: openingCreditCents,
      currency,
      referenceType: "provisioning",
      referenceId: `opening_${companyId}`,
      description: `Opening promotional credit for ${legalName}`,
      createdBy: actorEmail,
      metadata: { provisioned: true },
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
      `UPDATE companies SET status = 'active', updated_at = ? WHERE id = ?`,
    )
    .bind(now, companyId)
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
      modules,
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
  status: "active" | "suspended" | "closed",
  actorEmail: string,
): Promise<Company> {
  const now = nowIso();
  const company = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!company) throw new Error("Company not found");

  if (status === "suspended") {
    await db
      .prepare(
        `UPDATE companies SET status = 'suspended', suspended_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, companyId)
      .run();
    // Disable service identities so chargeable gateway use stops
    await db
      .prepare(
        `UPDATE service_identities SET status = 'disabled', updated_at = ? WHERE company_id = ? AND status = 'active'`,
      )
      .bind(now, companyId)
      .run();
  } else if (status === "closed") {
    await db
      .prepare(
        `UPDATE companies SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, companyId)
      .run();
    await db
      .prepare(
        `UPDATE service_identities SET status = 'disabled', updated_at = ? WHERE company_id = ?`,
      )
      .bind(now, companyId)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE companies SET status = 'active', suspended_at = NULL, closed_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(now, companyId)
      .run();
  }

  await recordAuditEvent(db, {
    companyId,
    eventType: "company.updated",
    actor: actorEmail,
    resourceType: "company",
    resourceId: companyId,
    detail: { status },
  });

  const row = await db
    .prepare("SELECT * FROM companies WHERE id = ?")
    .bind(companyId)
    .first();
  if (!row) throw new Error("Company not found after update");
  return rowToCompany(row);
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
  if (status === "closed" || status === "draft" || status === "provisioning") {
    return {
      ok: false,
      error: `Company status '${status}' does not allow gateway requests`,
      status: 403,
    };
  }
  return { ok: true };
}

import { Hono } from "hono";
import type { CompanyRole } from "@infra/shared";
import type { Env } from "../env";
import {
  requireAuth,
  requirePlatformAdmin,
  type AuthVariables,
} from "../auth/middleware";
import { readSessionCookie, verifySessionToken } from "../auth/session";
import {
  getUserById,
  setMembershipStatus,
  setUserStatus,
  updateMembershipRole,
  updateUserPassword,
} from "../auth/users";
import {
  createPasswordSetupToken,
  validateNewPassword,
} from "../auth/password-setup";
import { getCompanyEmailConfig } from "../services/email/company-config";
import { sendTransactionalEmail } from "../services/email/send-transactional";
import { renderTestEmail } from "../services/email-outbox";
import { exchangeMailSendRbacGuide } from "../services/email/providers/microsoft-graph";
import {
  getCompanyBySlug,
  listMcpEnvironments,
  recordAuditEvent,
} from "../services/control-plane";
import {
  executeGatewayRequest,
  resolveGatewayActor,
} from "../services/gateway";
import { handleInfraMcpHttp } from "../services/mcp-gateway";
import {
  appendLedgerEntry,
  getWalletBalance,
  listLedgerEntries,
  listPlatformBalances,
} from "../services/ledger";
import {
  ensureDefaultPricing,
  listPricingPolicies,
  listPricingRules,
} from "../services/pricing";
import {
  approveProviderRateCard,
  createManualPricingReviewProposal,
  ensureProviderCostCatalogue,
  getProviderRateCard,
  listPricingReviews,
  listProviderRateCards,
  updateDraftRateCardItems,
} from "../services/provider-costs";
import {
  listFinancialExceptions,
  runFinancialReconciliation,
} from "../services/reconciliation";
import {
  getUsageCommercialSummary,
  listPlatformUsage,
} from "../services/usage";
import {
  groupLedgerCharges,
  groupOperationsIntoInteractions,
} from "../services/interactions";
import {
  createServiceIdentity,
  listServiceIdentities,
  rotateServiceIdentityToken,
  setServiceIdentityStatus,
  getServiceIdentity,
  type ServiceIdentityType,
} from "../services/service-identities";
import { resolveServiceIdentityScopesForCompany } from "../services/service-identity-scopes";
import { getCompanyBillingMode } from "../services/company-billing-mode";
import {
  createTopUpCheckoutIntent,
  getTopUpCheckoutStatus,
  getStripeMode,
  isAllowedTopUpAmountCents,
  isStripeConfigured,
  isStripeTestModeActive,
  listRecentTopUps,
  minimumTopUpAmountCents,
  processStripeWebhookEvent,
  stripePaymentsAllowed,
  verifyStripeWebhookSignature,
} from "../services/stripe";
import { getPlatformPaymentProviderStatus, getCompanyPaymentProviderStatus, DEFAULT_AUTO_TOPUP_AMOUNT_CENTS, DEFAULT_AUTO_TOPUP_THRESHOLD_CENTS } from "../services/payment-providers";
import { classifyLedgerCredit } from "../services/wallet-credits";
import {
  getCompanySettings,
  updateAutoTopUpSettings,
  updateCompanySettings,
} from "../services/company-settings";
import { getSpendThisMonthCents } from "../services/wallet-metrics";
import {
  createStripePaymentMethodSetupSession,
  getStripePaymentMethodStatus,
} from "../services/stripe";
import {
  infraGatewayExecuteUrl,
  infraMcpGatewayUrl,
  portalOrigin,
  infraBrowserPublicBase,
} from "../services/public-urls";
import {
  getUserCompanyRole,
  userHasCompanyAccess,
} from "../permissions/service";
import {
  getAiUserConnection,
  isAiChannelEnabled,
  oauthIssuer,
  revokeHumanOauthGrant,
  setAiChannelEnabled,
} from "../auth/mcp-oauth";
import { registerCommand6Routes } from "./command6";
import { newId, nowIso } from "../db/mappers";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const phase3 = new Hono<AppEnv>();

async function companyFromSlug(db: D1Database, slug: string) {
  return getCompanyBySlug(db, slug);
}

function canManageCompany(user: AuthVariables["user"], companyId: string) {
  if (user.isPlatformAdmin) return true;
  const role = getUserCompanyRole(user, companyId);
  return role === "company_admin" || role === "director";
}

async function countActiveCompanyAdmins(db: D1Database, companyId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM company_memberships
       WHERE company_id = ? AND role = 'company_admin' AND status = 'active'`,
    )
    .bind(companyId)
    .first();
  return Number(row?.count ?? 0);
}

async function assertNotLastCompanyAdmin(
  db: D1Database,
  companyId: string,
  userId: string,
  nextRole?: CompanyRole,
  disabling?: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const membership = await db
    .prepare(
      `SELECT role, status FROM company_memberships WHERE company_id = ? AND user_id = ?`,
    )
    .bind(companyId, userId)
    .first();
  if (!membership) return { ok: true };
  const isAdmin =
    String(membership.role) === "company_admin" && String(membership.status) === "active";
  if (!isAdmin) return { ok: true };
  const removingAdmin =
    disabling || (nextRole != null && nextRole !== "company_admin");
  if (!removingAdmin) return { ok: true };
  const adminCount = await countActiveCompanyAdmins(db, companyId);
  if (adminCount <= 1) {
    return {
      ok: false,
      error: "Cannot remove or demote the last company administrator",
    };
  }
  return { ok: true };
}

// ---------- Gateway ----------

phase3.post("/api/gateway/v1/execute", async (c) => {
  const token = readSessionCookie(c.req.header("Cookie") ?? null);
  const sessionUser = token
    ? await verifySessionToken(token, c.env.SESSION_SECRET)
    : null;

  const actorResult = await resolveGatewayActor(c.env, c.req.raw, sessionUser);
  if ("error" in actorResult) {
    return c.json({ error: actorResult.error }, actorResult.status);
  }

  const body = await c.req.json<{
    companyId?: string;
    companySlug?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    mcpEnvironmentId?: string;
    sourceClient?: string;
    clientRequestId?: string;
    requestId?: string;
  }>();

  let companyId = body.companyId;
  if (!companyId && body.companySlug) {
    const company = await getCompanyBySlug(c.env.DB, body.companySlug);
    companyId = company?.id;
  }
  if (!companyId && actorResult.type === "service") {
    companyId = actorResult.identity.companyId;
  }

  if (!companyId || !body.toolName) {
    return c.json({ error: "companyId and toolName are required" }, 400);
  }

  const result = await executeGatewayRequest(c.env, {
    actor: actorResult,
    companyId,
    toolName: body.toolName,
    arguments: body.arguments,
    mcpEnvironmentId: body.mcpEnvironmentId,
    sourceClient:
      body.sourceClient ??
      c.req.header("X-Infra-Client") ??
      (actorResult.type === "service"
        ? actorResult.identity.identityType
        : "gateway"),
    clientRequestId:
      body.clientRequestId ??
      body.requestId ??
      c.req.header("X-Infra-Request-Id") ??
      null,
  });

  if (result.status !== 200) {
    return c.json(
      {
        error: result.error,
        code: "code" in result ? result.code : undefined,
        correlationId: result.correlationId,
        action: "action" in result ? result.action : undefined,
        riskClass: "riskClass" in result ? result.riskClass : undefined,
        balanceCents: "balanceCents" in result ? result.balanceCents : undefined,
        requiredCents:
          "requiredCents" in result ? result.requiredCents : undefined,
      },
      result.status,
    );
  }

  return c.json(result);
});

// MCP protocol facade — ChatGPT/Claude should connect here, not to company MCP directly
phase3.all("/api/gateway/v1/mcp", async (c) => {
  const token = readSessionCookie(c.req.header("Cookie") ?? null);
  const sessionUser = token
    ? await verifySessionToken(token, c.env.SESSION_SECRET)
    : null;
  return handleInfraMcpHttp(c.env, c.req.raw, sessionUser);
});

phase3.get("/api/gateway/v1/health", (c) =>
  c.json({
    status: "ok",
    service: "infra-gateway",
    version: "v1",
    stripeConfigured: isStripeConfigured(c.env),
    stripeMode: getStripeMode(c.env),
    stripePaymentsAllowed: stripePaymentsAllowed(c.env),
    mcpFacade: "/api/gateway/v1/mcp",
  }),
);

// ---------- Company wallet / billing ----------

phase3.get("/api/companies/:slug/wallet", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const [wallet, ledger, recentTopUps, spendThisMonthCents, settings] = await Promise.all([
    getWalletBalance(c.env.DB, company.id),
    listLedgerEntries(c.env.DB, company.id, 30),
    listRecentTopUps(c.env.DB, company.id, 10),
    getSpendThisMonthCents(c.env.DB, company.id),
    getCompanySettings(c.env.DB, company.id),
  ]);

  const credits = classifyLedgerCredit(
    await listLedgerEntries(c.env.DB, company.id, 500),
  );
  const payments = await getCompanyPaymentProviderStatus(c.env, c.env.DB, company.id);
  return c.json({
    wallet: {
      ...wallet,
      testCreditCents: credits.testCents,
      paidCreditCents: credits.paidCents,
      spendThisMonthCents,
    },
    ledger,
    chargeGroups: groupLedgerCharges(ledger),
    recentTopUps,
    stripeConfigured: payments.configured,
    paymentProvider: payments,
    topUpOptionsCents: payments.topUpOptionsCents,
    billing: {
      spendThisMonthCents,
      monthStartUtc: new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
      ).toISOString(),
      lowBalanceThresholdCents: settings?.lowBalanceThresholdCents ?? wallet.lowBalanceThresholdCents,
    },
  });
});

phase3.get("/api/companies/:slug/wallet/top-up/:checkoutId", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  const checkoutId = c.req.param("checkoutId");
  if (!checkoutId) return c.json({ error: "checkoutId required" }, 400);
  const status = await getTopUpCheckoutStatus(c.env, company.id, checkoutId);
  if (!status) return c.json({ error: "Top-up not found" }, 404);
  return c.json({ checkout: status });
});

phase3.post("/api/companies/:slug/wallet/top-up", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (String(company.status) === "suspended") {
    return c.json({ error: "Company is suspended" }, 403);
  }
  if (company.archivedAt) {
    return c.json({ error: "Company is archived" }, 403);
  }
  const user = c.get("user");
  if (!canManageCompany(user, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{
    amountCents?: number;
    successUrl?: string;
    cancelUrl?: string;
  }>();

  const companyBillingMode = await getCompanyBillingMode(c.env.DB, company.id);
  const minAmountCents = minimumTopUpAmountCents(c.env, companyBillingMode);
  if (!body.amountCents || body.amountCents < minAmountCents) {
    return c.json(
      {
        error: `amountCents must be at least ${minAmountCents} (£${(minAmountCents / 100).toFixed(2)})`,
      },
      400,
    );
  }
  if (!isAllowedTopUpAmountCents(body.amountCents, c.env, companyBillingMode)) {
    return c.json(
      {
        error: isStripeTestModeActive(c.env)
          ? "Invalid top-up amount. Allowed: £1 (sandbox), £5, £10, £25, £50, £100."
          : companyBillingMode === "live"
            ? "Invalid top-up amount. Allowed: £1 (live acceptance), £5, £10, £25, £50, £100."
            : "Invalid top-up amount. Allowed preset amounts: £5, £10, £25, £50, £100.",
      },
      400,
    );
  }

  const origin = portalOrigin(c.env, c.req.header("Origin"));
  const result = await createTopUpCheckoutIntent(c.env, {
    companyId: company.id,
    companyName: company.name,
    amountCents: body.amountCents,
    createdBy: user.email,
    successUrl:
      body.successUrl ??
      `${origin}/portal/${company.slug}/billing?topup=success`,
    cancelUrl:
      body.cancelUrl ??
      `${origin}/portal/${company.slug}/billing?topup=cancelled`,
  });

  if (!result.configured && "error" in result) {
    return c.json({ error: result.error, stripeConfigured: false }, 400);
  }

  return c.json(result);
});

phase3.get("/api/companies/:slug/wallet/payment-method", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  const user = c.get("user");
  const status = await import("../services/stripe").then((m) =>
    m.reconcilePaymentMethodFromStripe(c.env, {
      companyId: company.id,
      companyName: company.name,
      actorEmail: user.email,
    }),
  );
  return c.json({ paymentMethod: status });
});

phase3.post("/api/companies/:slug/wallet/payment-method/setup", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!canManageCompany(c.get("user"), company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }
  const user = c.get("user");
  const origin = portalOrigin(c.env, c.req.header("Origin"));
  const result = await createStripePaymentMethodSetupSession(c.env, {
    companyId: company.id,
    companyName: company.name,
    actorEmail: user.email,
    successUrl: `${origin}/portal/${company.slug}/billing?tab=payment&setup=complete`,
    cancelUrl: `${origin}/portal/${company.slug}/billing?tab=payment&setup=cancelled`,
  });
  if (!result.configured) {
    return c.json({ error: result.error, stripeConfigured: false }, 400);
  }
  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "payment_method.setup_started",
    actor: user.email,
    resourceType: "stripe_customer",
    resourceId: result.customerId,
  });
  return c.json({
    url: result.url,
    sessionId: result.sessionId,
    stripeConfigured: true,
    testMode: isStripeTestModeActive(c.env),
  });
});

phase3.put("/api/companies/:slug/wallet/auto-topup", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!canManageCompany(c.get("user"), company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }
  const body = await c.req.json<{
    enabled?: boolean;
    thresholdCents?: number;
    amountCents?: number;
    confirm?: boolean;
  }>();
  if (body.enabled && !body.confirm) {
    return c.json({ error: "Explicit confirmation required to enable auto top-up" }, 400);
  }
  const current = await getCompanySettings(c.env.DB, company.id);
  const patch = {
    enabled: Boolean(body.enabled),
    thresholdCents:
      body.thresholdCents ?? current?.autoTopUp.thresholdCents ?? DEFAULT_AUTO_TOPUP_THRESHOLD_CENTS,
    amountCents:
      body.amountCents ?? current?.autoTopUp.amountCents ?? DEFAULT_AUTO_TOPUP_AMOUNT_CENTS,
  };
  const updated = await updateAutoTopUpSettings(c.env.DB, company.id, patch);
  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: patch.enabled ? "auto_topup.enabled" : "auto_topup.disabled",
    actor: c.get("user").email,
    resourceType: "company_commercial_settings",
    resourceId: company.id,
    detail: patch,
  });
  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "auto_topup.updated",
    actor: c.get("user").email,
    resourceType: "company_commercial_settings",
    resourceId: company.id,
    detail: patch,
  });
  return c.json({ settings: updated.autoTopUp });
});

phase3.get("/api/companies/:slug/settings", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  const settings = await getCompanySettings(c.env.DB, company.id);
  if (!settings) return c.json({ error: "Company not found" }, 404);
  return c.json({ settings });
});

phase3.patch("/api/companies/:slug/settings", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!canManageCompany(c.get("user"), company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }
  const body = await c.req.json<Parameters<typeof updateCompanySettings>[2]>();
  try {
    const settings = await updateCompanySettings(c.env.DB, company.id, body);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "company.settings.updated",
      actor: c.get("user").email,
      resourceType: "company",
      resourceId: company.id,
      detail: { fields: Object.keys(body) },
    });
    return c.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to save settings";
    return c.json({ error: message }, 400);
  }
});

phase3.post(
  "/api/companies/:slug/wallet/manual-credit",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    const body = await c.req.json<{
      amountCents?: number;
      description?: string;
      creditClass?: "paid" | "promotional";
      reason?: string;
      internalNote?: string;
    }>();
    if (!body.amountCents || body.amountCents === 0) {
      return c.json({ error: "amountCents is required" }, 400);
    }
    if (!body.reason?.trim()) {
      return c.json({ error: "reason is required for admin credit grants" }, 400);
    }

    const isPromotional = body.creditClass !== "paid";
    if (isPromotional) {
      const result = await import("../services/promotional-grants").then((m) =>
        m.grantPromotionalCredit(c.env.DB, {
          companyId: company.id,
          amountCents: body.amountCents!,
          reason: body.reason!.trim(),
          internalNote: body.internalNote,
          grantedBy: c.get("user").email,
          description: body.description ?? body.reason!.trim(),
        }),
      );
      await recordAuditEvent(c.env.DB, {
        companyId: company.id,
        eventType: "wallet.credited",
        actor: c.get("user").email,
        resourceType: "promotional_credit_grant",
        resourceId: result.grantId,
        detail: {
          amountCents: body.amountCents,
          creditClass: "promotional",
          reason: body.reason!.trim(),
        },
      });
      return c.json({ grantId: result.grantId, ledgerEntryId: result.ledgerEntryId });
    }

    const entryType = "manual_credit";
    const entry = await appendLedgerEntry(c.env.DB, {
      companyId: company.id,
      entryType,
      amountCents: body.amountCents,
      description: body.description ?? body.reason.trim(),
      referenceType: "manual",
      referenceId: newId("manual"),
      createdBy: c.get("user").email,
      metadata: {
        creditClass: "paid",
        paid: true,
        reason: body.reason.trim(),
        internalNote: body.internalNote?.trim() ?? null,
        grantedBy: c.get("user").email,
      },
    });

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "wallet.credited",
      actor: c.get("user").email,
      resourceType: "ledger",
      resourceId: entry.entry.id,
      detail: {
        amountCents: body.amountCents,
        creditClass: isPromotional ? "promotional" : "paid",
        reason: body.reason.trim(),
      },
    });

    return c.json(entry);
  },
);

phase3.get("/api/billing/balances", requireAuth, requirePlatformAdmin, async (c) => {
  const { listEnrichedPlatformBalances } = await import("../services/billing-admin");
  return c.json(await listEnrichedPlatformBalances(c.env.DB));
});

phase3.get("/api/billing/summary", requireAuth, requirePlatformAdmin, async (c) => {
  const { getBillingPlatformSummary } = await import("../services/billing-admin");
  return c.json(await getBillingPlatformSummary(c.env.DB));
});

phase3.get("/api/billing/ledger", requireAuth, requirePlatformAdmin, async (c) => {
  const { listPlatformLedger } = await import("../services/billing-admin");
  const creditClass = c.req.query("creditClass");
  return c.json(
    await listPlatformLedger(c.env.DB, {
      companyId: c.req.query("companyId") ?? undefined,
      from: c.req.query("from") ?? undefined,
      to: c.req.query("to") ?? undefined,
      entryType: c.req.query("entryType") ?? undefined,
      creditClass:
        creditClass === "paid" || creditClass === "promotional"
          ? creditClass
          : undefined,
      q: c.req.query("q") ?? undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : 200,
    }),
  );
});

phase3.get("/api/billing/ledger/export", requireAuth, requirePlatformAdmin, async (c) => {
  const { listPlatformLedger, platformLedgerToCsv } = await import(
    "../services/billing-admin"
  );
  const creditClass = c.req.query("creditClass");
  const rows = await listPlatformLedger(c.env.DB, {
    companyId: c.req.query("companyId") ?? undefined,
    from: c.req.query("from") ?? undefined,
    to: c.req.query("to") ?? undefined,
    entryType: c.req.query("entryType") ?? undefined,
    creditClass:
      creditClass === "paid" || creditClass === "promotional"
        ? creditClass
        : undefined,
    q: c.req.query("q") ?? undefined,
    limit: 5000,
  });
  const csv = platformLedgerToCsv(rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="infra-ledger-export.csv"',
    },
  });
});

phase3.get("/api/billing/balances-legacy", requireAuth, requirePlatformAdmin, async (c) => {
  const balances = await listPlatformBalances(c.env.DB);
  return c.json(balances);
});

phase3.get("/api/billing/overview", requireAuth, requirePlatformAdmin, async (c) => {
  const balances = await listPlatformBalances(c.env.DB);
  const payments = getPlatformPaymentProviderStatus(c.env);
  const totalCents = balances.reduce((sum, row) => sum + row.balanceCents, 0);
  const low = balances.filter((row) => row.lowBalance);
  return c.json({
    paymentProvider: payments,
    tide: {
      role: "payout_destination",
      integrated: false,
      note: "Stripe payouts settle to the Tide business bank account. No Tide API is required.",
    },
    totalWalletCents: totalCents,
    companyCount: balances.length,
    lowBalanceCompanies: low,
    balances,
  });
});

phase3.get("/api/pricing/rules", requireAuth, async (c) => {
  const companyId = c.req.query("companyId");
  if (companyId && !userHasCompanyAccess(c.get("user"), companyId)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  const [rules, policies] = await Promise.all([
    listPricingRules(c.env.DB, companyId),
    listPricingPolicies(c.env.DB),
  ]);
  return c.json({ rules, policies });
});

phase3.post("/api/pricing/policies", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{
    companyId?: string | null;
    targetMarginBps?: number;
    minimumChargeCents?: number;
    label?: string;
  }>();
  if (body.targetMarginBps == null || body.minimumChargeCents == null) {
    return c.json({ error: "targetMarginBps and minimumChargeCents required" }, 400);
  }
  const { createPricingPolicyVersion } = await import("../services/pricing-admin");
  const policy = await createPricingPolicyVersion(c.env.DB, {
    companyId: body.companyId ?? null,
    targetMarginBps: body.targetMarginBps,
    minimumChargeCents: body.minimumChargeCents,
    label: body.label ?? "Updated pricing policy",
    actor: c.get("user").email,
  });
  return c.json({ policy });
});

phase3.post("/api/pricing/preview", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{
    companyId?: string | null;
    action?: string;
    underlyingCostMicros?: number | null;
    underlyingCostCents?: number | null;
  }>();
  if (!body.action) return c.json({ error: "action required" }, 400);
  const { previewPricingCharge } = await import("../services/pricing-admin");
  return c.json(
    await previewPricingCharge(c.env.DB, {
      companyId: body.companyId ?? null,
      action: body.action,
      underlyingCostMicros: body.underlyingCostMicros ?? null,
      underlyingCostCents: body.underlyingCostCents ?? null,
    }),
  );
});

// ---------- Stripe webhook ----------

phase3.post("/api/stripe/webhook", async (c) => {
  const payload = await c.req.text();
  const signature = c.req.header("Stripe-Signature");

  if (!isStripeConfigured(c.env)) {
    return c.json(
      {
        error: "Stripe is not configured",
        requiredSecrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      },
      503,
    );
  }

  const valid = await verifyStripeWebhookSignature(
    c.env,
    payload,
    signature ?? null,
  );
  if (!valid) {
    await recordAuditEvent(c.env.DB, {
      companyId: null,
      eventType: "webhook.rejected",
      actor: "stripe-webhook",
      resourceType: "stripe_event",
      resourceId: null,
      detail: {
        reason: signature ? "invalid_signature" : "missing_signature",
        endpoint: "/api/stripe/webhook",
      },
    });
    return c.json({ error: "Invalid Stripe signature" }, 400);
  }

  const event = JSON.parse(payload) as {
    id: string;
    type: string;
    data?: unknown;
  };

  const result = await processStripeWebhookEvent(c.env, {
    stripeEventId: event.id,
    eventType: event.type,
    payload: event as unknown as Record<string, unknown>,
  });

  return c.json(result);
});

// ---------- Users / invites ----------

phase3.post("/api/companies/:slug/users/invite", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const user = c.get("user");
  if (!canManageCompany(user, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{
    email?: string;
    displayName?: string;
    role?: CompanyRole;
    teamId?: string;
    customRoleId?: string;
  }>();

  if (!body.email || !body.displayName || !body.role) {
    return c.json({ error: "email, displayName, and role are required" }, 400);
  }

  const origin = portalOrigin(c.env, c.req.header("Origin"));
  try {
    const invited = await import("../services/invitations").then((m) =>
      m.createCompanyInvitation(c.env, {
        companyId: company.id,
        companyName: company.name,
        companySlug: company.slug,
        email: body.email!,
        displayName: body.displayName!,
        role: body.role!,
        invitedBy: user.email,
        inviterName: user.displayName,
        teamId: body.teamId,
        customRoleId: body.customRoleId,
        origin,
      }),
    );

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "user.created",
      actor: user.email,
      resourceType: "user",
      resourceId: invited.user.id,
      detail: { role: body.role, emailSent: invited.emailSent },
    });

    return c.json({
      user: {
        id: invited.user.id,
        email: invited.user.email,
        displayName: invited.user.displayName,
        status: invited.user.status,
      },
      role: body.role,
      setupUrl: invited.setupUrl,
      setupTokenExpiresAt: invited.expiresAt,
      emailSent: invited.emailSent,
      emailError: invited.emailError,
      setupToken: invited.setupToken,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === "DUPLICATE_ACTIVE_INVITATION"
    ) {
      const invitationId = (err as Error & { invitationId?: string }).invitationId;
      const invitations = await import("../services/invitations").then((m) =>
        m.listCompanyInvitations(c.env.DB, company.id),
      );
      const existing = invitations.find((i) => i.id === invitationId);
      return c.json(
        {
          error:
            "An active invitation already exists for this email. Resend or cancel it instead of creating a duplicate.",
          code: "DUPLICATE_ACTIVE_INVITATION",
          existingInvitation: existing ?? null,
        },
        409,
      );
    }
    throw err;
  }
});

phase3.post("/api/companies/:slug/users/:userId/status", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const actor = c.get("user");
  if (!canManageCompany(actor, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{ status?: "active" | "disabled" }>();
  if (!body.status) return c.json({ error: "status is required" }, 400);

  const targetId = c.req.param("userId");
  if (targetId === actor.userId) {
    return c.json({ error: "Cannot change your own status" }, 400);
  }

  if (body.status === "disabled") {
    const guard = await assertNotLastCompanyAdmin(
      c.env.DB,
      company.id,
      targetId,
      undefined,
      true,
    );
    if (!guard.ok) return c.json({ error: guard.error }, 400);
  }

  await setMembershipStatus(c.env.DB, targetId, company.id, body.status);
  // Also disable platform login if membership revoked and not platform admin
  const target = await getUserById(c.env.DB, targetId);
  if (target && !target.isPlatformAdmin && body.status === "disabled") {
    await setUserStatus(c.env.DB, targetId, "disabled");
  }
  if (target && body.status === "active") {
    await setUserStatus(c.env.DB, targetId, "active");
  }

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: body.status === "disabled" ? "user.disabled" : "role.changed",
    actor: actor.email,
    resourceType: "user",
    resourceId: targetId,
    detail: { status: body.status },
  });

  return c.json({ ok: true, userId: targetId, status: body.status });
});

phase3.post("/api/companies/:slug/users/:userId/reset-password", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const actor = c.get("user");
  if (!canManageCompany(actor, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const targetId = c.req.param("userId");
  if (targetId === actor.userId) {
    return c.json({ error: "Use forgot password to change your own password" }, 400);
  }

  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.isPlatformAdmin) {
    return c.json({ error: "Platform administrator passwords cannot be reset here" }, 403);
  }

  const membership = await c.env.DB
    .prepare(
      `SELECT id FROM company_memberships WHERE company_id = ? AND user_id = ? AND status = 'active'`,
    )
    .bind(company.id, targetId)
    .first();
  if (!membership) {
    return c.json({ error: "User is not an active member of this company" }, 404);
  }

  const body = await c.req.json<{ temporaryPassword?: string }>().catch(() => ({}));
  const origin = portalOrigin(c.env, c.req.header("Origin"));

  if (body.temporaryPassword) {
    const passwordError = validateNewPassword(body.temporaryPassword);
    if (passwordError) return c.json({ error: passwordError }, 400);

    await updateUserPassword(c.env.DB, targetId, body.temporaryPassword);
    const setup = await createPasswordSetupToken(c.env.DB, targetId, "password_setup");
    const setupUrl = `${origin}/setup-password?token=${encodeURIComponent(setup.token)}`;

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "user.password_reset",
      actor: actor.email,
      resourceType: "user",
      resourceId: targetId,
      detail: { mode: "temporary", initiatedBy: "company_admin" },
    });

    return c.json({
      ok: true,
      mode: "temporary" as const,
      setupUrl,
      expiresAt: setup.expiresAt,
      message:
        "Temporary password set. Share the secure setup link so the user can choose a permanent password.",
    });
  }

  const reset = await createPasswordSetupToken(c.env.DB, targetId, "password_reset");
  const resetUrl = `${origin}/setup-password?token=${encodeURIComponent(reset.token)}`;

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "user.password_reset",
    actor: actor.email,
    resourceType: "user",
    resourceId: targetId,
    detail: { mode: "link", initiatedBy: "company_admin" },
  });

  return c.json({
    ok: true,
    mode: "link" as const,
    resetUrl,
    expiresAt: reset.expiresAt,
    message: "Password reset link created. Share it securely with the user.",
  });
});

phase3.post("/api/companies/:slug/users/:userId/remove", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const actor = c.get("user");
  if (!canManageCompany(actor, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const targetId = c.req.param("userId");
  if (targetId === actor.userId) {
    return c.json({ error: "Cannot remove your own account" }, 400);
  }

  const guard = await assertNotLastCompanyAdmin(
    c.env.DB,
    company.id,
    targetId,
    undefined,
    true,
  );
  if (!guard.ok) return c.json({ error: guard.error }, 400);

  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ error: "User not found" }, 404);
  if (target.isPlatformAdmin) {
    return c.json({ error: "Platform administrators cannot be removed from a company portal" }, 403);
  }

  await setMembershipStatus(c.env.DB, targetId, company.id, "disabled");

  const otherActive = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS count FROM company_memberships
       WHERE user_id = ? AND status = 'active' AND company_id != ?`,
    )
    .bind(targetId, company.id)
    .first<{ count: number }>();

  if (!target.isPlatformAdmin && Number(otherActive?.count ?? 0) === 0) {
    await setUserStatus(c.env.DB, targetId, "disabled");
  }

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "user.removed",
    actor: actor.email,
    resourceType: "user",
    resourceId: targetId,
  });

  return c.json({ ok: true, userId: targetId });
});

phase3.post("/api/companies/:slug/users/:userId/role", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const actor = c.get("user");
  if (!canManageCompany(actor, company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{ role?: CompanyRole }>();
  if (!body.role) return c.json({ error: "role is required" }, 400);

  const targetId = c.req.param("userId");
  if (targetId === actor.userId && body.role !== "company_admin") {
    const guard = await assertNotLastCompanyAdmin(
      c.env.DB,
      company.id,
      targetId,
      body.role,
    );
    if (!guard.ok) return c.json({ error: guard.error }, 400);
  } else {
    const guard = await assertNotLastCompanyAdmin(
      c.env.DB,
      company.id,
      targetId,
      body.role,
    );
    if (!guard.ok) return c.json({ error: guard.error }, 400);
  }

  const membership = await updateMembershipRole(
    c.env.DB,
    targetId,
    company.id,
    body.role,
  );

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "user.role_changed",
    actor: actor.email,
    resourceType: "user",
    resourceId: c.req.param("userId"),
    detail: { role: body.role },
  });

  return c.json({ ok: true, membership });
});

// ---------- Service identities ----------

phase3.get("/api/companies/:slug/service-identities", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }
  return c.json(await listServiceIdentities(c.env.DB, company.id));
});

phase3.post("/api/companies/:slug/service-identities", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!canManageCompany(c.get("user"), company.id)) {
    return c.json({ error: "Company administrator access required" }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    identityType?: ServiceIdentityType;
    description?: string;
    scopes?: string[];
    mcpEnvironmentId?: string;
  }>();

  if (!body.name || !body.identityType) {
    return c.json({ error: "name and identityType are required" }, 400);
  }

  const mcps = await listMcpEnvironments(c.env.DB, company.id);
  const mcpId = body.mcpEnvironmentId ?? mcps[0]?.id ?? null;

  const created = await createServiceIdentity(c.env.DB, {
    companyId: company.id,
    name: body.name,
    identityType: body.identityType,
    description: body.description,
    scopes: body.scopes,
    mcpEnvironmentId: mcpId,
  });

  await recordAuditEvent(c.env.DB, {
    companyId: company.id,
    eventType: "credential.created",
    actor: c.get("user").email,
    resourceType: "service_identity",
    resourceId: created.identity.id,
    detail: { identityType: body.identityType, tokenPrefix: created.identity.tokenPrefix },
  });

  return c.json({
    identity: created.identity,
    token: created.token,
    warning: "Store this token securely. It will not be shown again.",
  });
});

phase3.post(
  "/api/companies/:slug/service-identities/:id/rotate",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const identity = await getServiceIdentity(c.env.DB, c.req.param("id"));
    if (!identity || identity.companyId !== company.id) {
      return c.json({ error: "Service identity not found" }, 404);
    }

    const rotated = await rotateServiceIdentityToken(c.env.DB, identity.id);
    if (!rotated) return c.json({ error: "Rotate failed" }, 500);

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "credential.rotated",
      actor: c.get("user").email,
      resourceType: "service_identity",
      resourceId: identity.id,
      detail: { tokenPrefix: rotated.identity.tokenPrefix },
    });

    return c.json({
      identity: rotated.identity,
      token: rotated.token,
      warning: "Store this token securely. It will not be shown again.",
    });
  },
);

phase3.post(
  "/api/companies/:slug/service-identities/:id/status",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const identity = await getServiceIdentity(c.env.DB, c.req.param("id"));
    if (!identity || identity.companyId !== company.id) {
      return c.json({ error: "Service identity not found" }, 404);
    }

    const body = await c.req.json<{ status?: "active" | "disabled" }>();
    if (!body.status) return c.json({ error: "status is required" }, 400);

    const updated = await setServiceIdentityStatus(
      c.env.DB,
      identity.id,
      body.status,
    );
    return c.json(updated);
  },
);

// ---------- AI client connections ----------

async function ensureDefaultAiConnections(
  db: D1Database,
  companyId: string,
): Promise<void> {
  const now = nowIso();
  const defaults: Array<{
    id: string;
    clientType: string;
    displayName: string;
    status: string;
    notes: string;
  }> = [
    {
      id: `ai_${companyId}_chatgpt`,
      clientType: "chatgpt",
      displayName: "ChatGPT",
      status: "ready_to_connect",
      notes:
        "Generate a service identity token, then configure ChatGPT to call the INFRA MCP facade with the Bearer token. Do not point ChatGPT at the company MCP directly.",
    },
    {
      id: `ai_${companyId}_claude`,
      clientType: "claude",
      displayName: "Claude",
      status: "ready_to_connect",
      notes:
        "Generate a service identity token, then configure Claude to call the INFRA MCP facade with the Bearer token.",
    },
    {
      id: `ai_${companyId}_whatsapp`,
      clientType: "whatsapp",
      displayName: "WhatsApp",
      status: "coming_soon",
      notes: "WhatsApp channel gateway is planned for a later phase.",
    },
  ];

  for (const item of defaults) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ai_client_connections
          (id, company_id, client_type, display_name, status, gateway_path, setup_notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '/api/gateway/v1/mcp', ?, ?, ?)`,
      )
      .bind(
        item.id,
        companyId,
        item.clientType,
        item.displayName,
        item.status,
        item.notes,
        now,
        now,
      )
      .run();
  }
}

phase3.get("/api/companies/:slug/ai-connections", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  await ensureDefaultAiConnections(c.env.DB, company.id);

  const rows = await c.env.DB.prepare(
    `SELECT * FROM ai_client_connections WHERE company_id = ? ORDER BY client_type ASC`,
  )
    .bind(company.id)
    .all();

  const apiBase = infraBrowserPublicBase(c.env, c.req.url, c.req.raw);
  const mcpUrl = infraMcpGatewayUrl(c.env, c.req.url, c.req.raw);
  const executeUrl = infraGatewayExecuteUrl(c.env, c.req.url);
  const identities = await listServiceIdentities(c.env.DB, company.id);
  const identityById = new Map(identities.map((item) => [item.id, item]));
  const viewer = c.get("user");
  const viewerCanManage = canManageCompany(viewer, company.id);
  const issuer = oauthIssuer(apiBase);
  const authorizeBase = `${issuer}/oauth/authorize`;

  return c.json(
    await Promise.all(
      (rows.results ?? []).map(async (row) => {
      const identityId = row.service_identity_id
        ? String(row.service_identity_id)
        : null;
      const identity = identityId ? identityById.get(identityId) : null;
      const status = String(row.status);
      const clientType = String(row.client_type);
      const channelEnabled = await isAiChannelEnabled(c.env.DB, company.id, clientType);
      const userConnection = await getAiUserConnection(
        c.env.DB,
        company.id,
        viewer.userId,
        clientType,
      );
      let tokenStatus = "Not Generated";
      if (identity?.status === "active" && identity.hasToken) tokenStatus = "Active";
      else if (identity?.status === "disabled") tokenStatus = "Revoked";
      else if (status === "connected" && !identity) tokenStatus = "Rotation Required";
      const userConnected = String(userConnection?.status ?? "") === "connected";

      return {
        id: String(row.id),
        companyId: String(row.company_id),
        companyName: company.name,
        clientType,
        displayName: String(row.display_name),
        status: channelEnabled ? (userConnected ? "connected" : "ready_to_connect") : status,
        channelEnabled,
        authMode: "oauth",
        viewerCanManageChannel: viewerCanManage,
        viewerCanConnect: userHasCompanyAccess(viewer, company.id),
        userConnectionStatus: userConnection
          ? String(userConnection.status)
          : "not_connected",
        serviceIdentityId: viewerCanManage ? identityId : null,
        serviceIdentityName: viewerCanManage ? identity?.name ?? null : null,
        serviceIdentityStatus: viewerCanManage ? identity?.status ?? null : null,
        scopes: identity?.scopes ?? [],
        tokenStatus: viewerCanManage ? tokenStatus : userConnected ? "Active" : "Not Generated",
        tokenPrefix: viewerCanManage ? identity?.tokenPrefix ?? null : null,
        connectionMethod: "INFRA OAuth",
        gatewayEndpoint: executeUrl,
        mcpEndpoint: mcpUrl,
        authorizationServer: issuer,
        oauthAuthorizeUrl: `${authorizeBase}?company=${encodeURIComponent(company.slug)}&channel=${encodeURIComponent(clientType)}`,
        gatewayPath: row.gateway_path ? String(row.gateway_path) : null,
        setupNotes: row.setup_notes ? String(row.setup_notes) : null,
        lastUsedAt: userConnection?.last_used_at
          ? String(userConnection.last_used_at)
          : identity?.lastUsedAt
            ? String(identity.lastUsedAt)
            : row.last_used_at
              ? String(row.last_used_at)
              : null,
        lastSuccessfulRequestAt: identity?.lastUsedAt
          ? String(identity.lastUsedAt)
          : null,
        requestCount: identity?.requestCount ?? 0,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
      }),
    ),
  );
});

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/enable",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const clientType = c.req.param("clientType");
    if (clientType !== "chatgpt" && clientType !== "claude") {
      return c.json({ error: "Unsupported AI client" }, 400);
    }
    await ensureDefaultAiConnections(c.env.DB, company.id);
    await setAiChannelEnabled(c.env.DB, company.id, clientType, true);
    await c.env.DB.prepare(
      `UPDATE ai_client_connections SET status = 'ready_to_connect', updated_at = ?
       WHERE company_id = ? AND client_type = ? AND status != 'connected'`,
    )
      .bind(nowIso(), company.id, clientType)
      .run();
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "ai_connection.enabled",
      actor: c.get("user").email,
      resourceType: "ai_connection",
      resourceId: clientType,
      detail: { stage: "ai_channel.enabled" },
    });
    return c.json({ ok: true, clientType, channelEnabled: true });
  },
);

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/disable",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const clientType = c.req.param("clientType");
    await setAiChannelEnabled(c.env.DB, company.id, clientType, false);
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "ai_connection.disabled",
      actor: c.get("user").email,
      resourceType: "ai_connection",
      resourceId: clientType,
      detail: { stage: "ai_channel.disabled" },
    });
    return c.json({ ok: true, clientType, channelEnabled: false });
  },
);

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/connect",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }

    const clientType = c.req.param("clientType");
    if (clientType === "whatsapp") {
      return c.json({ error: "WhatsApp is coming soon" }, 400);
    }
    if (clientType !== "chatgpt" && clientType !== "claude") {
      return c.json({ error: "Unsupported AI client" }, 400);
    }

    const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
    const mode = body.mode === "service_token" ? "service_token" : "oauth";
    await ensureDefaultAiConnections(c.env.DB, company.id);
    const mcpEndpoint = infraMcpGatewayUrl(c.env, c.req.url, c.req.raw);
    const gatewayEndpoint = infraGatewayExecuteUrl(c.env, c.req.url);
    const issuer = oauthIssuer(infraBrowserPublicBase(c.env, c.req.url, c.req.raw));

    if (mode === "oauth") {
      const enabled = await isAiChannelEnabled(c.env.DB, company.id, clientType);
      if (!enabled) {
        return c.json(
          {
            error:
              "ChatGPT is not enabled for this company yet. Ask a company administrator to enable it.",
            code: "channel_not_enabled",
          },
          403,
        );
      }
      return c.json({
        clientType,
        status: "ready_to_connect",
        authMode: "oauth",
        token: null,
        gatewayEndpoint,
        mcpEndpoint,
        authorizationServer: issuer,
        oauthAuthorizeUrl: `${issuer}/oauth/authorize?company=${encodeURIComponent(company.slug)}&channel=${encodeURIComponent(clientType)}`,
        setup: {
          preferred: "In ChatGPT, add an MCP app using OAuth. INFRA is the authorization authority. Do not use a bearer token or Microsoft login.",
          auth: "OAuth",
          mcpUrl: mcpEndpoint,
          authentication: "oauth",
          identityProvider: "infra",
        },
        warning: null,
      });
    }

    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const mcps = await listMcpEnvironments(c.env.DB, company.id);

    // Disable any previous identity for this AI connection before issuing a new token.
    const existing = await c.env.DB.prepare(
      `SELECT service_identity_id FROM ai_client_connections
       WHERE company_id = ? AND client_type = ?`,
    )
      .bind(company.id, clientType)
      .first();
    if (existing?.service_identity_id) {
      await setServiceIdentityStatus(
        c.env.DB,
        String(existing.service_identity_id),
        "disabled",
      );
    }

    const aiScopes = await resolveServiceIdentityScopesForCompany(
      c.env.DB,
      company.id,
    );

    const created = await createServiceIdentity(c.env.DB, {
      companyId: company.id,
      name: `${company.name} ${clientType === "chatgpt" ? "ChatGPT" : "Claude"}`,
      identityType: clientType,
      scopes: aiScopes,
      mcpEnvironmentId: mcps[0]?.id ?? null,
    });

    const setupNotes =
      `REQUIRED: Connect ${clientType === "chatgpt" ? "ChatGPT" : "Claude"} to ${mcpEndpoint} with Authorization: Bearer <token>. ` +
      `Direct company MCP URLs are blocked (401 Unauthorized) and will not work. ` +
      `Remove any company MCP connector from the AI client.`;

    await c.env.DB.prepare(
      `UPDATE ai_client_connections
       SET status = 'connected', service_identity_id = ?, setup_notes = ?,
           gateway_path = ?, updated_at = ?
       WHERE company_id = ? AND client_type = ?`,
    )
      .bind(
        created.identity.id,
        setupNotes,
        "/api/gateway/v1/mcp",
        nowIso(),
        company.id,
        clientType,
      )
      .run();

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "ai_connection.created",
      actor: c.get("user").email,
      resourceType: "ai_connection",
      resourceId: clientType,
      detail: {
        stage: "ai_connection.token_issued",
        mcpEndpoint,
        identityId: created.identity.id,
        previousIdentityDisabled: Boolean(existing?.service_identity_id),
      },
    });

    return c.json({
      clientType,
      status: "connected",
      identity: created.identity,
      token: created.token,
      gatewayEndpoint,
      mcpEndpoint,
      setup: {
        preferred: "Connect ChatGPT/Claude MCP ONLY to mcpEndpoint with Bearer token",
        auth: "Authorization: Bearer <token>",
        mcpUrl: mcpEndpoint,
        removeDirectCompanyMcp: true,
        restBody: {
          companyId: company.id,
          toolName: "search_company_knowledge",
          arguments: { query: "..." },
          clientRequestId: "unique-per-logical-request",
        },
        critical:
          "Company MCP public access is locked. ChatGPT MUST use the INFRA MCP facade.",
      },
      warning:
        "Copy this token now. You will not be able to view it again.",
    });
  },
);

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/revoke-self",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }
    const clientType = c.req.param("clientType");
    const user = c.get("user");
    await revokeHumanOauthGrant(c.env.DB, user.userId, company.id);
    await c.env.DB.prepare(
      `UPDATE ai_user_connections
       SET status = 'revoked', updated_at = ?
       WHERE company_id = ? AND user_id = ? AND client_type = ?`,
    )
      .bind(nowIso(), company.id, user.userId, clientType)
      .run();
    return c.json({ ok: true, status: "revoked", clientType, scope: "self" });
  },
);

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/revoke",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const clientType = c.req.param("clientType");
    const row = await c.env.DB.prepare(
      `SELECT * FROM ai_client_connections WHERE company_id = ? AND client_type = ?`,
    )
      .bind(company.id, clientType)
      .first();
    if (!row) return c.json({ error: "AI connection not found" }, 404);

    if (row.service_identity_id) {
      await setServiceIdentityStatus(
        c.env.DB,
        String(row.service_identity_id),
        "disabled",
      );
    }
    const { revokeHumanOauthForCompany } = await import("../auth/mcp-oauth");
    await revokeHumanOauthForCompany(c.env.DB, company.id, clientType);
    await c.env.DB.prepare(
      `UPDATE ai_client_connections
       SET status = 'ready_to_connect', service_identity_id = NULL, updated_at = ?
       WHERE company_id = ? AND client_type = ?`,
    )
      .bind(nowIso(), company.id, clientType)
      .run();

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "ai_connection.revoked",
      actor: c.get("user").email,
      resourceType: "ai_connection",
      resourceId: clientType,
      detail: { stage: "ai_connection.revoked" },
    });

    return c.json({ ok: true, status: "ready_to_connect", clientType });
  },
);

phase3.post(
  "/api/companies/:slug/ai-connections/:clientType/test",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access to this company is denied" }, 403);
    }
    const clientType = c.req.param("clientType");
    const row = await c.env.DB.prepare(
      `SELECT * FROM ai_client_connections WHERE company_id = ? AND client_type = ?`,
    )
      .bind(company.id, clientType)
      .first();
    if (!row) return c.json({ error: "AI connection not found" }, 404);

    const health = await executeGatewayRequest(c.env, {
      actor: { type: "user", user: c.get("user"), channel: "portal" },
      companyId: company.id,
      toolName: "system_health",
      sourceClient: `${clientType}-test`,
      requireCredit: false,
      clientRequestId: `ai-test-health-${Date.now()}`,
    });

    // Non-billable connectivity check only — do not run chargeable knowledge.search here.
    const status = health.status === 200 ? "HEALTHY" : "FAILED";

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "company.accessed",
      actor: c.get("user").email,
      resourceType: "ai_connection",
      resourceId: clientType,
      detail: {
        stage: "ai_connection.tested",
        status,
        healthStatus: health.status,
        billable: false,
      },
    });

    return c.json({
      status,
      message:
        status === "HEALTHY"
          ? "Authentication, tenant resolution, gateway, and MCP health succeeded"
          : health.error ?? "Connection test failed",
      checks: {
        authentication: "passed",
        tenantResolution: "passed",
        permissions: "passed",
        wallet: health.status === 402 ? "failed" : "passed",
        gateway: health.status === 200 ? "passed" : "failed",
        mcp: health.status === 200 ? "passed" : "failed",
      },
      mcpEndpoint: infraMcpGatewayUrl(c.env, c.req.url),
    });
  },
);

// ---------- Connector instances (framework: configure without secrets in response) ----------

phase3.post(
  "/api/companies/:slug/connectors/:definitionId/instances",
  requireAuth,
  async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }

    const body = await c.req.json<{
      name?: string;
      config?: Record<string, unknown>;
      secretRef?: string;
      secretLabel?: string;
    }>();

    const definitionId = c.req.param("definitionId");
    const id = newId("ci");
    const now = nowIso();
    const name = body.name ?? `${company.name} connector`;

    const { sanitizeConnectorConfig } = await import(
      "../services/connector-credentials"
    );
    const safeConfig = sanitizeConnectorConfig(body.config);

    if (body.secretRef && /secret|token|password|apikey/i.test(body.secretRef) && body.secretRef.length > 80) {
      return c.json(
        { error: "Plaintext secrets are not accepted. Store a secret reference only." },
        409,
      );
    }

    await c.env.DB.prepare(
      `INSERT INTO connector_instances (
        id, company_id, connector_definition_id, name, status, config_json,
        sync_settings_json, data_environment_id, last_sync_at, last_sync_status,
        last_sync_message, health_status, health_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, NULL, NULL, 'unknown', 'Awaiting credentials', ?, ?)`,
    )
      .bind(
        id,
        company.id,
        definitionId,
        name,
        JSON.stringify(safeConfig),
        JSON.stringify({ enabled: false, mode: "manual", schedule: null }),
        now,
        now,
      )
      .run();

    if (body.secretRef) {
      await c.env.DB.prepare(
        `INSERT INTO credential_refs (
          id, company_id, connector_instance_id, label, provider, secret_ref,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      )
        .bind(
          newId("cred"),
          company.id,
          id,
          body.secretLabel ?? "Primary credential",
          definitionId,
          body.secretRef,
          now,
          now,
        )
        .run();
    }

    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "connector.instance_created",
      actor: c.get("user").email,
      resourceType: "connector",
      resourceId: id,
      detail: { definitionId, hasSecretRef: Boolean(body.secretRef) },
    });

    const row = await c.env.DB.prepare(
      `SELECT * FROM connector_instances WHERE id = ?`,
    )
      .bind(id)
      .first();

    return c.json({
      id,
      companyId: company.id,
      connectorDefinitionId: definitionId,
      name,
      status: "draft",
      config: safeConfig,
      // Never return secret values
      credentialConfigured: Boolean(body.secretRef),
      createdAt: now,
    });
  },
);

phase3.get("/api/companies/:slug/credentials", requireAuth, async (c) => {
  const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!userHasCompanyAccess(c.get("user"), company.id)) {
    return c.json({ error: "Access to this company is denied" }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, company_id, connector_instance_id, label, provider, status, expires_at, created_at, updated_at
     FROM credential_refs WHERE company_id = ?`,
  )
    .bind(company.id)
    .all();

  // Intentionally omit secret_ref from list responses for company users;
  // platform admin may see ref name only (not value).
  return c.json(
    (rows.results ?? []).map((row) => ({
      id: String(row.id),
      companyId: String(row.company_id),
      connectorInstanceId: row.connector_instance_id
        ? String(row.connector_instance_id)
        : null,
      label: String(row.label),
      provider: String(row.provider),
      status: String(row.status),
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      hasSecretRef: true,
    })),
  );
});

// ---------- Commercial / pricing admin ----------

phase3.get("/api/commercial/summary", requireAuth, requirePlatformAdmin, async (c) => {
  await ensureDefaultPricing(c.env.DB);
  await ensureProviderCostCatalogue(c.env.DB);
  const [usage, policies, rules, cards, exceptions] = await Promise.all([
    getUsageCommercialSummary(c.env.DB),
    listPricingPolicies(c.env.DB),
    listPricingRules(c.env.DB),
    listProviderRateCards(c.env.DB),
    listFinancialExceptions(c.env.DB, "open"),
  ]);
  return c.json({
    usage,
    policies,
    rules,
    providerRateCards: cards,
    openIntegrityExceptions: exceptions.length,
  });
});

phase3.get("/api/commercial/usage", requireAuth, requirePlatformAdmin, async (c) => {
  const companyId = c.req.query("companyId") || undefined;
  const sourceClient = c.req.query("sourceClient") || undefined;
  const successParam = c.req.query("success");
  const success =
    successParam === "1" || successParam === "true"
      ? true
      : successParam === "0" || successParam === "false"
        ? false
        : undefined;
  const [records, summary] = await Promise.all([
    listPlatformUsage(c.env.DB, 100, { companyId, sourceClient, success }),
    getUsageCommercialSummary(c.env.DB, companyId),
  ]);
  return c.json({
    summary,
    records,
    interactions: groupOperationsIntoInteractions(records),
  });
});

phase3.get("/api/commercial/usage/export", requireAuth, requirePlatformAdmin, async (c) => {
  const companyId = c.req.query("companyId") || undefined;
  const sourceClient = c.req.query("sourceClient") || undefined;
  const successParam = c.req.query("success");
  const success =
    successParam === "1" || successParam === "true"
      ? true
      : successParam === "0" || successParam === "false"
        ? false
        : undefined;
  const records = await listPlatformUsage(c.env.DB, 5000, { companyId, sourceClient, success });
  const companies = await c.env.DB.prepare(`SELECT id, name FROM companies`).all();
  const companyName = new Map(
    (companies.results ?? []).map((row) => [String(row.id), String(row.name)]),
  );
  const header = [
    "recorded_at",
    "company",
    "actor",
    "ai_client",
    "action",
    "tool",
    "status",
    "charge_gbp",
    "request_id",
    "correlation_id",
  ].join(",");
  const lines = records.map((row) => {
    const charge = row.customerChargeCents != null ? (row.customerChargeCents / 100).toFixed(2) : "";
    const fields = [
      row.recordedAt,
      companyName.get(row.companyId) ?? row.companyId,
      row.actorEmail ?? "",
      row.sourceClient ?? "",
      row.action ?? "",
      row.toolName ?? "",
      row.success === false ? "failed" : "success",
      charge,
      row.requestId ?? "",
      row.correlationId ?? "",
    ];
    return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",");
  });
  const csv = [header, ...lines].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="infra-usage-export.csv"',
    },
  });
});

phase3.get("/api/commercial/provider-costs", requireAuth, requirePlatformAdmin, async (c) => {
  await ensureProviderCostCatalogue(c.env.DB);
  const cards = await listProviderRateCards(c.env.DB);
  const detailed = [];
  for (const card of cards) {
    const full = await getProviderRateCard(c.env.DB, card.id);
    if (full) detailed.push(full);
  }
  return c.json({
    cards: detailed,
    nextReviewNote:
      "Schedule approximately monthly. Proposed updates require Platform Admin approval — never auto-apply scraped tariffs.",
  });
});

phase3.get(
  "/api/commercial/provider-costs/:id",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const full = await getProviderRateCard(c.env.DB, c.req.param("id"));
    if (!full) return c.json({ error: "Rate card not found" }, 404);
    return c.json(full);
  },
);

phase3.get("/api/commercial/pricing-rules", requireAuth, requirePlatformAdmin, async (c) => {
  await ensureDefaultPricing(c.env.DB);
  return c.json({
    policies: await listPricingPolicies(c.env.DB),
    rules: await listPricingRules(c.env.DB),
  });
});

phase3.post(
  "/api/commercial/provider-costs/:provider/request-review",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const body = (await c.req
      .json<{ sourceUrl?: string; notes?: string }>()
      .catch(() => ({}))) as { sourceUrl?: string; notes?: string };
    const id = await createManualPricingReviewProposal(c.env.DB, {
      provider: c.req.param("provider"),
      sourceUrl: body.sourceUrl,
      notes: body.notes,
      actor: c.get("user").email,
    });
    await recordAuditEvent(c.env.DB, {
      companyId: null,
      eventType: "company.accessed",
      actor: c.get("user").email,
      resourceType: "pricing",
      resourceId: id,
      detail: {
        stage: "pricing.rate_update_detected",
        provider: c.req.param("provider"),
        status: "pending_admin_review",
      },
    });
    return c.json({ reviewId: id, status: "pending" });
  },
);

phase3.get("/api/commercial/pricing-reviews", requireAuth, requirePlatformAdmin, async (c) => {
  return c.json({ reviews: await listPricingReviews(c.env.DB) });
});

phase3.put(
  "/api/commercial/provider-costs/:id/items",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const body = await c.req.json<{
      items?: Array<{ id: string; unitCostMicros: number; notes?: string | null }>;
    }>();
    if (!body.items?.length) {
      return c.json({ error: "items array is required" }, 400);
    }
    try {
      const updated = await updateDraftRateCardItems(
        c.env.DB,
        c.req.param("id"),
        body.items,
        c.get("user").email,
      );
      await recordAuditEvent(c.env.DB, {
        eventType: "pricing.rate_card_updated",
        actor: c.get("user").email,
        resourceType: "provider_rate_card",
        resourceId: c.req.param("id"),
        detail: { itemCount: body.items.length },
      });
      return c.json(updated);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unable to update rate card" },
        400,
      );
    }
  },
);

phase3.post(
  "/api/commercial/provider-costs/:id/approve",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    try {
      const card = await approveProviderRateCard(
        c.env.DB,
        c.req.param("id"),
        c.get("user").email,
      );
      await recordAuditEvent(c.env.DB, {
        eventType: "pricing.rate_card_approved",
        actor: c.get("user").email,
        resourceType: "provider_rate_card",
        resourceId: card.id,
        detail: { provider: card.provider, versionLabel: card.versionLabel },
      });
      return c.json({ ok: true, card });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Unable to approve rate card" },
        400,
      );
    }
  },
);

phase3.post(
  "/api/commercial/reconciliation/run",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const result = await runFinancialReconciliation(c.env.DB);
    await recordAuditEvent(c.env.DB, {
      companyId: null,
      eventType: "company.accessed",
      actor: c.get("user").email,
      resourceType: "billing",
      resourceId: "reconciliation",
      detail: result,
    });
    return c.json(result);
  },
);

phase3.get(
  "/api/commercial/reconciliation/exceptions",
  requireAuth,
  requirePlatformAdmin,
  async (c) => {
    const status = c.req.query("status") ?? "open";
    return c.json({ exceptions: await listFinancialExceptions(c.env.DB, status) });
  },
);

registerCommand6Routes(phase3);

phase3.get("/api/companies/:slug/email/config", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  if (!canManageCompany(c.get("user"), company.id)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const config = await getCompanyEmailConfig(c.env.DB, company.id);
  if (!config) {
    return c.json({
      enabled: false,
      provider: null,
      sender: null,
      healthStatus: "configuration_required",
    });
  }

  return c.json({
    enabled: config.enabled,
    provider: config.provider === "microsoft365" ? "Microsoft 365" : config.provider,
    sender: `${config.senderDisplayName} <${config.senderAddress}>`,
    healthStatus: config.healthStatus,
    allowedTypes: config.allowedTypes,
    lastSentAt: config.lastSentAt,
    lastErrorCategory: config.lastErrorCategory,
  });
});

phase3.post("/api/companies/:slug/email/test", requireAuth, async (c) => {
  const company = await getCompanyBySlug(c.env.DB, c.req.param("slug"));
  if (!company) return c.json({ error: "Company not found" }, 404);
  const user = c.get("user");
  if (!canManageCompany(user, company.id) && !user.isPlatformAdmin) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ recipient?: string }>().catch(() => ({ recipient: undefined }));
  const recipient = (body.recipient ?? user.email).trim().toLowerCase();
  const content = renderTestEmail({
    companyName: company.name,
    sentAtLabel: new Date().toLocaleString("en-GB"),
  });

  const result = await sendTransactionalEmail(c.env, c.env.DB, {
    companyId: company.id,
    type: "TEST_EMAIL",
    recipient,
    subject: content.subject,
    bodyText: content.text,
    bodyHtml: content.html,
    actor: user.email,
  });

  return c.json({
    ok: result.sent,
    emailId: result.id,
    provider: result.provider,
    error: result.error,
    microsoftSetup: result.failureCategory === "permission" ? exchangeMailSendRbacGuide() : undefined,
  });
});

export default phase3;

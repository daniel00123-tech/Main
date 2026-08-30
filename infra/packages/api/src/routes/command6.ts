import { Hono } from "hono";
import type { CompanyRole, ToolAction } from "@infra/shared";
import type { Env } from "../env";
import type { AuthVariables } from "../auth/middleware";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware";
import { getCompanyBySlug, recordAuditEvent } from "../services/control-plane";
import {
  getUserCompanyRole,
  userHasCompanyAccess,
  replaceCompanyRoleOverrides,
  listRoleActionOverrides,
  effectiveActionAllowed,
  isRolePermissionEditable,
  resolvePresetPermissions,
} from "../permissions/service";
import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../services/notifications";
import {
  listCompanyTeams,
  createCompanyTeam,
  addTeamMember,
  removeTeamMember,
  archiveCompanyTeam,
} from "../services/teams";
import {
  listCustomRoles,
  createCustomRole,
  listCustomRoleGrants,
  archiveCustomRole,
} from "../services/custom-roles";
import {
  createCompanyInvitation,
  listCompanyInvitations,
  cancelInvitation,
} from "../services/invitations";
import { listBillingDocuments } from "../services/billing-documents";
import { listAddonCatalog, listCompanyAddons, requestCompanyAddon } from "../services/addons";
import { getWalletHealth } from "../services/wallet-health";
import { listPromotionalGrants, grantPromotionalCredit } from "../services/promotional-grants";
import { evaluateAutoTopUp, getAutoTopUpDiagnostics } from "../services/auto-topup";
import { detachStripePaymentMethod } from "../services/stripe";
import { updateAutoTopUpSettings } from "../services/company-settings";
import { listLedgerEntries } from "../services/ledger";
import { listPlatformUsage } from "../services/usage";
import { portalOrigin } from "../services/public-urls";
import { listWhatsAppInbox } from "../services/whatsapp-ops";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

async function companyFromSlug(db: D1Database, slug: string) {
  return getCompanyBySlug(db, slug);
}

function canManageCompany(user: AuthVariables["user"], companyId: string) {
  if (user.isPlatformAdmin) return true;
  const role = getUserCompanyRole(user, companyId);
  return role === "company_admin" || role === "director";
}

export function registerCommand6Routes(app: Hono<AppEnv>) {
  // ---------- Notifications ----------
  app.get("/api/companies/:slug/notifications", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const user = c.get("user");
    const [items, unreadCount] = await Promise.all([
      listNotifications(c.env.DB, {
        companyId: company.id,
        userId: user.userId,
        unreadOnly: c.req.query("unread") === "1",
        limit: Number(c.req.query("limit") ?? 30),
      }),
      countUnreadNotifications(c.env.DB, company.id, user.userId),
    ]);
    return c.json({ notifications: items, unreadCount });
  });

  app.post("/api/companies/:slug/notifications/:id/read", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    await markNotificationRead(c.env.DB, c.req.param("id"), company.id);
    return c.json({ ok: true });
  });

  app.post("/api/companies/:slug/notifications/read-all", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    await markAllNotificationsRead(c.env.DB, company.id, c.get("user").userId);
    return c.json({ ok: true });
  });

  // ---------- Payment method removal ----------
  app.delete("/api/companies/:slug/wallet/payment-method", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const body = (await c.req.json<{ disableAutoTopUp?: boolean }>().catch(() => ({
      disableAutoTopUp: undefined,
    }))) as { disableAutoTopUp?: boolean };
    const result = await detachStripePaymentMethod(c.env, {
      companyId: company.id,
      actorEmail: c.get("user").email,
      disableAutoTopUp: body.disableAutoTopUp,
    });
    if (!result.ok) {
      return c.json({ error: result.error, code: result.code }, 400);
    }
    if (body.disableAutoTopUp) {
      const settings = await import("../services/company-settings").then((m) =>
        m.getCompanySettings(c.env.DB, company.id),
      );
      if (settings?.autoTopUp.enabled) {
        await updateAutoTopUpSettings(c.env.DB, company.id, {
          enabled: false,
          thresholdCents: settings.autoTopUp.thresholdCents ?? 500,
          amountCents: settings.autoTopUp.amountCents ?? 2500,
        });
      }
    }
    return c.json({ ok: true });
  });

  // ---------- Auto top-up evaluation ----------
  app.get("/api/companies/:slug/wallet/auto-topup/status", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const evaluation = await evaluateAutoTopUp(c.env.DB, company.id);
    const diagnostics = await getAutoTopUpDiagnostics(c.env, company.id);
    return c.json({ evaluation, diagnostics });
  });

  // ---------- Wallet health ----------
  app.get("/api/companies/:slug/wallet/health", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    return c.json({ health: await getWalletHealth(c.env.DB, company.id) });
  });

  // ---------- Teams ----------
  app.get("/api/companies/:slug/teams", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    return c.json({ teams: await listCompanyTeams(c.env.DB, company.id) });
  });

  app.post("/api/companies/:slug/teams", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const body = await c.req.json<{ name?: string; description?: string; defaultRole?: CompanyRole }>();
    if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
    const team = await createCompanyTeam(c.env.DB, {
      companyId: company.id,
      name: body.name,
      description: body.description,
      defaultRole: body.defaultRole,
    });
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "team.created",
      actor: c.get("user").email,
      resourceType: "company_team",
      resourceId: team.id,
    });
    return c.json({ team });
  });

  app.post("/api/companies/:slug/teams/:teamId/members", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const body = await c.req.json<{ userId?: string; role?: CompanyRole }>();
    if (!body.userId) return c.json({ error: "userId is required" }, 400);
    await addTeamMember(c.env.DB, {
      teamId: c.req.param("teamId"),
      userId: body.userId,
      role: body.role,
    });
    return c.json({ ok: true });
  });

  app.delete("/api/companies/:slug/teams/:teamId/members/:userId", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    await removeTeamMember(c.env.DB, c.req.param("teamId"), c.req.param("userId"));
    return c.json({ ok: true });
  });

  app.post("/api/companies/:slug/teams/:teamId/archive", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    await archiveCompanyTeam(c.env.DB, c.req.param("teamId"), company.id);
    return c.json({ ok: true });
  });

  // ---------- Custom roles ----------
  app.get("/api/companies/:slug/custom-roles", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    return c.json({ roles: await listCustomRoles(c.env.DB, company.id) });
  });

  app.post("/api/companies/:slug/custom-roles", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const body = await c.req.json<{
      name?: string;
      description?: string;
      cloneFromRole?: string;
    }>();
    if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
    const role = await createCustomRole(c.env.DB, {
      companyId: company.id,
      name: body.name,
      description: body.description,
      cloneFromRole: body.cloneFromRole,
    });
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "custom_role.created",
      actor: c.get("user").email,
      resourceType: "company_custom_role",
      resourceId: role.id,
    });
    return c.json({ role });
  });

  app.get("/api/companies/:slug/custom-roles/:roleId/grants", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    return c.json({ grants: await listCustomRoleGrants(c.env.DB, c.req.param("roleId")) });
  });

  app.post("/api/companies/:slug/custom-roles/:roleId/archive", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    try {
      await archiveCustomRole(c.env.DB, company.id, c.req.param("roleId"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Unable to archive role" }, 400);
    }
  });

  // ---------- Invitations ----------
  app.get("/api/companies/:slug/invitations", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    return c.json({ invitations: await listCompanyInvitations(c.env.DB, company.id) });
  });

  app.post("/api/companies/:slug/invitations/:id/resend", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    try {
      const origin = portalOrigin(c.env, c.req.header("Origin"));
      const result = await import("../services/invitations").then((m) =>
        m.resendInvitation(c.env, {
          companyId: company.id,
          companyName: company.name,
          invitationId: c.req.param("id"),
          inviterName: c.get("user").displayName,
          origin,
        }),
      );
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Unable to resend invitation" }, 400);
    }
  });

  app.get("/api/companies/:slug/billing-payments", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const { listBillingPayments } = await import("../services/billing-payments");
    return c.json({ payments: await listBillingPayments(c.env.DB, company.id) });
  });

  app.get("/api/companies/:slug/wallet/auto-topup/transactions", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const rows = await c.env.DB.prepare(
      `SELECT id, amount_cents, status, failure_reason, stripe_payment_intent_id, created_at, completed_at
       FROM auto_top_up_transactions WHERE company_id = ? ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(company.id)
      .all();
    return c.json({
      transactions: (rows.results ?? []).map((row) => ({
        id: String(row.id),
        amountCents: Number(row.amount_cents),
        status: String(row.status),
        failureReason: row.failure_reason ? String(row.failure_reason) : null,
        paymentIntentId: row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null,
        createdAt: String(row.created_at),
        completedAt: row.completed_at ? String(row.completed_at) : null,
      })),
    });
  });

  app.post("/api/companies/:slug/invitations/:id/cancel", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    await cancelInvitation(c.env.DB, company.id, c.req.param("id"));
    await recordAuditEvent(c.env.DB, {
      companyId: company.id,
      eventType: "invitation.cancelled",
      actor: c.get("user").email,
      resourceType: "user_invitation",
      resourceId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });

  // ---------- Billing documents ----------
  app.get("/api/companies/:slug/billing-documents", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    return c.json({ documents: await listBillingDocuments(c.env.DB, company.id) });
  });

  // ---------- Add-ons ----------
  app.get("/api/addons/catalog", requireAuth, async (c) => {
    return c.json({ addons: await listAddonCatalog(c.env.DB) });
  });

  app.get("/api/companies/:slug/addons", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!userHasCompanyAccess(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    return c.json({ subscriptions: await listCompanyAddons(c.env.DB, company.id) });
  });

  app.post("/api/companies/:slug/addons/request", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Company administrator access required" }, 403);
    }
    const body = await c.req.json<{ addonSlug?: string }>();
    if (!body.addonSlug) return c.json({ error: "addonSlug is required" }, 400);
    try {
      const result = await requestCompanyAddon(c.env.DB, company.id, body.addonSlug);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Unable to request add-on" }, 400);
    }
  });

  // ---------- Promotional grants (admin) ----------
  app.get("/api/companies/:slug/wallet/promotional-grants", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id) && !c.get("user").isPlatformAdmin) {
      return c.json({ error: "Access denied" }, 403);
    }
    return c.json({ grants: await listPromotionalGrants(c.env.DB, company.id) });
  });

  app.post(
    "/api/companies/:slug/wallet/promotional-grants",
    requireAuth,
    requirePlatformAdmin,
    async (c) => {
      const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
      if (!company) return c.json({ error: "Company not found" }, 404);
      const body = await c.req.json<{
        amountCents?: number;
        reason?: string;
        internalNote?: string;
        expiresAt?: string;
      }>();
      if (!body.amountCents || !body.reason?.trim()) {
        return c.json({ error: "amountCents and reason are required" }, 400);
      }
      const result = await grantPromotionalCredit(c.env.DB, {
        companyId: company.id,
        amountCents: body.amountCents,
        reason: body.reason.trim(),
        internalNote: body.internalNote,
        expiresAt: body.expiresAt,
        grantedBy: c.get("user").email,
      });
      await recordAuditEvent(c.env.DB, {
        companyId: company.id,
        eventType: "wallet.promotional_granted",
        actor: c.get("user").email,
        resourceType: "promotional_credit_grant",
        resourceId: result.grantId,
        detail: { amountCents: body.amountCents, reason: body.reason },
      });
      return c.json(result);
    },
  );

  // ---------- Data exports ----------
  app.get("/api/companies/:slug/exports/usage.csv", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const records = await listPlatformUsage(c.env.DB, 5000, { companyId: company.id });
    const header = "id,createdAt,toolName,action,status,chargeCents\n";
    const rows = records
      .map(
        (r) =>
          `${r.id},${r.recordedAt},${r.toolName ?? ""},${r.action ?? ""},${r.success ? "success" : "failed"},${r.customerChargeCents ?? 0}`,
      )
      .join("\n");
    return new Response(header + rows, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${company.slug}-usage.csv"`,
      },
    });
  });

  app.get("/api/companies/:slug/exports/wallet.csv", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    if (!canManageCompany(c.get("user"), company.id)) {
      return c.json({ error: "Access denied" }, 403);
    }
    const entries = await listLedgerEntries(c.env.DB, company.id, 5000);
    const header = "id,createdAt,entryType,amountCents,balanceAfterCents,description\n";
    const rows = entries
      .map(
        (e) =>
          `${e.id},${e.createdAt},${e.entryType},${e.amountCents},${e.balanceAfterCents},"${(e.description ?? "").replace(/"/g, '""')}"`,
      )
      .join("\n");
    return new Response(header + rows, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${company.slug}-wallet.csv"`,
      },
    });
  });

  // ---------- Failed requests intelligence (platform admin) ----------
  app.get("/api/platform/failed-requests", requireAuth, requirePlatformAdmin, async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT company_id, tool_name, action, error_code,
              COUNT(*) AS count,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen
       FROM gateway_requests
       WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
       GROUP BY company_id, tool_name, action, error_code
       ORDER BY count DESC
       LIMIT 100`,
    ).all();

    const companies = await c.env.DB.prepare(`SELECT id, name, slug FROM companies`).all();
    const companyMap = new Map(
      (companies.results ?? []).map((row) => [
        String(row.id),
        { name: String(row.name), slug: String(row.slug) },
      ]),
    );

    const whatsappInbox = await listWhatsAppInbox(c.env).catch(() => ({
      items: [],
      stuckCount: 0,
      processingCount: 0,
      failedCount: 0,
      consecutiveFailedReplies: 0,
      metrics: undefined,
    }));

    return c.json({
      whatsapp: {
        stuckCount: whatsappInbox.stuckCount,
        processingCount: whatsappInbox.processingCount,
        failedCount: whatsappInbox.failedCount,
        consecutiveFailedReplies: whatsappInbox.consecutiveFailedReplies,
        incidents: whatsappInbox.items.filter((item) => item.stuck || item.status === "failed").slice(0, 40),
        metrics: "metrics" in whatsappInbox ? whatsappInbox.metrics : undefined,
      },
      failures: (rows.results ?? []).map((row) => {
        const companyId = String(row.company_id);
        const meta = companyMap.get(companyId);
        const count = Number(row.count);
        return {
          companyId,
          companyName: meta?.name ?? null,
          companySlug: meta?.slug ?? null,
          toolName: row.tool_name ? String(row.tool_name) : null,
          action: row.action ? String(row.action) : null,
          errorCode: row.error_code ? String(row.error_code) : null,
          count,
          firstSeen: row.first_seen ? String(row.first_seen) : null,
          lastSeen: row.last_seen ? String(row.last_seen) : null,
          severity: count >= 10 ? "high" : count >= 3 ? "medium" : "low",
          recurring: count >= 3,
        };
      }),
    });
  });

  app.get("/api/companies/:slug/wallet/auto-topup/diagnostics", requireAuth, async (c) => {
    const company = await companyFromSlug(c.env.DB, c.req.param("slug"));
    if (!company) return c.json({ error: "Company not found" }, 404);
    const user = c.get("user");
    if (!userHasCompanyAccess(user, company.id) && !user.isPlatformAdmin) {
      return c.json({ error: "Access denied" }, 403);
    }
    return c.json({ diagnostics: await getAutoTopUpDiagnostics(c.env, company.id) });
  });

  // ---------- Weekly review foundation ----------
  app.get("/api/platform/weekly-review", requireAuth, requirePlatformAdmin, async (c) => {
    const failures = await c.env.DB.prepare(
      `SELECT error_code, error_message, tool_name, COUNT(*) AS count
       FROM gateway_requests
       WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')
       GROUP BY error_code, error_message, tool_name
       ORDER BY count DESC
       LIMIT 20`,
    ).all();

    const summary = (failures.results ?? []).map((row) => ({
      errorCode: row.error_code ? String(row.error_code) : "unknown",
      message: row.error_message ? String(row.error_message).slice(0, 200) : null,
      toolName: row.tool_name ? String(row.tool_name) : null,
      count: Number(row.count),
      severity: Number(row.count) >= 10 ? "high" : Number(row.count) >= 3 ? "medium" : "low",
    }));

    return c.json({
      generatedAt: new Date().toISOString(),
      periodDays: 7,
      summary,
      note: "Automated review report — does not modify production code.",
    });
  });
}

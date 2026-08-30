import { Hono } from "hono";
import type { Env } from "../env";
import {
  requireAuth,
  requirePlatformAdmin,
  type AuthVariables,
} from "../auth/middleware";
import {
  cancelPendingInvitationsForEmail,
  countActivePlatformAdmins,
  disableUserAccount,
  enableUserAccount,
  getUserById,
  setUserMobileE164,
  updateMembershipRole,
  updateUserProfile,
} from "../auth/users";
import { invalidateActiveSetupTokensForUser } from "../auth/password-setup";
import { recordAuditEvent } from "../services/control-plane";
import { MobileCollisionError, MobileValidationError, maskMobileE164 } from "../services/phone";
import {
  getCompanyEconomicsDetail,
  listCustomerEconomics,
  type EconomicsPeriodPreset,
} from "../services/customer-economics";
import {
  createPlatformOverhead,
  deletePlatformOverhead,
  listPlatformOverheads,
  OVERHEAD_CATEGORIES,
  summariseOverheads,
  updatePlatformOverhead,
} from "../services/platform-overheads";
import {
  getInteractionDetail,
  listInteractionHistory,
  logInteractionAccess,
} from "../services/interaction-history";
import {
  listQualityIssues,
  QUALITY_STATUSES,
  type QualityStatus,
  updateQualityIssueStatus,
} from "../services/quality-auditor";
import { PROVIDER_COST_COVERAGE } from "../services/provider-cost-coverage";
import {
  getWhatsAppChannelConfig,
  resolveWhatsAppIdentity,
} from "../services/whatsapp-identity";
import { inspectWhatsAppAssets, secretPresence } from "../services/whatsapp-assets";
import { inspectWhatsAppMessageSubscription } from "../services/whatsapp-subscription";
import {
  WHATSAPP_WEBHOOK_PATH,
  whatsappOutboundAiEnabled,
  whatsappVerifyConfigured,
} from "../services/whatsapp-webhook";
import { WHATSAPP_AI_MODEL, WHATSAPP_AI_PROVIDER } from "../services/whatsapp-orchestrator";

const routes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function periodFilters(c: { req: { query: (name: string) => string | undefined } }) {
  const preset = c.req.query("preset") as EconomicsPeriodPreset | undefined;
  return {
    companyId: c.req.query("companyId") || undefined,
    provider: c.req.query("provider") || undefined,
    service: c.req.query("service") || undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    preset: preset || undefined,
  };
}

routes.get("/api/platform/economics", requireAuth, requirePlatformAdmin, async (c) => {
  const filters = periodFilters(c);
  const [economics, overheads] = await Promise.all([
    listCustomerEconomics(c.env.DB, filters),
    listPlatformOverheads(c.env.DB),
  ]);
  const overheadSummary = summariseOverheads(
    overheads,
    economics.period.from,
    economics.period.to,
  );
  return c.json({
    period: economics.period,
    companies: economics.companies,
    platformOverheads: {
      allocatedToCustomers: false,
      ...overheadSummary,
    },
    coverage: PROVIDER_COST_COVERAGE,
  });
});

routes.get("/api/platform/economics/:companyId", requireAuth, requirePlatformAdmin, async (c) => {
  const detail = await getCompanyEconomicsDetail(
    c.env.DB,
    c.req.param("companyId"),
    periodFilters(c),
  );
  if (!detail.company) return c.json({ error: "Company not found or has no economics row" }, 404);
  return c.json(detail);
});

routes.get("/api/platform/overheads", requireAuth, requirePlatformAdmin, async (c) => {
  const items = await listPlatformOverheads(c.env.DB);
  return c.json({
    items,
    categories: OVERHEAD_CATEGORIES,
    allocatedToCustomers: false,
  });
});

routes.post("/api/platform/overheads", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{
    provider?: string;
    description?: string;
    monthlyCostCents?: number;
    currency?: string;
    startDate?: string;
    endDate?: string | null;
    category?: string;
  }>();
  if (!body.provider || !body.description || body.monthlyCostCents == null || !body.startDate || !body.category) {
    return c.json({ error: "provider, description, monthlyCostCents, startDate, and category are required" }, 400);
  }
  const item = await createPlatformOverhead(c.env.DB, {
    provider: body.provider,
    description: body.description,
    monthlyCostCents: Number(body.monthlyCostCents),
    currency: body.currency,
    startDate: body.startDate,
    endDate: body.endDate,
    category: body.category,
    createdBy: c.get("user").email,
  });
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "platform.overhead.created",
    actor: c.get("user").email,
    resourceType: "platform_overhead",
    resourceId: item.id,
    detail: { provider: item.provider, monthlyCostCents: item.monthlyCostCents },
  });
  return c.json(item, 201);
});

routes.patch("/api/platform/overheads/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const item = await updatePlatformOverhead(c.env.DB, c.req.param("id"), {
    provider: typeof body.provider === "string" ? body.provider : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    monthlyCostCents: typeof body.monthlyCostCents === "number" ? body.monthlyCostCents : undefined,
    currency: typeof body.currency === "string" ? body.currency : undefined,
    startDate: typeof body.startDate === "string" ? body.startDate : undefined,
    endDate: body.endDate === null || typeof body.endDate === "string" ? (body.endDate as string | null) : undefined,
    category: typeof body.category === "string" ? body.category : undefined,
  });
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

routes.delete("/api/platform/overheads/:id", requireAuth, requirePlatformAdmin, async (c) => {
  await deletePlatformOverhead(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

routes.get("/api/platform/interactions", requireAuth, requirePlatformAdmin, async (c) => {
  const success = c.req.query("success");
  const items = await listInteractionHistory(c.env.DB, {
    companyId: c.req.query("companyId") || undefined,
    userId: c.req.query("userId") || undefined,
    channel: c.req.query("channel") || undefined,
    provider: c.req.query("provider") || undefined,
    tool: c.req.query("tool") || undefined,
    from: c.req.query("from") || undefined,
    to: c.req.query("to") || undefined,
    success: success === "true" ? true : success === "false" ? false : undefined,
    limit: Number(c.req.query("limit") ?? 75),
  });
  return c.json({ items });
});

routes.get("/api/platform/interactions/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const detail = await getInteractionDetail(c.env.DB, c.req.param("id"));
  if (!detail) return c.json({ error: "Interaction not found" }, 404);
  const viewer = c.get("user");
  await logInteractionAccess(c.env.DB, {
    interactionId: detail.id,
    companyId: detail.companyId,
    viewerUserId: viewer.userId,
    viewerEmail: viewer.email,
    purpose: c.req.query("purpose") || "admin_inspect",
  });
  await recordAuditEvent(c.env.DB, {
    companyId: detail.companyId,
    eventType: "interaction.viewed",
    actor: viewer.email,
    resourceType: "interaction",
    resourceId: detail.id,
    detail: { viewerUserId: viewer.userId },
  });
  return c.json(detail);
});

routes.get("/api/platform/quality-issues", requireAuth, requirePlatformAdmin, async (c) => {
  const items = await listQualityIssues(c.env.DB, {
    companyId: c.req.query("companyId") || undefined,
    status: c.req.query("status") || undefined,
    category: c.req.query("category") || undefined,
    limit: Number(c.req.query("limit") ?? 100),
  });
  return c.json({ items, statuses: QUALITY_STATUSES });
});

routes.post("/api/platform/quality-issues/:id/status", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ status?: QualityStatus }>();
  if (!body.status) return c.json({ error: "status is required" }, 400);
  try {
    const row = await updateQualityIssueStatus(c.env.DB, c.req.param("id"), body.status);
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true, status: body.status });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Invalid status" }, 400);
  }
});

routes.get("/api/platform/whatsapp/foundation", requireAuth, requirePlatformAdmin, async (c) => {
  const config = await getWhatsAppChannelConfig(c.env.DB, c.env);
  const assets = inspectWhatsAppAssets(c.env);
  const secrets = secretPresence(c.env);
  const subscription = await inspectWhatsAppMessageSubscription(c.env);
  return c.json({
    ...config,
    productionChannel: whatsappOutboundAiEnabled(c.env) && assets.ok ? "ACTIVE" : "WEBHOOK_ONLY",
    webhookPath: WHATSAPP_WEBHOOK_PATH,
    webhookUrl: "https://api.infrastack.app/api/webhooks/whatsapp",
    verifyConfigured: whatsappVerifyConfigured(c.env),
    outboundAiEnabled: whatsappOutboundAiEnabled(c.env),
    aiRouting: {
      provider: WHATSAPP_AI_PROVIDER,
      model: WHATSAPP_AI_MODEL,
      cursorInRuntime: false,
    },
    secretStatus: {
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: secrets.verifyToken ? "present" : "missing",
      WHATSAPP_ACCESS_TOKEN: secrets.accessToken ? "present" : "missing",
      META_APP_SECRET: secrets.appSecret ? "present" : "missing",
    },
    subscription,
  });
});

routes.post("/api/platform/whatsapp/lookup", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ number?: string }>();
  if (!body.number) return c.json({ error: "number is required" }, 400);
  const result = await resolveWhatsAppIdentity(c.env.DB, body.number);
  return c.json(result);
});

routes.patch("/api/platform/users/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const existing = await getUserById(c.env.DB, c.req.param("id"));
  if (!existing) return c.json({ error: "User not found" }, 404);
  const body = await c.req.json<{
    displayName?: string;
    email?: string;
    mobile?: string | null;
    status?: "active" | "disabled";
    companyId?: string;
    role?: import("@infra/shared").CompanyRole;
  }>().catch(
    (): {
      displayName?: string;
      email?: string;
      mobile?: string | null;
      status?: "active" | "disabled";
      companyId?: string;
      role?: import("@infra/shared").CompanyRole;
    } => ({}),
  );

  try {
    if (body.displayName !== undefined || body.email !== undefined) {
      await updateUserProfile(c.env.DB, existing.id, {
        displayName: body.displayName,
        email: body.email,
      });
      if (body.email && body.email.trim().toLowerCase() !== existing.email.toLowerCase()) {
        await cancelPendingInvitationsForEmail(c.env.DB, existing.email);
        await invalidateActiveSetupTokensForUser(c.env.DB, existing.id);
      }
    }
    if (typeof body.mobile === "string" && body.mobile.trim()) {
      await setUserMobileE164(c.env.DB, existing.id, body.mobile);
    }
    if (body.status === "active" || body.status === "disabled") {
      if (body.status === "disabled" && existing.isPlatformAdmin) {
        const admins = await countActivePlatformAdmins(c.env.DB);
        if (admins <= 1) {
          return c.json({ error: "The last platform administrator cannot be disabled" }, 400);
        }
      }
      if (body.status === "disabled" && existing.id === c.get("user").userId) {
        return c.json({ error: "You cannot disable your own account" }, 400);
      }
      if (body.status === "disabled") {
        await disableUserAccount(c.env.DB, existing.id);
        await invalidateActiveSetupTokensForUser(c.env.DB, existing.id);
      } else {
        await enableUserAccount(c.env.DB, existing.id);
      }
    }
    if (body.companyId && body.role) {
      await updateMembershipRole(c.env.DB, existing.id, body.companyId, body.role);
    }
    const user = await getUserById(c.env.DB, existing.id);
    await recordAuditEvent(c.env.DB, {
      companyId: body.companyId ?? null,
      eventType: "user.updated",
      actor: c.get("user").email,
      resourceType: "user",
      resourceId: existing.id,
      detail: {
        fields: Object.keys(body).filter((key) => body[key as keyof typeof body] != null),
      },
    });
    return c.json({
      ok: true,
      userId: existing.id,
      displayName: user?.displayName,
      email: user?.email,
      status: user?.status,
      mobileMasked: maskMobileE164(user?.mobileE164 ?? null),
    });
  } catch (err) {
    if (err instanceof MobileValidationError || err instanceof MobileCollisionError) {
      return c.json({ error: err.message }, 400);
    }
    const message = err instanceof Error ? err.message : "Unable to update user";
    if (message.includes("already used by another Infra user")) {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: message }, 400);
  }
});

routes.delete("/api/platform/users/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const existing = await getUserById(c.env.DB, c.req.param("id"));
  if (!existing) return c.json({ error: "User not found" }, 404);
  if (existing.id === c.get("user").userId) {
    return c.json({ error: "You cannot delete your own account" }, 400);
  }
  if (existing.isPlatformAdmin) {
    const admins = await countActivePlatformAdmins(c.env.DB);
    if (admins <= 1) {
      return c.json({ error: "The last platform administrator cannot be deleted" }, 400);
    }
  }
  await disableUserAccount(c.env.DB, existing.id);
  await invalidateActiveSetupTokensForUser(c.env.DB, existing.id);
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "user.disabled",
    actor: c.get("user").email,
    resourceType: "user",
    resourceId: existing.id,
    detail: { invitationsCancelled: true },
  });
  return c.json({ ok: true, userId: existing.id, status: "disabled" });
});

routes.post("/api/platform/users/:id/cancel-invitations", requireAuth, requirePlatformAdmin, async (c) => {
  const existing = await getUserById(c.env.DB, c.req.param("id"));
  if (!existing) return c.json({ error: "User not found" }, 404);
  const cancelled = await cancelPendingInvitationsForEmail(c.env.DB, existing.email);
  await invalidateActiveSetupTokensForUser(c.env.DB, existing.id);
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "invitation.cancelled",
    actor: c.get("user").email,
    resourceType: "user",
    resourceId: existing.id,
    detail: { cancelled },
  });
  return c.json({ ok: true, cancelled });
});

routes.post("/api/platform/users/:id/mobile", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ mobile?: string }>();
  if (!body.mobile) return c.json({ error: "mobile is required" }, 400);
  const existing = await getUserById(c.env.DB, c.req.param("id"));
  if (!existing) return c.json({ error: "User not found" }, 404);
  try {
    const user = await setUserMobileE164(c.env.DB, existing.id, body.mobile);
    await recordAuditEvent(c.env.DB, {
      companyId: null,
      eventType: "user.mobile_updated",
      actor: c.get("user").email,
      resourceType: "user",
      resourceId: user.id,
      detail: { mobileMasked: maskMobileE164(user.mobileE164), channel: "whatsapp" },
    });
    return c.json({
      ok: true,
      userId: user.id,
      mobileMasked: maskMobileE164(user.mobileE164),
    });
  } catch (err) {
    if (err instanceof MobileValidationError || err instanceof MobileCollisionError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

export default routes;

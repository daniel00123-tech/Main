import { Hono } from "hono";
import type { Env } from "../env";
import {
  requireAuth,
  requirePlatformAdmin,
  type AuthVariables,
} from "../auth/middleware";
import { recordAuditEvent } from "../services/control-plane";
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
  const config = await getWhatsAppChannelConfig(c.env.DB);
  return c.json({
    ...config,
    productionChannel: "NOT_ENABLED",
  });
});

routes.post("/api/platform/whatsapp/lookup", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ number?: string }>();
  if (!body.number) return c.json({ error: "number is required" }, 400);
  const result = await resolveWhatsAppIdentity(c.env.DB, body.number);
  return c.json(result);
});

export default routes;

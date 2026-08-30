import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth, requirePlatformAdmin, type AuthVariables } from "../auth/middleware";
import { recordAuditEvent } from "../services/control-plane";
import {
  approveRecommended,
  decideProposal,
  ensureQualityLoopConfig,
  getRunBundle,
  listQualityLoopOverview,
  maybeRunQualityLoop,
  resolveReviewToken,
} from "../services/quality-loop";

const routes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

routes.get("/api/platform/quality-loop", requireAuth, requirePlatformAdmin, async (c) => {
  const overview = await listQualityLoopOverview(c.env.DB);
  const latestId = overview.latestRun?.id;
  const bundle = latestId ? await getRunBundle(c.env.DB, latestId) : null;
  return c.json({
    ...overview,
    latest: bundle,
  });
});

routes.get("/api/platform/quality-loop/reviews/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const bundle = await getRunBundle(c.env.DB, c.req.param("id"));
  if (!bundle) return c.json({ error: "Review not found" }, 404);
  return c.json(bundle);
});

routes.get("/api/platform/quality-loop/resolve-token", requireAuth, requirePlatformAdmin, async (c) => {
  const token = c.req.query("token") || "";
  if (!token) return c.json({ error: "token is required" }, 400);
  const resolved = await resolveReviewToken(c.env.DB, token);
  if (!resolved) return c.json({ error: "Unknown review token" }, 404);
  if ("expired" in resolved) return c.json({ error: "Review token expired" }, 410);
  return c.json({ runId: resolved.runId, executesChanges: false });
});

routes.post("/api/platform/quality-loop/reviews/:id/approve-recommended", requireAuth, requirePlatformAdmin, async (c) => {
  const user = c.get("user");
  const results = await approveRecommended(c.env, { runId: c.req.param("id"), actor: user.email });
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "quality_loop.approved_recommended",
    actor: user.email,
    resourceType: "quality_loop_run",
    resourceId: c.req.param("id"),
    detail: { count: results.length },
  });
  return c.json({ ok: true, results });
});

routes.post("/api/platform/quality-loop/proposals/:id/decide", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ decision?: "approve" | "reject" | "defer"; runId?: string }>();
  if (!body.decision) return c.json({ error: "decision is required" }, 400);
  const user = c.get("user");
  const result = await decideProposal(c.env, {
    proposalId: c.req.param("id"),
    decision: body.decision,
    actor: user.email,
    runId: body.runId,
  });
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: `quality_loop.proposal_${body.decision}`,
    actor: user.email,
    resourceType: "quality_proposal",
    resourceId: c.req.param("id"),
    detail: { status: result.status },
  });
  return c.json({ ok: true, ...result });
});

routes.post("/api/platform/quality-loop/run", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ force?: "baseline" | "daily" | "weekly" | "manual" }>().catch(() => ({ force: undefined as undefined }));
  const result = await maybeRunQualityLoop(c.env, new Date(), { force: body.force ?? "manual" });
  return c.json(result);
});

routes.get("/api/platform/quality-loop/config", requireAuth, requirePlatformAdmin, async (c) => {
  const config = await ensureQualityLoopConfig(c.env.DB);
  return c.json(config);
});

export default routes;

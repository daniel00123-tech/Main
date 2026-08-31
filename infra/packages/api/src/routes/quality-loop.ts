import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth, requirePlatformAdmin, type AuthVariables } from "../auth/middleware";
import { recordAuditEvent } from "../services/control-plane";
import { buildQualityCentre } from "../services/quality-loop/centre";
import {
  approveRecommended,
  decideProposal,
  ensureQualityLoopConfig,
  getRunBundle,
  maybeRunQualityLoop,
  resolveReviewToken,
} from "../services/quality-loop";
import { applyApprovedProposal, previewProposal, rollbackProposal } from "../services/quality-loop/apply";
import { getProposal, listHistoryForProposal } from "../services/quality-loop/store";

const routes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

routes.get("/api/platform/quality-loop", requireAuth, requirePlatformAdmin, async (c) => {
  const runId = c.req.query("run") || undefined;
  return c.json(await buildQualityCentre(c.env.DB, { runId }));
});

routes.get("/api/platform/quality-loop/reviews/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const centre = await buildQualityCentre(c.env.DB, { runId: c.req.param("id") });
  if (!centre.latest) return c.json({ error: "Review not found" }, 404);
  return c.json(centre.latest);
});

routes.get("/api/platform/quality-loop/proposals/:id", requireAuth, requirePlatformAdmin, async (c) => {
  const preview = await previewProposal(c.env, c.req.param("id"));
  if (!preview.ok) return c.json({ error: preview.reason }, 404);
  return c.json(preview);
});

routes.post("/api/platform/quality-loop/proposals/:id/preview", requireAuth, requirePlatformAdmin, async (c) => {
  const preview = await previewProposal(c.env, c.req.param("id"));
  if (!preview.ok) return c.json({ error: preview.reason }, 404);
  return c.json({ ...preview, executesChanges: false });
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

routes.post("/api/platform/quality-loop/reviews/:id/apply-low", requireAuth, requirePlatformAdmin, async (c) => {
  const user = c.get("user");
  const bundle = await getRunBundle(c.env.DB, c.req.param("id"));
  if (!bundle) return c.json({ error: "Review not found" }, 404);
  const results: Array<{ id: string; title: string; status: string; reason: string }> = [];
  for (const proposal of bundle.proposals) {
    if (proposal.risk !== "low" || !proposal.autoApplyable || proposal.engineeringRequired) continue;
    if (proposal.status !== "pending_approval") continue;
    const apply = await decideProposal(c.env, {
      proposalId: proposal.id,
      decision: "approve",
      actor: user.email,
      runId: c.req.param("id"),
    });
    results.push({ id: proposal.id, title: proposal.title, status: apply.status, reason: apply.apply?.reason ?? apply.status });
  }
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "quality_loop.apply_low",
    actor: user.email,
    resourceType: "quality_loop_run",
    resourceId: c.req.param("id"),
    detail: { count: results.length, results },
  });
  return c.json({ ok: true, results });
});

routes.post("/api/platform/quality-loop/reviews/:id/bulk", requireAuth, requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{
    decision?: "approve" | "reject" | "defer";
    proposalIds?: string[];
  }>();
  if (!body.decision || !Array.isArray(body.proposalIds) || body.proposalIds.length === 0) {
    return c.json({ error: "decision and proposalIds are required" }, 400);
  }
  const user = c.get("user");
  const results = [];
  for (const proposalId of body.proposalIds) {
    try {
      const result = await decideProposal(c.env, {
        proposalId,
        decision: body.decision,
        actor: user.email,
        runId: c.req.param("id"),
      });
      results.push({ id: proposalId, ok: true, status: result.status, reason: result.apply?.reason ?? result.status });
    } catch (err) {
      results.push({
        id: proposalId,
        ok: false,
        status: "error",
        reason: err instanceof Error ? err.message : "Bulk item failed",
      });
    }
  }
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: `quality_loop.bulk_${body.decision}`,
    actor: user.email,
    resourceType: "quality_loop_run",
    resourceId: c.req.param("id"),
    detail: { count: results.length, results },
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

routes.post("/api/platform/quality-loop/proposals/:id/apply", requireAuth, requirePlatformAdmin, async (c) => {
  const user = c.get("user");
  const proposal = await getProposal(c.env.DB, c.req.param("id"));
  if (!proposal) return c.json({ error: "Proposal not found" }, 404);
  const result = await applyApprovedProposal(c.env, {
    proposalId: proposal.id,
    actor: user.email,
    runId: proposal.runId,
  });
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "quality_loop.proposal_apply",
    actor: user.email,
    resourceType: "quality_proposal",
    resourceId: proposal.id,
    detail: { status: result.status },
  });
  return c.json({ ok: true, ...result });
});

routes.post("/api/platform/quality-loop/proposals/:id/rollback", requireAuth, requirePlatformAdmin, async (c) => {
  const user = c.get("user");
  const result = await rollbackProposal(c.env, { proposalId: c.req.param("id"), actor: user.email });
  await recordAuditEvent(c.env.DB, {
    companyId: null,
    eventType: "quality_loop.proposal_rollback",
    actor: user.email,
    resourceType: "quality_proposal",
    resourceId: c.req.param("id"),
    detail: { status: result.status },
  });
  return c.json({ ok: true, ...result });
});

routes.get("/api/platform/quality-loop/proposals/:id/history", requireAuth, requirePlatformAdmin, async (c) => {
  const history = await listHistoryForProposal(c.env.DB, c.req.param("id"));
  return c.json({ history });
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

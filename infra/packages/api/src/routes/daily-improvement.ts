import { createHash } from "node:crypto";
import { Hono } from "hono";
import { requireAuth, requirePlatformAdmin, type AuthVariables } from "../auth/middleware";
import type { Env } from "../env";
import {
  bootstrapDailyImprovement,
  claimEngineeringJob,
  completeClaimedJob,
  DAILY_IMPROVEMENT_CONTRACT,
  engineeringQueueSnapshot,
  loadDashboard,
  provisionDailyImprovementAutomations,
} from "../services/daily-improvement";

const routes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

async function verifyInternalToken(c: {
  env: Env;
  req: { header: (name: string) => string | undefined };
}): Promise<boolean> {
  const token = c.req.header("X-CMD13-Acceptance-Token")?.trim();
  if (!token) return false;
  const hash = createHash("sha256").update(token).digest("hex");
  const valid = await c.env.DB.prepare(
    `SELECT token_hash FROM cmd13_acceptance_tokens WHERE token_hash = ? AND expires_at > datetime('now') LIMIT 1`,
  )
    .bind(hash)
    .first();
  return Boolean(valid);
}

routes.get("/api/platform/daily-improvement", requireAuth, requirePlatformAdmin, async (c) => {
  const dashboard = await loadDashboard(c.env.DB, {
    tenant: c.req.query("tenant") || undefined,
    channel: c.req.query("channel") || undefined,
    provider: c.req.query("provider") || undefined,
    model: c.req.query("model") || undefined,
    severity: c.req.query("severity") || undefined,
    capability: c.req.query("capability") || undefined,
  });
  return c.json({
    ok: true,
    contract: DAILY_IMPROVEMENT_CONTRACT,
    ...dashboard,
  });
});

routes.get("/api/internal/cursor-engineering/jobs", async (c) => {
  if (!(await verifyInternalToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  return c.json(await engineeringQueueSnapshot(c.env));
});

routes.post("/api/internal/cursor-engineering/claim", async (c) => {
  if (!(await verifyInternalToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { claimedBy?: string };
  return c.json(await claimEngineeringJob(c.env, body.claimedBy?.trim() || "cursor-runner"));
});

routes.post("/api/internal/cursor-engineering/complete", async (c) => {
  if (!(await verifyInternalToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    jobId?: string;
    status?: string;
    result?: Record<string, unknown>;
  };
  if (!body.jobId || !body.status) return c.json({ error: "jobId and status required" }, 400);
  const completed = await completeClaimedJob(c.env, {
    jobId: body.jobId,
    status: body.status,
    result: body.result ?? {},
  });
  return c.json(completed);
});

routes.post("/api/internal/daily-improvement/bootstrap", async (c) => {
  if (!(await verifyInternalToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const result = await bootstrapDailyImprovement(c.env);
  return c.json(result);
});

routes.post("/api/internal/automation/daily-improvement-qa", async (c) => {
  const { runDailyImprovementQa } = await import("../services/daily-improvement");
  return c.json(await runDailyImprovementQa(c.env));
});

routes.post("/api/internal/automation/daily-improvement-report", async (c) => {
  const { runDailyImprovementReport } = await import("../services/daily-improvement");
  return c.json(await runDailyImprovementReport(c.env));
});

routes.post("/api/internal/automation/daily-improvement-engineering", async (c) => {
  const { runDailyImprovementEngineering } = await import("../services/daily-improvement");
  return c.json(await runDailyImprovementEngineering(c.env));
});

routes.post("/api/internal/automation/ensure-daily-improvement", async (c) => {
  return c.json(await provisionDailyImprovementAutomations(c.env.DB));
});

export default routes;

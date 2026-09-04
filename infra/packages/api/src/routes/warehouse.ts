import { createHash } from "node:crypto";
import { Hono } from "hono";
import { requireAuth, requirePlatformAdmin, type AuthVariables } from "../auth/middleware";
import type { Env } from "../env";
import { computeNextWarehouseSyncUtcIso } from "../services/warehouse/schedule";
import { createD1WarehouseRepository } from "../services/warehouse/store";
import { runWarehouseBackfill } from "../services/warehouse/sync";
import { warehouseControlCentreView } from "../services/warehouse/status";
import { sendWarehouseLiveEmail } from "../services/warehouse/email";
import { WAREHOUSE_EL_COMPANY_ID } from "../services/warehouse/standard";

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

routes.get("/api/platform/warehouse", requireAuth, requirePlatformAdmin, async (c) => {
  const companyId = c.req.query("companyId") || WAREHOUSE_EL_COMPANY_ID;
  const repo = createD1WarehouseRepository(c.env.DB);
  return c.json({ ok: true, warehouse: await warehouseControlCentreView(repo, companyId) });
});

routes.post("/api/internal/warehouse/backfill", async (c) => {
  if (!(await verifyInternalToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as { companyId?: string; notify?: boolean };
  const result = await runWarehouseBackfill({
    env: c.env,
    companyId: body.companyId || WAREHOUSE_EL_COMPANY_ID,
  });
  let email: { sent: boolean; recipients: string[]; error?: string } | null = null;
  if (body.notify && result.source && result.source.status !== "FAILED" && result.source.status !== "NEVER_SYNCED") {
    email = await sendWarehouseLiveEmail(c.env, { source: result.source, run: result.run ?? null });
  }
  return c.json({
    ok: Boolean(result.ran && result.run && result.run.status !== "failed"),
    nextSync: computeNextWarehouseSyncUtcIso(),
    result,
    email,
  });
});

export default routes;

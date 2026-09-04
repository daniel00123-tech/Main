import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Env } from "../env";
import {
  ENGINEERING_SUPERVISOR_CONTRACT,
  listEngineeringSupervisorFeed,
} from "../services/intelligence/dev-failure-queue.js";

const routes = new Hono<{ Bindings: Env }>();

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

routes.get("/api/internal/engineering-failures", async (c) => {
  if (!(await verifyInternalToken(c))) {
    return c.json({ error: "Invalid or expired acceptance token" }, 403);
  }
  const items = await listEngineeringSupervisorFeed(c.env.DB, Number(c.req.query("limit") ?? 20));
  return c.json({
    ok: true,
    cursorInCustomerPath: ENGINEERING_SUPERVISOR_CONTRACT.cursorInCustomerPath,
    autoDeployFromSingleFailure: ENGINEERING_SUPERVISOR_CONTRACT.autoDeployFromSingleFailure,
    requiredForFix: ENGINEERING_SUPERVISOR_CONTRACT.requiredForFix,
    items,
  });
});

export default routes;

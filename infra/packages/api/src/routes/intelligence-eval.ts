import { Hono } from "hono";
import type { Env } from "../env";
import { probeWorkersAiModels, runOfflineBenchmarks, selectWinningModel } from "../services/intelligence/eval/benchmark.js";
import { evaluationCases } from "../services/intelligence/eval/cases.js";

const routes = new Hono<{ Bindings: Env }>();

function authorized(env: Env, request: { header(name: string): string | undefined }): boolean {
  const key = String(env.WHATSAPP_META_PROBE_KEY ?? "").trim();
  return key.length >= 24 && request.header("x-infra-whatsapp-probe") === key;
}

routes.post("/api/internal/intelligence-eval", async (c) => {
  if (!authorized(c.env, c.req)) return c.json({ error: "Not found" }, 404);
  const body = await c.req
    .json<{ action?: string }>()
    .catch(() => ({ action: "offline" }));
  const action = String(body.action ?? "offline").trim();
  if (action === "probe") {
    const probes = await probeWorkersAiModels(c.env);
    return c.json({
      ok: true,
      action,
      cases: evaluationCases().length,
      probes,
      winner: selectWinningModel(probes),
    });
  }
  const offline = await runOfflineBenchmarks();
  return c.json({
    ok: true,
    action: "offline",
    cases: evaluationCases().length,
    v11Policy: offline.v11Policy,
    v1Fragile: offline.v1Fragile,
    catalogue: offline.catalogue.map((model) => ({ id: model.id, role: model.role, notes: model.notes })),
  });
});

export default routes;

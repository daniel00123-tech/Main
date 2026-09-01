import { Hono } from "hono";
import type { Env } from "../env";
import { probeWorkersAiModels, runOfflineBenchmarks, selectWinningModel } from "../services/intelligence/eval/benchmark.js";
import { evaluationCases } from "../services/intelligence/eval/cases.js";
import { runAdversarialSuite, sanitizeReport } from "../services/intelligence/eval/adversarial-runner.js";
import { ADVERSARIAL_SUITE_VERSION, assertSuiteIntegrity } from "../services/intelligence/eval/adversarial-scenarios.js";
import { instantiateLiveDocQaSequences } from "../services/intelligence/eval/live-docqa-sequences.js";
import { FALLBACK_ADAPTERS } from "../services/intelligence/eval/adversarial-scenarios.js";

const routes = new Hono<{ Bindings: Env }>();

function authorized(env: Env, request: { header(name: string): string | undefined }): boolean {
  const probe = String(env.WHATSAPP_META_PROBE_KEY ?? "").trim();
  const runKey = String(env.ADVERSARIAL_EVAL_KEY ?? "").trim();
  const header = request.header("x-infra-whatsapp-probe") ?? request.header("x-infra-adversarial-run") ?? "";
  if (probe.length >= 24 && header === probe) return true;
  if (runKey.length >= 16 && header === runKey) return true;
  return false;
}

routes.post("/api/internal/intelligence-eval", async (c) => {
  if (!authorized(c.env, c.req)) return c.json({ error: "Not found" }, 404);
  const body = await c.req
    .json<{
      action?: string;
      includeTwentyTurn?: boolean;
      tenant?: "caddington" | "elvex";
      limit?: number;
      offset?: number;
    }>()
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
  if (action === "adversarial-offline" || action === "adversarial-persist") {
    const integrity = assertSuiteIntegrity();
    const persist = action === "adversarial-persist";
    const run = await runAdversarialSuite({
      env: persist ? c.env : undefined,
      mode: persist ? "persist" : "offline",
      includeTwentyTurn: body.includeTwentyTurn === true,
      transport: persist ? "GATED" : "OFFLINE",
      tenant: body.tenant === "elvex" || body.tenant === "caddington" ? body.tenant : undefined,
      limit: Number.isFinite(body.limit) ? Number(body.limit) : undefined,
      offset: Number.isFinite(body.offset) ? Number(body.offset) : undefined,
    });
    return c.json({
      ok: true,
      action,
      suite: ADVERSARIAL_SUITE_VERSION,
      integrity,
      sendWhatsApp: false,
      ...sanitizeReport(run),
    });
  }
  if (action === "live-docqa-offline") {
    return c.json({
      ok: true,
      action,
      transport: "OFFLINE",
      sequences: {
        caddington: instantiateLiveDocQaSequences(FALLBACK_ADAPTERS.caddington).length,
        elvex: instantiateLiveDocQaSequences(FALLBACK_ADAPTERS.elvex).length,
      },
      sendWhatsApp: false,
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

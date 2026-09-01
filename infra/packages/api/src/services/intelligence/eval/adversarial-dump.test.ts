import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { runAdversarialSuite } from "./adversarial-runner.js";
import { sanitizeReport } from "./adversarial-runner.js";

const OUT = process.env.ADVERSARIAL_DUMP ?? "/tmp/adversarial-100-after.json";

describe("adversarial dump", () => {
  it("writes the offline 100-scenario baseline", async () => {
    const run = sanitizeReport(await runAdversarialSuite({ mode: "offline" }));
    mkdirSync("/tmp", { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          version: run.version,
          mode: run.mode,
          transport: run.transport,
          summary: run.summary,
          perTenant: run.perTenant,
          tenants: run.tenants.map((tenant) => ({
            tenant: tenant.tenant,
            companyId: tenant.companyId,
            companySlug: tenant.companySlug,
            role: tenant.role,
            whatsappAuthorised: tenant.whatsappAuthorised,
            elAuthGap: tenant.elAuthGap,
            notes: tenant.notes,
            adapter: tenant.adapter,
          })),
          rows: run.rows.map((row) => ({
            id: `${row.tenant}:${row.scenarioId}:${row.turnIndex}`,
            intent: row.intent,
            text: row.text,
            scope: row.scope,
            route: row.route,
            tools: row.tools,
            score: row.score,
            band: row.band,
            cluster: row.cluster,
            reasons: row.reasons,
            invented: row.invented,
            assistantLike: row.assistantLike,
            latencyMs: row.latencyMs,
          })),
        },
        null,
        2,
      ),
    );
  }, 60_000);
});

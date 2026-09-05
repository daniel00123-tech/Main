import { describe, expect, it } from "vitest";
import {
  classifyProblemClass,
  classifyToolSufficiency,
  recipeHintsForPrompt,
  recordRecipeOutcome,
  sanitiseRecipeText,
} from "./solution-recipes.js";

type Row = Record<string, unknown>;

function memoryDb() {
  const rows: Row[] = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (/INSERT INTO intelligence_solution_recipes/.test(sql)) {
                rows.push({
                  recipe_id: args[0],
                  company_id: args[1],
                  problem_class: args[2],
                  capabilities_used: args[3],
                  evidence_types: args[4],
                  successful_strategy: args[5],
                  confidence: args[6],
                  created_at: args[7],
                  last_success: args[8],
                  last_failure: null,
                  success_count: args[9],
                  failure_count: 0,
                });
              }
              if (/UPDATE intelligence_solution_recipes/.test(sql)) {
                const id = args[10];
                const row = rows.find((item) => item.recipe_id === id);
                if (row) {
                  row.capabilities_used = args[0];
                  row.evidence_types = args[1];
                  row.successful_strategy = args[2];
                  row.confidence = args[3];
                  if (args[4]) row.last_success = args[5];
                  if (args[6]) row.last_failure = args[7];
                  row.success_count = args[8];
                  row.failure_count = args[9];
                }
              }
              return { success: true };
            },
            async first<T>() {
              if (/company_id = \? AND problem_class = \?/.test(sql)) {
                return (rows.find((row) => row.company_id === args[0] && row.problem_class === args[1]) ?? null) as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: rows.filter((row) => row.company_id === args[0]) as T[] };
            },
          };
        },
        async run() {
          return { success: true };
        },
      };
    },
  };
}

describe("solution recipes", () => {
  it("classifies capability sequences without storing customer phrases as hard rules", () => {
    expect(classifyProblemClass({ tools: ["warehouse_sales_analysis"] })).toBe("historical_finance");
    expect(classifyProblemClass({ tools: ["xero_get_invoice"] })).toBe("live_finance");
    expect(classifyProblemClass({ tools: ["web_search"] })).toBe("public_web");
    expect(classifyProblemClass({ tools: ["search_company_knowledge"], text: "how would you work out a price" })).toBe(
      "pricing",
    );
    expect(sanitiseRecipeText("Quote INV-02277 at £12 for ella@elvexpropertyservices.com")).not.toMatch(/INV-02277|£12|ella@/i);
  });

  it("marks empty and failed tool payloads as insufficient", () => {
    expect(classifyToolSufficiency({ name: "search_company_knowledge", ok: false, latencyMs: 1, data: null })).toBe("FAILED");
    expect(
      classifyToolSufficiency({ name: "search_company_knowledge", ok: true, latencyMs: 1, data: { results: [] } }),
    ).toBe("INSUFFICIENT");
    expect(
      classifyToolSufficiency({
        name: "search_company_knowledge",
        ok: true,
        latencyMs: 1,
        data: { results: [{ id: "1", title: "Payment Process" }] },
      }),
    ).toBe("SUFFICIENT");
  });

  it("persists tenant-safe recipes and treats them as hints", async () => {
    const db = memoryDb();
    const first = await recordRecipeOutcome(db, {
      companyId: "co_el",
      tools: ["search_company_knowledge", "web_search"],
      text: "price a tap",
      success: true,
      sufficiency: ["INSUFFICIENT", "SUFFICIENT"],
    });
    expect(first?.company_id).toBe("co_el");
    expect(first?.problem_class).toBe("pricing");
    expect(first?.successful_strategy).toMatch(/hint|insufficient|authorised/i);
    expect(first?.successful_strategy).not.toMatch(/tap/i);
    const hint = recipeHintsForPrompt([first!]);
    expect(hint).toMatch(/hints, not hard rules/i);
    const second = await recordRecipeOutcome(db, {
      companyId: "co_caddington",
      tools: ["warehouse_sales_analysis"],
      success: true,
    });
    expect(second?.company_id).toBe("co_caddington");
    expect(db.rows).toHaveLength(2);
  });
});

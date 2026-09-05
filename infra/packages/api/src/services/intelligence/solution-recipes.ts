import { newId, nowIso } from "../../db/mappers.js";
import { toolFamilyOf } from "./catalogue.js";
import type { IntelligenceToolResult } from "./types.js";

const RECIPE_TABLE = `CREATE TABLE IF NOT EXISTS intelligence_solution_recipes (
  recipe_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  problem_class TEXT NOT NULL,
  capabilities_used TEXT NOT NULL,
  evidence_types TEXT NOT NULL,
  successful_strategy TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  last_success TEXT,
  last_failure TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0
)`;

const RECIPE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_recipes_company_class
  ON intelligence_solution_recipes (company_id, problem_class)`;

export type RecipeDb = {
  prepare(query: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
      all(): Promise<{ results?: T[] } | { results: T[] }>;
    };
    run(): Promise<unknown>;
  };
};

export type SolutionRecipe = {
  recipe_id: string;
  company_id: string;
  problem_class: string;
  capabilities_used: string[];
  evidence_types: string[];
  successful_strategy: string;
  confidence: number;
  created_at: string;
  last_success: string | null;
  success_count: number;
  failure_count: number;
};

export type RouteSufficiency = "SUFFICIENT" | "PARTIAL" | "INSUFFICIENT" | "FAILED";

const PRIVATE_RECIPE_CONTENT =
  /INV-\d+|£\s?[\d,]+(?:\.\d{2})?|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\belvex\b|\bcaddington\b|\bht business\b/gi;

export async function ensureIntelligenceRecipesSchema(db: RecipeDb): Promise<void> {
  await db.prepare(RECIPE_TABLE).run();
  await db.prepare(RECIPE_INDEX).run();
}

export function classifyToolSufficiency(result: IntelligenceToolResult): RouteSufficiency {
  if (!result.ok) return "FAILED";
  const raw = JSON.stringify(result.data ?? "");
  if (!raw || raw === "null" || raw === "{}") return "INSUFFICIENT";
  if (/"error"\s*:\s*"(no_results|empty|not_found)"/i.test(raw)) return "INSUFFICIENT";
  if (/"results"\s*:\s*\[\s*\]/.test(raw) || /"messages"\s*:\s*\[\s*\]/.test(raw) || /"documents"\s*:\s*\[\s*\]/.test(raw)) {
    return "INSUFFICIENT";
  }
  if (/"none"\s*:\s*true/.test(raw) || /"completeness_status"\s*:\s*"(MISSING|STALE|DEGRADED)"/i.test(raw)) {
    return "PARTIAL";
  }
  return "SUFFICIENT";
}

export function classifyProblemClass(input: { tools: string[]; text?: string }): string {
  const tools = input.tools;
  const families = new Set(tools.map((name) => toolFamilyOf(name)).filter((family) => family !== "none"));
  const pricingAsk = /\b(price|pricing|quote|quotation|estimate|labour|labor|markup)\b/i.test(input.text ?? "");
  if (pricingAsk && (families.has("knowledge") || families.has("web") || families.has("catalogue"))) {
    return "pricing";
  }
  if (families.has("xero") && families.has("outlook")) return "finance_and_mailbox";
  if (families.has("xero") && families.has("knowledge")) return "finance_and_knowledge";
  if (families.has("outlook") && families.has("knowledge")) return "mailbox_and_knowledge";
  if (families.has("web") && families.size === 1) return "public_web";
  if (tools.some((name) => name.startsWith("warehouse_"))) return "historical_finance";
  if (tools.some((name) => name.startsWith("xero_"))) return "live_finance";
  if (families.has("outlook")) return "mailbox";
  if (families.has("knowledge")) return "company_knowledge";
  if (families.has("catalogue")) return "document_catalogue";
  if (families.has("web")) return "public_web";
  return "general";
}

export function recipeStrategyFromCapabilities(capabilities: string[], sufficiency: RouteSufficiency[]): string {
  const sequence = capabilities.join(" → ") || "authorised catalogue";
  const recovered = sufficiency.some((row) => row === "INSUFFICIENT" || row === "FAILED") && sufficiency.some((row) => row === "SUFFICIENT");
  return recovered
    ? `${sequence}. First permitted route was insufficient; continue with another authorised source, then synthesise only from evidence.`
    : `${sequence}. Use permitted capabilities, inspect evidence, and synthesise a grounded answer. Ignore this hint when the current question differs.`;
}

export function recipeHintsForPrompt(recipes: SolutionRecipe[]): string {
  if (!recipes.length) return "";
  return [
    "Optional planning hints from prior successful turns for THIS company only. They are hints, not hard rules. Ignore or update them when context differs.",
    ...recipes.map(
      (recipe) =>
        `- ${recipe.problem_class}: ${sanitiseRecipeText(recipe.successful_strategy)} (capabilities ${recipe.capabilities_used.join(", ") || "none"}; successes ${recipe.success_count})`,
    ),
  ].join("\n");
}

export function sanitiseRecipeText(value: string): string {
  return String(value ?? "")
    .replace(PRIVATE_RECIPE_CONTENT, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function parseJsonList(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rowToRecipe(row: Record<string, unknown>): SolutionRecipe {
  return {
    recipe_id: String(row.recipe_id ?? ""),
    company_id: String(row.company_id ?? ""),
    problem_class: String(row.problem_class ?? ""),
    capabilities_used: parseJsonList(row.capabilities_used as string),
    evidence_types: parseJsonList(row.evidence_types as string),
    successful_strategy: String(row.successful_strategy ?? ""),
    confidence: Number(row.confidence ?? 0),
    created_at: String(row.created_at ?? ""),
    last_success: row.last_success ? String(row.last_success) : null,
    success_count: Number(row.success_count ?? 0),
    failure_count: Number(row.failure_count ?? 0),
  };
}

export async function loadCompanyRecipes(
  db: RecipeDb,
  companyId: string,
  limit = 4,
): Promise<SolutionRecipe[]> {
  if (!companyId) return [];
  await ensureIntelligenceRecipesSchema(db);
  const result = await db
    .prepare(
      `SELECT recipe_id, company_id, problem_class, capabilities_used, evidence_types,
              successful_strategy, confidence, created_at, last_success, success_count, failure_count
         FROM intelligence_solution_recipes
        WHERE company_id = ?
        ORDER BY success_count DESC, last_success DESC
        LIMIT ?`,
    )
    .bind(companyId, limit)
    .all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToRecipe);
}

export async function recordRecipeOutcome(
  db: RecipeDb,
  input: {
    companyId: string;
    tools: string[];
    text?: string;
    success: boolean;
    sufficiency?: RouteSufficiency[];
  },
): Promise<SolutionRecipe | null> {
  const companyId = String(input.companyId ?? "").trim();
  if (!companyId) return null;
  const capabilities = [...new Set(input.tools.filter(Boolean))].slice(0, 8);
  if (!capabilities.length) return null;
  const problemClass = classifyProblemClass({ tools: capabilities, text: input.text });
  const evidenceTypes = [...new Set(capabilities.map((name) => toolFamilyOf(name)).filter((family) => family !== "none"))];
  const strategy = sanitiseRecipeText(recipeStrategyFromCapabilities(capabilities, input.sufficiency ?? []));
  await ensureIntelligenceRecipesSchema(db);
  const existing = await db
    .prepare(
      `SELECT recipe_id, company_id, problem_class, capabilities_used, evidence_types,
              successful_strategy, confidence, created_at, last_success, success_count, failure_count
         FROM intelligence_solution_recipes
        WHERE company_id = ? AND problem_class = ?`,
    )
    .bind(companyId, problemClass)
    .first<Record<string, unknown>>();
  const now = nowIso();
  if (!existing) {
    if (!input.success) return null;
    const recipe: SolutionRecipe = {
      recipe_id: newId("recipe"),
      company_id: companyId,
      problem_class: problemClass,
      capabilities_used: capabilities,
      evidence_types: evidenceTypes,
      successful_strategy: strategy,
      confidence: 0.55,
      created_at: now,
      last_success: now,
      success_count: 1,
      failure_count: 0,
    };
    await db
      .prepare(
        `INSERT INTO intelligence_solution_recipes (
           recipe_id, company_id, problem_class, capabilities_used, evidence_types,
           successful_strategy, confidence, created_at, last_success, last_failure,
           success_count, failure_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
      )
      .bind(
        recipe.recipe_id,
        recipe.company_id,
        recipe.problem_class,
        JSON.stringify(recipe.capabilities_used),
        JSON.stringify(recipe.evidence_types),
        recipe.successful_strategy,
        recipe.confidence,
        recipe.created_at,
        recipe.last_success,
        recipe.success_count,
      )
      .run();
    return recipe;
  }
  const current = rowToRecipe(existing);
  const successCount = current.success_count + (input.success ? 1 : 0);
  const failureCount = current.failure_count + (input.success ? 0 : 1);
  const confidence = Math.max(0.15, Math.min(0.95, successCount / Math.max(1, successCount + failureCount)));
  const nextStrategy = input.success ? strategy : current.successful_strategy;
  await db
    .prepare(
      `UPDATE intelligence_solution_recipes
          SET capabilities_used = ?,
              evidence_types = ?,
              successful_strategy = ?,
              confidence = ?,
              last_success = CASE WHEN ? THEN ? ELSE last_success END,
              last_failure = CASE WHEN ? THEN ? ELSE last_failure END,
              success_count = ?,
              failure_count = ?
        WHERE recipe_id = ? AND company_id = ?`,
    )
    .bind(
      JSON.stringify(input.success ? capabilities : current.capabilities_used),
      JSON.stringify(input.success ? evidenceTypes : current.evidence_types),
      nextStrategy,
      confidence,
      input.success ? 1 : 0,
      now,
      input.success ? 0 : 1,
      now,
      successCount,
      failureCount,
      current.recipe_id,
      companyId,
    )
    .run();
  return {
    ...current,
    capabilities_used: input.success ? capabilities : current.capabilities_used,
    evidence_types: input.success ? evidenceTypes : current.evidence_types,
    successful_strategy: nextStrategy,
    confidence,
    last_success: input.success ? now : current.last_success,
    success_count: successCount,
    failure_count: failureCount,
  };
}

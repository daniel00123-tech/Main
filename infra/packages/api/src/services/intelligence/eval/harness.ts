import { runIntelligenceTurn } from "../orchestrator.js";
import type { IntelligenceCompleter } from "../provider.js";
import type { IntelligenceRuntime, IntelligenceToolResult, IntelligenceTurnResult } from "../types.js";
import { EVAL_FIXTURES, evaluationCases, type EvalCase, type EvalExpectation } from "./cases.js";

export type EvalScores = {
  cases: number;
  correctIntent: number;
  correctTool: number;
  correctEntity: number;
  correctClarification: number;
  grounded: number;
  hallucination: number;
  structuredOutput: number;
  contextualFollowUp: number;
  naturalQuality: number;
  unnecessaryTools: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  estimatedCostUsd: number;
  infraScore: number;
};

export type EvalRow = {
  id: string;
  category: string;
  text: string;
  expectedTool: string | null | undefined;
  actualTool: string | null;
  kind: string;
  pass: boolean;
  reasons: string[];
  latencyMs: number;
  costUsd: number;
};

const MOCK_USAGE = {
  provider: "workers-ai" as const,
  model: "eval-policy",
  latencyMs: 8,
  promptTokens: 80,
  completionTokens: 24,
  estimatedCostUsd: 0.00005,
};

export function mockedToolRuntime(): IntelligenceRuntime {
  return {
    async executeTool(call): Promise<IntelligenceToolResult> {
      const started = 2;
      if (call.name === "search_company_knowledge") {
        const q = String(call.arguments.query ?? "").toLowerCase();
        const results = [];
        if (/profile|staff|cv|2015|market/.test(q)) results.push({ id: EVAL_FIXTURES.CV.id, title: EVAL_FIXTURES.CV.title, url: EVAL_FIXTURES.CV.url, snippet: "Field sales executive, south east." });
        if (/vehicle|van|fuel|policy/.test(q)) results.push({ id: EVAL_FIXTURES.VAN.id, title: EVAL_FIXTURES.VAN.title, url: EVAL_FIXTURES.VAN.url, snippet: "Drivers must return vehicles on leaving." });
        if (/site|survey|coal/.test(q)) results.push({ id: EVAL_FIXTURES.SITE.id, title: EVAL_FIXTURES.SITE.title, url: EVAL_FIXTURES.SITE.url, snippet: "Site survey of the yard." });
        if (!results.length) {
          results.push(
            { id: EVAL_FIXTURES.CV.id, title: EVAL_FIXTURES.CV.title, url: EVAL_FIXTURES.CV.url, snippet: "Staff profile" },
            { id: EVAL_FIXTURES.VAN.id, title: EVAL_FIXTURES.VAN.title, url: EVAL_FIXTURES.VAN.url, snippet: "Vehicle policy" },
          );
        }
        return { name: call.name, ok: true, latencyMs: started, data: { results } };
      }
      if (call.name === "search_document" || call.name === "get_knowledge_document") {
        const id = String(call.arguments.document_id ?? call.arguments.id ?? "");
        const doc = [EVAL_FIXTURES.CV, EVAL_FIXTURES.VAN, EVAL_FIXTURES.SITE].find((item) => item.id === id) ?? EVAL_FIXTURES.CV;
        const none = id === EVAL_FIXTURES.CV.id && /van|fuel|vehicle|coal/.test(String(call.arguments.query ?? "").toLowerCase());
        return {
          name: call.name,
          ok: true,
          latencyMs: started,
          data: {
            document_id: doc.id,
            title: doc.title,
            url: doc.url,
            none,
            chunks: none
              ? []
              : [{ id: "c0", text: id === EVAL_FIXTURES.VAN.id ? "Return the vehicle when employment ends. Fuel is recorded weekly." : "Field sales executive covering the south east, 2014-2016." }],
          },
        };
      }
      if (call.name.startsWith("xero_")) {
        return { name: call.name, ok: true, latencyMs: started, data: { summary: "Sales 12k, overdue 2 invoices." } };
      }
      if (call.name === "outlook_search_mailbox") {
        return { name: call.name, ok: true, latencyMs: started, data: { messages: [{ subject: "Invoice scan" }] } };
      }
      return { name: call.name, ok: true, latencyMs: started, data: { ok: true } };
    },
  };
}

/** Reference policy completer — same prompts/tools, deterministic expected behaviour. */
export function policyCompleter(): IntelligenceCompleter {
  return async ({ user }) => {
    const userLine = user.match(/User: (.*)$/m)?.[1] ?? "";
    const current = user.match(/Current document: (.+)$/m)?.[1] ?? "none";
    const hasCurrent = current !== "none";
    const correction = /User correction/.test(user);
    const evidence = /Evidence so far: none yet/.test(user) === false && /Evidence so far:\n/.test(user);
    if (evidence) {
      const none = /"none":true/.test(user);
      return json({
        action: "answer",
        text: none
          ? "That file does not mention it. I can look in other documents if you want."
          : "From the retrieved evidence: the supported facts are above.",
        confidence: none ? "none" : "strong",
        offer_search_other: none,
        cite_source: /url=https?:\/\//.test(current),
      });
    }
    if (/^(hi|hello|hey|morning|cheers|thanks|thank you|what can you do)\b/i.test(userLine.trim())) {
      return json({ action: "answer", text: "Hi — what do you need?", confidence: "strong", offer_search_other: false, cite_source: false });
    }
    if (correction && /vehicle|site survey/i.test(userLine)) {
      return json({ action: "call_tool", name: "search_company_knowledge", arguments: { query: userLine } });
    }
    if (correction && /not what I (meant|asked)|something else/i.test(userLine)) {
      return json({ action: "clarify", text: "Sorry — what did you want instead?" });
    }
    if (hasCurrent && /open the source|source (link|url)|where did you get/i.test(userLine)) {
      return json({ action: "call_tool", name: "get_knowledge_document", arguments: { document_id: idFromCurrent(current) } });
    }
    if (/sales|overdue|invoice|p&l|pnl|owes/i.test(userLine) && !hasCurrent) {
      const name = /INV-|\binvoice\b.*\d/i.test(userLine)
        ? "xero_get_invoice"
        : /overdue|owes/i.test(userLine)
          ? "xero_list_overdue_invoices"
          : /p&l|pnl/i.test(userLine)
            ? "xero_profit_and_loss"
            : "xero_sales_summary";
      return json({ action: "call_tool", name, arguments: /INV-003/.test(userLine) ? { invoice_id: "INV-003" } : {} });
    }
    if (/mailbox|outlook|inbox/i.test(userLine)) {
      return json({ action: "call_tool", name: "outlook_search_mailbox", arguments: { query: userLine } });
    }
    if (/what's the policy|find the document|open that file|the other one|policy on this|pull up the policy/i.test(userLine) && !hasCurrent) {
      return json({ action: "clarify", text: "Which document do you mean?" });
    }
    if (hasCurrent && !/\b(find|search|look(?:ing)? (for|up)|another|different|other (doc|document|file)|broaden|return to)\b/i.test(userLine)) {
      return json({
        action: "call_tool",
        name: "search_document",
        arguments: { document_id: idFromCurrent(current), query: userLine },
      });
    }
    return json({ action: "call_tool", name: "search_company_knowledge", arguments: { query: userLine } });
  };
}

/** Simulates V1 Llama 3.1 8B empty/non-JSON behaviour on first call, then recovery. */
export function v1FragileCompleter(): IntelligenceCompleter {
  let n = 0;
  return async (input) => {
    n += 1;
    if (n % 3 === 1) {
      return { text: "", usage: { ...MOCK_USAGE, model: "@cf/meta/llama-3.1-8b-instruct", malformed: true } };
    }
    if (n % 3 === 2) {
      return { text: "Sure, I can help with that.", usage: { ...MOCK_USAGE, model: "@cf/meta/llama-3.1-8b-instruct", malformed: true } };
    }
    return policyCompleter()(input);
  };
}

export async function runEvaluationSuite(completer: IntelligenceCompleter): Promise<{
  scores: EvalScores;
  rows: EvalRow[];
}> {
  const cases = evaluationCases();
  const rows: EvalRow[] = [];
  const latencies: number[] = [];
  let cost = 0;
  const tally = {
    correctIntent: 0,
    correctTool: 0,
    correctEntity: 0,
    correctClarification: 0,
    grounded: 0,
    hallucination: 0,
    structuredOutput: 0,
    contextualFollowUp: 0,
    naturalQuality: 0,
    unnecessaryTools: 0,
    followUps: 0,
  };

  for (const testCase of cases) {
    const started = Date.now();
    const result = await runIntelligenceTurn({
      text: testCase.text,
      state: testCase.state,
      runtime: mockedToolRuntime(),
      completer,
    });
    const latency = Date.now() - started || result.totalModelMs;
    latencies.push(latency);
    cost += result.estimatedCostUsd;
    const judged = judgeCase(testCase, result);
    rows.push({
      id: testCase.id,
      category: testCase.category,
      text: testCase.text,
      expectedTool: testCase.expect.tool,
      actualTool: result.toolCalls[0]?.name ?? (result.kind === "fast_path" ? null : null),
      kind: result.kind,
      pass: judged.pass,
      reasons: judged.reasons,
      latencyMs: latency,
      costUsd: result.estimatedCostUsd,
    });
    if (judged.intent) tally.correctIntent += 1;
    if (judged.tool) tally.correctTool += 1;
    if (judged.entity) tally.correctEntity += 1;
    if (judged.clarify) tally.correctClarification += 1;
    if (judged.grounded) tally.grounded += 1;
    if (judged.hallucination) tally.hallucination += 1;
    if (judged.structured) tally.structuredOutput += 1;
    if (testCase.expect.stayOnDocument) {
      tally.followUps += 1;
      if (judged.followUp) tally.contextualFollowUp += 1;
    }
    if (judged.natural) tally.naturalQuality += 1;
    if (judged.unnecessary) tally.unnecessaryTools += 1;
  }

  const n = cases.length;
  const avg = average(latencies);
  const p95 = percentile(latencies, 95);
  const infraScore =
    (tally.correctIntent / n) * 20 +
    (tally.correctTool / n) * 22 +
    (tally.correctEntity / n) * 12 +
    (tally.correctClarification / n) * 8 +
    (tally.grounded / n) * 22 +
    (1 - tally.hallucination / n) * 10 +
    (tally.structuredOutput / n) * 6 +
    (tally.followUps ? tally.contextualFollowUp / tally.followUps : 1) * 12 +
    (tally.naturalQuality / n) * 4 -
    (tally.unnecessaryTools / n) * 8 -
    Math.min(2, avg / 5_000);

  return {
    scores: {
      cases: n,
      correctIntent: pct(tally.correctIntent, n),
      correctTool: pct(tally.correctTool, n),
      correctEntity: pct(tally.correctEntity, n),
      correctClarification: pct(tally.correctClarification, n),
      grounded: pct(tally.grounded, n),
      hallucination: pct(tally.hallucination, n),
      structuredOutput: pct(tally.structuredOutput, n),
      contextualFollowUp: tally.followUps ? pct(tally.contextualFollowUp, tally.followUps) : 100,
      naturalQuality: pct(tally.naturalQuality, n),
      unnecessaryTools: pct(tally.unnecessaryTools, n),
      avgLatencyMs: avg,
      p95LatencyMs: p95,
      estimatedCostUsd: cost / n,
      infraScore: Math.max(0, Math.round(infraScore * 10) / 10),
    },
    rows,
  };
}

function judgeCase(testCase: EvalCase, result: IntelligenceTurnResult) {
  const reasons: string[] = [];
  const firstTool = result.toolCalls[0]?.name ?? null;
  const expect = testCase.expect;
  const intent = matchesIntent(expect, result, firstTool);
  if (!intent) reasons.push("intent");
  const tool =
    expect.allowNoTool && !firstTool
      ? true
      : expect.tool
        ? firstTool === expect.tool || result.toolCalls.some((call) => call.name === expect.tool)
        : expect.tool === null
          ? !firstTool || result.kind === "fast_path"
          : true;
  if (!tool) reasons.push("tool");
  const entity = expect.stayOnDocument
    ? result.currentDocument?.id === testCase.state.currentDocument?.id &&
      !result.toolCalls.some((call) => call.name === "search_company_knowledge")
    : true;
  if (!entity) reasons.push("entity");
  const clarify = expect.clarify ? result.kind === "clarify" || result.clarification : !expect.clarify || result.kind !== "answer" || result.confidence !== "strong";
  if (expect.clarify && result.kind !== "clarify" && !result.clarification) reasons.push("clarify");
  const grounded = expect.grounded !== false ? !/https:\/\/invented|£9,999|Jane Doe invented/.test(result.text) : true;
  const hallucination = /https:\/\/invented|I am sure they earned £/.test(result.text);
  const structured = result.kind !== "failed";
  const followUp = Boolean(entity && expect.stayOnDocument);
  const natural = result.text.length < 1_200 && !/vectorize|workers ai|mcp\b|\bd1\b/i.test(result.text);
  const unnecessary =
    expect.allowNoTool && result.toolCalls.length > 0 && result.kind !== "fast_path" && expect.intent === "chat";
  return {
    pass: reasons.length === 0 && !hallucination,
    reasons,
    intent,
    tool,
    entity,
    clarify,
    grounded,
    hallucination,
    structured,
    followUp,
    natural,
    unnecessary,
  };
}

function matchesIntent(expect: EvalExpectation, result: IntelligenceTurnResult, firstTool: string | null): boolean {
  switch (expect.intent) {
    case "chat":
      return result.kind === "fast_path" || (result.kind === "answer" && !firstTool);
    case "search":
      return result.toolCalls.some((call) => call.name === "search_company_knowledge");
    case "scoped":
      return result.toolCalls.some((call) => call.name === "search_document") || result.kind === "answer";
    case "fetch":
    case "source":
      return (
        result.kind === "fast_path" ||
        result.toolCalls.some((call) => call.name === "get_knowledge_document") ||
        /https?:\/\//.test(result.text)
      );
    case "clarify":
    case "replan":
      return result.kind === "clarify" || result.kind === "answer" || result.toolCalls.length > 0;
    case "xero":
      return result.toolCalls.some((call) => call.name.startsWith("xero_"));
    case "mailbox":
      return result.toolCalls.some((call) => call.name === "outlook_search_mailbox");
    case "none":
      return result.kind === "fast_path" || result.kind === "answer" || result.kind === "clarify";
    default:
      return true;
  }
}

function json(value: Record<string, unknown>) {
  return { text: JSON.stringify(value), usage: MOCK_USAGE };
}

function idFromCurrent(current: string): string {
  const match = current.match(/id=([^);]+)/);
  return match?.[1] ?? EVAL_FIXTURES.CV.id;
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

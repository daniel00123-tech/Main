import { isGenericRetryCopy } from "../intelligence/verbalise-business.js";
import type { FrozenQuestion } from "./el-business-whatsapp-50-v1.js";

export type Grade = "GOOD" | "ACCEPTABLE" | "POOR" | "UNUSABLE";

export type FailureCategory =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R";

export type ScoredTurn = {
  id: string;
  text: string;
  actor: string;
  role: string | null;
  family: FrozenQuestion["family"];
  sourceClient: string;
  scope: string | null;
  capability: string | null;
  tools: string[];
  action: string | null;
  arguments: Record<string, unknown>[];
  resultPreview: string;
  latencyMs: number;
  duplicateCalls: boolean;
  usageAction: string | null;
  settlement: string | null;
  charged: boolean;
  grade: Grade;
  categories: FailureCategory[];
  inventedFigures: boolean;
  permissionLeak: boolean;
  misroute: boolean;
  genericRetryOnSuccess: boolean;
};

const INVENTED_MONEY = /£\s?[\d,]+(?:\.\d{2})?/;

export function scoreTurn(input: {
  question: FrozenQuestion;
  role: string | null;
  reply: string;
  tools: string[];
  scope: string | null;
  latencyMs: number;
  settlement?: string | null;
  usageAction?: string | null;
  charged?: boolean;
  arguments?: Record<string, unknown>[];
  toolOk?: boolean[];
}): ScoredTurn {
  const tools = input.tools;
  const reply = input.reply ?? "";
  const categories: FailureCategory[] = [];
  let misroute = false;
  const expected = input.question.expectedToolPrefix;
  const firstTool = tools[0] ?? null;

  if (expected && firstTool && !firstTool.startsWith(expected.replace(/_$/, "")) && !firstTool.startsWith(expected)) {
    if (expected.startsWith("xero_") && !firstTool.startsWith("xero_")) {
      misroute = true;
      categories.push(firstTool.startsWith("search") || firstTool.includes("knowledge") ? "A" : "A");
    } else if (expected.startsWith("outlook_") && firstTool.startsWith("xero_")) {
      misroute = true;
      categories.push("A");
    } else if (expected === "search_company_knowledge" && firstTool.startsWith("xero_")) {
      misroute = true;
      categories.push("A");
    } else if (expected === "list_documents" && firstTool !== "list_documents") {
      categories.push("P");
    } else if (!firstTool.startsWith(expected.replace(/_$/, ""))) {
      categories.push("A");
      misroute = expected.startsWith("xero_") || expected.startsWith("outlook_");
    }
  }
  if (expected?.startsWith("xero_") && tools.some((name) => name === "search_company_knowledge" || name === "database_summary")) {
    misroute = true;
    if (!categories.includes("A")) categories.push("A");
  }
  if (expected?.startsWith("outlook_") && tools.some((name) => name.startsWith("xero_"))) {
    misroute = true;
    if (!categories.includes("A")) categories.push("A");
  }

  const deniedReply = /permissions? don.?t allow|not allowed|permission_denied/i.test(reply);
  const permissionLeak =
    input.question.expectedDeny && !deniedReply && /£|invoice|subject|from /i.test(reply);
  if (input.question.expectedDeny && !deniedReply) categories.push("B");
  if (!input.question.expectedDeny && deniedReply && input.question.actor === "director") categories.push("B");
  if (permissionLeak) categories.push("B");

  const genericRetryOnSuccess =
    isGenericRetryCopy(reply) && tools.length > 0 && (input.toolOk ?? []).some(Boolean);
  if (genericRetryOnSuccess) categories.push("H");

  const inventedFigures =
    Boolean(reply.match(INVENTED_MONEY)) &&
    !tools.some((name) => name.startsWith("xero_")) &&
    input.question.family === "xero";
  if (inventedFigures) categories.push("N");

  const duplicateCalls = countDuplicates(tools) > 0;
  if (duplicateCalls) categories.push("J");

  if (input.question.family === "memory" && tools.length > 0) categories.push("L");
  if (input.question.family === "correction" && expected && firstTool && !toolMatches(firstTool, expected)) {
    categories.push("K");
  }
  if (/couldn.?t find any matching/i.test(reply) && (input.toolOk ?? [true])[0] === false) categories.push("F");
  if (isGenericRetryCopy(reply) && (input.toolOk ?? []).every((ok) => ok === false)) categories.push("M");

  let grade: Grade = "GOOD";
  if (permissionLeak || inventedFigures || (misroute && input.question.family !== "memory")) grade = "UNUSABLE";
  else if (categories.includes("B") || genericRetryOnSuccess) grade = "POOR";
  else if (categories.length && grade === "GOOD") grade = "ACCEPTABLE";
  if (input.question.expectedDeny && deniedReply && !permissionLeak) {
    grade = "GOOD";
  }
  if (input.question.family === "knowledge" && /couldn.?t find any matching documents/i.test(reply) && !misroute) {
    grade = "ACCEPTABLE";
    if (!categories.includes("Q")) categories.push("Q");
  }

  return {
    id: input.question.id,
    text: input.question.text,
    actor: input.question.actor,
    role: input.role,
    family: input.question.family,
    sourceClient: "whatsapp",
    scope: input.scope,
    capability: firstTool,
    tools,
    action: input.usageAction ?? firstTool,
    arguments: input.arguments ?? [],
    resultPreview: reply.slice(0, 280),
    latencyMs: input.latencyMs,
    duplicateCalls,
    usageAction: input.usageAction ?? null,
    settlement: input.settlement ?? null,
    charged: Boolean(input.charged),
    grade,
    categories: [...new Set(categories)],
    inventedFigures,
    permissionLeak,
    misroute,
    genericRetryOnSuccess,
  };
}

function toolMatches(name: string, expected: string): boolean {
  if (expected.endsWith("_")) return name.startsWith(expected);
  return name === expected || name.startsWith(expected);
}

function countDuplicates(tools: string[]): number {
  const seen = new Map<string, number>();
  let extras = 0;
  for (const name of tools) {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1 && /^(xero_|outlook_)/.test(name)) extras += 1;
  }
  return extras;
}

export function tallyGrades(turns: ScoredTurn[]): Record<Grade, number> {
  const tallies: Record<Grade, number> = { GOOD: 0, ACCEPTABLE: 0, POOR: 0, UNUSABLE: 0 };
  for (const turn of turns) tallies[turn.grade] += 1;
  return tallies;
}

export function acceptanceGate(turns: ScoredTurn[]): { pass: boolean; reasons: string[] } {
  const tallies = tallyGrades(turns);
  const total = turns.length || 1;
  const goodAccept = (tallies.GOOD + tallies.ACCEPTABLE) / total;
  const good = tallies.GOOD / total;
  const reasons: string[] = [];
  if (turns.some((turn) => turn.inventedFigures)) reasons.push("invented figures");
  if (turns.some((turn) => turn.family === "outlook" && turn.tools.some((name) => name.startsWith("xero_")))) {
    reasons.push("email→Xero misroute");
  }
  if (turns.some((turn) => turn.family === "xero" && turn.tools.some((name) => name.includes("knowledge") || name === "database_summary"))) {
    reasons.push("Xero→knowledge misroute");
  }
  if (turns.some((turn) => turn.permissionLeak)) reasons.push("permission leak");
  if (turns.some((turn) => turn.duplicateCalls && turn.charged)) reasons.push("duplicate billing");
  if (turns.some((turn) => turn.genericRetryOnSuccess)) reasons.push("generic retry on success");
  if (goodAccept < 0.95) reasons.push(`GOOD+ACCEPTABLE ${(goodAccept * 100).toFixed(1)}% < 95%`);
  if (good < 0.9) reasons.push(`GOOD ${(good * 100).toFixed(1)}% < 90%`);
  return { pass: reasons.length === 0, reasons };
}


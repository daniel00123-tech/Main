import { isGenericRetryCopy } from "../intelligence/verbalise-business.js";
import type { ChannelScore, ExpectedSource, OvernightQuestion, OvernightTurnScore } from "./types";

const MONEY = /£\s?[\d,]+(?:\.\d{2})?/;

export function actualSourceFromTools(tools: string[], payloadSource?: string | null): string | null {
  if (payloadSource) return payloadSource;
  if (tools.some((name) => name.startsWith("warehouse_"))) return "xero_warehouse";
  if (tools.some((name) => name.startsWith("xero_"))) return "xero_live";
  if (tools.some((name) => name.startsWith("outlook_"))) return "outlook";
  if (tools.some((name) => /knowledge|search|fetch|ask_document/.test(name))) return "knowledge";
  if (tools.some((name) => name === "list_documents")) return "catalogue";
  return tools.length ? tools[0] : null;
}

export function toolMatchesExpected(tools: string[], expected: string | null): boolean {
  if (!expected) return true;
  return tools.some((name) => name === expected || name.startsWith(expected.replace(/_$/, "")));
}

export function scoreOvernightTurn(input: {
  question: OvernightQuestion;
  tools: string[];
  reply: string;
  denied: boolean;
  charged: boolean;
  latencyMs: number;
  payloadSource?: string | null;
  warehouseAsOf?: string | null;
  completeness?: string | null;
  liveXeroAlsoCalled?: boolean;
  terminal?: string;
}): OvernightTurnScore {
  const tools = input.tools;
  const reply = input.reply ?? "";
  const defects: string[] = [];
  const actualSource = actualSourceFromTools(tools, input.payloadSource);
  const expected = input.question.expectedSource;

  let sourceOk = true;
  if (expected === "xero_warehouse") {
    sourceOk = actualSource === "xero_warehouse" || tools.some((name) => name.startsWith("warehouse_"));
    if (!sourceOk) defects.push("WRONG_SOURCE");
    if (input.liveXeroAlsoCalled) {
      sourceOk = false;
      defects.push("UNNECESSARY_LIVE_XERO");
    }
    if (sourceOk && !input.warehouseAsOf && input.question.channel !== "whatsapp" && input.question.channel !== "portal") {
      defects.push("MISSING_WAREHOUSE_AS_OF");
    }
    if (sourceOk && !input.completeness && input.question.channel === "mcp") {
      defects.push("MISSING_COMPLETENESS");
    }
  } else if (expected === "xero_live") {
    sourceOk = actualSource === "xero_live" || tools.some((name) => name.startsWith("xero_"));
    if (!sourceOk && input.question.family !== "mixed") defects.push("WRONG_SOURCE");
  } else if (expected && expected !== "none") {
    sourceOk = actualSource === expected || toolMatchesExpected(tools, input.question.expectedToolPrefix);
    if (!sourceOk && !input.question.expectedDeny) defects.push("WRONG_TOOL");
  }

  if (input.question.expectedToolPrefix && tools.length && !toolMatchesExpected(tools, input.question.expectedToolPrefix)) {
    if (input.question.family === "followup" && !input.question.expectedToolPrefix) {
      /* follow-up may reuse evidence */
    } else if (input.question.expectedSource === "none" && tools.length) {
      defects.push("UNNECESSARY_TOOL");
    } else if (!input.question.expectedDeny) {
      defects.push("WRONG_TOOL_FAMILY");
    }
  }

  if (input.question.expectedSource === "none" && tools.length > 0 && input.question.family === "followup") {
    defects.push("FOLLOWUP_SHOULD_REUSE_EVIDENCE");
  }
  if (input.question.expectedSource === "none" && tools.length > 0 && input.question.family === "no_tool") {
    defects.push("UNNECESSARY_TOOL");
  }

  const deniedReply = /permissions? don.?t allow|not allowed|permission_denied|don’t allow this action/i.test(reply);
  const rbacOk = input.question.expectedDeny ? deniedReply || input.denied : !input.denied && !deniedReply;
  if (!rbacOk) defects.push(input.question.expectedDeny ? "FALSE_PERMISSION_GRANT" : "FALSE_PERMISSION_DENIAL");

  const permissionLeak =
    input.question.expectedDeny && !deniedReply && /£|invoice|subject|from /i.test(reply) && !input.denied;
  if (permissionLeak) defects.push("PERMISSION_LEAK");

  const genericRetry = isGenericRetryCopy(reply) && tools.length > 0;
  if (genericRetry) defects.push("GENERIC_RETRY");

  const hallucination =
    Boolean(reply.match(MONEY)) &&
    !tools.some((name) => name.startsWith("xero_") || name.startsWith("warehouse_")) &&
    (input.question.family === "xero_live" || input.question.family === "xero_warehouse");
  if (hallucination) defects.push("HALLUCINATION");

  const counts = new Map<string, number>();
  for (const name of tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  const duplicateTools = [...counts.values()].some((n) => n > 1) && tools.some((name) => /^(xero_|warehouse_|outlook_)/.test(name));
  if (duplicateTools) defects.push("DUPLICATE_TOOL");

  const unnecessaryTools = input.question.expectedSource === "none" && tools.length > 0;
  if (input.charged) defects.push("TEST_TRAFFIC_CHARGED");
  if (!reply.trim() && !input.question.expectedDeny) defects.push("NO_FINAL_ANSWER");
  if (input.latencyMs > 45_000) defects.push("SLOW_RESPONSE");

  const firstAnswer = Boolean(reply.trim()) && !genericRetry;
  const grounded = !hallucination && (input.question.expectedDeny || tools.length > 0 || input.question.expectedSource === "none");
  const unique = [...new Set(defects)];
  const perfect =
    unique.filter((d) => d !== "MISSING_WAREHOUSE_AS_OF" && d !== "MISSING_COMPLETENESS").length === 0 &&
    rbacOk &&
    !permissionLeak &&
    !hallucination &&
    !input.charged;

  return {
    id: input.question.id,
    channel: input.question.channel,
    text: input.question.text,
    actor: input.question.actor,
    family: input.question.family,
    tools,
    expectedSource: expected,
    actualSource,
    sourceOk,
    rbacOk,
    grounded,
    firstAnswer,
    hallucination,
    unnecessaryTools,
    duplicateTools,
    genericRetry,
    charged: input.charged,
    latencyMs: input.latencyMs,
    reply: reply.slice(0, 360),
    terminal: input.terminal ?? (perfect ? "success" : "defect"),
    perfect,
    defects: unique,
  };
}

export function scoreChannel(label: string, turns: OvernightTurnScore[]): ChannelScore {
  const defects = [...new Set(turns.flatMap((turn) => turn.defects))];
  const perfect = turns.filter((turn) => turn.perfect).length;
  const score = turns.length === 0 ? 0 : perfect === turns.length && defects.length === 0 ? 10 : Math.max(0, Math.round((perfect / turns.length) * 10));
  return { channel: label, turns: turns.length, perfect, score, defects };
}

export function overallFromChannels(channels: ChannelScore[]): number {
  if (!channels.length) return 0;
  if (channels.some((row) => row.score < 10 && row.turns > 0)) {
    const weighted = channels.reduce((sum, row) => sum + row.score * row.turns, 0);
    const total = channels.reduce((sum, row) => sum + row.turns, 0) || 1;
    return Math.round((weighted / total) * 10) / 10;
  }
  return 10;
}

export function expectedSourceLabel(value: ExpectedSource): string {
  return value ?? "none";
}

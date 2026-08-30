import type { ConversationEvaluation, QualityFlagCategory } from "./types";

export interface QualityPattern {
  fingerprint: string;
  companyId: string | null;
  category: QualityFlagCategory | "mixed";
  title: string;
  rootCause: string;
  occurrenceCount: number;
  severity: "low" | "medium" | "high";
  evidence: Array<{ conversationKey: string; interactionId?: string | null; snippet: string }>;
  platformAggregate?: boolean;
}

export function groupQualityPatterns(evaluations: ConversationEvaluation[]): QualityPattern[] {
  const byCompany = new Map<string, ConversationEvaluation[]>();
  for (const evaluation of evaluations) {
    const list = byCompany.get(evaluation.companyId) ?? [];
    list.push(evaluation);
    byCompany.set(evaluation.companyId, list);
  }

  const patterns: QualityPattern[] = [];
  for (const [companyId, rows] of byCompany) {
    patterns.push(...groupForCompany(companyId, rows));
  }
  patterns.push(...anonymisedPlatformAggregates(evaluations));
  return patterns;
}

function groupForCompany(companyId: string, evaluations: ConversationEvaluation[]): QualityPattern[] {
  const buckets = new Map<string, ConversationEvaluation[]>();
  for (const evaluation of evaluations) {
    const negatives = evaluation.flags.filter((flag) => flag.polarity === "negative");
    if (negatives.length === 0) continue;
    for (const flag of negatives) {
      const key = `${companyId}:${flag.category}`;
      const list = buckets.get(key) ?? [];
      list.push(evaluation);
      buckets.set(key, list);
    }
  }

  const patterns: QualityPattern[] = [];
  for (const [key, rows] of buckets) {
    const category = key.split(":")[1] as QualityFlagCategory;
    const unique = uniqueBy(rows, (row) => row.conversationKey);
    patterns.push({
      fingerprint: key,
      companyId,
      category,
      title: titleFor(category),
      rootCause: rootCauseFor(category),
      occurrenceCount: unique.length,
      severity: unique.some((row) => row.flags.some((flag) => flag.category === category && flag.severity === "high"))
        ? "high"
        : "medium",
      evidence: unique.slice(0, 3).map((row) => ({
        conversationKey: row.conversationKey,
        interactionId: row.interactionId,
        snippet: row.flags.find((flag) => flag.category === category)?.evidence ?? "See interaction detail",
      })),
    });
  }
  return patterns;
}

function anonymisedPlatformAggregates(evaluations: ConversationEvaluation[]): QualityPattern[] {
  const counts = new Map<string, number>();
  for (const evaluation of evaluations) {
    for (const flag of evaluation.flags.filter((item) => item.polarity === "negative")) {
      counts.set(flag.category, (counts.get(flag.category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([category, count]) => ({
      fingerprint: `platform:${category}`,
      companyId: null,
      category: category as QualityFlagCategory,
      title: `Platform aggregate: ${titleFor(category as QualityFlagCategory)}`,
      rootCause: rootCauseFor(category as QualityFlagCategory),
      occurrenceCount: count,
      severity: count >= 5 ? "high" : "medium",
      evidence: [],
      platformAggregate: true,
    }));
}

function titleFor(category: QualityFlagCategory): string {
  switch (category) {
    case "silence":
      return "Silent WhatsApp turns";
    case "raw_dump":
      return "Raw tool dumps in replies";
    case "missing_source_url":
      return "Missing source URLs";
    case "context_loss":
      return "Follow-up context loss";
    case "excessive_latency":
      return "Excessive WhatsApp latency";
    case "rephrase":
      return "Users rephrasing unanswered asks";
    case "repeated_acks":
      return "Repeated acknowledgements";
    case "greeting_slow":
      return "Slow WhatsApp greetings";
    case "no_ack_on_slow_turn":
      return "No typing or ack on a slow turn";
    case "first_visible_slow":
      return "Slow first visible WhatsApp reply";
    case "rephrase_before_answer":
      return "Second message before first answer";
    case "outbound_meta_failure":
      return "Meta outbound send failures";
    case "wrong_tool":
      return "Wrong or unnecessary tool";
    case "permission_ux":
      return "Permission denial UX";
    default:
      return category.replace(/_/g, " ");
  }
}

function rootCauseFor(category: QualityFlagCategory): string {
  switch (category) {
    case "silence":
      return "Final send path or watchdog did not emit a user-visible reply.";
    case "raw_dump":
      return "Response compression / format rules did not strip tool payloads.";
    case "missing_source_url":
      return "Planner or source lookup did not attach a usable URL after an explicit ask.";
    case "context_loss":
      return "Entity memory was not reused for a follow-up or button tap.";
    case "excessive_latency":
      return "Ack, tool, or outbound path exceeded the WhatsApp latency budget.";
    case "rephrase":
      return "First answer was empty, ungrounded, or did not match the ask.";
    case "repeated_acks":
      return "Progress/ack policy fired more than once before a useful final.";
    case "greeting_slow":
      return "Greeting path still waited on connectors, MCP, or queue before sending text.";
    case "no_ack_on_slow_turn":
      return "Tool turn exceeded 3s without a typing indicator or text acknowledgement.";
    case "first_visible_slow":
      return "First user-visible WhatsApp response exceeded 3 seconds.";
    case "rephrase_before_answer":
      return "User sent a second or rephrased message before the first answer arrived.";
    case "outbound_meta_failure":
      return "Meta Cloud API failed an outbound text send.";
    case "wrong_tool":
      return "Planner ranking selected an unnecessary or incorrect tool.";
    case "permission_ux":
      return "Denial copy or unexpected deny — confirm this is policy, not model failure.";
    default:
      return "Evidence-backed WhatsApp quality pattern.";
  }
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

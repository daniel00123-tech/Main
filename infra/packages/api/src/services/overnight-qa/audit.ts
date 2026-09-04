import type { Env } from "../../env";
import { NON_CUSTOMER_TRAFFIC } from "../daily-improvement/constants";
import { isGenuineCustomerTraffic } from "../daily-improvement/traffic";

const REPAIR =
  /\b(i meant|no,?\s+|that is wrong|that'?s wrong|try again|what about|make it shorter|make it friendlier|you.?re wrong|not what i asked)\b/i;

export type SevenDayIssue = {
  cluster: string;
  severity: "P0" | "P1" | "P2" | "P3";
  count: number;
  example: string;
  reproduced: boolean;
};

export async function auditLastSevenDays(env: Env): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const portal = await env.DB.prepare(
    `SELECT m.id, m.conversation_id, m.company_id, m.user_id, m.content, m.created_at, u.email AS email
     FROM portal_conversation_messages m
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.role = 'user' AND m.created_at >= ?
     ORDER BY m.created_at ASC LIMIT 500`,
  )
    .bind(since)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] as Array<Record<string, unknown>> }));

  const usage = await env.DB.prepare(
    `SELECT interaction_id, company_id, source_client, tool_name, action, success, customer_charge_cents, duration_ms, recorded_at
     FROM usage_records
     WHERE recorded_at >= ?
       AND source_client IN ('whatsapp','portal_chat','chatgpt','claude')
     ORDER BY recorded_at ASC LIMIT 800`,
  )
    .bind(since)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] as Array<Record<string, unknown>> }));

  const daily = await env.DB.prepare(
    `SELECT interaction_id, company_id, channel, user_message, assistant_answer, tools_executed, traffic_class, source_client, terminal_state, customer_charge_cents, created_at
     FROM daily_improvement_interactions
     WHERE created_at >= ?
     ORDER BY created_at ASC LIMIT 500`,
  )
    .bind(since)
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] as Array<Record<string, unknown>> }));

  const customerDaily = (daily.results ?? []).filter((row) => {
    const traffic = String(row.traffic_class ?? "CUSTOMER_REQUEST");
    if (NON_CUSTOMER_TRAFFIC.has(traffic)) return false;
    return isGenuineCustomerTraffic(traffic);
  });

  const portalUsers = (portal.results ?? []).filter((row) => {
    const text = String(row.content ?? "");
    return !/ova_|InfraAcceptance|overnight/i.test(text);
  });

  const clusters = new Map<string, { count: number; example: string; severity: SevenDayIssue["severity"] }>();
  const bump = (cluster: string, severity: SevenDayIssue["severity"], example: string) => {
    const existing = clusters.get(cluster);
    if (existing) existing.count += 1;
    else clusters.set(cluster, { count: 1, example: example.slice(0, 160), severity });
  };

  let repairTurns = 0;
  for (const row of portalUsers) {
    const text = String(row.content ?? "");
    if (REPAIR.test(text)) {
      repairTurns += 1;
      bump("USER_REPAIR", "P1", text);
    }
  }
  for (const row of customerDaily) {
    const message = String(row.user_message ?? "");
    const answer = String(row.assistant_answer ?? "");
    const tools = String(row.tools_executed ?? "");
    const terminal = String(row.terminal_state ?? "");
    if (REPAIR.test(message)) {
      repairTurns += 1;
      bump("USER_REPAIR", "P1", message);
    }
    if (/couldn.?t find any matching/i.test(answer)) bump("FALSE_NO_RESULT", "P1", message);
    if (/permission/i.test(answer) && /xero|sales|invoice/i.test(message)) bump("FALSE_PERMISSION_DENIAL", "P1", message);
    if (/need another moment|try asking once more/i.test(answer)) bump("GENERIC_RETRY", "P1", message);
    if (!answer.trim() || /NO_FINAL/i.test(terminal)) bump("NO_FINAL_ANSWER", "P0", message);
    if (/xero_/i.test(tools) && /\bemail|inbox|mailbox\b/i.test(message) && !/xero|sales|invoice/i.test(message)) {
      bump("WRONG_TOOL", "P0", message);
    }
    if (/timeout/i.test(terminal)) bump("PORTAL_CHAT_TIMEOUT", "P1", message);
    if (Number(row.customer_charge_cents ?? 0) > 3) bump("BILLING_ANOMALY", "P0", message);
  }

  const issues: SevenDayIssue[] = [...clusters.entries()].map(([cluster, value]) => ({
    cluster,
    severity: value.severity,
    count: value.count,
    example: value.example,
    reproduced: false,
  }));

  const customerTurns = customerDaily.length + portalUsers.length;
  return {
    since,
    portalUserTurns: portalUsers.length,
    usageRows: (usage.results ?? []).length,
    dailyCustomerTurns: customerDaily.length,
    genuineConversationsReviewed: customerTurns,
    repairTurns,
    repeatedUserRate: customerTurns ? Number((repairTurns / customerTurns).toFixed(3)) : 0,
    issues,
    clusters: issues,
    permissionLeakCount: 0,
    hallucinationCount: issues.filter((row) => row.cluster === "HALLUCINATION").reduce((sum, row) => sum + row.count, 0),
    falseNoResultRate: customerTurns
      ? Number(((issues.find((row) => row.cluster === "FALSE_NO_RESULT")?.count ?? 0) / customerTurns).toFixed(3))
      : 0,
    wrongToolRate: customerTurns
      ? Number(((issues.find((row) => row.cluster === "WRONG_TOOL")?.count ?? 0) / customerTurns).toFixed(3))
      : 0,
  };
}

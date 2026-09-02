/**
 * Shared Outlook read arguments for WhatsApp, Portal, and ChatGPT.
 * Resolves sender emails from company directory. Never invents an address.
 */
import { londonCivilParts, resolveBusinessPeriod, formatCivilDate } from "./periods.js";

export type CompanyPerson = {
  displayName: string;
  email: string;
};

export type OutlookSearchPrep = {
  query: string;
  fromDate?: string;
  toDate?: string;
  mailboxAddress?: string;
  fromEmail?: string;
  clarify?: string;
};

const FROM_HINT = /\b(?:from|sent by|has|have)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/;
const BARE_NAME = /\b([A-Z][a-z]{2,})(?:\s+[A-Z][a-z]{2,})?\b/g;
const STOP = new Set([
  "How",
  "Many",
  "What",
  "When",
  "Where",
  "Who",
  "Why",
  "The",
  "Our",
  "Today",
  "Yesterday",
  "Search",
  "Emails",
  "Email",
  "Outlook",
  "Inbox",
  "Mailbox",
  "Please",
  "Show",
  "Find",
  "Sent",
  "About",
  "This",
  "That",
  "Latest",
  "Shared",
]);

export function extractPersonMentions(text: string): string[] {
  const mentions: string[] = [];
  const hinted = text.match(FROM_HINT);
  if (hinted?.[1] && !STOP.has(hinted[1].split(/\s+/)[0] ?? "")) {
    mentions.push(hinted[1].trim());
  }
  for (const match of text.matchAll(BARE_NAME)) {
    const name = match[1]?.trim();
    if (!name || STOP.has(name) || mentions.some((row) => row.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    mentions.push(name);
  }
  return mentions;
}

export function resolveCompanyPerson(
  people: CompanyPerson[],
  mention: string,
): { status: "resolved"; person: CompanyPerson } | { status: "ambiguous"; candidates: CompanyPerson[] } | { status: "none" } {
  const needle = mention.trim().toLowerCase();
  if (!needle) return { status: "none" };
  const exact = people.filter((person) => {
    const display = person.displayName.trim().toLowerCase();
    const first = display.split(/\s+/)[0] ?? "";
    const local = person.email.split("@")[0]?.toLowerCase() ?? "";
    return display === needle || first === needle || local === needle || display.startsWith(`${needle} `);
  });
  if (exact.length === 1) return { status: "resolved", person: exact[0]! };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };
  return { status: "none" };
}

export function prepareOutlookSearchArguments(
  text: string,
  people: CompanyPerson[] = [],
  now = new Date(),
): OutlookSearchPrep {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const namedPeriod =
    /\b(today|yesterday|this|last|past|previous)\b/i.test(trimmed) &&
    /\b(today|yesterday|week|month|quarter|year|days?)\b/i.test(trimmed);
  const period = namedPeriod ? resolveBusinessPeriod(trimmed, now) : null;
  const london = londonCivilParts(now);
  const today = formatCivilDate(london);
  const wantsToday = /\btoday\b/i.test(trimmed) && !/\bthis (week|month|quarter|year)\b/i.test(trimmed);
  const fromDate = wantsToday ? today : period?.fromDate;
  const toDate = wantsToday ? today : period?.toDate;
  const mentions = extractPersonMentions(trimmed);
  const senderAsk = /\b(sent|from|sender|has .+ sent)\b/i.test(trimmed);

  let fromEmail: string | undefined;
  let clarify: string | undefined;
  if (senderAsk && mentions.length) {
    const resolved = resolveCompanyPerson(people, mentions[0]!);
    if (resolved.status === "resolved") {
      fromEmail = resolved.person.email;
    } else if (resolved.status === "ambiguous") {
      const labels = resolved.candidates
        .map((person) => `${person.displayName} <${person.email}>`)
        .slice(0, 4)
        .join(", ");
      clarify = `There is more than one ${mentions[0]} on the company directory (${labels}). Which email address should I count?`;
    }
  }

  const query = fromEmail ? `from:${fromEmail}` : trimmed || "inbox";
  return {
    query,
    fromDate,
    toDate,
    fromEmail,
    clarify,
  };
}

export function withOutlookReadArgs(
  toolName: string,
  args: Record<string, unknown>,
  text: string,
  people: CompanyPerson[] = [],
  now = new Date(),
): Record<string, unknown> {
  if (!toolName.startsWith("outlook_")) return args;
  if (toolName === "outlook_get_message") return args;
  const prepared = prepareOutlookSearchArguments(text, people, now);
  const next = { ...args };
  if (toolName === "outlook_search_mailbox" && !String(next.query ?? "").trim()) {
    next.query = prepared.query;
  }
  if (!String(next.fromDate ?? "").trim() && prepared.fromDate) next.fromDate = prepared.fromDate;
  if (!String(next.toDate ?? "").trim() && prepared.toDate) next.toDate = prepared.toDate;
  if (prepared.fromEmail && !next.from) next.from = prepared.fromEmail;
  if (people.length && prepared.fromEmail) {
    next.query = prepared.query;
  }
  return next;
}

export function extractSenderHint(text: string): string | null {
  return extractPersonMentions(text)[0] ?? null;
}

export function pickOutlookReadTool(text: string): "outlook_search_mailbox" | "outlook_list_messages" {
  const trimmed = text.trim();
  if (
    /\b(latest|newest|recent) emails?\b/i.test(trimmed) &&
    !/\b(from|sent|has |subject|about|how many|count)\b/i.test(trimmed)
  ) {
    return "outlook_list_messages";
  }
  return "outlook_search_mailbox";
}

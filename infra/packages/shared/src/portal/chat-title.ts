const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const GREETING = /^(hi+|hey+|hello|yo|thanks|thank you|ta|ok|okay|cheers)[\s!.]*$/i;

const PREFIXES = [
  /^(please\s+)?(can|could|would|will)\s+you\s+/i,
  /^(please\s+)?(i\s+)?(want|need|would like|'d like)\s+to\s+/i,
  /^(please\s+)/i,
  /^(tell me|show me|give me|get me|find me|look up|look for|help me)\s+/i,
  /^(show|tell|give|get|find|list|check|display|pull|fetch)\s+/i,
  /^(what(?:'s|s| is| are| was| were)|who(?:'s|s| is)|where(?:'s|s| is)|when(?:'s|s| is)|why(?: is| are)|how(?: much| many| do| can| to|'s|s)?)\s+/i,
  /^(search(?:\s+company)?(?:\s+files)?(?:\s+for)?|search for)\s+/i,
];

const STOP_LEADING = /^(the|a|an|our|my|any|some|all)\s+/i;
const TRAILING_PUNCT = /[?!.]+$/g;
const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "of", "for", "in", "on", "to", "at", "vs"]);

export type ConversationAgeGroup = "today" | "yesterday" | "older";

export function titleFromUserText(text: string, now = new Date()): string {
  const cleaned = text.replace(/\s+/g, " ").trim().replace(TRAILING_PUNCT, "").trim();
  if (!cleaned) return "New chat";
  if (GREETING.test(cleaned)) return "Hello";

  let rest = cleaned;
  for (let i = 0; i < 6; i += 1) {
    let next = rest;
    for (const prefix of PREFIXES) next = next.replace(prefix, "");
    next = next.replace(STOP_LEADING, "").trim();
    if (next === rest) break;
    rest = next;
  }
  rest = rest.replace(TRAILING_PUNCT, "").trim();
  if (!rest) return "New chat";

  const temporal = applyTemporal(rest, now);
  const system = applySystem(temporal.text.replace(/^'s\b\s*/i, ""));
  const inbox = applyInbox(system.text);
  const modifier = applyModifier(inbox.text);
  const topic = titleCasePhrase(
    modifier.text
      .replace(/^\b(on|in|from|via|for|about|regarding)\b\s+/i, "")
      .replace(/\b(on|in|from|via|for|about|regarding)\s*$/i, "")
      .trim(),
  );

  const title = uniqueParts([temporal.label, modifier.modifier, inbox.inbox, system.system, topic]).join(" ");
  const resolved = title || titleCasePhrase(cleaned);
  return resolved.length > 40 ? `${resolved.slice(0, 37).trim()}…` : resolved;
}

export function looksLikeRawPromptTitle(title: string): boolean {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed === "New chat") return true;
  if (trimmed.includes("?")) return true;
  return /^(what|who|where|when|why|how|show|search|tell|list|check|find|get|can you)\b/i.test(trimmed);
}

export function displayConversationTitle(
  stored: string,
  firstUserText?: string | null,
  now = new Date(),
): string {
  const source = (firstUserText || stored || "").trim();
  if (!stored.trim() || stored.trim() === "New chat" || looksLikeRawPromptTitle(stored)) {
    return titleFromUserText(source, now);
  }
  return stored.replace(/\s+/g, " ").trim();
}

export function messagePreview(text: string | null | undefined, max = 72): string {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trim()}…` : cleaned;
}

export function conversationAgeGroup(iso: string, now = new Date()): ConversationAgeGroup {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "older";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const yesterday = new Date(start);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date >= start) return "today";
  if (date >= yesterday) return "yesterday";
  return "older";
}

export function groupConversations<T extends { updatedAt: string }>(
  rows: T[],
  now = new Date(),
): Array<{ key: ConversationAgeGroup; label: string; items: T[] }> {
  const buckets: Record<ConversationAgeGroup, T[]> = { today: [], yesterday: [], older: [] };
  for (const row of rows) buckets[conversationAgeGroup(row.updatedAt, now)].push(row);
  const groups: Array<{ key: ConversationAgeGroup; label: string; items: T[] }> = [];
  if (buckets.today.length) groups.push({ key: "today", label: "Today", items: buckets.today });
  if (buckets.yesterday.length) groups.push({ key: "yesterday", label: "Yesterday", items: buckets.yesterday });
  if (buckets.older.length) groups.push({ key: "older", label: "Older", items: buckets.older });
  return groups;
}

function applyTemporal(text: string, now: Date): { text: string; label?: string } {
  if (/\bthis month\b/i.test(text)) {
    return { text: stripPhrase(text, /\b(for\s+)?this month\b/gi), label: MONTHS[now.getMonth()] };
  }
  if (/\blast month\b/i.test(text)) {
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { text: stripPhrase(text, /\b(for\s+)?last month\b/gi), label: MONTHS[previous.getMonth()] };
  }
  if (/\bthis week\b/i.test(text)) {
    return { text: stripPhrase(text, /\b(for\s+)?this week\b/gi), label: "This Week" };
  }
  if (/\btoday\b/i.test(text)) {
    return { text: stripPhrase(text, /\btoday\b/gi), label: "Today" };
  }
  if (/\byesterday\b/i.test(text)) {
    return { text: stripPhrase(text, /\byesterday\b/gi), label: "Yesterday" };
  }
  return { text };
}

function applySystem(text: string): { text: string; system?: string } {
  const systems: Array<[RegExp, string]> = [
    [/\b(?:on|in|from|via)?\s*xero\b/gi, "Xero"],
    [/\b(?:on|in|from|via)?\s*outlook\b/gi, "Outlook"],
    [/\b(?:microsoft\s+)?365\b/gi, "Microsoft 365"],
    [/\bsharepoint\b/gi, "SharePoint"],
    [/\bonedrive\b/gi, "OneDrive"],
  ];
  let system: string | undefined;
  let out = text;
  for (const [pattern, name] of systems) {
    if (pattern.test(out)) {
      system = name;
      out = out.replace(pattern, " ");
    }
  }
  return { text: out.replace(/\s+/g, " ").trim(), system };
}

function applyInbox(text: string): { text: string; inbox?: string } {
  const match = text.match(/\b(?:in\s+(?:the\s+)?)?([a-z0-9._-]+)\s+inbox\b/i);
  if (!match) return { text };
  return {
    text: stripPhrase(text, match[0]),
    inbox: titleWord(match[1] ?? ""),
  };
}

function applyModifier(text: string): { text: string; modifier?: string } {
  if (/\b(newest|latest|most recent|last)\b/i.test(text)) {
    return {
      text: stripPhrase(text, /\b(the\s+)?(newest|latest|most recent|last)\b/gi),
      modifier: "Latest",
    };
  }
  if (/\boverdue\b/i.test(text)) {
    return { text: stripPhrase(text, /\boverdue\b/gi), modifier: "Overdue" };
  }
  if (/\boutstanding\b/i.test(text)) {
    return { text: stripPhrase(text, /\boutstanding\b/gi), modifier: "Outstanding" };
  }
  return { text };
}

function titleWord(word: string): string {
  const compact = word.replace(/[^\w&+-]/g, "");
  if (!compact) return "";
  if (/^po$/i.test(compact)) return "PO";
  if (/^(p&l|pnl)$/i.test(compact)) return "P&L";
  if (/^(id|vat|uk|el)$/i.test(compact)) return compact.toUpperCase();
  return compact.charAt(0).toUpperCase() + compact.slice(1).toLowerCase();
}

function titleCasePhrase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      const cleaned = word.replace(/[^\w&+-]/g, "");
      if (!cleaned) return "";
      if (index > 0 && SMALL_WORDS.has(cleaned.toLowerCase())) return cleaned.toLowerCase();
      return titleWord(cleaned);
    })
    .filter(Boolean)
    .join(" ");
}

function uniqueParts(parts: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const value = (part ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stripPhrase(text: string, pattern: string | RegExp): string {
  return text.replace(pattern, " ").replace(/\s+/g, " ").trim();
}

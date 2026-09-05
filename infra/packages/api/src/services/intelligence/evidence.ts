import { rejectCrossTenantMerge } from "./tenant-isolation.js";
import { extractOutlookMessages } from "./verbalise-business.js";
import type {
  EvidenceNeed,
  IntelligenceConversationState,
  IntelligenceToolCall,
  IntelligenceToolResult,
  RecentCatalogueEvidence,
  RecentDocumentEvidence,
  RecentEmailEvidence,
  RecentXeroEvidence,
  StructuredEvidence,
} from "./types.js";

const MAX_BODY = 900;
const MAX_SUMMARY = 420;

export function emptyEvidence(): StructuredEvidence {
  return {
    companyId: null,
    source: null,
    capturedAt: null,
    recentEmail: null,
    recentXero: null,
    recentDocument: null,
    recentCatalogueItem: null,
    lastSuccessfulCalls: [],
  };
}

export function mergeEvidence(
  prior: StructuredEvidence | null | undefined,
  next: StructuredEvidence | null | undefined,
): StructuredEvidence {
  const left = prior ?? emptyEvidence();
  const right = next ?? emptyEvidence();
  if (rejectCrossTenantMerge(left, right)) return left;
  return {
    companyId: right.companyId ?? left.companyId ?? null,
    source: right.source ?? left.source ?? null,
    capturedAt: right.capturedAt ?? left.capturedAt ?? null,
    recentEmail: right.recentEmail ?? left.recentEmail ?? null,
    recentXero: right.recentXero ?? left.recentXero ?? null,
    recentDocument: right.recentDocument ?? left.recentDocument ?? null,
    recentCatalogueItem: right.recentCatalogueItem ?? left.recentCatalogueItem ?? null,
    lastSuccessfulCalls: [...(right.lastSuccessfulCalls ?? []), ...(left.lastSuccessfulCalls ?? [])].slice(0, 8),
  };
}

export function emailBodyRequired(text: string): boolean {
  if (/\b(subject|who sent|when (did|was)|latest email subject|newest email subject)\b/i.test(text)) {
    return false;
  }
  if (/\b(policy|document|handbook|procedure|guidance|knowledge base)\b/i.test(text) && !/\b(email|inbox|mailbox|outlook|message)\b/i.test(text)) {
    return false;
  }
  return (
    /\b(what (are|were) they asking|what does .{0,40}(say|said)|what did they (ask|want|say)|summar(y|ise|ize)|draft|reply|respond|full (email|message|body)|the (email|message) (body|content|text)|what are they asking)\b/i.test(
      text,
    ) || isDraftOrEdit(text)
  );
}

export function emailEvidenceHasBody(evidence: StructuredEvidence | null | undefined): boolean {
  const body = String(evidence?.recentEmail?.body ?? "").replace(/\s+/g, " ").trim();
  return body.length >= 40;
}

export function classifyEvidenceNeed(
  text: string,
  state: Pick<IntelligenceConversationState, "recentEvidence" | "lastAnswerText" | "lastAnswerTopic" | "currentBusinessSystem">,
): EvidenceNeed {
  const evidence = state.recentEvidence ?? emptyEvidence();
  if (isFreshListingAsk(text) && !isDraftOrEdit(text)) return "NEEDS_FRESH_DATA";
  if (isFreshBusinessSystemAsk(text)) return "NEEDS_FRESH_DATA";
  if (isPeriodCompareMissing(text, evidence.recentXero)) return "NEEDS_FRESH_DATA";
  if (canUseExisting(text, state, evidence)) {
    if (emailBodyRequired(text) && !emailEvidenceHasBody(evidence)) return "NEEDS_FRESH_DATA";
    return "CAN_ANSWER_FROM_EXISTING_EVIDENCE";
  }
  return "NEEDS_FRESH_DATA";
}

export function canUseExisting(
  text: string,
  state: Pick<IntelligenceConversationState, "recentEvidence" | "lastAnswerText" | "lastAnswerTopic" | "currentBusinessSystem">,
  evidence = state.recentEvidence ?? emptyEvidence(),
): boolean {
  if (isDraftOrEdit(text) && (state.lastAnswerText || evidence.recentEmail || evidence.recentXero)) return true;
  if (isRecall(text) && (state.lastAnswerText || evidence.recentEmail || evidence.recentXero || evidence.recentDocument)) {
    return true;
  }
  if (isEmailFollowUp(text, state, evidence)) return true;
  if (isXeroFollowUpWithoutNewPeriod(text, state, evidence)) return true;
  if (isDocumentFollowUp(text, evidence)) return true;
  return false;
}

export function isDraftOrEdit(text: string): boolean {
  return (
    /\b(reply|respond|draft|suggest(?:ion)?|what (should|can) (i|we) (say|reply|write)|make (that|it|this|the (reply|draft|email)).{0,28}(short|shorter|brief|simple|friendlier|friendly|warmer|formal|polite|professional|softer)|friendlier|more (friendly|formal|polite|professional)|in fewer words)\b/i.test(
      text,
    ) || /^(make (that|it) (shorter|friendlier|warmer)|more detail)[.?!]*$/i.test(text.trim())
  );
}

export function isRecall(text: string): boolean {
  if (isFreshListingAsk(text)) return false;
  return /\b(what were (we|they) (talking about|asking)|what did (they|you|i) (just )?(ask|say|tell)|who sent|what was the subject|remind me|what were we talking about)\b/i.test(
    text,
  );
}

function isFreshListingAsk(text: string): boolean {
  return /\b(newest|latest|last \d|unread|most recent(?:ly)?|check (in )?(the )?(info |finance )?(inbox|mailbox)|search (the )?(inbox|mailbox|email)|finance mailbox|info (inbox|mailbox))\b/i.test(
    text,
  );
}

export function isFreshBusinessSystemAsk(text: string): boolean {
  return (
    /\b(xero|sales|overdue|invoice|revenue|profit|p&l|pnl|top customers?|biggest customers?)\b/i.test(text) &&
    !/\b(that|those|the figures|the sales|reply|shorter|friendlier)\b/i.test(text)
  );
}

function isEmailFollowUp(
  text: string,
  state: Pick<IntelligenceConversationState, "lastAnswerTopic" | "currentBusinessSystem">,
  evidence: StructuredEvidence,
): boolean {
  if (!evidence.recentEmail) return false;
  if (isFreshBusinessSystemAsk(text) && !/\b(email|inbox|outlook|mailbox|reply)\b/i.test(text)) return false;
  const explicit = /\b(that email|the email|this email|reply|they asking|who sent)\b/i.test(text);
  const draftOrRecall = isDraftOrEdit(text) || isRecall(text);
  if (!explicit && !draftOrRecall) return false;
  void state;
  return !isFreshListingAsk(text);
}

function isXeroFollowUpWithoutNewPeriod(
  text: string,
  state: Pick<IntelligenceConversationState, "lastAnswerTopic" | "currentBusinessSystem">,
  evidence: StructuredEvidence,
): boolean {
  if (!evidence.recentXero) return false;
  const onFinance = state.lastAnswerTopic === "finance" || state.currentBusinessSystem === "xero";
  if (!onFinance && !/\b(that|those|the figures|the sales)\b/i.test(text)) return false;
  return !isPeriodCompareMissing(text, evidence.recentXero);
}

function isDocumentFollowUp(text: string, evidence: StructuredEvidence): boolean {
  if (!evidence.recentDocument && !evidence.recentCatalogueItem) return false;
  return /\b(that (file|document)|this (file|document)|open (it|the (file|link))|the (url|link)|who modified|when was it)\b/i.test(
    text,
  );
}

function isPeriodCompareMissing(text: string, xero?: RecentXeroEvidence | null): boolean {
  if (!xero) return /\b(last month|previous month|compare|versus)\b/i.test(text);
  if (/\b(last month|previous month)\b/i.test(text) && !/last month|previous/i.test(`${xero.fromDate ?? ""} ${xero.label ?? ""}`)) {
    return true;
  }
  return false;
}

export function argsFingerprint(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
    .sort()
    .map((key) => `${key}=${stable(args[key])}`)
    .join("&");
  return `${name}:${keys}`.slice(0, 240);
}

export function shouldReuseSuccessfulTool(
  call: IntelligenceToolCall,
  evidence: StructuredEvidence | null | undefined,
): boolean {
  const hash = argsFingerprint(call.name, call.arguments);
  if (evidence?.lastSuccessfulCalls?.some((row) => row.name === call.name && row.argsHash === hash)) {
    return true;
  }
  const invoice = String(call.arguments.invoiceNumber ?? call.arguments.invoiceId ?? "")
    .trim()
    .toUpperCase();
  if (
    invoice &&
    /^xero_get_invoice$/.test(call.name) &&
    evidence?.lastSuccessfulCalls?.some((row) => row.name === call.name && row.argsHash.toUpperCase().includes(invoice))
  ) {
    return true;
  }
  return false;
}

function resultIdentity(call: IntelligenceToolResult): string {
  const record = isRecord(call.data) ? call.data : {};
  const inner = isRecord(record.result) ? record.result : record;
  const invoice = String(
    inner.invoiceNumber ?? inner.InvoiceNumber ?? inner.invoice_number ?? record.invoiceNumber ?? record.InvoiceNumber ?? "",
  )
    .trim()
    .toUpperCase();
  if (invoice && /^xero_/.test(call.name)) return `${call.name}:invoice=${invoice}`;
  const messageId = String(inner.id ?? inner.messageId ?? record.id ?? record.messageId ?? "").trim();
  if (messageId && /outlook/.test(call.name)) return `${call.name}:msg=${messageId}`;
  return argsFingerprint(call.name, {});
}

export function extractEvidenceFromTools(toolCalls: IntelligenceToolResult[]): StructuredEvidence {
  const next = emptyEvidence();
  for (const call of toolCalls) {
    if (!call.ok) continue;
    if (/outlook/i.test(call.name)) {
      const messages = extractOutlookMessages(call.data);
      const newest = messages[0];
      if (newest) {
        next.recentEmail = sanitiseEmail({
          id: newest.id,
          subject: newest.subject,
          from: newest.from,
          receivedDateTime: newest.receivedDateTime,
          mailboxAddress: newest.mailboxAddress,
          body: newest.body,
          toolName: call.name,
        });
      }
    }
    if (/^xero_/.test(call.name)) {
      next.recentXero = sanitiseXero(call);
    }
    if (call.name === "get_knowledge_document" || call.name === "search_document" || call.name === "fetch") {
      next.recentDocument = sanitiseDocument(call);
    }
    if (call.name === "list_documents" || call.name === "search_company_knowledge") {
      next.recentCatalogueItem = sanitiseCatalogue(call);
    }
    next.lastSuccessfulCalls = [
      ...(next.lastSuccessfulCalls ?? []),
      { name: call.name, argsHash: resultIdentity(call), summary: clip(JSON.stringify(call.data ?? ""), 180) },
    ].slice(0, 8);
  }
  return next;
}

export function recordSuccessfulCall(
  evidence: StructuredEvidence,
  call: IntelligenceToolCall,
  result: IntelligenceToolResult,
): StructuredEvidence {
  if (!result.ok) return evidence;
  const row = {
    name: call.name,
    argsHash: argsFingerprint(call.name, call.arguments),
    summary: clip(JSON.stringify(result.data ?? ""), 180),
  };
  return {
    ...evidence,
    lastSuccessfulCalls: [row, ...(evidence.lastSuccessfulCalls ?? []).filter((item) => item.argsHash !== row.argsHash)].slice(
      0,
      8,
    ),
  };
}

export function sanitiseEvidenceForModel(evidence: StructuredEvidence | null | undefined): string {
  if (!evidence) return "none";
  const lines: string[] = [];
  if (evidence.recentEmail) {
    const email = evidence.recentEmail;
    lines.push(
      `recentEmail: subject=${email.subject}; from=${email.from}; when=${email.receivedDateTime}; mailbox=${email.mailboxAddress}; body=${clip(email.body, MAX_BODY)}`,
    );
  }
  if (evidence.recentXero) {
    const xero = evidence.recentXero;
    lines.push(
      `recentXero: tool=${xero.toolName}; total=${xero.total ?? "n/a"}; count=${xero.count ?? "n/a"}; period=${xero.fromDate ?? ""}..${xero.toDate ?? ""}; summary=${clip(xero.summary, MAX_SUMMARY)}`,
    );
  }
  if (evidence.recentDocument) {
    const doc = evidence.recentDocument;
    lines.push(`recentDocument: ${doc.title} (${doc.id}); excerpt=${clip(doc.excerpt, MAX_SUMMARY)}`);
  }
  if (evidence.recentCatalogueItem) {
    const item = evidence.recentCatalogueItem;
    lines.push(`recentCatalogueItem: ${item.title} (${item.id})`);
  }
  return lines.length ? lines.join("\n") : "none";
}

export function stripSecretsFromText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

export function answerFromExistingEvidence(
  text: string,
  state: IntelligenceConversationState,
): string | null {
  const evidence = state.recentEvidence ?? emptyEvidence();
  const previous = (state.lastAnswerText || "").trim();
  if (evidence.recentEmail && (isDraftOrEdit(text) || isEmailFollowUp(text, state, evidence))) {
    return answerFromEmail(text, evidence.recentEmail, previous);
  }
  if (evidence.recentEmail && isRecall(text) && /\b(they|email|sent|subject|asking)\b/i.test(text)) {
    return answerFromEmail(text, evidence.recentEmail, previous);
  }
  if (isDraftOrEdit(text) && previous) {
    if (/\b(short(?:er)?|brief|fewer)\b/i.test(text)) return shorten(previous);
    if (/\b(friendlier|friendly|warmer|softer)\b/i.test(text)) return friendlier(previous);
    return simplify(previous);
  }
  if (isRecall(text) && /\b(they|email|sent|subject|asking)\b/i.test(text) && evidence.recentEmail) {
    return answerFromEmail(text, evidence.recentEmail, previous);
  }
  if (isRecall(text) && evidence.recentXero?.summary && /\b(sales|xero|amount|figures)\b/i.test(text)) {
    return `We were looking at Xero: ${evidence.recentXero.summary}`;
  }
  return null;
}

function answerFromEmail(text: string, email: RecentEmailEvidence, previous: string): string {
  if (/\bwhat were they asking|what did they (ask|want|say)|who sent|what was the subject\b/i.test(text)) {
    const asking = askingFor(email);
    const who = email.from ? ` from ${email.from}` : "";
    return asking
      ? `They were asking about ${asking}${who}. Subject: “${email.subject}”.`
      : `The email${who} is “${email.subject}”.`;
  }
  if (/\b(short(?:er)?|brief|fewer)\b/i.test(text) && previous) return shorten(previous);
  if (/\b(friendlier|friendly|warmer|softer)\b/i.test(text) && previous) return friendlier(previous);
  if (/\b(reply|respond|draft|suggest|do anything)\b/i.test(text) || !previous) {
    return draftReply(email);
  }
  if (previous) {
    if (/\b(short(?:er)?|brief|fewer)\b/i.test(text)) return shorten(previous);
    if (/\b(friendlier|friendly|warmer)\b/i.test(text)) return friendlier(previous);
    return previous;
  }
  return draftReply(email);
}

function draftReply(email: RecentEmailEvidence): string {
  const asking = askingFor(email);
  const who = email.from || "there";
  const about = asking || email.subject || "your email";
  return `Suggested reply:\nHi ${firstName(who)},\nThanks for your email about ${about}. Happy to help — I’ll take a look and come back to you shortly.\nKind regards`;
}

function askingFor(email: RecentEmailEvidence): string {
  const blob = `${email.subject}\n${email.body}`.replace(/\s+/g, " ").trim();
  const request = blob.match(/\b(?:please|could you|can you|we need|looking for|request(?:ing)?)\b(.{10,120})/i);
  if (request?.[1]) return request[1].replace(/[.?!].*$/, "").trim();
  return email.subject.replace(/^(re:|fw:)\s*/i, "").trim();
}

function firstName(from: string): string {
  const name = from.split("@")[0]?.split(/[.\s_]/)[0] ?? "there";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "there";
}

function sanitiseEmail(email: RecentEmailEvidence): RecentEmailEvidence {
  return {
    ...email,
    subject: clip(stripSecretsFromText(email.subject), 180),
    from: clip(email.from, 180),
    body: clip(
      stripSecretsFromText(
        email.body
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/<[^>]*$/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
      MAX_BODY,
    ),
    mailboxAddress: clip(email.mailboxAddress, 180),
  };
}

function sanitiseXero(call: IntelligenceToolResult): RecentXeroEvidence {
  const record = isRecord(call.data) ? call.data : {};
  const summary = isRecord(record.summary) ? record.summary : {};
  const period = isRecord(record.period) ? record.period : {};
  const total = numberish(record.sales_total ?? summary.totalSales ?? record.total);
  const count = numberish(record.invoice_count ?? summary.transactionCount ?? record.count);
  const fromDate = String(period.fromDate ?? summary.fromDate ?? record.fromDate ?? "");
  const toDate = String(period.toDate ?? summary.toDate ?? record.toDate ?? "");
  const invoices = Array.isArray(record.invoices) ? record.invoices.length : null;
  return {
    toolName: call.name,
    total,
    count: count ?? invoices,
    fromDate: fromDate || null,
    toDate: toDate || null,
    currency: String(record.currencyCode ?? record.currency ?? "GBP"),
    summary: clip(
      typeof record.summary === "string" ? record.summary : JSON.stringify({ total, count, fromDate, toDate }),
      MAX_SUMMARY,
    ),
    label: fromDate && toDate ? `${fromDate} to ${toDate}` : call.name,
  };
}

function sanitiseDocument(call: IntelligenceToolResult): RecentDocumentEvidence | null {
  const record = isRecord(call.data) ? call.data : {};
  const id = String(record.document_id ?? record.documentId ?? record.id ?? "").trim();
  const title = String(record.title ?? "").trim();
  if (!id || !title) return null;
  const chunks = Array.isArray(record.chunks) ? record.chunks : [];
  const excerpt = chunks
    .map((row) => (isRecord(row) ? String(row.text ?? "") : ""))
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_SUMMARY);
  return { id, title, url: typeof record.url === "string" ? record.url : null, excerpt, source: typeof record.source === "string" ? record.source : null };
}

function sanitiseCatalogue(call: IntelligenceToolResult): RecentCatalogueEvidence | null {
  const record = isRecord(call.data) ? call.data : {};
  const docs = Array.isArray(record.documents)
    ? record.documents
    : Array.isArray(record.results)
      ? record.results
      : [];
  const first = docs.find(isRecord);
  if (!first) return null;
  const id = String(first.id ?? first.document_id ?? "").trim();
  const title = String(first.title ?? "").trim();
  if (!id || !title) return null;
  return { id, title, source: typeof first.source === "string" ? first.source : null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[,£$]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stable(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function simplify(text: string): string {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).slice(0, 3).join(" ").trim().slice(0, 420);
}

function shorten(text: string): string {
  const lines = text.replace(/^suggested reply:\s*/i, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const first = (lines[1] && /^hi\b/i.test(lines[0] ?? "") ? lines.slice(0, 2).join(" ") : lines[0]) ?? text;
  const sentence = first.split(/(?<=[.!?])\s+/)[0] ?? first;
  const clipped = sentence.trim().slice(0, 160);
  return clipped.length < text.length ? clipped : text.slice(0, Math.max(40, Math.floor(text.length * 0.6)));
}

function friendlier(text: string): string {
  const cleaned = text
    .replace(/^suggested reply:\s*/i, "")
    .replace(/\bkind regards\b/gi, "Thanks so much")
    .replace(/\bI will\b/g, "I'll")
    .replace(/\bplease be advised\b/gi, "just to let you know");
  if (/^hi\b/i.test(cleaned)) return cleaned.includes("Hope you're well") ? cleaned : cleaned.replace(/^hi([^,]*)(,)?/i, "Hi$1 — hope you're well,");
  return `Hope you're well — ${cleaned}`;
}

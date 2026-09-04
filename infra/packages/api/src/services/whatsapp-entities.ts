import { classifyDocument, extractTypedFacts } from "./whatsapp-grounded-qa";

export type WhatsAppDocumentClass =
  | "cv_resume"
  | "policy_procedure"
  | "invoice_payment"
  | "spreadsheet"
  | "email"
  | "general";

export type WhatsAppDocumentEntity = {
  id: string;
  title: string;
  url: string | null;
  excerpt: string;
  amount: string | null;
  reference: string | null;
  sourceLabel: string | null;
  sourceSystem?: string | null;
  providerItemId?: string | null;
  sourceKey?: string | null;
  path?: string | null;
  documentClass?: WhatsAppDocumentClass | null;
  modifiedAt?: string | null;
  modifiedBy?: string | null;
};

export type WhatsAppEntityMemory = {
  lastDocument?: WhatsAppDocumentEntity | null;
  recentDocuments?: WhatsAppDocumentEntity[];
  lastEmail?: { id?: string; title?: string; from?: string; url?: string | null } | null;
  lastInvoice?: { id?: string; number?: string; customer?: string } | null;
  lastCustomer?: { name: string } | null;
  lastJob?: { title?: string; date?: string } | null;
  lastDateRange?: { label: string } | null;
  lastTool?: string | null;
  lastSource?: string | null;
  lastSourceUrl?: string | null;
  lastSourceSystem?: string | null;
  lastSearchQuery?: string | null;
  lastUserQuestion?: string | null;
  lastAnswerText?: string | null;
  currentScope?: string | null;
  currentBusinessSystem?: string | null;
  lastSuccessfulTool?: string | null;
  lastAnswerTopic?: string | null;
  lastUserIntent?: string | null;
};

const EMPTY: WhatsAppEntityMemory = {};
const RECENT_LIMIT = 5;

export function emptyEntityMemory(): WhatsAppEntityMemory {
  return {};
}

export function parseEntityMemory(raw: string | null | undefined): WhatsAppEntityMemory {
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as WhatsAppEntityMemory;
    if (!parsed || typeof parsed !== "object") return EMPTY;
    return parsed;
  } catch {
    return EMPTY;
  }
}

export function serializeEntityMemory(memory: WhatsAppEntityMemory): string {
  return JSON.stringify({
    lastDocument: memory.lastDocument ? compactDocument(memory.lastDocument) : null,
    recentDocuments: (memory.recentDocuments ?? []).slice(0, RECENT_LIMIT).map(compactDocument),
    lastEmail: memory.lastEmail ?? null,
    lastInvoice: memory.lastInvoice ?? null,
    lastCustomer: memory.lastCustomer ?? null,
    lastJob: memory.lastJob ?? null,
    lastDateRange: memory.lastDateRange ?? null,
    lastTool: memory.lastTool ?? null,
    lastSource: memory.lastSource ?? null,
    lastSourceUrl: memory.lastSourceUrl ?? memory.lastDocument?.url ?? null,
    lastSourceSystem: memory.lastSourceSystem ?? memory.lastDocument?.sourceSystem ?? null,
    lastSearchQuery: memory.lastSearchQuery ?? null,
    lastUserQuestion: memory.lastUserQuestion ?? null,
    lastAnswerText: memory.lastAnswerText ?? null,
    currentScope: memory.currentScope ?? null,
    currentBusinessSystem: memory.currentBusinessSystem ?? null,
    lastSuccessfulTool: memory.lastSuccessfulTool ?? memory.lastTool ?? null,
    lastAnswerTopic: memory.lastAnswerTopic ?? null,
    lastUserIntent: memory.lastUserIntent ?? null,
  });
}

function compactDocument(doc: WhatsAppDocumentEntity): WhatsAppDocumentEntity {
  return {
    id: doc.id.slice(0, 180),
    title: doc.title.slice(0, 180),
    url: doc.url,
    excerpt: doc.excerpt.slice(0, 400),
    amount: doc.amount,
    reference: doc.reference,
    sourceLabel: doc.sourceLabel,
    sourceSystem: doc.sourceSystem ?? null,
    providerItemId: doc.providerItemId ?? null,
    sourceKey: doc.sourceKey ?? null,
    path: doc.path ?? null,
    documentClass: doc.documentClass ?? null,
  };
}

export function extractAmount(text: string): string | null {
  if (!/\b(invoice|payment confirmation|order id|paid|amount due|total due|payment was successful)\b/i.test(text)) {
    return null;
  }
  for (const match of text.matchAll(/£\s?[\d,]+(?:\.\d{2})?(?:\s*GBP)?/gi)) {
    const idx = match.index ?? 0;
    const window = text.slice(Math.max(0, idx - 48), idx + match[0].length + 24);
    if (/\b(amount|total|paid|payment|invoice|order id|fee)\b/i.test(window)) {
      return match[0].replace(/\s+/g, " ");
    }
  }
  return null;
}

export function extractReference(text: string): string | null {
  const match = text.match(
    /\b(?:order[ -]?id|ref(?:erence)?(?:\s*(?:no\.?|number|#))?)\s*[:.#-]\s*([A-Z0-9][A-Z0-9/_-]{2,})\b/i,
  );
  const token = match?.[1]?.trim() ?? "";
  if (!token || /^(references?|erences|email|mobile|phone|amount)$/i.test(token)) return null;
  if (!/\d/.test(token) && !/^[A-Z]{2,}[-/][A-Z0-9]+$/i.test(token)) return null;
  return token;
}

export function documentEntityFromHit(input: {
  id: string;
  title: string;
  url?: string | null;
  text?: string | null;
  snippet?: string | null;
  sourceLabel?: string | null;
  sourceSystem?: string | null;
  providerItemId?: string | null;
  sourceKey?: string | null;
  path?: string | null;
  modifiedAt?: string | null;
  modifiedBy?: string | null;
}): WhatsAppDocumentEntity {
  const body = String(input.text || input.snippet || "");
  const documentClass = classifyDocument({ title: input.title, text: body, path: input.path });
  const typed = extractTypedFacts(body, documentClass);
  return {
    id: input.id,
    title: input.title,
    url: input.url && /^https?:\/\//i.test(input.url) ? input.url : null,
    excerpt: body.replace(/\s+/g, " ").trim().slice(0, 400),
    amount: typed.amount ?? (documentClass === "invoice_payment" ? extractAmount(body) : null) ?? null,
    reference: typed.reference ?? (documentClass === "invoice_payment" ? extractReference(body) : null) ?? null,
    sourceLabel: input.sourceLabel ?? input.title,
    sourceSystem: input.sourceSystem ?? null,
    providerItemId: input.providerItemId ?? null,
    sourceKey: input.sourceKey ?? null,
    path: input.path ?? null,
    documentClass,
    modifiedAt: input.modifiedAt ?? null,
    modifiedBy: input.modifiedBy ?? null,
  };
}

export function sameDocument(
  left: WhatsAppDocumentEntity | null | undefined,
  right: WhatsAppDocumentEntity | null | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.providerItemId && right.providerItemId && left.providerItemId === right.providerItemId) {
    return true;
  }
  const a = normalizeTitle(left.title);
  const b = normalizeTitle(right.title);
  return Boolean(a && b && a === b);
}

function normalizeTitle(title: string | null | undefined): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/\.(pdf|docx?|xlsx?|pptx?)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function mergeEntityMemory(
  prior: WhatsAppEntityMemory,
  next: Partial<WhatsAppEntityMemory>,
): WhatsAppEntityMemory {
  const incoming = next.lastDocument;
  const lastDocument = incoming !== undefined ? incoming : prior.lastDocument;
  const displaced =
    incoming !== undefined &&
    incoming &&
    prior.lastDocument &&
    !sameDocument(incoming, prior.lastDocument)
      ? prior.lastDocument
      : null;
  const recent = mergeRecentDocuments({
    prior: prior.recentDocuments,
    last: lastDocument,
    displaced,
    extra: next.recentDocuments,
  });
  return {
    lastDocument,
    recentDocuments: recent,
    lastEmail: next.lastEmail !== undefined ? next.lastEmail : prior.lastEmail,
    lastInvoice: next.lastInvoice !== undefined ? next.lastInvoice : prior.lastInvoice,
    lastCustomer: next.lastCustomer !== undefined ? next.lastCustomer : prior.lastCustomer,
    lastJob: next.lastJob !== undefined ? next.lastJob : prior.lastJob,
    lastDateRange: next.lastDateRange !== undefined ? next.lastDateRange : prior.lastDateRange,
    lastTool: next.lastTool !== undefined ? next.lastTool : prior.lastTool,
    lastSource: next.lastSource !== undefined ? next.lastSource : prior.lastSource,
    lastSourceUrl:
      next.lastSourceUrl !== undefined
        ? next.lastSourceUrl
        : lastDocument?.url ?? prior.lastSourceUrl ?? null,
    lastSourceSystem:
      next.lastSourceSystem !== undefined
        ? next.lastSourceSystem
        : lastDocument?.sourceSystem ?? prior.lastSourceSystem ?? null,
    lastSearchQuery: next.lastSearchQuery !== undefined ? next.lastSearchQuery : prior.lastSearchQuery,
    lastUserQuestion: next.lastUserQuestion !== undefined ? next.lastUserQuestion : prior.lastUserQuestion,
    lastAnswerText: next.lastAnswerText !== undefined ? next.lastAnswerText : prior.lastAnswerText,
    currentScope: next.currentScope !== undefined ? next.currentScope : prior.currentScope,
    currentBusinessSystem:
      next.currentBusinessSystem !== undefined ? next.currentBusinessSystem : prior.currentBusinessSystem,
    lastSuccessfulTool: next.lastSuccessfulTool !== undefined ? next.lastSuccessfulTool : prior.lastSuccessfulTool,
    lastAnswerTopic: next.lastAnswerTopic !== undefined ? next.lastAnswerTopic : prior.lastAnswerTopic,
    lastUserIntent: next.lastUserIntent !== undefined ? next.lastUserIntent : prior.lastUserIntent,
  };
}

function mergeRecentDocuments(input: {
  prior: WhatsAppDocumentEntity[] | undefined;
  last: WhatsAppDocumentEntity | null | undefined;
  displaced?: WhatsAppDocumentEntity | null;
  extra?: WhatsAppDocumentEntity[];
}): WhatsAppDocumentEntity[] {
  const out: WhatsAppDocumentEntity[] = [];
  const seen = new Set<string>();
  const skip = input.last ? documentKey(input.last) : "";
  for (const doc of [input.displaced, ...(input.extra ?? []), ...(input.prior ?? [])]) {
    if (!doc?.title && !doc?.id) continue;
    const key = documentKey(doc);
    if (!key || key === skip || seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
    if (out.length >= RECENT_LIMIT) break;
  }
  return out;
}

function documentKey(doc: WhatsAppDocumentEntity): string {
  if (doc.id) return `id:${doc.id.toLowerCase()}`;
  if (doc.providerItemId) return `prov:${doc.providerItemId.toLowerCase()}`;
  return `title:${normalizeTitle(doc.title)}`;
}

export function hasDocumentMemory(memory: WhatsAppEntityMemory | null | undefined): boolean {
  return Boolean(memory?.lastDocument?.id || memory?.lastDocument?.title);
}

export function recentDocumentTitles(memory: WhatsAppEntityMemory | null | undefined): string[] {
  const titles = [
    memory?.lastDocument?.title,
    ...(memory?.recentDocuments ?? []).map((doc) => doc.title),
  ].filter((title): title is string => Boolean(title));
  return [...new Set(titles)];
}

export function rememberedDocuments(memory: WhatsAppEntityMemory | null | undefined): WhatsAppDocumentEntity[] {
  const out: WhatsAppDocumentEntity[] = [];
  const seen = new Set<string>();
  for (const doc of [memory?.lastDocument, ...(memory?.recentDocuments ?? [])]) {
    if (!doc) continue;
    const key = documentKey(doc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
}

const PREVIOUS_REF =
  /\b(the previous (one|document|file)|the last one|the other (one|document)|that first (one|document))\b/i;

export function resolveRememberedDocument(
  memory: WhatsAppEntityMemory | null | undefined,
  text: string,
): WhatsAppDocumentEntity | null {
  if (!memory) return null;
  if (PREVIOUS_REF.test(text)) {
    return memory.recentDocuments?.[0] ?? memory.lastDocument ?? null;
  }
  const terms = String(text ?? "")
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter(
      (token) =>
        (token.length >= 4 || token === "cv" || token === "van") &&
        !["that", "this", "document", "file", "allowed", "does", "what", "from"].includes(token),
    );
  if (terms.length) {
    const docs = rememberedDocuments(memory);
    const scored = docs
      .map((doc) => {
        const hay = normalizeTitle(doc.title);
        const hits = terms.filter((term) => hay.includes(term)).length;
        return { doc, hits };
      })
      .filter((row) => row.hits > 0)
      .sort((left, right) => right.hits - left.hits);
    if (
      scored[0] &&
      scored[0].hits >= 2 &&
      (scored.length === 1 || scored[0].hits > (scored[1]?.hits ?? 0))
    ) {
      return scored[0].doc;
    }
  }
  return memory.lastDocument ?? null;
}

const KNOWN_TITLES = [
  { match: /coal search/i, title: "Coal Search.pdf" },
  { match: /arnold crescent/i, title: "Arnold Crescent" },
];

export function inferEntitiesFromTurns(
  turns: Array<{ role: string; text: string }>,
  entities: WhatsAppEntityMemory,
): WhatsAppEntityMemory {
  if (hasDocumentMemory(entities)) {
    return entities;
  }
  const hay = turns.map((turn) => turn.text).join("\n");
  const files = [...hay.matchAll(/([A-Za-z0-9][\w .'-]{1,80}\.(?:pdf|docx?|xlsx?|pptx?))/gi)].map(
    (match) => match[1]!.trim(),
  );
  const named = KNOWN_TITLES.filter((row) => row.match.test(hay)).map((row) => row.title);
  const titles = [...new Set([...files, ...named])];
  if (!titles.length) return entities;
  const docs = titles.slice(0, 3).map((title) => ({
    id: entities.lastDocument?.id ?? "",
    title,
    url: entities.lastDocument?.url ?? null,
    excerpt: entities.lastDocument?.excerpt ?? "",
    amount: entities.lastDocument?.amount ?? null,
    reference: entities.lastDocument?.reference ?? null,
    sourceLabel: title,
  }));
  return mergeEntityMemory(entities, {
    lastDocument: entities.lastDocument ?? docs[0],
    recentDocuments: docs,
  });
}

export function namesDifferentDocument(text: string, memory: WhatsAppEntityMemory | null | undefined): boolean {
  const terms = String(text ?? "")
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= 3 && !GENERIC_REF_STOP.has(token));
  if (!terms.length) return false;
  const last = normalizeTitle(memory?.lastDocument?.title ?? "");
  if (!last) return true;
  return terms.some((term) => !last.includes(term));
}

const GENERIC_REF_STOP = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "document",
  "documents",
  "doc",
  "docs",
  "file",
  "files",
  "find",
  "search",
  "look",
  "url",
  "link",
  "source",
  "where",
  "about",
  "anything",
  "something",
  "please",
  "can",
  "you",
  "me",
]);

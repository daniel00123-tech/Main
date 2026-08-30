export type WhatsAppDocumentEntity = {
  id: string;
  title: string;
  url: string | null;
  excerpt: string;
  amount: string | null;
  reference: string | null;
  sourceLabel: string | null;
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
};

const EMPTY: WhatsAppEntityMemory = {};

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
    recentDocuments: (memory.recentDocuments ?? []).slice(0, 3).map(compactDocument),
    lastEmail: memory.lastEmail ?? null,
    lastInvoice: memory.lastInvoice ?? null,
    lastCustomer: memory.lastCustomer ?? null,
    lastJob: memory.lastJob ?? null,
    lastDateRange: memory.lastDateRange ?? null,
    lastTool: memory.lastTool ?? null,
    lastSource: memory.lastSource ?? null,
    lastSourceUrl: memory.lastSourceUrl ?? memory.lastDocument?.url ?? null,
    lastSourceSystem: memory.lastSourceSystem ?? null,
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
  };
}

export function extractAmount(text: string): string | null {
  return text.match(/£\s?[\d,]+(?:\.\d{2})?(?:\s*GBP)?/i)?.[0]?.replace(/\s+/g, " ") ?? null;
}

export function extractReference(text: string): string | null {
  return text.match(/\b(?:order id|ref(?:\.? no)?\.?)\s*[:.]?\s*([A-Z0-9][A-Z0-9/_-]{3,})/i)?.[1] ?? null;
}

export function documentEntityFromHit(input: {
  id: string;
  title: string;
  url?: string | null;
  text?: string | null;
  snippet?: string | null;
  sourceLabel?: string | null;
}): WhatsAppDocumentEntity {
  const body = String(input.text || input.snippet || "");
  return {
    id: input.id,
    title: input.title,
    url: input.url && /^https?:\/\//i.test(input.url) ? input.url : null,
    excerpt: body.replace(/\s+/g, " ").trim().slice(0, 400),
    amount: extractAmount(body),
    reference: extractReference(body),
    sourceLabel: input.sourceLabel ?? input.title,
  };
}

export function mergeEntityMemory(
  prior: WhatsAppEntityMemory,
  next: Partial<WhatsAppEntityMemory>,
): WhatsAppEntityMemory {
  const lastDocument = next.lastDocument !== undefined ? next.lastDocument : prior.lastDocument;
  const recent = mergeRecentDocuments(prior.recentDocuments, lastDocument, next.recentDocuments);
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
    lastSourceSystem: next.lastSourceSystem !== undefined ? next.lastSourceSystem : prior.lastSourceSystem,
  };
}

function mergeRecentDocuments(
  prior: WhatsAppDocumentEntity[] | undefined,
  last: WhatsAppDocumentEntity | null | undefined,
  extra?: WhatsAppDocumentEntity[],
): WhatsAppDocumentEntity[] {
  const out: WhatsAppDocumentEntity[] = [];
  const seen = new Set<string>();
  for (const doc of [last, ...(extra ?? []), ...(prior ?? [])]) {
    if (!doc?.title && !doc?.id) continue;
    const key = `${doc.id}|${doc.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
    if (out.length >= 3) break;
  }
  return out;
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

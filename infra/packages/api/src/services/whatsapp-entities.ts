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
  lastInvoice?: { id?: string; number?: string; customer?: string } | null;
  lastCustomer?: { name: string } | null;
  lastDateRange?: { label: string } | null;
  lastTool?: string | null;
  lastSource?: string | null;
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
    lastDocument: memory.lastDocument
      ? {
          id: memory.lastDocument.id.slice(0, 180),
          title: memory.lastDocument.title.slice(0, 180),
          url: memory.lastDocument.url,
          excerpt: memory.lastDocument.excerpt.slice(0, 400),
          amount: memory.lastDocument.amount,
          reference: memory.lastDocument.reference,
          sourceLabel: memory.lastDocument.sourceLabel,
        }
      : null,
    lastInvoice: memory.lastInvoice ?? null,
    lastCustomer: memory.lastCustomer ?? null,
    lastDateRange: memory.lastDateRange ?? null,
    lastTool: memory.lastTool ?? null,
    lastSource: memory.lastSource ?? null,
  });
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
  return {
    lastDocument: next.lastDocument !== undefined ? next.lastDocument : prior.lastDocument,
    lastInvoice: next.lastInvoice !== undefined ? next.lastInvoice : prior.lastInvoice,
    lastCustomer: next.lastCustomer !== undefined ? next.lastCustomer : prior.lastCustomer,
    lastDateRange: next.lastDateRange !== undefined ? next.lastDateRange : prior.lastDateRange,
    lastTool: next.lastTool !== undefined ? next.lastTool : prior.lastTool,
    lastSource: next.lastSource !== undefined ? next.lastSource : prior.lastSource,
  };
}

export function hasDocumentMemory(memory: WhatsAppEntityMemory | null | undefined): boolean {
  return Boolean(memory?.lastDocument?.id || memory?.lastDocument?.title);
}

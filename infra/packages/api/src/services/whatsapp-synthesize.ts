import { wantsFullDetail, wantsSummary, sanitizeWhatsAppSource, compressDocumentAnswer } from "./whatsapp-compress";
import type { WhatsAppDocumentEntity, WhatsAppEntityMemory } from "./whatsapp-entities";
import type { WhatsAppPlan } from "./whatsapp-plan";

const NO_LINK =
  "I found the document, but I don’t currently have a direct download link for that source. I can summarise it or look for another copy if that helps.";

export function sourceLinkReply(doc: WhatsAppDocumentEntity | null | undefined): string {
  if (!doc) {
    return "I don’t have a previous document in this chat to link. Tell me the name and I’ll look it up.";
  }
  if (doc.url && /^https?:\/\//i.test(doc.url)) {
    return `${doc.title}\n${doc.url}`;
  }
  return NO_LINK;
}

export function sourceAttributionReply(doc: WhatsAppDocumentEntity | null | undefined): string {
  if (!doc) return "I don’t have a stored source from this chat yet.";
  const lines = [`Source: ${doc.title}`];
  if (doc.url && /^https?:\/\//i.test(doc.url)) lines.push(doc.url);
  return lines.join("\n");
}

export function memoryFactReply(
  plan: WhatsAppPlan,
  memory: WhatsAppEntityMemory,
  fetchedText?: string | null,
): string {
  const doc = memory.lastDocument;
  if (!doc) return "I don’t have that from the earlier message. Tell me which document you mean.";
  if (plan.fact === "amount") {
    return doc.amount
      ? `${doc.title}: the amount was ${doc.amount}.`
      : `I have ${doc.title}, but I couldn’t see a clear amount in what I stored. Want me to open the document again?`;
  }
  if (plan.fact === "who") {
    const who = (fetchedText || doc.excerpt).match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+(?:LLP|Ltd|Limited|Solicitors)\b/);
    return who
      ? `${doc.title} looks associated with ${who[0]}.`
      : `I couldn’t see a clear sender on ${doc.title} from the stored excerpt.`;
  }
  if (plan.fact === "alternatives") {
    return `I can look for other documents like ${doc.title}. Tell me if you want more search results.`;
  }
  return compressDocumentAnswer({
    title: doc.title,
    text: fetchedText || doc.excerpt,
    question: plan.fact === "detail" ? "give me the full detail" : "summarise it",
  });
}

export function draftFromMemory(
  kind: "reply" | "quote" | "method" | "professional",
  memory: WhatsAppEntityMemory,
  guidanceNote?: string | null,
): string {
  const doc = memory.lastDocument;
  const source = doc ? sanitizeWhatsAppSource(doc.excerpt || doc.title) : "";
  const title = doc?.title ?? "the last item";
  const body =
    kind === "quote"
      ? `Draft quote summary based on ${title}.\n\nScope is taken from the source notes only. I have not invented prices.${doc?.amount ? ` Source-backed figure: ${doc.amount}.` : " No source-backed price was found — treat any figure as an assumption until you confirm."}`
      : kind === "method"
        ? `Draft method-statement outline from ${title}. Use the source document for site-specific steps; I have not added unstated procedures.`
        : kind === "professional"
          ? `Professional rewrite based on ${title}:\n\n${source.slice(0, 280) || "I can rewrite this once I have the source text."}`
          : `Draft customer reply based on ${title}:\n\nThank you for your message. I’ve reviewed ${title}${doc?.reference ? ` (ref ${doc.reference})` : ""}${doc?.amount ? ` for ${doc.amount}` : ""}. Please let me know if you would like me to take this further.\n\nThis is a draft only — I have not sent it.`;
  const note = guidanceNote ? `\n\n${guidanceNote}` : "";
  return `${body}${note}\n\nWant me to give you more detail?`;
}

export function priceAdviceReply(input: { title?: string | null; text?: string | null; found: boolean }): string {
  if (!input.found) {
    return "I couldn’t find a connected pricing sheet for that job. I can search historical documents if you give me a system, material or job name. I will not invent a price.";
  }
  const amount = input.text?.match(/£\s?[\d,]+(?:\.\d{2})?/)?.[0];
  return [
    input.title ? `From ${input.title}:` : "From your connected pricing documents:",
    amount ? `Source-backed figure: ${amount}.` : "I found related pricing notes but no single clear rate.",
    "Treat anything not on the source sheet as an assumption.",
    "Want me to give you more detail?",
  ].join("\n");
}

export function withOptionalSource(reply: string, title: string | null, question: string): string {
  if (!title) return reply;
  if (wantsFullDetail(question) || wantsSummary(question) || /\bwhere did you get\b/i.test(question)) {
    if (/^Source:/m.test(reply)) return reply;
    return `${reply}\n\nSource: ${title}`;
  }
  return reply;
}

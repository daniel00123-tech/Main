const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const MARKDOWN_TABLE_RE = /^\s*\|.+\|\s*$/gm;

export function formatWhatsAppReply(text: string, options?: { maxChars?: number }): string {
  const maxChars = options?.maxChars ?? 1400;
  let next = String(text ?? "").replace(/\r\n/g, "\n").trim();
  next = next.replace(UUID_RE, "");
  next = next.replace(/```[\s\S]*?```/g, (block) => {
    const inner = block.replace(/```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      return "Details are available in your connected business systems.";
    }
    return inner;
  });
  next = next.replace(MARKDOWN_TABLE_RE, "");
  next = next.replace(/\n{3,}/g, "\n\n");
  next = next.replace(/[ \t]{2,}/g, " ");
  next = next.trim();
  if (!next) {
    return "I could not find a useful answer from your connected systems.";
  }
  if (next.length <= maxChars) {
    return next;
  }
  const cut = next.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  const head = (lastBreak > 400 ? cut.slice(0, lastBreak + 1) : cut).trim();
  return `${head}\n\nReply if you want more detail.`;
}

export function companySelectionMessage(companies: Array<{ companyId: string; companyName: string }>): string {
  const lines = companies.slice(0, 8).map((company, index) => `${index + 1}. ${company.companyName}`);
  return [
    "This number is linked to more than one company.",
    "Reply with the company number to continue:",
    "",
    ...lines,
  ].join("\n");
}

export function writeIntentWhatsAppMessage(): string {
  return [
    "That looks like a change to business records.",
    "WhatsApp can search and answer from your connected systems, but writes still need approval in the Infra portal.",
  ].join(" ");
}

export function toolFailureWhatsAppMessage(): string {
  return "I could not complete that lookup from your connected systems. Try again shortly, or ask in the portal.";
}

export function aiFailureWhatsAppMessage(): string {
  return "I could not complete that request just now. Please try again shortly.";
}

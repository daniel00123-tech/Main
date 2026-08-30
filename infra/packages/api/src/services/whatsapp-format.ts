const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const MARKDOWN_TABLE_RE = /^\s*\|.+\|\s*$/gm;

export function formatWhatsAppReply(text: string, options?: { maxChars?: number }): string {
  const maxChars = options?.maxChars ?? 700;
  let next = String(text ?? "").replace(/\r\n/g, "\n").trim();
  next = next.replace(UUID_RE, "");
  next = next.replace(/^#{1,6}\s+/gm, "");
  next = next.replace(/\\#/g, "");
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
  return `${head}\n\nI can give you more detail if you want.`;
}

export function companySelectionMessage(companies: Array<{ companyId: string; companyName: string }>): string {
  const lines = companies.slice(0, 8).map((company, index) => `${index + 1}. ${company.companyName}`);
  return ["Which company would you like me to use?", "", ...lines].join("\n");
}

export function writeIntentWhatsAppMessage(): string {
  return "That would change a business record. WhatsApp can search and answer, but writes still need approval in the Infra portal.";
}

export function toolFailureWhatsAppMessage(): string {
  return "I can’t reach that system right now. I’ve logged the issue — please try again shortly.";
}

export function permissionBlockedWhatsAppMessage(): string {
  return "You don’t currently have permission to access that information.";
}

export function noResultWhatsAppMessage(): string {
  return "I couldn’t find that in the systems I can currently access. If you give me another name, date or reference, I can try again.";
}

export function timeoutWhatsAppMessage(): string {
  return "That took longer than expected and I couldn’t complete it this time. Please try again.";
}

export function aiFailureWhatsAppMessage(): string {
  return "I couldn’t complete that request just now. Please try again shortly.";
}

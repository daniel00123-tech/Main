export type WhatsAppReplyButton = {
  id: string;
  title: string;
};

export type WhatsAppListRow = {
  id: string;
  title: string;
  description?: string;
};

const ACTION_TO_TEXT: Record<string, string> = {
  summarise: "summarise it",
  more_detail: "give me more detail",
  open_source: "send me the link",
  try_again: "try again",
  search_emails: "find the latest email about it",
  search_documents: "find the document",
  make_shorter: "make that shorter",
  find_similar: "find another document like it",
  compare_last_month: "what about last month?",
  show_overdue: "find overdue invoices",
  top_customers: "who is our biggest customer?",
  draft_reply: "draft a reply",
  find_related: "find related emails",
  find_document: "find a document",
  check_finance: "what were sales this month?",
  what_else: "what can you do?",
  capabilities: "what can you do?",
};

const WRITE_BUTTON = /\b(send invoice|approve|create quote|write|delete|void)\b/i;

export function isSafeButtonId(id: string): boolean {
  if (!id || id.length > 80) return false;
  if (WRITE_BUTTON.test(id)) return false;
  if (ACTION_TO_TEXT[id]) return true;
  if (/^co_[a-z0-9-]{1,60}$/i.test(id)) return true;
  if (/^doc:[A-Za-z0-9 ._-]{1,40}$/.test(id)) return true;
  return false;
}

export function mapButtonToUserText(
  id: string,
  title?: string | null,
): { text: string; action: string; supported: boolean } {
  const trimmed = String(id ?? "").trim();
  if (!isSafeButtonId(trimmed)) {
    return { text: title?.trim() || "", action: "unsupported", supported: false };
  }
  if (ACTION_TO_TEXT[trimmed]) {
    return { text: ACTION_TO_TEXT[trimmed]!, action: trimmed, supported: true };
  }
  if (trimmed.startsWith("co_")) {
    return { text: trimmed, action: "company_select", supported: true };
  }
  if (trimmed.startsWith("doc:")) {
    const titlePart = trimmed.slice(4).trim();
    return { text: `find ${titlePart}`, action: "document_select", supported: true };
  }
  return { text: title?.trim() || trimmed, action: "unknown", supported: false };
}

export function clipButtonTitle(title: string): string {
  const next = title.replace(/\s+/g, " ").trim();
  return next.length <= 20 ? next : `${next.slice(0, 17).trim()}…`;
}

export function suggestionButtons(input: {
  kind:
    | "document"
    | "no_result"
    | "long"
    | "finance"
    | "email"
    | "help"
    | "clarify_docs"
    | "company"
    | "none";
  hasSourceUrl?: boolean;
  hasXero?: boolean;
  documentTitles?: string[];
  companies?: Array<{ companyId: string; companyName: string }>;
}): WhatsAppReplyButton[] {
  if (input.kind === "document") {
    const buttons: WhatsAppReplyButton[] = [
      { id: "summarise", title: "Summarise" },
      input.hasSourceUrl ? { id: "open_source", title: "Open source" } : { id: "find_similar", title: "Find similar" },
      { id: "more_detail", title: "More detail" },
    ];
    return buttons.slice(0, 3);
  }
  if (input.kind === "no_result") {
    return [
      { id: "try_again", title: "Try again" },
      { id: "search_emails", title: "Search emails" },
      { id: "search_documents", title: "Search documents" },
    ];
  }
  if (input.kind === "long") {
    return [
      { id: "make_shorter", title: "Make shorter" },
      { id: "more_detail", title: "More detail" },
    ];
  }
  if (input.kind === "finance" && input.hasXero) {
    return [
      { id: "compare_last_month", title: "Compare last mo." },
      { id: "show_overdue", title: "Show overdue" },
      { id: "top_customers", title: "Top customers" },
    ];
  }
  if (input.kind === "email") {
    return [
      { id: "summarise", title: "Summarise" },
      { id: "draft_reply", title: "Draft reply" },
      { id: "find_related", title: "Find related" },
    ];
  }
  if (input.kind === "help") {
    const buttons: WhatsAppReplyButton[] = [{ id: "find_document", title: "Find a document" }];
    if (input.hasXero) buttons.push({ id: "check_finance", title: "Check finance" });
    buttons.push({ id: "what_else", title: "What else?" });
    return buttons.slice(0, 3);
  }
  if (input.kind === "clarify_docs") {
    return (input.documentTitles ?? []).slice(0, 3).map((title) => ({
      id: `doc:${title.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 36)}`,
      title: clipButtonTitle(title.replace(/\.pdf$/i, "")),
    }));
  }
  if (input.kind === "company") {
    return (input.companies ?? []).slice(0, 3).map((company) => ({
      id: company.companyId,
      title: clipButtonTitle(company.companyName),
    }));
  }
  return [];
}

export function listRowsFromCompanies(
  companies: Array<{ companyId: string; companyName: string }>,
): WhatsAppListRow[] {
  return companies.slice(0, 10).map((company) => ({
    id: company.companyId,
    title: clipButtonTitle(company.companyName),
  }));
}

export function shouldAttachButtons(reply: string, buttons: WhatsAppReplyButton[]): boolean {
  return buttons.length > 0 && buttons.length <= 3 && reply.length > 0 && reply.length <= 900;
}

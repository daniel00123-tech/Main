export type WhatsAppReplyButton = {
  id: string;
  title: string;
};

export type WhatsAppListRow = {
  id: string;
  title: string;
  description?: string;
};

export const ACTION_TO_TEXT: Record<string, string> = {
  summarise: "summarise it",
  more_detail: "give me more detail",
  more_on_this: "give me more detail",
  open_source: "send me the link",
  search_other_docs: "search other documents",
  try_again: "try again",
  search_emails: "search the shared mailbox",
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
  by_source: "where are most of them from?",
  by_file_type: "how many of each file type?",
  recent_files: "what were the most recent files?",
};

const WRITE_BUTTON = /\b(send invoice|approve|create quote|write|delete|void)\b/i;

const BOUND_BUTTON_ID = /^ctx_[a-z0-9]{8,16}:[a-z0-9_]{1,40}$/i;

export function isSafeButtonId(id: string): boolean {
  if (!id || id.length > 256) return false;
  if (WRITE_BUTTON.test(id)) return false;
  if (BOUND_BUTTON_ID.test(id)) {
    const action = id.split(":")[1] ?? "";
    return Boolean(ACTION_TO_TEXT[action]);
  }
  if (id.length > 80) return false;
  if (ACTION_TO_TEXT[id]) return true;
  if (/^co_[a-z0-9-]{1,60}$/i.test(id)) return true;
  if (/^doc:[A-Za-z0-9 ._-]{1,40}$/.test(id)) return true;
  return false;
}

export function mapButtonToUserText(
  id: string,
  title?: string | null,
): { text: string; action: string; supported: boolean; contextToken: string | null } {
  const trimmed = String(id ?? "").trim();
  if (!isSafeButtonId(trimmed)) {
    return { text: title?.trim() || "", action: "unsupported", supported: false, contextToken: null };
  }
  const bound = trimmed.match(/^(ctx_[a-z0-9]{8,16}):([a-z0-9_]+)$/i);
  const actionKey = bound ? bound[2]!.toLowerCase() : trimmed;
  const contextToken = bound ? bound[1]!.toLowerCase() : null;
  if (ACTION_TO_TEXT[actionKey]) {
    return {
      text: ACTION_TO_TEXT[actionKey]!,
      action: actionKey,
      supported: true,
      contextToken,
    };
  }
  if (trimmed.startsWith("co_")) {
    return { text: trimmed, action: "company_select", supported: true, contextToken: null };
  }
  if (trimmed.startsWith("doc:")) {
    const titlePart = trimmed.slice(4).trim();
    return { text: `find ${titlePart}`, action: "document_select", supported: true, contextToken: null };
  }
  return { text: title?.trim() || trimmed, action: "unknown", supported: false, contextToken: null };
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
    | "index_stats"
    | "none";
  variant?: "find" | "grounded" | "none";
  hasSourceUrl?: boolean;
  hasXero?: boolean;
  documentTitles?: string[];
  companies?: Array<{ companyId: string; companyName: string }>;
  contextToken?: string | null;
  completedAction?: string | null;
}): WhatsAppReplyButton[] {
  if (input.kind === "document") {
    if (input.contextToken && /^ctx_[a-z0-9]{8,16}$/i.test(input.contextToken)) {
      const token = input.contextToken.toLowerCase();
      const completed = String(input.completedAction ?? "").toLowerCase();
      const source = input.hasSourceUrl
        ? { id: `${token}:open_source`, title: "Open source" }
        : { id: `${token}:find_similar`, title: "Find similar" };
      if (input.variant === "none") {
        return [{ id: `${token}:search_other_docs`, title: "Search other docs" }, source].slice(0, 3);
      }
      if (input.variant === "grounded") {
        const hideDetail = completed === "more_detail" || completed === "detail" || completed === "more_on_this";
        const buttons: WhatsAppReplyButton[] = [];
        if (!hideDetail) buttons.push({ id: `${token}:more_on_this`, title: "More on this" });
        else buttons.push({ id: `${token}:summarise`, title: "Summarise" });
        buttons.push({ id: `${token}:search_other_docs`, title: "Search other docs" }, source);
        return buttons.slice(0, 3);
      }
      const hideSummarise = completed === "summarise" || completed === "summary";
      const hideDetail = completed === "more_detail" || completed === "detail";
      const buttons: WhatsAppReplyButton[] = [];
      if (!hideSummarise) buttons.push({ id: `${token}:summarise`, title: "Summarise" });
      buttons.push(source);
      if (!hideDetail) buttons.push({ id: `${token}:more_detail`, title: "More detail" });
      return buttons.slice(0, 3);
    }
    return [];
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
  if (input.kind === "index_stats") {
    return [
      { id: "by_source", title: "By source" },
      { id: "by_file_type", title: "By file type" },
      { id: "recent_files", title: "Recent files" },
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

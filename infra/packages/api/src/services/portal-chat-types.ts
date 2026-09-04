import type { IntelligenceDocumentRef, IntelligenceScope } from "./intelligence/types.js";

export const PORTAL_CHAT_SOURCE_CLIENT = "portal_chat";

export type PortalChatMessageRole = "user" | "assistant";

export type PortalChatContext = {
  currentDocument: IntelligenceDocumentRef | null;
  recentDocuments: IntelligenceDocumentRef[];
  lastToolName?: string | null;
  lastToolSummary?: string | null;
  currentScope?: IntelligenceScope | null;
  currentBusinessSystem?: string | null;
  lastSuccessfulTool?: string | null;
  lastAnswerTopic?: string | null;
  lastUserIntent?: string | null;
  lastAnswerText?: string | null;
  lastMailboxAddress?: string | null;
  lastEmailMessageId?: string | null;
};

export type PortalChatConversationSummary = {
  id: string;
  companyId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview?: string | null;
};

export type PortalChatMessage = {
  id: string;
  conversationId: string;
  companyId: string;
  userId: string;
  role: PortalChatMessageRole;
  content: string;
  createdAt: string;
  metadata: PortalChatMessageMetadata;
};

export type PortalChatMessageMetadata = {
  kind?: string | null;
  confidence?: string | null;
  scope?: string | null;
  toolNames?: string[];
  successfulTools?: string[];
  duplicateSuccessfulCalls?: number;
  sources?: Array<{ id: string; title: string; url?: string | null }>;
  permissionDenied?: boolean;
  controlledAction?: boolean;
  citeSource?: boolean;
  terminal?: string | null;
};

export type PortalChatConversation = PortalChatConversationSummary & {
  context: PortalChatContext;
  messages: PortalChatMessage[];
};

export type PortalChatStatusEvent = {
  label: string;
  tool: string;
};

export type PortalChatTurnResult = {
  conversation: PortalChatConversationSummary;
  userMessage: PortalChatMessage;
  assistantMessage: PortalChatMessage;
  createdConversation: boolean;
};

export function emptyPortalChatContext(): PortalChatContext {
  return {
    currentDocument: null,
    recentDocuments: [],
  };
}

const GREETING_ONLY = /^(hi|hello|hey|hiya|yo|thanks|thank you|ok|okay|yeah|yep|cheers)[.!? ]*$/i;

export function titleFromUserText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned || GREETING_ONLY.test(cleaned)) return "New chat";
  if (/\b(xero|sales)\b/i.test(cleaned) && /\b(this month|september|sep)\b/i.test(cleaned)) {
    return `${currentMonthName()} Xero Sales`;
  }
  if (/\b(xero|sales)\b/i.test(cleaned) && /\blast month\b/i.test(cleaned)) return "Last Month Xero Sales";
  if (/\b(newest|latest)\b/i.test(cleaned) && /\bfinance\b/i.test(cleaned) && /\b(inbox|email|mailbox)\b/i.test(cleaned)) {
    return "Latest Finance Inbox Email";
  }
  if (/\b(newest|latest)\b/i.test(cleaned) && /\b(inbox|email|mailbox|info)\b/i.test(cleaned)) {
    return "Latest Info Inbox Email";
  }
  if (/\b(po process|purchase order process)\b/i.test(cleaned)) return "PO Process";
  if (/\bweather\b/i.test(cleaned)) return "London Weather";
  const stripped = cleaned
    .replace(/^(ok(ay)?|yeah|yes|great|and|please|can you|could you|what(?:'s| is)|whats)\b[, ]*/gi, "")
    .replace(/[?!.]+$/g, "")
    .trim();
  const words = (stripped || cleaned).split(/\s+/).slice(0, 6);
  const titled = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  return titled.length > 42 ? `${titled.slice(0, 39)}…` : titled || "New chat";
}

function currentMonthName(): string {
  return new Date().toLocaleString("en-GB", { month: "long", timeZone: "Europe/London" });
}

export function toolStatusLabel(toolName: string): string | null {
  if (/^xero_/i.test(toolName)) return "Checking Xero…";
  if (/outlook|mailbox|email/i.test(toolName)) return "Checking email…";
  if (toolName === "search_company_knowledge" || toolName === "search") {
    return "Searching company files…";
  }
  if (toolName === "search_document" || toolName === "get_knowledge_document" || toolName === "fetch") {
    return "Reading the document…";
  }
  if (toolName === "get_document_index_stats") return "Checking the file library…";
  if (toolName === "get_connector_status" || toolName === "database_summary" || toolName === "system_health") {
    return "Checking connections…";
  }
  if (toolName === "get_active_automations") return "Checking automations…";
  if (toolName === "get_user_capabilities" || toolName === "get_company_system_summary") {
    return "Checking what you can access…";
  }
  if (toolName === "web_search") return "Searching the web…";
  return null;
}

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
};

export type PortalChatConversationSummary = {
  id: string;
  companyId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

export function titleFromUserText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  return cleaned.length > 48 ? `${cleaned.slice(0, 45)}…` : cleaned;
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
  return null;
}

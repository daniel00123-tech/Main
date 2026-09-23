/**
 * INFRA-native Outlook shared mailbox READ MCP tools.
 */

import {
  OUTLOOK_READ_TOOL_CONTRACTS,
  OUTLOOK_READ_TOOL_NAMES,
  OUTLOOK_READ_TOOL_REQUIRED_SCOPE,
  type OutlookReadToolName,
} from "@infra/shared";

export { OUTLOOK_READ_TOOL_NAMES, OUTLOOK_READ_TOOL_REQUIRED_SCOPE };

export function isOutlookReadTool(name: string): name is OutlookReadToolName {
  return (OUTLOOK_READ_TOOL_NAMES as readonly string[]).includes(name);
}

export function outlookReadToolAllowed(toolName: string, scopes: readonly string[]): boolean {
  if (!isOutlookReadTool(toolName)) return false;
  if (scopes.includes("*")) return true;
  return scopes.includes(OUTLOOK_READ_TOOL_REQUIRED_SCOPE);
}

export const OUTLOOK_READ_TOOL_SCHEMAS: Record<
  OutlookReadToolName,
  { description: string; inputSchema: Record<string, unknown> }
> = {
  outlook_search_mailbox: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_search_mailbox")!
      .description,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        mailboxAddress: {
          type: "string",
          description:
            "Shared mailbox SMTP address. For Elvex info inbox use info@elvexpropertyservices.com. Do not use finance@ unless the user is authorised for finance mail.",
        },
        sourceId: { type: "string", description: "Optional INFRA mailbox source id" },
        query: { type: "string", description: "Search query (subject/body/sender where Graph permits)" },
        folderId: { type: "string" },
        fromDate: { type: "string", description: "ISO date lower bound" },
        toDate: { type: "string", description: "ISO date upper bound" },
        limit: { type: "number", default: 25 },
      },
    },
  },
  outlook_list_messages: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_list_messages")!
      .description,
    inputSchema: {
      type: "object",
      properties: {
        mailboxAddress: {
          type: "string",
          description:
            "Shared mailbox SMTP address. For the Elvex info inbox use info@elvexpropertyservices.com. Omit to default to the info inbox. Never use finance@ for office staff.",
        },
        sourceId: { type: "string" },
        folderId: { type: "string" },
        folderName: { type: "string", default: "inbox" },
        limit: { type: "number", default: 5 },
      },
    },
  },
  outlook_get_message: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_get_message")!
      .description,
    inputSchema: {
      type: "object",
      required: ["mailboxAddress", "messageId"],
      properties: {
        mailboxAddress: { type: "string" },
        sourceId: { type: "string" },
        messageId: {
          type: "string",
          description: "Stable Graph or company-MCP message id returned by list/search. Not a preview snippet.",
        },
        id: { type: "string", description: "Alias of messageId" },
        internetMessageId: {
          type: "string",
          description: "Optional RFC internet message id when list/search returned that field instead of Graph id.",
        },
      },
    },
  },
  outlook_get_conversation: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_get_conversation")!
      .description,
    inputSchema: {
      type: "object",
      required: ["mailboxAddress", "conversationId"],
      properties: {
        mailboxAddress: { type: "string" },
        sourceId: { type: "string" },
        conversationId: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  outlook_list_folders: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_list_folders")!
      .description,
    inputSchema: {
      type: "object",
      required: ["mailboxAddress"],
      properties: {
        mailboxAddress: { type: "string" },
        sourceId: { type: "string" },
      },
    },
  },
  outlook_list_attachments: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_list_attachments")!
      .description,
    inputSchema: {
      type: "object",
      required: ["mailboxAddress", "messageId"],
      properties: {
        mailboxAddress: { type: "string" },
        sourceId: { type: "string" },
        messageId: { type: "string" },
      },
    },
  },
  outlook_get_attachment: {
    description: OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === "outlook_get_attachment")!
      .description,
    inputSchema: {
      type: "object",
      required: ["mailboxAddress", "messageId", "attachmentId"],
      properties: {
        mailboxAddress: { type: "string" },
        sourceId: { type: "string" },
        messageId: { type: "string" },
        attachmentId: { type: "string" },
      },
    },
  },
};

export function withOutlookReadTools(
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  scopes?: readonly string[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const allowed =
    !scopes || scopes.includes("*") || scopes.includes(OUTLOOK_READ_TOOL_REQUIRED_SCOPE);
  if (!allowed) return tools;

  const outlookTools = OUTLOOK_READ_TOOL_NAMES.map((name) => ({
    name,
    description: OUTLOOK_READ_TOOL_SCHEMAS[name].description,
    inputSchema: OUTLOOK_READ_TOOL_SCHEMAS[name].inputSchema,
  }));
  return [...tools, ...outlookTools];
}

export function outlookActionForTool(toolName: string): string | null {
  const contract = OUTLOOK_READ_TOOL_CONTRACTS.find((t) => t.name === toolName);
  return contract?.action ?? null;
}

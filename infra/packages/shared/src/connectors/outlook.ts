/**
 * Outlook shared mailbox READ tool contracts — live retrieval, not knowledge indexing.
 */

export const OUTLOOK_READ_TOOL_NAMES = [
  "outlook_search_mailbox",
  "outlook_list_messages",
  "outlook_get_message",
  "outlook_get_conversation",
  "outlook_list_folders",
  "outlook_list_attachments",
  "outlook_get_attachment",
] as const;

export type OutlookReadToolName = (typeof OUTLOOK_READ_TOOL_NAMES)[number];

export const OUTLOOK_READ_TOOL_REQUIRED_SCOPE = "outlook.mail.read";

export const OUTLOOK_MAILBOX_TYPES = [
  "shared_mailbox",
  "personal_mailbox",
  "room_mailbox",
  "equipment_mailbox",
  "unknown",
] as const;

export type OutlookMailboxType = (typeof OUTLOOK_MAILBOX_TYPES)[number];

/** Minimum Microsoft Graph application permission for shared mailbox READ (app-only). */
export const OUTLOOK_REQUIRED_APP_PERMISSION = "Mail.Read";

/** Optional application permission for tenant mailbox discovery listing. */
export const OUTLOOK_DISCOVERY_APP_PERMISSION = "User.Read.All";

export const OUTLOOK_READ_TOOL_CONTRACTS: Array<{
  name: OutlookReadToolName;
  description: string;
  riskClass: "low_risk";
  action: string;
}> = [
  {
    name: "outlook_search_mailbox",
    description:
      "Search messages in an explicitly included Outlook shared mailbox. Supports subject, sender, date range and free-text queries where Graph permits.",
    riskClass: "low_risk",
    action: "outlook.mail.search",
  },
  {
    name: "outlook_list_messages",
    description: "List recent messages from an included shared mailbox folder.",
    riskClass: "low_risk",
    action: "outlook.mail.read",
  },
  {
    name: "outlook_get_message",
    description: "Retrieve a single message by ID from an included shared mailbox.",
    riskClass: "low_risk",
    action: "outlook.mail.read",
  },
  {
    name: "outlook_get_conversation",
    description: "Retrieve messages in a conversation/thread from an included shared mailbox.",
    riskClass: "low_risk",
    action: "outlook.mail.read",
  },
  {
    name: "outlook_list_folders",
    description: "List mail folders for an included shared mailbox.",
    riskClass: "low_risk",
    action: "outlook.mail.read",
  },
  {
    name: "outlook_list_attachments",
    description: "List attachment metadata for a message in an included shared mailbox.",
    riskClass: "low_risk",
    action: "outlook.mail.read",
  },
  {
    name: "outlook_get_attachment",
    description:
      "Download a supported attachment (PDF, DOCX, XLSX, TXT) from an included shared mailbox message.",
    riskClass: "low_risk",
    action: "outlook.mail.read",
  },
];

export function isOutlookReadToolName(name: string): name is OutlookReadToolName {
  return (OUTLOOK_READ_TOOL_NAMES as readonly string[]).includes(name);
}

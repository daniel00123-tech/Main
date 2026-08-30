import { normalizeMailbox } from "../microsoft/config";
import type { ElvexCapability } from "./capabilities";

export const INFO_MAILBOX = "info@elvexpropertyservices.com";
export const FINANCE_MAILBOX = "finance@elvexpropertyservices.com";

export type MailboxKind = "info" | "finance";

export function mailboxKind(mailbox: string): MailboxKind | null {
  const normalized = normalizeMailbox(mailbox);
  if (normalized === INFO_MAILBOX) return "info";
  if (normalized === FINANCE_MAILBOX) return "finance";
  return null;
}

export function mailboxCapabilities(
  mailbox: string,
  action: "read" | "write"
): ElvexCapability | null {
  const kind = mailboxKind(mailbox);
  if (kind === "info") return action === "write" ? "mail.info.write" : "mail.info.read";
  if (kind === "finance") return action === "write" ? "mail.finance.write" : "mail.finance.read";
  return null;
}

export function calendarCapabilities(
  mailbox: string,
  action: "read" | "write"
): ElvexCapability | null {
  const kind = mailboxKind(mailbox);
  if (kind === "info") return action === "write" ? "calendar.info.write" : "calendar.info.read";
  if (kind === "finance") return action === "write" ? "calendar.finance.write" : "calendar.finance.read";
  return null;
}

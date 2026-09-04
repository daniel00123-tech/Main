import { ELVEX_FINANCE_MAILBOXES, ELVEX_INFO_MAILBOXES } from "@infra/shared";

export type MailboxResolution =
  | { kind: "resolved"; mailboxAddress: string; label: "info" | "finance" | "reused" }
  | { kind: "clarify"; text: string };

const MY_INBOX = /\b(my inbox|my e-?mails?|my mailbox|in my inbox)\b/i;
const FINANCE_INBOX = /\b(finance@|finance inbox|finance mailbox|finance e-?mails?)\b/i;
const INFO_INBOX = /\b(info@|info inbox|info mailbox|info e-?mails?)\b/i;
const BARE_INBOX = /\b((the )?(inbox|mailbox)|newest e-?mail|latest e-?mail)\b/i;

export function isPersonalInboxAsk(text: string): boolean {
  return MY_INBOX.test(text);
}

export function resolveMailboxAsk(
  text: string,
  input: {
    lastMailboxAddress?: string | null;
    lastAnswerTopic?: string | null;
    currentBusinessSystem?: string | null;
    personalMailboxAddress?: string | null;
  } = {},
): MailboxResolution {
  const onEmail =
    input.lastAnswerTopic === "email" ||
    input.currentBusinessSystem === "email" ||
    input.currentBusinessSystem === "outlook";
  if (
    FINANCE_INBOX.test(text) ||
    (onEmail && /\bfinance\b/i.test(text) && !/\b(info@|info inbox|xero|sales|invoice)\b/i.test(text))
  ) {
    return { kind: "resolved", mailboxAddress: ELVEX_FINANCE_MAILBOXES[0], label: "finance" };
  }
  if (INFO_INBOX.test(text) || (onEmail && /\binfo inbox\b/i.test(text))) {
    return { kind: "resolved", mailboxAddress: ELVEX_INFO_MAILBOXES[0], label: "info" };
  }
  if (MY_INBOX.test(text)) {
    const personal = input.personalMailboxAddress?.trim();
    if (personal) return { kind: "resolved", mailboxAddress: personal, label: "reused" };
    return {
      kind: "clarify",
      text: "Do you mean the info@ inbox or the finance@ inbox?",
    };
  }
  if (input.lastMailboxAddress && isEmailFollowUp(text, input) && !FINANCE_INBOX.test(text) && !INFO_INBOX.test(text)) {
    return { kind: "resolved", mailboxAddress: input.lastMailboxAddress, label: "reused" };
  }
  if (BARE_INBOX.test(text) || /\be-?mails?\b/i.test(text)) {
    return { kind: "resolved", mailboxAddress: ELVEX_INFO_MAILBOXES[0], label: "info" };
  }
  if (input.lastMailboxAddress) {
    return { kind: "resolved", mailboxAddress: input.lastMailboxAddress, label: "reused" };
  }
  return { kind: "resolved", mailboxAddress: ELVEX_INFO_MAILBOXES[0], label: "info" };
}

function isEmailFollowUp(
  text: string,
  input: { lastAnswerTopic?: string | null; currentBusinessSystem?: string | null },
): boolean {
  const onEmail =
    input.lastAnswerTopic === "email" ||
    input.currentBusinessSystem === "email" ||
    input.currentBusinessSystem === "outlook";
  if (!onEmail) {
    return /\b(what about|how about) (the )?(finance|info) inbox\b/i.test(text);
  }
  return /\b(what about|how about|and now|what does it say|who sent|the inbox|same (thing|again))\b/i.test(text);
}

export function isNewestEmailAsk(text: string): boolean {
  return /\b(newest|latest|most recent(?:ly)?|last e-?mail|recent e-?mail|who emailed)\b/i.test(text);
}

export function isEmailBodyFollowUp(text: string): boolean {
  return /\b(what does (it|that|the e-?mail) say|full (e-?mail|body|message)|who sent (it|that))\b/i.test(text);
}

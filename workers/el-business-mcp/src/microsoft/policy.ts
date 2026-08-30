import { normalizeMailbox, type ElMicrosoftConfig } from "./config";
import { ElMicrosoftError } from "./errors";

export type DirectoryUserLike = {
  displayName?: string | null;
  givenName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  accountEnabled?: boolean | null;
};

export type ProtectedIdentity = {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  givenName: string | null;
  matchedHint: string;
  driveId: string | null;
};

export class AccessPolicy {
  readonly approvedMailboxes: Set<string>;
  readonly calendarMailboxes: Set<string>;
  readonly protectedUsers = new Map<string, ProtectedIdentity>();
  readonly protectedDriveIds = new Set<string>();
  readonly unresolvedHints: string[] = [];

  constructor(readonly config: ElMicrosoftConfig) {
    this.approvedMailboxes = new Set(config.approvedMailboxes.map(normalizeMailbox));
    this.calendarMailboxes = new Set(config.calendarMailboxes.map(normalizeMailbox));
  }

  assertApprovedMailbox(mailbox: string): string {
    const normalized = normalizeMailbox(mailbox);
    if (!this.approvedMailboxes.has(normalized)) {
      throw new ElMicrosoftError(
        `Mailbox '${normalized}' is not an approved EL shared mailbox. Allowed: ${[...this.approvedMailboxes].join(", ")}.`,
        "EL_MS_MAILBOX_DENIED",
        403
      );
    }
    return normalized;
  }

  assertCalendarMailbox(mailbox: string): string {
    const normalized = this.assertApprovedMailbox(mailbox);
    if (!this.calendarMailboxes.has(normalized)) {
      throw new ElMicrosoftError(
        `Calendar access for '${normalized}' is not enabled. ${[...this.calendarMailboxes].join(", ") || "none"} are the only allowed calendars.`,
        "EL_MS_CALENDAR_DENIED",
        403
      );
    }
    return normalized;
  }

  registerProtected(identity: ProtectedIdentity): void {
    this.protectedUsers.set(identity.id.toLowerCase(), identity);
    if (identity.driveId) this.protectedDriveIds.add(identity.driveId);
  }

  markHintUnresolved(hint: string): void {
    this.unresolvedHints.push(hint);
  }

  isProtectedUser(input: {
    id?: string | null;
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
    givenName?: string | null;
  }): boolean {
    const id = input.id?.trim().toLowerCase();
    if (id && this.protectedUsers.has(id)) return true;

    const emails = [input.mail, input.userPrincipalName]
      .filter(Boolean)
      .map((value) => normalizeMailbox(value!));
    for (const identity of this.protectedUsers.values()) {
      const protectedEmails = [identity.mail, identity.userPrincipalName]
        .filter(Boolean)
        .map((value) => normalizeMailbox(value!));
      if (emails.some((email) => protectedEmails.includes(email))) return true;
    }

    const names = [input.displayName, input.givenName]
      .filter(Boolean)
      .map((value) => value!.trim().toLowerCase());
    for (const hint of this.config.protectedUserHints) {
      const needle = hint.trim().toLowerCase();
      if (!needle) continue;
      if (names.some((name) => name === needle || name.startsWith(`${needle} `))) {
        return true;
      }
    }
    return false;
  }

  isProtectedDrive(driveId: string | null | undefined): boolean {
    return Boolean(driveId && this.protectedDriveIds.has(driveId));
  }

  assertDriveAllowed(driveId: string, owner?: Parameters<AccessPolicy["isProtectedUser"]>[0]): void {
    if (this.isProtectedDrive(driveId) || (owner && this.isProtectedUser(owner))) {
      throw new ElMicrosoftError(
        "This drive belongs to a protected user and cannot be accessed.",
        "EL_MS_PROTECTED_DRIVE_DENIED",
        403
      );
    }
  }

  snapshot(): {
    approvedMailboxes: string[];
    calendarMailboxes: string[];
    protectedUsers: ProtectedIdentity[];
    unresolvedHints: string[];
  } {
    return {
      approvedMailboxes: [...this.approvedMailboxes],
      calendarMailboxes: [...this.calendarMailboxes],
      protectedUsers: [...this.protectedUsers.values()],
      unresolvedHints: [...this.unresolvedHints],
    };
  }
}

export function scoreProtectedCandidate(user: DirectoryUserLike, hint: string): number {
  const needle = hint.trim().toLowerCase();
  const display = (user.displayName ?? "").toLowerCase();
  const given = (user.givenName ?? "").toLowerCase();
  const mail = (user.mail ?? user.userPrincipalName ?? "").toLowerCase();
  let score = 0;
  if (given === needle) score += 80;
  if (display === needle) score += 70;
  if (display.startsWith(`${needle} `)) score += 60;
  if (display.includes(needle)) score += 30;
  if (mail.startsWith(`${needle}.`) || mail.startsWith(`${needle}@`)) score += 40;
  if (mail.endsWith("@elvexpropertyservices.com")) score += 25;
  if (user.accountEnabled === false) score -= 40;
  return score;
}

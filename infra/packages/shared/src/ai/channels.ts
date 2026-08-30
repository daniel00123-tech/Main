export const AI_CHANNELS = ["chatgpt", "claude", "whatsapp"] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];

export const AI_CHANNEL_LABELS: Record<AiChannel, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  whatsapp: "WhatsApp",
};

const COMPANY_POLICY_ROLES = new Set(["company_admin", "director"]);

export function isAiChannel(value: string | null | undefined): value is AiChannel {
  return Boolean(value && (AI_CHANNELS as readonly string[]).includes(value));
}

/** Company Admin / Director (or platform admin) may approve or revoke a company AI channel. */
export function canManageCompanyAiPolicy(
  role: string | null | undefined,
  isPlatformAdmin = false,
): boolean {
  if (isPlatformAdmin) return true;
  return Boolean(role && COMPANY_POLICY_ROLES.has(role));
}

/**
 * Any active company member may bind their own identity to an already-approved
 * channel. Company Admin is not required for personal connection.
 */
export function canConnectApprovedUserChannel(input: {
  role: string | null | undefined;
  companyApproved: boolean;
  membershipStatus?: string | null;
  userStatus?: string | null;
}): { allowed: boolean; reason?: string } {
  if (input.userStatus && input.userStatus !== "active") {
    return { allowed: false, reason: "User is disabled" };
  }
  if (input.membershipStatus && input.membershipStatus !== "active") {
    return { allowed: false, reason: "Membership is not active" };
  }
  if (!input.role) {
    return { allowed: false, reason: "No company role assigned" };
  }
  if (!input.companyApproved) {
    return { allowed: false, reason: "Channel is not approved by your company" };
  }
  return { allowed: true };
}

export function employeeMustNotSeeSharedToken(input: {
  isPlatformAdmin?: boolean;
  role: string | null | undefined;
}): boolean {
  return !canManageCompanyAiPolicy(input.role, input.isPlatformAdmin);
}

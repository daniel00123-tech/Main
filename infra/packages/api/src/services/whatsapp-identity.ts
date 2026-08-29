import type { CompanyRole } from "@infra/shared";
import {
  UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE,
  normalizeE164,
  tryNormalizeE164,
} from "./phone";

export const WHATSAPP_CHANNEL = "whatsapp" as const;

export const FUTURE_WHATSAPP_RUNTIME_PATH = [
  "WhatsApp Business Platform",
  "INFRA webhook (not registered in V1)",
  "user identity lookup (E.164 → user → company → permissions)",
  "AI gateway / orchestration on infra-api",
  "company MCP / tools / knowledge",
  "permissions",
  "metering",
  "audit / interaction history",
  "response",
] as const;

export const WHATSAPP_FOUNDATION_CONSTRAINTS = {
  productionMessagingEnabled: false,
  metaAppRequired: false,
  dedicatedNumberRequired: false,
  webhookRegistered: false,
  verificationSmsEnabled: false,
  welcomeTemplateRegistered: false,
  cursorInRuntimePath: false,
  chatgptRequiredInRuntimePath: false,
} as const;

export type WhatsAppIdentityFound = {
  found: true;
  channel: typeof WHATSAPP_CHANNEL;
  mobileE164: string;
  mobileVerified: boolean;
  mobileVerificationRequired: boolean;
  user: {
    id: string;
    email: string;
    displayName: string;
    status: string;
  };
  memberships: Array<{
    companyId: string;
    companyName: string;
    companySlug: string;
    role: CompanyRole;
    status: string;
  }>;
};

export type WhatsAppIdentityUnknown = {
  found: false;
  channel: typeof WHATSAPP_CHANNEL;
  publicMessage: typeof UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE;
};

export type WhatsAppIdentityResult = WhatsAppIdentityFound | WhatsAppIdentityUnknown;

function unknownResult(): WhatsAppIdentityUnknown {
  return {
    found: false,
    channel: WHATSAPP_CHANNEL,
    publicMessage: UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE,
  };
}

/**
 * Resolve an inbound WhatsApp sender number to an Infra user.
 * Unknown or inactive numbers return no tenant data.
 */
export async function resolveWhatsAppIdentity(
  db: D1Database,
  rawNumber: string,
): Promise<WhatsAppIdentityResult> {
  const parsed = tryNormalizeE164(rawNumber);
  if (!parsed.ok) return unknownResult();

  const userRow = await db
    .prepare(
      `SELECT id, email, display_name, status, mobile_e164, mobile_verified,
              mobile_verification_required
       FROM users
       WHERE mobile_e164 = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(parsed.e164)
    .first<{
      id: string;
      email: string;
      display_name: string;
      status: string;
      mobile_e164: string;
      mobile_verified: number;
      mobile_verification_required: number;
    }>();

  if (!userRow) return unknownResult();

  const memberships = await db
    .prepare(
      `SELECT m.company_id, m.role, m.status, c.name AS company_name, c.slug AS company_slug
       FROM company_memberships m
       JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = ? AND m.status = 'active'
         AND c.status NOT IN ('suspended', 'closed', 'archived')
         AND c.suspended_at IS NULL
       ORDER BY m.created_at ASC`,
    )
    .bind(userRow.id)
    .all<{
      company_id: string;
      role: CompanyRole;
      status: string;
      company_name: string;
      company_slug: string;
    }>();

  const activeMemberships = (memberships.results ?? []).map((row) => ({
    companyId: row.company_id,
    companyName: row.company_name,
    companySlug: row.company_slug,
    role: row.role,
    status: row.status,
  }));

  if (activeMemberships.length === 0) return unknownResult();

  return {
    found: true,
    channel: WHATSAPP_CHANNEL,
    mobileE164: normalizeE164(userRow.mobile_e164),
    mobileVerified: Number(userRow.mobile_verified) === 1,
    mobileVerificationRequired: Number(userRow.mobile_verification_required) === 1,
    user: {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name,
      status: userRow.status,
    },
    memberships: activeMemberships,
  };
}

export async function getWhatsAppChannelConfig(db: D1Database) {
  const row = await db
    .prepare(`SELECT * FROM channel_config WHERE channel = 'whatsapp' LIMIT 1`)
    .first<{
      id: string;
      channel: string;
      enabled: number;
      welcome_message_template: string | null;
      notes: string | null;
      config_json: string;
    }>();

  return {
    channel: WHATSAPP_CHANNEL,
    enabled: false,
    productionEnabled: false,
    welcomeMessageTemplate:
      row?.welcome_message_template ??
      "Hi [Name], welcome to Infra. You can message this number whenever you need help with your connected business systems.",
    notes:
      row?.notes ??
      "Foundation only. Do not send. Production WhatsApp is not enabled.",
    runtimePath: FUTURE_WHATSAPP_RUNTIME_PATH,
    constraints: WHATSAPP_FOUNDATION_CONSTRAINTS,
  };
}

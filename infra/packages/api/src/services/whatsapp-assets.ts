import type { Env } from "../env";

/** Real Infra WhatsApp Cloud API assets — not Meta sandbox. */
export const INFRA_WHATSAPP_PHONE_NUMBER_ID = "1338434179351224";
export const INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID = "1629422285251338";
export const INFRA_WHATSAPP_DISPLAY_E164 = "+447466227958";

const SANDBOX_ID = /^(1{5,}|0{5,}|555)/;
const SANDBOX_TEXT = /555\d{7}|sandbox|\+1\s*555/i;

export type WhatsAppAssetCheck = {
  ok: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  phoneMatchesProduction: boolean;
  wabaMatchesProduction: boolean;
  looksLikeSandbox: boolean;
  reason?: string;
};

export function inspectWhatsAppAssets(env: Env): WhatsAppAssetCheck {
  const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const businessAccountId = String(env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "").trim();
  const phoneMatchesProduction = phoneNumberId === INFRA_WHATSAPP_PHONE_NUMBER_ID;
  const wabaMatchesProduction = businessAccountId === INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID;
  const looksLikeSandbox =
    SANDBOX_ID.test(phoneNumberId) ||
    SANDBOX_ID.test(businessAccountId) ||
    SANDBOX_TEXT.test(phoneNumberId) ||
    SANDBOX_TEXT.test(businessAccountId);
  if (!phoneNumberId || !businessAccountId) {
    return {
      ok: false,
      phoneNumberId,
      businessAccountId,
      phoneMatchesProduction,
      wabaMatchesProduction,
      looksLikeSandbox,
      reason: "WhatsApp production IDs are not configured",
    };
  }
  if (looksLikeSandbox) {
    return {
      ok: false,
      phoneNumberId,
      businessAccountId,
      phoneMatchesProduction,
      wabaMatchesProduction,
      looksLikeSandbox,
      reason: "Configured WhatsApp IDs look like Meta sandbox assets",
    };
  }
  if (!phoneMatchesProduction || !wabaMatchesProduction) {
    return {
      ok: false,
      phoneNumberId,
      businessAccountId,
      phoneMatchesProduction,
      wabaMatchesProduction,
      looksLikeSandbox,
      reason: "Configured WhatsApp IDs do not match the Infra production assets",
    };
  }
  return {
    ok: true,
    phoneNumberId,
    businessAccountId,
    phoneMatchesProduction,
    wabaMatchesProduction,
    looksLikeSandbox: false,
  };
}

export function whatsappAccessToken(env: Env): string {
  return String(env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
}

export function whatsappPhoneNumberId(env: Env): string {
  return String(env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
}

export function whatsappBusinessAccountId(env: Env): string {
  return String(env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "").trim();
}

export function metaAppSecret(env: Env): string {
  return String(env.META_APP_SECRET ?? "").trim();
}

export function secretPresence(env: Env): {
  verifyToken: boolean;
  accessToken: boolean;
  appSecret: boolean;
} {
  return {
    verifyToken: String(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "").trim().length >= 16,
    accessToken: whatsappAccessToken(env).length > 8,
    appSecret: metaAppSecret(env).length > 8,
  };
}

export function inboundSignatureRequired(env: Env): boolean {
  return Boolean(String(env.META_APP_SECRET ?? "").trim()) || env.ENVIRONMENT === "production";
}

export function outboundAiEnabled(env: Env): boolean {
  return Boolean(
    secretPresence(env).accessToken &&
      secretPresence(env).appSecret &&
      inspectWhatsAppAssets(env).ok &&
      env.WHATSAPP_OUTBOUND_AI_ENABLED === "true",
  );
}

import type { Env } from "../env";
import { redactSecretFields } from "./secrets";
import {
  INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
  INFRA_WHATSAPP_DISPLAY_E164,
  INFRA_WHATSAPP_PHONE_NUMBER_ID,
  inspectWhatsAppAssets,
  secretPresence,
  whatsappAccessToken,
} from "./whatsapp-assets";

/** Current WhatsApp Cloud API Graph version used for register / phone status. */
export const WHATSAPP_REGISTER_GRAPH_VERSION = "v22.0";
export const WHATSAPP_REGISTER_GRAPH_BASE = `https://graph.facebook.com/${WHATSAPP_REGISTER_GRAPH_VERSION}`;
export const WHATSAPP_PIN_USER_ACTION = "USER ACTION REQUIRED: provide/set WhatsApp registration PIN";

export type WhatsAppPinResolution =
  | { ok: true; source: "request" | "secret" }
  | { ok: false; userActionRequired: typeof WHATSAPP_PIN_USER_ACTION };

export type WhatsAppCloudInspect = {
  checked: boolean;
  graphVersion: typeof WHATSAPP_REGISTER_GRAPH_VERSION;
  phoneNumberId: string;
  businessAccountId: string;
  displayE164: typeof INFRA_WHATSAPP_DISPLAY_E164;
  phoneMatchesProduction: boolean;
  wabaMatchesProduction: boolean;
  looksLikeSandbox: boolean;
  tokenPresent: boolean;
  tokenHasAccessToWaba: boolean;
  phoneNumberIdConfirmed: boolean;
  pinRequired: true;
  pinConfigured: boolean;
  metaStatus: string | null;
  codeVerificationStatus: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  registered: boolean;
  userActionRequired: string | null;
  error?: string;
};

export type WhatsAppRegisterResult = {
  attempted: boolean;
  success: boolean;
  graphVersion: typeof WHATSAPP_REGISTER_GRAPH_VERSION;
  phoneNumberId: string;
  businessAccountId: string;
  pinRequired: true;
  pinSupplied: boolean;
  userActionRequired: string | null;
  graphSuccess: boolean | null;
  error?: string;
  inspect: WhatsAppCloudInspect;
};

const PHONE_FIELDS = [
  "id",
  "display_phone_number",
  "verified_name",
  "code_verification_status",
  "quality_rating",
  "platform_type",
  "status",
  "name_status",
  "account_mode",
].join(",");

function redactMetaText(value: string): string {
  const redacted = String(redactSecretFields({ message: value }).message ?? value);
  return redacted.replace(/EAA[A-Za-z0-9]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function graphErrorMessage(json: Record<string, unknown>, fallback: string): string {
  const error = json.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return redactMetaText(message);
  }
  return redactMetaText(fallback);
}

function isRegisteredStatus(status: string | null, codeVerification: string | null): boolean {
  const normalized = (status ?? "").toUpperCase();
  if (normalized === "CONNECTED") return true;
  if (normalized === "PENDING" || normalized === "DISCONNECTED" || normalized === "") {
    return codeVerification === "VERIFIED" && normalized === "CONNECTED";
  }
  return false;
}

export function resolveWhatsAppRegistrationPin(
  env: Env,
  supplied?: string | null,
): WhatsAppPinResolution & { pin?: string } {
  const fromRequest = String(supplied ?? "").trim();
  if (/^\d{6}$/.test(fromRequest)) {
    return { ok: true, source: "request", pin: fromRequest };
  }
  const fromSecret = String(env.WHATSAPP_REGISTRATION_PIN ?? "").trim();
  if (/^\d{6}$/.test(fromSecret)) {
    return { ok: true, source: "secret", pin: fromSecret };
  }
  return { ok: false, userActionRequired: WHATSAPP_PIN_USER_ACTION };
}

async function graphGet(
  token: string,
  path: string,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${WHATSAPP_REGISTER_GRAPH_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = parseJson(await response.text());
  return { ok: response.ok, status: response.status, json };
}

export async function inspectWhatsAppCloudRegistration(env: Env): Promise<WhatsAppCloudInspect> {
  const assets = inspectWhatsAppAssets(env);
  const secrets = secretPresence(env);
  const base: WhatsAppCloudInspect = {
    checked: false,
    graphVersion: WHATSAPP_REGISTER_GRAPH_VERSION,
    phoneNumberId: assets.phoneNumberId || INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: assets.businessAccountId || INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    displayE164: INFRA_WHATSAPP_DISPLAY_E164,
    phoneMatchesProduction: assets.phoneMatchesProduction,
    wabaMatchesProduction: assets.wabaMatchesProduction,
    looksLikeSandbox: assets.looksLikeSandbox,
    tokenPresent: secrets.accessToken,
    tokenHasAccessToWaba: false,
    phoneNumberIdConfirmed: false,
    pinRequired: true,
    pinConfigured: secrets.registrationPin,
    metaStatus: null,
    codeVerificationStatus: null,
    displayPhoneNumber: null,
    verifiedName: null,
    registered: false,
    userActionRequired: secrets.registrationPin ? null : WHATSAPP_PIN_USER_ACTION,
  };

  if (!assets.ok) {
    return { ...base, error: assets.reason ?? "Invalid WhatsApp assets" };
  }
  const token = whatsappAccessToken(env);
  if (!token) {
    return { ...base, error: "WHATSAPP_ACCESS_TOKEN is not configured" };
  }

  try {
    const [waba, phone, numbers] = await Promise.all([
      graphGet(token, `${assets.businessAccountId}?fields=id,name,account_review_status`),
      graphGet(token, `${assets.phoneNumberId}?fields=${PHONE_FIELDS}`),
      graphGet(
        token,
        `${assets.businessAccountId}/phone_numbers?fields=id,display_phone_number,code_verification_status,status`,
      ),
    ]);

    const tokenHasAccessToWaba = waba.ok && String(waba.json.id ?? "") === assets.businessAccountId;
    const phoneId = String(phone.json.id ?? "");
    const listed = Array.isArray(numbers.json.data)
      ? (numbers.json.data as Array<Record<string, unknown>>)
      : [];
    const listedMatch = listed.some((row) => String(row.id ?? "") === assets.phoneNumberId);
    const phoneNumberIdConfirmed =
      phone.ok && phoneId === assets.phoneNumberId && phoneId === INFRA_WHATSAPP_PHONE_NUMBER_ID;

    const metaStatus = typeof phone.json.status === "string" ? phone.json.status : null;
    const codeVerificationStatus =
      typeof phone.json.code_verification_status === "string" ? phone.json.code_verification_status : null;
    const registered = phoneNumberIdConfirmed && isRegisteredStatus(metaStatus, codeVerificationStatus);

    let error: string | undefined;
    if (!waba.ok) {
      error = graphErrorMessage(waba.json, `WABA lookup HTTP ${waba.status}`);
    } else if (!phone.ok) {
      error = graphErrorMessage(phone.json, `Phone lookup HTTP ${phone.status}`);
    }

    return {
      ...base,
      checked: true,
      tokenHasAccessToWaba,
      phoneNumberIdConfirmed: phoneNumberIdConfirmed || listedMatch,
      metaStatus,
      codeVerificationStatus,
      displayPhoneNumber:
        typeof phone.json.display_phone_number === "string" ? phone.json.display_phone_number : null,
      verifiedName: typeof phone.json.verified_name === "string" ? phone.json.verified_name : null,
      registered,
      userActionRequired: registered ? null : secrets.registrationPin ? null : WHATSAPP_PIN_USER_ACTION,
      error,
    };
  } catch (err) {
    return {
      ...base,
      checked: true,
      error: redactMetaText(err instanceof Error ? err.message : "graph_network_error"),
    };
  }
}

export async function registerWhatsAppCloudPhoneNumber(
  env: Env,
  pin: string,
): Promise<WhatsAppRegisterResult> {
  const assets = inspectWhatsAppAssets(env);
  const emptyInspect = (): WhatsAppCloudInspect => ({
    checked: false,
    graphVersion: WHATSAPP_REGISTER_GRAPH_VERSION,
    phoneNumberId: assets.phoneNumberId || INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: assets.businessAccountId || INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    displayE164: INFRA_WHATSAPP_DISPLAY_E164,
    phoneMatchesProduction: assets.phoneMatchesProduction,
    wabaMatchesProduction: assets.wabaMatchesProduction,
    looksLikeSandbox: assets.looksLikeSandbox,
    tokenPresent: secretPresence(env).accessToken,
    tokenHasAccessToWaba: false,
    phoneNumberIdConfirmed: false,
    pinRequired: true,
    pinConfigured: secretPresence(env).registrationPin,
    metaStatus: null,
    codeVerificationStatus: null,
    displayPhoneNumber: null,
    verifiedName: null,
    registered: false,
    userActionRequired: /^\d{6}$/.test(pin) ? null : WHATSAPP_PIN_USER_ACTION,
    error: assets.reason,
  });
  const fail = (
    error: string,
    userActionRequired: string | null = null,
    inspect: WhatsAppCloudInspect = emptyInspect(),
  ): WhatsAppRegisterResult => ({
    attempted: false,
    success: false,
    graphVersion: WHATSAPP_REGISTER_GRAPH_VERSION,
    phoneNumberId: assets.phoneNumberId || INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: assets.businessAccountId || INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    pinRequired: true,
    pinSupplied: /^\d{6}$/.test(pin),
    userActionRequired,
    graphSuccess: null,
    error,
    inspect,
  });

  if (!assets.ok || assets.looksLikeSandbox) {
    return fail(assets.reason ?? "Refusing to register non-production WhatsApp assets");
  }
  if (assets.phoneNumberId !== INFRA_WHATSAPP_PHONE_NUMBER_ID) {
    return fail("Refusing to register a phone number that is not the Infra production number");
  }
  if (!/^\d{6}$/.test(pin)) {
    return fail("A six-digit registration PIN is required", WHATSAPP_PIN_USER_ACTION);
  }

  const token = whatsappAccessToken(env);
  if (!token) {
    return fail("WHATSAPP_ACCESS_TOKEN is not configured");
  }

  const inspectBefore = await inspectWhatsAppCloudRegistration(env);

  try {
    const response = await fetch(`${WHATSAPP_REGISTER_GRAPH_BASE}/${assets.phoneNumberId}/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    });
    const json = parseJson(await response.text());
    const graphSuccess = response.ok && json.success === true;
    const inspect = await inspectWhatsAppCloudRegistration(env);
    if (!graphSuccess) {
      const error = graphErrorMessage(json, `Register HTTP ${response.status}`);
      const pinMismatch = /PIN|133005|two.step/i.test(error);
      return {
        attempted: true,
        success: false,
        graphVersion: WHATSAPP_REGISTER_GRAPH_VERSION,
        phoneNumberId: assets.phoneNumberId,
        businessAccountId: assets.businessAccountId,
        pinRequired: true,
        pinSupplied: true,
        userActionRequired: pinMismatch ? WHATSAPP_PIN_USER_ACTION : inspect.userActionRequired,
        graphSuccess: false,
        error,
        inspect,
      };
    }
    return {
      attempted: true,
      success: inspect.registered || graphSuccess,
      graphVersion: WHATSAPP_REGISTER_GRAPH_VERSION,
      phoneNumberId: assets.phoneNumberId,
      businessAccountId: assets.businessAccountId,
      pinRequired: true,
      pinSupplied: true,
      userActionRequired: inspect.registered ? null : inspect.userActionRequired,
      graphSuccess: true,
      inspect,
    };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      graphVersion: WHATSAPP_REGISTER_GRAPH_VERSION,
      phoneNumberId: assets.phoneNumberId,
      businessAccountId: assets.businessAccountId,
      pinRequired: true,
      pinSupplied: true,
      userActionRequired: inspectBefore.userActionRequired,
      graphSuccess: false,
      error: redactMetaText(err instanceof Error ? err.message : "graph_network_error"),
      inspect: inspectBefore,
    };
  }
}

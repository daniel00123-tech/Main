import type { Env } from "../env";
import { inspectWhatsAppAssets, whatsappAccessToken } from "./whatsapp-assets";
import { whatsappVerifyToken, WHATSAPP_WEBHOOK_PATH } from "./whatsapp-webhook";

export const WHATSAPP_PRODUCTION_WEBHOOK_URL = `https://api.infrastack.app${WHATSAPP_WEBHOOK_PATH}`;

export type WhatsAppSubscriptionCheck = {
  checked: boolean;
  messagesField: "subscribed" | "missing" | "unknown";
  appSubscribed: boolean | null;
  overrideCallbackUri: string | null;
  overrideMatchesProduction: boolean | null;
  phoneWebhookUri: string | null;
  subscribeHttpStatus: number | null;
  overrideHttpStatus: number | null;
  userActionRequired: string | null;
  error: string | null;
};

const GRAPH = "https://graph.facebook.com/v22.0";

export async function inspectWhatsAppMessageSubscription(
  env: Env,
): Promise<WhatsAppSubscriptionCheck> {
  return ensureWhatsAppCloudWebhookSubscription(env, { applyOverride: false });
}

/**
 * Two-step Cloud API attach:
 * 1) POST /{WABA}/subscribed_apps (subscribe the token's app)
 * 2) POST override_callback_uri + verify_token so Meta delivers to infra-api
 */
export async function ensureWhatsAppCloudWebhookSubscription(
  env: Env,
  options?: { applyOverride?: boolean },
): Promise<WhatsAppSubscriptionCheck> {
  const applyOverride = options?.applyOverride !== false;
  const assets = inspectWhatsAppAssets(env);
  const token = whatsappAccessToken(env);
  const verifyToken = whatsappVerifyToken(env);
  const empty: WhatsAppSubscriptionCheck = {
    checked: false,
    messagesField: "unknown",
    appSubscribed: null,
    overrideCallbackUri: null,
    overrideMatchesProduction: null,
    phoneWebhookUri: null,
    subscribeHttpStatus: null,
    overrideHttpStatus: null,
    userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
    error: null,
  };
  if (!assets.ok || !token) {
    return { ...empty, error: "missing_token_or_assets" };
  }

  try {
    let subscribeHttpStatus: number | null = null;
    if (applyOverride) {
      const subscribe = await fetch(`${GRAPH}/${assets.businessAccountId}/subscribed_apps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      subscribeHttpStatus = subscribe.status;
      await subscribe.text().catch(() => "");
    }

    let overrideHttpStatus: number | null = null;
    if (applyOverride && verifyToken.length >= 16) {
      const override = await fetch(`${GRAPH}/${assets.businessAccountId}/subscribed_apps`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          override_callback_uri: WHATSAPP_PRODUCTION_WEBHOOK_URL,
          verify_token: verifyToken,
        }),
      });
      overrideHttpStatus = override.status;
      await override.text().catch(() => "");
    }

    const listed = await fetch(`${GRAPH}/${assets.businessAccountId}/subscribed_apps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const raw = await listed.text();
    let parsed: {
      data?: Array<{ override_callback_uri?: string; whatsapp_business_api_data?: { link?: string } }>;
    } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
    const apps = Array.isArray(parsed.data) ? parsed.data : [];
    const overrideCallbackUri = apps.find((app) => app.override_callback_uri)?.override_callback_uri ?? null;
    const phoneWebhookUri = await readPhoneWebhookUri(token, assets.phoneNumberId);
    const appSubscribed = listed.ok ? apps.length > 0 : null;
    const overrideMatchesProduction =
      overrideCallbackUri != null ? overrideCallbackUri === WHATSAPP_PRODUCTION_WEBHOOK_URL : null;

    if (!listed.ok) {
      return {
        checked: true,
        messagesField: "unknown",
        appSubscribed,
        overrideCallbackUri,
        overrideMatchesProduction,
        phoneWebhookUri,
        subscribeHttpStatus,
        overrideHttpStatus,
        userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
        error: `subscribed_apps_http_${listed.status}`,
      };
    }
    if (!appSubscribed) {
      return {
        checked: true,
        messagesField: "missing",
        appSubscribed: false,
        overrideCallbackUri,
        overrideMatchesProduction,
        phoneWebhookUri,
        subscribeHttpStatus,
        overrideHttpStatus,
        userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
        error: null,
      };
    }
    return {
      checked: true,
      messagesField: overrideMatchesProduction || phoneWebhookUri === WHATSAPP_PRODUCTION_WEBHOOK_URL
        ? "subscribed"
        : "unknown",
      appSubscribed: true,
      overrideCallbackUri,
      overrideMatchesProduction,
      phoneWebhookUri,
      subscribeHttpStatus,
      overrideHttpStatus,
      userActionRequired: overrideMatchesProduction
        ? null
        : "USER ACTION REQUIRED: subscribe messages field",
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      checked: false,
      error: err instanceof Error ? err.message : "subscription_inspect_failed",
    };
  }
}

async function readPhoneWebhookUri(token: string, phoneNumberId: string): Promise<string | null> {
  try {
    const response = await fetch(`${GRAPH}/${phoneNumberId}?fields=webhook_configuration`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await response.json()) as {
      webhook_configuration?: { webhook_url?: string; override_callback_uri?: string };
    };
    return json.webhook_configuration?.override_callback_uri
      ?? json.webhook_configuration?.webhook_url
      ?? null;
  } catch {
    return null;
  }
}

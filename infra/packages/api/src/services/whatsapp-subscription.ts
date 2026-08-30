import type { Env } from "../env";
import { inspectWhatsAppAssets, whatsappAccessToken } from "./whatsapp-assets";

export type WhatsAppSubscriptionCheck = {
  checked: boolean;
  messagesField: "subscribed" | "missing" | "unknown";
  userActionRequired: string | null;
};

export async function inspectWhatsAppMessageSubscription(
  env: Env,
): Promise<WhatsAppSubscriptionCheck> {
  const assets = inspectWhatsAppAssets(env);
  const token = whatsappAccessToken(env);
  if (!assets.ok || !token) {
    return {
      checked: false,
      messagesField: "unknown",
      userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
    };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${assets.businessAccountId}/subscribed_apps`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const raw = await response.text();
    let parsed: { data?: Array<{ whatsapp_business_api_data?: { link?: string } }> } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      return {
        checked: true,
        messagesField: "unknown",
        userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
      };
    }
    const subscribed = Array.isArray(parsed.data) && parsed.data.length > 0;
    if (!subscribed) {
      return {
        checked: true,
        messagesField: "missing",
        userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
      };
    }
    // Graph confirms the app is subscribed to the WABA. The messages webhook
    // field is still a Meta App Dashboard toggle and cannot be proven here.
    return {
      checked: true,
      messagesField: "unknown",
      userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
    };
  } catch {
    return {
      checked: false,
      messagesField: "unknown",
      userActionRequired: "USER ACTION REQUIRED: subscribe messages field",
    };
  }
}

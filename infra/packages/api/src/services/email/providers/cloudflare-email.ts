import type { Env } from "../../../env";
import { resolvePlatformEmailIdentity } from "../platform-identity";

export type CloudflareEmailSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; category: "auth" | "provider" | "network" | "unknown"; message: string };

function errorCategory(code: string | undefined): CloudflareEmailSendResult["category"] {
  if (!code) return "unknown";
  if (code.includes("AUTH") || code.includes("UNAUTHORIZED") || code.includes("FORBIDDEN")) {
    return "auth";
  }
  if (code.includes("NETWORK")) return "network";
  return "provider";
}

export async function sendCloudflareEmail(
  env: Env,
  input: {
    toEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
  },
): Promise<CloudflareEmailSendResult> {
  const identity = resolvePlatformEmailIdentity(env);
  const fromBinding = { name: identity.name, email: identity.address };
  const fromRest = { name: identity.name, address: identity.address };
  const payload = {
    to: input.toEmail,
    subject: input.subject,
    text: input.bodyText,
    html: input.bodyHtml,
  };

  const binding = env.EMAIL;
  if (binding && typeof binding.send === "function") {
    try {
      const response = await binding.send({
        to: payload.to,
        from: fromBinding,
        replyTo: fromBinding,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      });
      return { ok: true, providerMessageId: response?.messageId ?? null };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
      const message = err instanceof Error ? err.message : "Cloudflare Email send failed";
      return { ok: false, category: errorCategory(code), message: code ? `${code}: ${message}` : message };
    }
  }

  const token = env.EMAIL_SENDING_API_TOKEN?.trim() || env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    return {
      ok: false,
      category: "auth",
      message:
        "Cloudflare Email Service is not bound and EMAIL_SENDING_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are missing.",
    };
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: payload.to,
          from: fromRest,
          reply_to: fromRest,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
        }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      result?: { message_id?: string };
      errors?: Array<{ message?: string; code?: number }>;
    };
    if (!response.ok || body.success === false) {
      const first = body.errors?.[0];
      return {
        ok: false,
        category: response.status === 401 || response.status === 403 ? "auth" : "provider",
        message: first?.message ?? `Cloudflare Email send failed (${response.status})`,
      };
    }
    return { ok: true, providerMessageId: body.result?.message_id ?? null };
  } catch (err) {
    return {
      ok: false,
      category: "network",
      message: err instanceof Error ? err.message : "Cloudflare Email network error",
    };
  }
}

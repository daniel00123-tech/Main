import type { Env } from "../../../env";

export type ResendSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; category: "auth" | "provider" | "network" | "unknown"; message: string };

/** Development / fallback provider — not used for production tenant senders. */
export async function sendResendEmail(
  env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM">,
  input: {
    fromDisplayName: string;
    fromEmail: string;
    toEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
  },
): Promise<ResendSendResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, category: "auth", message: "RESEND_API_KEY not configured" };
  }

  const from =
    env.EMAIL_FROM?.trim() ||
    `${input.fromDisplayName} <${input.fromEmail}>`;

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.toEmail],
        subject: input.subject,
        text: input.bodyText,
        html: input.bodyHtml,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      category: "network",
      message: err instanceof Error ? err.message : "Resend network error",
    };
  }

  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) {
    return {
      ok: false,
      category: response.status === 401 ? "auth" : "provider",
      message: body.message ?? "Email send failed",
    };
  }

  return { ok: true, providerMessageId: body.id ?? null };
}

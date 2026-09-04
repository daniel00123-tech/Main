import { Hono } from "hono";
import type { Env } from "../env";
import { renderTestEmail } from "../services/email-outbox";
import { resolvePlatformEmailIdentity } from "../services/email/platform-identity";
import { sendTransactionalEmail } from "../services/email/send-transactional";

export const EMAIL_LIVE_TEST_RECIPIENT = "daniel.dwyer123@gmail.com";
export const EMAIL_LIVE_TEST_SUBJECT = "Infra email test";

const routes = new Hono<{ Bindings: Env }>();

function liveTestAuthorized(env: Env, request: { header(name: string): string | undefined }): boolean {
  const key = String(env.EMAIL_LIVE_TEST_KEY ?? "").trim();
  return key.length >= 24 && request.header("x-infra-email-live-test") === key;
}

routes.post("/api/internal/email-live-test", async (c) => {
  if (!liveTestAuthorized(c.env, c.req)) {
    return c.json({ error: "Not found" }, 404);
  }

  const identity = resolvePlatformEmailIdentity(c.env);
  const content = renderTestEmail({
    companyName: "Infra",
    sentAtLabel: new Date().toISOString(),
  });
  const result = await sendTransactionalEmail(c.env, c.env.DB, {
    companyId: "co_infra_test",
    type: "TEST_EMAIL",
    recipient: EMAIL_LIVE_TEST_RECIPIENT,
    subject: EMAIL_LIVE_TEST_SUBJECT,
    bodyText: content.text,
    bodyHtml: content.html,
    actor: "system:email-live-test",
  });

  return c.json(
    {
      ok: result.sent,
      emailId: result.id,
      provider: result.provider,
      providerMessageId: result.providerMessageId ?? null,
      failureCategory: result.failureCategory ?? null,
      error: result.error ?? null,
      sender: identity.formatted,
      fromEmail: identity.address,
      replyTo: identity.address,
      subject: EMAIL_LIVE_TEST_SUBJECT,
      recipient: EMAIL_LIVE_TEST_RECIPIENT,
      bindingPresent: typeof c.env.EMAIL?.send === "function",
      portalUrlPresent: content.html.includes("https://app.infrastack.app"),
      caddingtonAbsent:
        !/caddington/i.test(content.html) &&
        !/caddington/i.test(content.text) &&
        !/caddington/i.test(identity.formatted),
    },
    result.sent ? 200 : 502,
  );
});

export default routes;

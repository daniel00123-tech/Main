import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../../env";
import { sendCloudflareEmail } from "./cloudflare-email";

describe("sendCloudflareEmail", () => {
  it("uses the Workers EmailAddress email field and Infra noreply identity", async () => {
    const send = vi.fn(async () => ({ messageId: "cf-msg-1" }));
    const result = await sendCloudflareEmail(
      {
        EMAIL: { send },
        EMAIL_FROM_NAME: "Infra",
        EMAIL_FROM_ADDRESS: "noreply@infrastack.app",
      } as Env,
      {
        toEmail: "daniel.dwyer123@gmail.com",
        subject: "Infra email test",
        bodyText: "Open Infra: https://app.infrastack.app",
        bodyHtml: '<a href="https://app.infrastack.app">Open Infra</a>',
      },
    );

    expect(result).toEqual({ ok: true, providerMessageId: "cf-msg-1" });
    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]?.[0] as {
      from: { email?: string; address?: string; name?: string };
      replyTo: { email?: string; name?: string };
    };
    expect(payload.from).toEqual({ name: "Infra", email: "noreply@infrastack.app" });
    expect(payload.replyTo).toEqual({ name: "Infra", email: "noreply@infrastack.app" });
    expect(JSON.stringify(payload)).not.toMatch(/caddington/i);
    expect(payload.from.address).toBeUndefined();
  });
});

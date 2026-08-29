import { describe, expect, it } from "vitest";
import { UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE } from "./phone";
import { resolveWhatsAppIdentity, WHATSAPP_FOUNDATION_CONSTRAINTS } from "./whatsapp-identity";

describe("WhatsApp identity foundation", () => {
  it("returns no tenant data for unknown or invalid numbers", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return null;
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const unknown = await resolveWhatsAppIdentity(db, "+447700900999");
    expect(unknown).toEqual({
      found: false,
      channel: "whatsapp",
      publicMessage: UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE,
    });
    expect(JSON.stringify(unknown)).not.toMatch(/company|Caddington|email/i);

    const invalid = await resolveWhatsAppIdentity(db, "abc");
    expect(invalid.found).toBe(false);
    expect("user" in invalid).toBe(false);
  });

  it("resolves an active user and memberships for a known number", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes("FROM users")) {
                  return {
                    id: "user_1",
                    email: "sam@example.com",
                    display_name: "Sam",
                    status: "active",
                    mobile_e164: "+447700900123",
                    mobile_verified: 0,
                    mobile_verification_required: 1,
                  };
                }
                return null;
              },
              async all() {
                return {
                  results: [
                    {
                      company_id: "co_1",
                      role: "office_staff",
                      status: "active",
                      company_name: "Example Ltd",
                      company_slug: "example",
                    },
                  ],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const found = await resolveWhatsAppIdentity(db, "07700900123");
    expect(found.found).toBe(true);
    if (found.found) {
      expect(found.mobileE164).toBe("+447700900123");
      expect(found.memberships[0]?.companyId).toBe("co_1");
      expect(found.mobileVerificationRequired).toBe(true);
    }
  });

  it("does not enable production messaging in V1", () => {
    expect(WHATSAPP_FOUNDATION_CONSTRAINTS.productionMessagingEnabled).toBe(false);
    expect(WHATSAPP_FOUNDATION_CONSTRAINTS.webhookRegistered).toBe(false);
  });
});

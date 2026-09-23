import { describe, expect, it } from "vitest";
import {
  PLATFORM_EMAIL_FROM,
  PLATFORM_EMAIL_FROM_ADDRESS,
  PLATFORM_EMAIL_FROM_NAME,
  RESERVED_INFRA_EMAIL_ALIASES,
  isPlatformSenderAddress,
} from "./identity";

describe("platform email identity", () => {
  it("is Infra noreply", () => {
    expect(PLATFORM_EMAIL_FROM_NAME).toBe("Infra");
    expect(PLATFORM_EMAIL_FROM_ADDRESS).toBe("noreply@infrastack.app");
    expect(PLATFORM_EMAIL_FROM).toBe("Infra <noreply@infrastack.app>");
    expect(isPlatformSenderAddress("noreply@infrastack.app")).toBe(true);
    expect(isPlatformSenderAddress("admin@CaddingtonHoldings.co.uk")).toBe(false);
  });

  it("reserves future aliases without treating them as senders", () => {
    expect(RESERVED_INFRA_EMAIL_ALIASES).toEqual([
      "support@infrastack.app",
      "billing@infrastack.app",
      "admin@infrastack.app",
    ]);
    expect(RESERVED_INFRA_EMAIL_ALIASES).not.toContain(PLATFORM_EMAIL_FROM_ADDRESS);
  });
});

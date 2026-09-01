import { describe, expect, it } from "vitest";
import { publicToolErrorMessage } from "./public-errors";

describe("publicToolErrorMessage", () => {
  it("maps 401 to reconnect copy", () => {
    expect(publicToolErrorMessage(401, "Invalid or revoked service token").message).toBe(
      "Authentication needs reconnecting",
    );
  });

  it("maps 402 to insufficient credit", () => {
    expect(publicToolErrorMessage(402, "INSUFFICIENT_CREDIT").message).toBe(
      "Insufficient credit",
    );
  });

  it("does not leak SQL or stack traces", () => {
    const result = publicToolErrorMessage(
      500,
      "D1_ERROR: no such table\n    at executeGatewayRequest",
    );
    expect(result.message).toBe("Request failed — retry");
    expect(result.message).not.toMatch(/D1|stack|table/i);
  });

  it("maps worker 530-style text to MCP unavailable", () => {
    expect(publicToolErrorMessage(500, "Error 530: worker unavailable").message).toBe(
      "Business MCP unavailable",
    );
  });

  it("keeps short human permission reasons", () => {
    expect(
      publicToolErrorMessage(403, "Permission denied: knowledge.search").message,
    ).toBe("Permission denied: knowledge.search");
  });

  it("maps Outlook connector failures to safe reconnect or retry copy", () => {
    expect(publicToolErrorMessage(403, "Mail.Read (Application) admin consent").message).toBe(
      "Outlook needs reconnecting",
    );
    expect(publicToolErrorMessage(429, "OUTLOOK_RATE_LIMITED").message).toBe(
      "Microsoft temporarily rejected the request",
    );
    expect(publicToolErrorMessage(404, "Mailbox source not found").message).toBe(
      "Outlook mailbox is not available",
    );
  });
});

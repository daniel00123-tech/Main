import { describe, expect, it } from "vitest";
import {
  composeOutlookGetResult,
  composeOutlookListResult,
  composeOutlookMessage,
  mapOutlookGetArgs,
  unwrapOutlookMessage,
} from "./microsoft-outlook-company-mcp";

describe("company MCP Outlook get composition", () => {
  it("maps get arguments to id aliases used by company MCPs", () => {
    expect(mapOutlookGetArgs({ messageId: "AAMkAGI1" })).toMatchObject({
      messageId: "AAMkAGI1",
      id: "AAMkAGI1",
      emailId: "AAMkAGI1",
      query: "AAMkAGI1",
      documentRef: "AAMkAGI1",
    });
    expect(
      mapOutlookGetArgs({ id: "graph-id", internetMessageId: "<mid@elvex>" }),
    ).toMatchObject({
      messageId: "graph-id",
      id: "graph-id",
      internetMessageId: "<mid@elvex>",
    });
  });

  it("keeps attachment bytes from a company MCP get payload", () => {
    const composed = composeOutlookGetResult(
      {
        id: "AAMk-1",
        subject: "Fw: Your receipt from Anthropic, PBC #2275-0489-5290",
        hasAttachments: true,
        attachments: [
          {
            id: "att-1",
            name: "receipt.pdf",
            contentType: "application/pdf",
            size: 2048,
            contentBytes: "JVBERi0=",
          },
        ],
      },
      "finance@elvexpropertyservices.com",
    );
    expect(composed.hasAttachments).toBe(true);
    expect(composed.attachments).toEqual([
      expect.objectContaining({
        id: "att-1",
        name: "receipt.pdf",
        contentBytes: "JVBERi0=",
      }),
    ]);
  });

  it("unwraps a single EL get_elvex_email object that is not wrapped in messages[]", () => {
    const bare = unwrapOutlookMessage({
      id: "AAMk-1",
      subject: "Quote request",
      from: { emailAddress: { address: "client@example.com", name: "Client" } },
      body: { content: "Please quote the roof works.", contentType: "text" },
    });
    expect(bare?.id).toBe("AAMk-1");
    expect(composeOutlookGetResult(bare, "info@elvexpropertyservices.com")).toMatchObject({
      count: 1,
      id: "AAMk-1",
      subject: "Quote request",
      body: "Please quote the roof works.",
    });
  });

  it("treats a raw HTML string as the message body", () => {
    const composed = composeOutlookGetResult(
      "<html><body><p>Please quote the roof works.</p></body></html>",
      "info@elvexpropertyservices.com",
    );
    expect(composed.count).toBe(1);
    expect(String(composed.body)).toMatch(/roof works/i);
  });

  it("does not treat a missing get payload as an empty list success", () => {
    const empty = composeOutlookGetResult({ messages: [] }, "info@elvexpropertyservices.com");
    expect(empty.count).toBe(0);
    expect(empty.messages).toEqual([]);
  });

  it("normalises list rows so later get calls receive a stable id", () => {
    const listed = composeOutlookListResult(
      {
        messages: [
          {
            messageId: "AAMk-listed",
            subject: "Newest info mail",
            from: "Site <site@example.com>",
            bodyPreview: "Preview only",
          },
        ],
      },
      "info@elvexpropertyservices.com",
    );
    expect(listed.count).toBe(1);
    expect((listed.messages as Array<{ id: string }>)[0]?.id).toBe("AAMk-listed");
  });

  it("keeps Graph-native fields on composed messages", () => {
    const message = composeOutlookMessage({
      id: "graph-1",
      internetMessageId: "<rfc@id>",
      subject: "Invoice",
      bodyPreview: "Please see attached",
      receivedDateTime: "2026-09-01T10:00:00Z",
    });
    expect(message).toMatchObject({
      id: "graph-1",
      internetMessageId: "<rfc@id>",
      subject: "Invoice",
    });
  });

  it("passes attachment metadata through instead of dropping it", () => {
    const composed = composeOutlookGetResult(
      {
        id: "AAMk-att",
        subject: "Quote",
        hasAttachments: true,
        attachments: [{ id: "att-1", name: "quote.pdf", contentType: "application/pdf", isInline: false }],
      },
      "info@elvexpropertyservices.com",
    );
    expect(composed.hasAttachments).toBe(true);
    expect(composed.attachments).toEqual([
      { id: "att-1", name: "quote.pdf", contentType: "application/pdf", isInline: false },
    ]);
  });
});

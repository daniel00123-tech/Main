import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE } from "@infra/shared";

const store = vi.hoisted(() => ({
  listAutomationDefinitions: vi.fn(),
}));
const provision = vi.hoisted(() => ({
  provisionTemplateAutomation: vi.fn(),
}));

vi.mock("./store", () => store);
vi.mock("./provision-template", () => provision);

import {
  provisionElKnowledgeActivityAutomation,
  resolveExistingDocumentActivityRecipient,
} from "./provision-el-knowledge-activity";

describe("EL knowledge activity provision", () => {
  it("reuses the live Caddington document-activity recipient and does not invent one", async () => {
    store.listAutomationDefinitions.mockResolvedValueOnce([
      {
        id: "aut_docs",
        status: "active",
        configuration: {
          templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
          parameters: { recipientEmail: "ops@example.com" },
        },
      },
    ]);
    await expect(resolveExistingDocumentActivityRecipient({} as never)).resolves.toBe("ops@example.com");
  });

  it("provisions only co_el on the existing knowledge-ingestion template", async () => {
    store.listAutomationDefinitions.mockResolvedValueOnce([
      {
        id: "aut_docs",
        status: "active",
        configuration: {
          templateKey: DOCUMENT_ACTIVITY_DAILY_EMAIL_TEMPLATE,
          parameters: { recipientEmail: "ops@example.com" },
        },
      },
    ]);
    provision.provisionTemplateAutomation.mockResolvedValueOnce({ id: "aut_el" });
    await provisionElKnowledgeActivityAutomation({} as never);
    expect(provision.provisionTemplateAutomation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "co_el",
        templateKey: "knowledge_ingestion_daily_email",
        recipientEmail: "ops@example.com",
        name: "Daily EL knowledge activity",
        timezone: "Europe/London",
        hour: 8,
        minute: 0,
        frequency: "daily",
        activate: true,
      }),
    );
  });
});

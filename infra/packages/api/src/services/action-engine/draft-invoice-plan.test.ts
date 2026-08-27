import { describe, expect, it } from "vitest";
import {
  buildDraftInvoiceProposedState,
  buildDraftInvoiceReviewSummary,
  defaultDraftInvoiceDates,
  draftInvoicePayloadFromProposedState,
  normalizeDraftInvoicePlanInput,
} from "./draft-invoice-plan";
import type { ActionPlanRecord } from "@infra/shared";

describe("draft invoice plan pipeline", () => {
  const baseInput = normalizeDraftInvoicePlanInput({
    contactId: "cc7c104a-c059-43b1-8c6b-8b5750a5321b",
    contactName: "ELVEX PROPERTY SERVICES LTD",
    lineItems: [{ description: "test", quantity: 1, unitAmount: 1, accountCode: "200", taxType: "NONE" }],
    reference: "123",
    invoiceDate: "2026-08-25",
    dueDate: "2026-08-26",
    taxTreatment: "No VAT",
    taxType: "NONE",
    taxTypeLabel: "No VAT",
  });

  it("preserves dueDate, taxType, accountCode, reference, and DRAFT status in proposed state", () => {
    const proposed = buildDraftInvoiceProposedState(baseInput);
    expect(proposed.status).toBe("DRAFT");
    expect(proposed.invoiceDate).toBe("2026-08-25");
    expect(proposed.dueDate).toBe("2026-08-26");
    expect(proposed.reference).toBe("123");
    expect(proposed.lineItems[0]?.accountCode).toBe("200");
    expect(proposed.lineItems[0]?.taxType).toBe("NONE");
  });

  it("builds a complete review summary for ChatGPT", () => {
    const review = buildDraftInvoiceReviewSummary(buildDraftInvoiceProposedState(baseInput));
    expect(review.customer).toBe("ELVEX PROPERTY SERVICES LTD");
    expect(review.invoiceStatus).toBe("DRAFT");
    expect(review.invoiceDate).toBe("2026-08-25");
    expect(review.dueDate).toBe("2026-08-26");
    expect(review.reference).toBe("123");
    expect(review.accountCode).toBe("200");
    expect(review.taxType).toBe("NONE");
    expect(review.total).toBe(1);
  });

  it("defaults invoice date to today and due date to tomorrow", () => {
    const dates = defaultDraftInvoiceDates(new Date("2026-08-26T12:00:00.000Z"));
    expect(dates.invoiceDate).toBe("2026-08-26");
    expect(dates.dueDate).toBe("2026-08-27");
  });

  it("maps proposed state to executor payload unchanged", () => {
    const plan = {
      targets: [
        {
          targetId: baseInput.contactId,
          targetType: "draft_invoice",
          humanRef: baseInput.contactName,
          currentState: {},
          proposedState: buildDraftInvoiceProposedState(baseInput),
          validation: "valid",
        },
      ],
    } as unknown as ActionPlanRecord;
    const payload = draftInvoicePayloadFromProposedState(plan);
    expect(payload.dueDate).toBe("2026-08-26");
    expect(payload.date).toBe("2026-08-25");
    expect(payload.reference).toBe("123");
    expect(payload.lineItems[0]?.taxType).toBe("NONE");
    expect(payload.lineItems[0]?.accountCode).toBe("200");
  });
});

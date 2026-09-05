import { describe, expect, it } from "vitest";
import { runResponseQualityGuard } from "./response-guard.js";

describe("response quality guard", () => {
  it("repairs a success-reported-as-failure answer from Xero evidence", () => {
    const guarded = runResponseQualityGuard({
      text: "I couldn't reach Xero just now.",
      question: "What are our sales this month?",
      kind: "answer",
      toolCalls: [
        {
          name: "xero_sales_summary",
          ok: true,
          latencyMs: 20,
          data: { sales_total: 5094, invoice_count: 32, period: { fromDate: "2026-09-01", toDate: "2026-09-04" } },
        },
      ],
    });
    expect(guarded.repaired).toBe(true);
    expect(guarded.text).toMatch(/£5,094|5094/);
    expect(guarded.terminal).toBe("ANSWER");
    expect(guarded.checks.every((check) => check.ok || check.id === "tool_success_not_reported_as_failure" || check.id === "successful_result_not_discarded" || check.id === "not_generic_retry_after_success")).toBeTruthy();
  });

  it("repairs a blank or placeholder answer when knowledge evidence exists", () => {
    const guarded = runResponseQualityGuard({
      text: "...",
      question: "What can you tell me about the subcontractor CIS process?",
      kind: "answer",
      toolCalls: [
        {
          name: "search_company_knowledge",
          ok: true,
          latencyMs: 12,
          data: {
            results: [
              {
                title: "Subcontractor Payment Process",
                snippet: "Verify the subcontractor and apply the correct labour deduction before payment.",
              },
            ],
          },
        },
      ],
    });
    expect(guarded.repaired).toBe(true);
    expect(guarded.text).toMatch(/Subcontractor Payment Process|deduction/i);
    expect(guarded.text).not.toMatch(/^\.\.\.$/);
    expect(guarded.terminal).toBe("ANSWER");
  });

  it("does not show generic retry after a successful Outlook read", () => {
    const guarded = runResponseQualityGuard({
      text: "I need another moment to finish that. Try asking once more.",
      question: "latest email",
      kind: "failed",
      toolCalls: [
        {
          name: "outlook_list_messages",
          ok: true,
          latencyMs: 15,
          data: {
            mailboxAddress: "info@elvexpropertyservices.com",
            messages: [{ id: "m1", subject: "Leak detection", from: "ops@example.com", receivedDateTime: "2026-09-04" }],
          },
        },
      ],
    });
    expect(guarded.text).not.toMatch(/another moment/);
    expect(guarded.text).toMatch(/Leak detection/);
  });
});

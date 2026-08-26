import { describe, expect, it } from "vitest";
import { xeroDateToIsoDate } from "./xero-write-verification";

describe("xero date normalization for verification", () => {
  it("prefers DueDateString over /Date()/ DueDate", () => {
    expect(
      xeroDateToIsoDate(
        {
          DueDateString: "2026-08-26T00:00:00",
          DueDate: "/Date(1787702400000+0000)/",
        },
        "DueDate",
      ),
    ).toBe("2026-08-26");
  });
});

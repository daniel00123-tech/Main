import { describe, expect, it } from "vitest";
import { followGraphMailPages } from "./microsoft-outlook-graph";

describe("Graph mail pagination", () => {
  it("follows @odata.nextLink across more than 50 folder messages", async () => {
    const pageOne = Array.from({ length: 50 }, (_, index) => ({ id: `m${index + 1}` }));
    const pageTwo = Array.from({ length: 10 }, (_, index) => ({ id: `m${index + 51}` }));
    const calls: string[] = [];
    const result = await followGraphMailPages<{ id: string }>(
      async (path) => {
        calls.push(path);
        if (path === "/first") {
          return { value: pageOne, "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" };
        }
        return { value: pageTwo };
      },
      "/first",
      { maxPages: 8, maxItems: 400 },
    );
    expect(calls).toEqual(["/first", "https://graph.microsoft.com/v1.0/next"]);
    expect(result.items).toHaveLength(60);
    expect(result.pages).toBe(2);
    expect(result.nextLinkFollowed).toBe(true);
    expect(result.truncated).toBe(false);
  });
});

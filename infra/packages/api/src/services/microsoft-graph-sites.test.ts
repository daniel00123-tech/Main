import { describe, expect, it, vi } from "vitest";
import {
  hostnameFromSharePointUrl,
  listSites,
  readGraphAppTokenClaims,
} from "./microsoft-graph";

function jwtWithRoles(roles: string[], appid = "f8ec6a91-f043-4f63-8800-64135af48c4e"): string {
  const payload = Buffer.from(
    JSON.stringify({ appid, tid: "af32e619-3647-44a2-85d9-1c45457c0e91", roles }),
  ).toString("base64url");
  return `hdr.${payload}.sig`;
}

describe("SharePoint site discovery", () => {
  it("reads Graph app roles without exposing the token", () => {
    const claims = readGraphAppTokenClaims(
      jwtWithRoles(["Files.ReadWrite.All", "Sites.ReadWrite.All", "Sites.Selected"]),
    );
    expect(claims.appId).toBe("f8ec6a91-f043-4f63-8800-64135af48c4e");
    expect(claims.tenantId).toBe("af32e619-3647-44a2-85d9-1c45457c0e91");
    expect(claims.roles).toEqual(["Files.ReadWrite.All", "Sites.ReadWrite.All", "Sites.Selected"]);
    expect(JSON.stringify(claims)).not.toContain("hdr.");
  });

  it("ignores personal OneDrive hosts", () => {
    expect(hostnameFromSharePointUrl("https://elvex-my.sharepoint.com/personal/a/file.pdf")).toBeNull();
    expect(hostnameFromSharePointUrl("https://elvexpropertyservicesltd.sharepoint.com/Shared%20Documents")).toBe(
      "elvexpropertyservicesltd.sharepoint.com",
    );
  });

  it("keeps discovering after /sites search returns 403", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/sites?search=")) {
        return new Response(JSON.stringify({ error: { code: "accessDenied", message: "Access denied" } }), {
          status: 403,
        });
      }
      if (url.includes("/sites/root")) {
        return new Response(
          JSON.stringify({
            id: "site-root",
            name: "root",
            displayName: "EL Business",
            webUrl: "https://elvexpropertyservicesltd.sharepoint.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const sites = await listSites({ accessToken: "token", tenantId: "tid" }, "Elvex");
    expect(sites.map((site) => site.id)).toEqual(["site-root"]);
    vi.unstubAllGlobals();
  });

  it("resolves a hostname when search and root are denied", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("elvexpropertyservicesltd.sharepoint.com") && !url.includes("search=")) {
        return new Response(
          JSON.stringify({
            id: "site-host",
            name: "EL",
            displayName: "Elvex",
            webUrl: "https://elvexpropertyservicesltd.sharepoint.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: { code: "accessDenied" } }), { status: 403 });
    });
    const sites = await listSites({ accessToken: "token", tenantId: "tid" }, "Elvex", [
      "elvexpropertyservicesltd.sharepoint.com",
    ]);
    expect(sites[0]?.id).toBe("site-host");
    vi.unstubAllGlobals();
  });
});

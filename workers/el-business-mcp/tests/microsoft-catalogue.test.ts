import { describe, expect, it } from "vitest";
import { AccessPolicy } from "../src/microsoft/policy";
import { loadMicrosoftConfig } from "../src/microsoft/config";
import { isIndexableOwner } from "../src/microsoft/files";
import { buildGraphKeywordQuery, searchTokens } from "../src/microsoft/query-tokens";
import type { Env } from "../src/env";

function policy(): AccessPolicy {
  const access = new AccessPolicy(
    loadMicrosoftConfig({
      EL_BUSINESS_DATA: {} as D1Database,
      EL_MS_TENANT_ID: "t",
      EL_MS_CLIENT_ID: "c",
      EL_MS_CLIENT_SECRET: "s",
      EL_MS_PROTECTED_USERS: "William,Ella",
    } satisfies Env)!
  );
  access.registerProtected({
    id: "william-id",
    displayName: "William Stone",
    mail: "William@elvexpropertyservices.com",
    userPrincipalName: "William@elvexpropertyservices.com",
    givenName: "William",
    matchedHint: "William",
    driveId: "drive-william",
  });
  return access;
}

describe("catalogue deny-before-index", () => {
  it("rejects William drive and owner before a row can be stored as searchable", () => {
    const access = policy();
    expect(
      isIndexableOwner(
        access,
        { id: "william-id", displayName: "William Stone", mail: "William@elvexpropertyservices.com" },
        "drive-william"
      )
    ).toBe(false);
    expect(
      isIndexableOwner(
        access,
        { id: "megan-id", displayName: "Megan Freeman", mail: "Megan.Freeman@elvexpropertyservices.com" },
        "drive-megan"
      )
    ).toBe(true);
    expect(
      isIndexableOwner(
        access,
        { id: "megan-id", displayName: "Megan Freeman", mail: "Megan.Freeman@elvexpropertyservices.com" },
        "drive-megan",
        "https://elvexpropertyservicesltd-my.sharepoint.com/personal/william_elvexpropertyservices_com/Documents/x.docx"
      )
    ).toBe(false);
  });
});

describe("search tokenisation", () => {
  it("strips natural-language wrappers for practical file search", () => {
    expect(searchTokens("find documents about invoice")).toEqual(["invoice"]);
    expect(searchTokens("find the subcontractor agreement")).toEqual(["subcontractor", "agreement"]);
    expect(searchTokens("Health and Safety Policy (2).docx")).toEqual(["health", "safety", "policy", "docx"]);
    expect(buildGraphKeywordQuery("find documents about invoice")).toBe("isDocument:true AND (invoice)");
  });
});

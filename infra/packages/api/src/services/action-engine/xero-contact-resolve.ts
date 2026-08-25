import { xeroGetJson } from "@infra/xero-core";
import { XERO_AUTH } from "@infra/shared";

export type XeroContactRow = {
  ContactID?: string;
  Name?: string;
  ContactStatus?: string;
};

export type ResolvedXeroContact = {
  contactId: string;
  contactName: string;
};

export type ContactResolveResult =
  | { ok: true; contact: ResolvedXeroContact }
  | {
      ok: false;
      validation: "not_found" | "ambiguous" | "reference_required";
      validationDetail: string;
      candidates?: Array<{ contactId: string; contactName: string; matchScore: number }>;
    };

/** Score how well a user-provided name matches a Xero contact (higher is better). */
export function scoreContactNameMatch(query: string, contactName: string): number {
  const q = query.trim().toLowerCase();
  const name = contactName.trim().toLowerCase();
  if (!q || !name) return 0;
  if (name === q) return 100;
  if (name.startsWith(q)) return 92;
  const firstWord = name.split(/\s+/)[0] ?? "";
  if (firstWord === q) return 88;
  if (name.split(/\s+/).some((word) => word.startsWith(q))) return 78;
  if (name.includes(q)) return 65;
  return 0;
}

export function rankContactNameMatches(
  query: string,
  contacts: XeroContactRow[],
): Array<{ contact: XeroContactRow; score: number }> {
  return contacts
    .map((contact) => ({
      contact,
      score: scoreContactNameMatch(query, String(contact.Name ?? "")),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.contact.Name).localeCompare(String(b.contact.Name)));
}

export function pickContactFromRankedMatches(
  query: string,
  ranked: Array<{ contact: XeroContactRow; score: number }>,
): ContactResolveResult {
  if (ranked.length === 0) {
    return {
      ok: false,
      validation: "not_found",
      validationDetail: `No Xero contact matched "${query.trim()}". Try a fuller name or provide contactId.`,
    };
  }

  const [best, second] = ranked;
  const bestScore = best.score;
  const secondScore = second?.score ?? 0;
  const tiedAtTop =
    ranked.filter((row) => row.score === bestScore).length > 1 ||
    (second && bestScore - secondScore < 8 && secondScore >= 78);

  if (tiedAtTop) {
    const candidates = ranked
      .filter((row) => row.score >= Math.max(65, bestScore - 5))
      .slice(0, 5)
      .map((row) => ({
        contactId: String(row.contact.ContactID ?? ""),
        contactName: String(row.contact.Name ?? ""),
        matchScore: row.score,
      }));
    return {
      ok: false,
      validation: "ambiguous",
      validationDetail: `Multiple Xero contacts matched "${query.trim()}". Specify contactId or a more precise name.`,
      candidates,
    };
  }

  const contactId = String(best.contact.ContactID ?? "").trim();
  if (!contactId) {
    return {
      ok: false,
      validation: "not_found",
      validationDetail: "Matched contact is missing ContactID in Xero.",
    };
  }

  return {
    ok: true,
    contact: {
      contactId,
      contactName: String(best.contact.Name ?? query.trim()),
    },
  };
}

export async function resolveXeroContactForDraftInvoice(input: {
  accessToken: string;
  tenantId: string;
  contactId?: string;
  contactName?: string;
}): Promise<ContactResolveResult> {
  const contactId = input.contactId?.trim() ?? "";
  const contactName = input.contactName?.trim() ?? "";

  if (!contactId && !contactName) {
    return {
      ok: false,
      validation: "reference_required",
      validationDetail: "Provide contactId or contactName (e.g. \"Elvex\" for Elvex Property Services).",
    };
  }

  const token = {
    accessToken: input.accessToken,
    tenantId: input.tenantId,
    apiBaseUrl: XERO_AUTH.apiBaseUrl,
  };

  if (contactId) {
    const body = await xeroGetJson<{ Contacts?: XeroContactRow[] }>(
      token,
      `/Contacts/${contactId}`,
    );
    const contact = body.Contacts?.[0];
    if (!contact?.ContactID) {
      return {
        ok: false,
        validation: "not_found",
        validationDetail: "Contact not found in Xero.",
      };
    }
    return {
      ok: true,
      contact: {
        contactId: String(contact.ContactID),
        contactName: String(contact.Name ?? contactId),
      },
    };
  }

  const escaped = contactName.replace(/"/g, "");
  const body = await xeroGetJson<{ Contacts?: XeroContactRow[] }>(token, "/Contacts", {
    where: `Name.Contains("${escaped}")`,
  });
  const active = (body.Contacts ?? []).filter(
    (row) => String(row.ContactStatus ?? "ACTIVE").toUpperCase() !== "ARCHIVED",
  );
  return pickContactFromRankedMatches(contactName, rankContactNameMatches(contactName, active));
}

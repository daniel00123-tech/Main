import { XERO_AUTH } from "@infra/shared";
import type { Env } from "../../env";
import { getValidXeroAccessToken } from "../xero";
import { xeroGetJson } from "@infra/xero-core";

export type TestArtefactRow = {
  type: "ACCREC" | "ACCPAY" | "CREDIT_NOTE" | "CONTACT";
  invoiceNumber: string | null;
  reference: string | null;
  xeroId: string;
  amount: number | null;
  status: string | null;
  createdDate: string | null;
  contactName: string | null;
};

const ALLOWED_PREFIXES = ["INFRA-ALPHA-WRITE-", "INFRA-BETA-WRITE-", "INFRA-CMD10-UAT-"];

export async function searchXeroTestArtefacts(
  env: Env,
  input: {
    companyId: string;
    instanceId: string;
    actor: string;
    prefix?: string;
    limit?: number;
  },
): Promise<{ reportOnly: boolean; prefix: string; artefacts: TestArtefactRow[]; note: string }> {
  const prefix = input.prefix ?? "INFRA-";
  if (!ALLOWED_PREFIXES.some((p) => prefix.startsWith(p) || p.startsWith(prefix))) {
    return {
      reportOnly: true,
      prefix,
      artefacts: [],
      note: "Only INFRA test prefixes are searchable (INFRA-ALPHA-WRITE-, INFRA-BETA-WRITE-, INFRA-CMD10-UAT-).",
    };
  }

  const token = await getValidXeroAccessToken({
    env,
    companyId: input.companyId,
    instanceId: input.instanceId,
    actor: input.actor,
    reason: "test_artefact_search",
  });
  if (!token.ok) {
    return { reportOnly: true, prefix, artefacts: [], note: token.body.error };
  }

  const cfg = { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl };
  const limit = Math.min(input.limit ?? 50, 100);
  const artefacts: TestArtefactRow[] = [];

  const invoiceBody = await xeroGetJson<{ Invoices?: Array<Record<string, unknown>> }>(cfg, "/Invoices", {
    where: `Reference.Contains("${prefix.replace(/"/g, "")}")`,
    order: "UpdatedDateUTC DESC",
  });
  for (const inv of (invoiceBody.Invoices ?? []).slice(0, limit)) {
    const ref = inv.Reference ? String(inv.Reference) : null;
    if (!ref?.startsWith(prefix) && !ALLOWED_PREFIXES.some((p) => ref?.startsWith(p))) continue;
    artefacts.push({
      type: String(inv.Type ?? "") === "ACCPAY" ? "ACCPAY" : "ACCREC",
      invoiceNumber: inv.InvoiceNumber ? String(inv.InvoiceNumber) : null,
      reference: ref,
      xeroId: String(inv.InvoiceID ?? ""),
      amount: inv.Total != null ? Number(inv.Total) : null,
      status: inv.Status ? String(inv.Status) : null,
      createdDate: inv.DateString ? String(inv.DateString).slice(0, 10) : null,
      contactName: (inv.Contact as { Name?: string } | undefined)?.Name ?? null,
    });
  }

  const cnBody = await xeroGetJson<{ CreditNotes?: Array<Record<string, unknown>> }>(cfg, "/CreditNotes", {
    where: `Reference.Contains("${prefix.replace(/"/g, "")}")`,
    order: "UpdatedDateUTC DESC",
  });
  for (const cn of (cnBody.CreditNotes ?? []).slice(0, limit)) {
    const ref = cn.Reference ? String(cn.Reference) : null;
    if (!ref?.startsWith(prefix) && !ALLOWED_PREFIXES.some((p) => ref?.startsWith(p))) continue;
    artefacts.push({
      type: "CREDIT_NOTE",
      invoiceNumber: cn.CreditNoteNumber ? String(cn.CreditNoteNumber) : null,
      reference: ref,
      xeroId: String(cn.CreditNoteID ?? ""),
      amount: cn.Total != null ? Number(cn.Total) : null,
      status: cn.Status ? String(cn.Status) : null,
      createdDate: cn.DateString ? String(cn.DateString).slice(0, 10) : null,
      contactName: (cn.Contact as { Name?: string } | undefined)?.Name ?? null,
    });
  }

  return {
    reportOnly: true,
    prefix,
    artefacts: artefacts.slice(0, limit),
    note: "Report only — no records deleted. Use operator-confirmed cleanup action for DRAFT test records.",
  };
}

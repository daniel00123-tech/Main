/**
 * Safe test-artefact cleanup — DRAFT only, INFRA prefix enforced server-side.
 */

import type { ActionTarget, FinancialImpact } from "@infra/shared";
import type { Env } from "../../env";
import { XERO_AUTH } from "@infra/shared";
import { xeroGetJson } from "@infra/xero-core";
import { getValidXeroAccessToken } from "../xero";
import {
  INFRA_TEST_ARTEFACT_PREFIXES,
  isAllowedInfraTestPrefix,
  recommendedCleanupAction,
  type TestArtefactRow,
} from "./xero-test-artefacts";

export type CleanupPreview = {
  eligible: boolean;
  artefact: TestArtefactRow;
  recommendedAction: ReturnType<typeof recommendedCleanupAction>;
  reason: string | null;
};

export async function previewTestArtefactCleanup(
  env: Env,
  input: {
    companyId: string;
    instanceId: string;
    actor: string;
    xeroId: string;
    reference: string;
    documentType: "ACCREC" | "ACCPAY" | "CREDIT_NOTE";
  },
): Promise<CleanupPreview> {
  if (!isAllowedInfraTestPrefix(input.reference)) {
    return {
      eligible: false,
      artefact: {
        type: input.documentType,
        invoiceNumber: null,
        reference: input.reference,
        xeroId: input.xeroId,
        amount: null,
        status: null,
        createdDate: null,
        contactName: null,
      },
      recommendedAction: "report_only",
      reason: `Reference must begin with an approved INFRA test prefix: ${INFRA_TEST_ARTEFACT_PREFIXES.join(", ")}`,
    };
  }

  const token = await getValidXeroAccessToken({
    env,
    companyId: input.companyId,
    instanceId: input.instanceId,
    actor: input.actor,
    reason: "cleanup_preview",
  });
  if (!token.ok) {
    return {
      eligible: false,
      artefact: {
        type: input.documentType,
        invoiceNumber: null,
        reference: input.reference,
        xeroId: input.xeroId,
        amount: null,
        status: null,
        createdDate: null,
        contactName: null,
      },
      recommendedAction: "report_only",
      reason: token.body.error,
    };
  }

  const cfg = { accessToken: token.accessToken, tenantId: token.tenantId, apiBaseUrl: XERO_AUTH.apiBaseUrl };
  let status: string | null = null;
  let invoiceNumber: string | null = null;
  let amount: number | null = null;

  if (input.documentType === "CREDIT_NOTE") {
    const body = await xeroGetJson<{ CreditNotes?: Array<Record<string, unknown>> }>(
      cfg,
      `/CreditNotes/${input.xeroId}`,
    );
    const cn = body.CreditNotes?.[0];
    status = cn?.Status ? String(cn.Status) : null;
    invoiceNumber = cn?.CreditNoteNumber ? String(cn.CreditNoteNumber) : null;
    amount = cn?.Total != null ? Number(cn.Total) : null;
  } else {
    const body = await xeroGetJson<{ Invoices?: Array<Record<string, unknown>> }>(
      cfg,
      `/Invoices/${input.xeroId}`,
    );
    const inv = body.Invoices?.[0];
    status = inv?.Status ? String(inv.Status) : null;
    invoiceNumber = inv?.InvoiceNumber ? String(inv.InvoiceNumber) : null;
    amount = inv?.Total != null ? Number(inv.Total) : null;
  }

  const artefact: TestArtefactRow = {
    type: input.documentType,
    invoiceNumber,
    reference: input.reference,
    xeroId: input.xeroId,
    amount,
    status,
    createdDate: null,
    contactName: null,
    recommendedCleanup: recommendedCleanupAction({
      type: input.documentType,
      invoiceNumber,
      reference: input.reference,
      xeroId: input.xeroId,
      amount,
      status,
      createdDate: null,
      contactName: null,
    }),
  };

  const rec = artefact.recommendedCleanup ?? "report_only";
  if (rec !== "delete_draft") {
    return {
      eligible: false,
      artefact,
      recommendedAction: rec,
      reason:
        rec === "void_authorised"
          ? "AUTHORISED documents must use controlled void action, not DRAFT deletion."
          : `Document status ${status ?? "unknown"} is not eligible for DRAFT deletion.`,
    };
  }

  return { eligible: true, artefact, recommendedAction: "delete_draft", reason: null };
}

export async function planXeroDeleteTestDraft(input: {
  env: Env;
  companyId: string;
  instanceId: string;
  actor: string;
  xeroId: string;
  reference: string;
  documentType: "ACCREC" | "ACCPAY" | "CREDIT_NOTE";
}): Promise<{ targets: ActionTarget[]; summary: string; financialImpact: FinancialImpact; review: Record<string, unknown> }> {
  const preview = await previewTestArtefactCleanup(input.env, input);

  if (!preview.eligible) {
    return {
      targets: [{
        targetId: input.xeroId,
        targetType: "test_artefact_cleanup",
        humanRef: input.reference,
        currentState: { status: preview.artefact.status, reference: input.reference },
        proposedState: { action: "delete_draft", blocked: true, reason: preview.reason },
        validation: "invalid",
        validationDetail: preview.reason,
      }],
      summary: `Cleanup blocked: ${preview.reason}`,
      financialImpact: { currencyCode: null, totalAmount: null, direction: "neutral", itemCount: 0 },
      review: { blocked: true, reason: preview.reason, prefixes: INFRA_TEST_ARTEFACT_PREFIXES },
    };
  }

  return {
    targets: [{
      targetId: input.xeroId,
      targetType: "test_artefact_cleanup",
      humanRef: input.reference,
      currentState: {
        status: preview.artefact.status,
        reference: input.reference,
        documentType: input.documentType,
        amount: preview.artefact.amount,
      },
      proposedState: {
        action: "delete_draft",
        xeroId: input.xeroId,
        reference: input.reference,
        documentType: input.documentType,
        resultingStatus: "DELETED",
      },
      amount: preview.artefact.amount,
      validation: "valid",
    }],
    summary: `Delete DRAFT test artefact ${input.reference} (${preview.artefact.invoiceNumber ?? input.xeroId}). Operator confirmation required.`,
    financialImpact: {
      currencyCode: "GBP",
      totalAmount: preview.artefact.amount,
      direction: "neutral",
      itemCount: 1,
    },
    review: {
      documentKind: "TEST ARTEFACT CLEANUP",
      warning: "This permanently removes a DRAFT test record from Xero. Only INFRA-prefixed DRAFT artefacts are eligible.",
      reference: input.reference,
      currentStatus: preview.artefact.status,
      resultingStatus: "DELETED",
    },
  };
}

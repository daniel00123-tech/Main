import type { ActionPlanRecord } from "@infra/shared";
import type { Env } from "../../env";
import { listMcpEnvironments } from "../control-plane";
import { mcpRequest } from "../mcp-client";
import { getValidXeroAccessToken } from "../xero";
import { XERO_AUTH } from "@infra/shared";
import {
  extractInvoiceIdFromMcpResult,
  extractInvoiceNumberFromMcpResult,
} from "./xero-write-verification";

import {
  draftInvoicePayloadFromProposedState,
} from "./draft-invoice-plan";

export type CompanyMcpWriteResult =
  | { ok: true; result: Record<string, unknown>; invoiceId: string | null; invoiceNumber: string | null; resourceId?: string | null; humanReference?: string | null }
  | { ok: false; code: string; message: string; httpStatus?: number };

function extractResourceMeta(parsed: Record<string, unknown>): {
  resourceId: string | null;
  humanReference: string | null;
} {
  const invoice = parsed.invoice as Record<string, unknown> | undefined;
  const bill = parsed.bill as Record<string, unknown> | undefined;
  const creditNote = parsed.creditNote as Record<string, unknown> | undefined;
  const contact = parsed.contact as Record<string, unknown> | undefined;
  if (invoice?.InvoiceID) {
    return { resourceId: String(invoice.InvoiceID), humanReference: invoice.InvoiceNumber ? String(invoice.InvoiceNumber) : null };
  }
  if (bill?.InvoiceID) {
    return { resourceId: String(bill.InvoiceID), humanReference: bill.InvoiceNumber ? String(bill.InvoiceNumber) : null };
  }
  if (creditNote?.CreditNoteID) {
    return { resourceId: String(creditNote.CreditNoteID), humanReference: creditNote.CreditNoteNumber ? String(creditNote.CreditNoteNumber) : null };
  }
  if (contact?.ContactID) {
    return { resourceId: String(contact.ContactID), humanReference: contact.Name ? String(contact.Name) : null };
  }
  return {
    resourceId: extractInvoiceIdFromMcpResult(parsed),
    humanReference: extractInvoiceNumberFromMcpResult(parsed),
  };
}

export async function executeXeroMcpTool(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    executionId: string;
    actor: string;
    toolName: string;
    arguments: Record<string, unknown>;
  },
): Promise<CompanyMcpWriteResult> {
  const mcps = await listMcpEnvironments(env.DB, input.plan.companyId);
  const mcpEnv = mcps.find((row) => row.enabled) ?? null;
  if (!mcpEnv) {
    return { ok: false, code: "MCP_NOT_FOUND", message: "No enabled Company MCP for this tenant." };
  }
  if (!input.plan.connectorInstanceId) {
    return { ok: false, code: "CONNECTOR_MISSING", message: "Plan has no connector instance." };
  }

  const token = await getValidXeroAccessToken({
    env,
    companyId: input.plan.companyId,
    instanceId: input.plan.connectorInstanceId,
    actor: input.actor,
    reason: "action_execute",
  });
  if (!token.ok) {
    return { ok: false, code: "XERO_AUTH_FAILED", message: token.body.error };
  }

  const xeroContextHeader = btoa(
    JSON.stringify({
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      apiBaseUrl: XERO_AUTH.apiBaseUrl,
      instanceId: input.plan.connectorInstanceId,
      organisationName: token.payload.organisationName ?? null,
    }),
  );

  const response = await mcpRequest(env, {
    endpointUrl: mcpEnv.endpointUrl,
    authSecretRef: mcpEnv.authSecretRef,
    serviceBindingRef: mcpEnv.serviceBindingRef,
    method: "tools/call",
    params: { name: input.toolName, arguments: input.arguments },
    internalHeaders: {
      "X-Infra-Xero-Context": xeroContextHeader,
      "X-Infra-Action-Plan-Id": input.plan.id,
      "X-Infra-Action-Execution-Id": input.executionId,
    },
  });

  if (response.payload.error) {
    return {
      ok: false,
      code: "MCP_TOOL_ERROR",
      message: response.payload.error.message ?? "Company MCP write failed.",
      httpStatus: response.httpStatus,
    };
  }

  const resultBody = response.payload.result as
    | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    | undefined;

  let parsed: Record<string, unknown> = {};
  const text = resultBody?.content?.find((part) => part.type === "text")?.text;
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }
  }

  if (resultBody?.isError || parsed.error) {
    return {
      ok: false,
      code: String(parsed.code ?? "XERO_WRITE_FAILED"),
      message: String(parsed.error ?? "Xero write returned an error."),
    };
  }

  const meta = extractResourceMeta(parsed);
  return {
    ok: true,
    result: parsed,
    invoiceId: meta.resourceId,
    invoiceNumber: meta.humanReference,
    resourceId: meta.resourceId,
    humanReference: meta.humanReference,
  };
}

function draftInvoicePayloadFromPlan(plan: ActionPlanRecord) {
  return draftInvoicePayloadFromProposedState(plan);
}

export async function executeXeroDraftInvoiceViaCompanyMcp(
  env: Env,
  input: {
    plan: ActionPlanRecord;
    executionId: string;
    actor: string;
  },
): Promise<CompanyMcpWriteResult> {
  return executeXeroMcpTool(env, {
    ...input,
    toolName: "xero_create_draft_invoice",
    arguments: draftInvoicePayloadFromPlan(input.plan),
  });
}

export { draftInvoicePayloadFromPlan };

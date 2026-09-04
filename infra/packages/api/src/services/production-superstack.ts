/**
 * Module-level production superstack assertions.
 * A standalone feature branch that dropped a critical surface fails these imports/checks.
 */

import { classifyUsageOutcome, elvexCan, resolveBusinessSystemIntent } from "@infra/shared";
import { sendPortalChatMessage } from "./portal-chat";
import { handleInfraMcpJsonRpc } from "./mcp-gateway";
import { withXeroReadTools } from "./xero-read-tools";
import { withOutlookReadTools } from "./microsoft-outlook-tools";
import { executeOutlookReadTool } from "./microsoft-outlook-read";
import { PRODUCTION_SUPERSTACK_CAPABILITIES, readGeneratedLineage } from "./production-lineage";

export { PRODUCTION_SUPERSTACK_CAPABILITIES };

const EL = { connectors: [{ definitionId: "conn_xero" }, { definitionId: "conn_outlook_shared" }] };

export function assertProductionSuperstackCapabilities(): {
  ok: true;
  capabilities: readonly string[];
} {
  if (typeof sendPortalChatMessage !== "function") {
    throw new Error("portal_chat_api missing");
  }
  if (typeof handleInfraMcpJsonRpc !== "function") {
    throw new Error("mcp_gateway missing");
  }
  if (typeof executeOutlookReadTool !== "function") {
    throw new Error("outlook_read_path missing");
  }
  if (typeof withXeroReadTools !== "function" || typeof withOutlookReadTools !== "function") {
    throw new Error("xero_read_injection or outlook tools missing");
  }
  if (elvexCan("office_staff", "xero.sales.read")) {
    throw new Error("rbac: office_staff must not have xero.sales.read");
  }
  if (!elvexCan("director", "xero.sales.read")) {
    throw new Error("rbac: director must have xero.sales.read");
  }
  if (resolveBusinessSystemIntent("Search emails", EL)?.capability !== "info_mailbox") {
    throw new Error("WhatsApp/shared routing: email must not fall through to Xero");
  }
  if (resolveBusinessSystemIntent("What is the PO process?", EL) !== null) {
    throw new Error("WhatsApp/shared routing: PO process must stay on knowledge");
  }
  if (resolveBusinessSystemIntent("Tell me Xero sales this month.", EL)?.capability !== "xero") {
    throw new Error("Xero business routing missing");
  }
  if (
    resolveBusinessSystemIntent("What is the newest email in the finance inbox?", EL)?.capability !==
    "finance_mailbox"
  ) {
    throw new Error("finance inbox must stay on Outlook, not Xero");
  }
  const denied = classifyUsageOutcome({
    success: 0,
    settlementStatus: "denied",
    metadata: { denied: true, result: "permission_denied" },
  });
  if (!denied.expectedDenial || denied.operationalFailure) {
    throw new Error("usage recording classifier must treat RBAC denials as expected");
  }
  if (PRODUCTION_SUPERSTACK_CAPABILITIES.length < 9) {
    throw new Error("capability marker list incomplete");
  }
  readGeneratedLineage();
  return { ok: true, capabilities: PRODUCTION_SUPERSTACK_CAPABILITIES };
}

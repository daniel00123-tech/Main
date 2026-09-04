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
import { resolveBrainPolicy } from "./intelligence/brain-policy";
import { authorizeToolCall, buildAllowedToolCatalogue } from "./intelligence/tool-auth";
import { looksLikePublicWebAsk } from "./intelligence/web-search";
import { ENGINEERING_SUPERVISOR_CONTRACT } from "./intelligence/dev-failure-queue";
import { buildTenantToolCatalogue, normaliseVendorToolName } from "./intelligence/company-tool-registry";
import { isolateEvidenceForCompany } from "./intelligence/tenant-isolation";
import { classifyTurnFailures } from "./intelligence/failure-telemetry";
import { inspectIntelligenceProvider } from "./intelligence/provider";
import { resolveRequestPricingPolicy } from "./customer-request-pricing";
import { DAILY_IMPROVEMENT_CONTRACT } from "./daily-improvement/constants";
import { ingestApprovedOutlookAttachments } from "./outlook-attachment-ingest";
import { discoverKnowledgeIntakeTarget, isKnowledgeIntakePath } from "./knowledge-intake";

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
  const brain = resolveBrainPolicy({ companyId: "co_caddington" });
  if (brain.useOpenAi) {
    throw new Error("openai brain must not activate for non-EL tenants by default");
  }
  const shadowEnv = {
    OPENAI_API_KEY: "sk-test-key-1234567890abcdef",
    OPENAI_BRAIN_ENABLED: "true",
    OPENAI_BRAIN_MODE: "openai_shadow",
    OPENAI_BRAIN_COMPANY_IDS: "co_el",
  };
  const shadow = resolveBrainPolicy({
    env: shadowEnv,
    companyId: "co_el",
  });
  if (shadow.useOpenAi) {
    throw new Error("unscoped openai_shadow must keep Cloudflare as the user-visible brain");
  }
  if (!shadow.shadow) {
    throw new Error("openai_shadow must evaluate OpenAI in parallel");
  }
  const pa = resolveBrainPolicy({ env: shadowEnv, companyId: "co_el", channel: "portal_chat" });
  if (!pa.useOpenAi || pa.userVisibleBrain !== "openai" || pa.role !== "pa") {
    throw new Error("EL Portal Chat PA must use OpenAI as the user-visible brain");
  }
  const request = resolveBrainPolicy({ env: shadowEnv, companyId: "co_el", channel: "whatsapp" });
  if (!request.useOpenAi || request.userVisibleBrain !== "openai" || request.role !== "request") {
    throw new Error("EL WhatsApp requests must use OpenAI as the user-visible brain");
  }
  const chatbot = resolveBrainPolicy({ env: shadowEnv, companyId: "co_el", channel: "chatgpt" });
  if (chatbot.useOpenAi || chatbot.reason !== "chatgpt_stays_direct_tools") {
    throw new Error("ChatGPT must stay on direct INFRA tools, not the hosted OpenAI brain");
  }
  const officeTools = buildAllowedToolCatalogue({
    role: "office_staff",
    companyId: "co_el",
    connectors: ["conn_xero", "conn_outlook_shared"],
  });
  if (officeTools.some((name) => name.startsWith("xero_"))) {
    throw new Error("preauth catalogue must not offer Xero to office_staff");
  }
  const toolDenied = authorizeToolCall(
    {
      role: "office_staff",
      companyId: "co_el",
      connectors: ["conn_xero", "conn_outlook_shared"],
      permittedTools: officeTools,
    },
    { name: "xero_sales_summary", arguments: {} },
  );
  if (toolDenied.allowed) {
    throw new Error("second RBAC check must deny office_staff Xero");
  }
  if (!looksLikePublicWebAsk("what's the weather in London")) {
    throw new Error("public web weather must not route to company MCP");
  }
  if (ENGINEERING_SUPERVISOR_CONTRACT.cursorInCustomerPath) {
    throw new Error("Cursor must not sit in the customer turn");
  }
  if (ENGINEERING_SUPERVISOR_CONTRACT.autoDeployFromSingleFailure) {
    throw new Error("must not auto-deploy from a single customer failure");
  }
  const ht = buildTenantToolCatalogue({ companyId: "co_ht", connectors: [], role: "office_staff" });
  if (ht.tools.some((name) => name.startsWith("xero_") || name.startsWith("outlook_"))) {
    throw new Error("HT catalogue must not advertise disconnected EL systems");
  }
  if (normaliseVendorToolName("analyse_xero_sales") !== "xero_sales_summary") {
    throw new Error("vendor MCP aliases must normalise to INFRA tools");
  }
  const leaked = isolateEvidenceForCompany(
    { companyId: "co_el", recentXero: { toolName: "xero_sales_summary", total: 1, count: 1, fromDate: null, toDate: null, currency: "GBP", summary: "x", label: "x" } },
    "co_caddington",
  );
  if (leaked.recentXero) {
    throw new Error("cross-tenant evidence must be stripped");
  }
  if (typeof classifyTurnFailures !== "function") {
    throw new Error("failure telemetry missing");
  }
  if (inspectIntelligenceProvider({}).provider === "openai") {
    throw new Error("Cloudflare/Workers AI must remain the default fallback provider");
  }
  if (resolveRequestPricingPolicy("co_caddington") || resolveRequestPricingPolicy("co_ht")) {
    throw new Error("must not apply EL request pricing to Caddington or HT");
  }
  if (resolveRequestPricingPolicy("co_el")?.chargeCents !== 3) {
    throw new Error("EL request-level pricing must remain 3p");
  }
  if (DAILY_IMPROVEMENT_CONTRACT.cursorInCustomerPath) {
    throw new Error("daily improvement must not put Cursor on the customer path");
  }
  if (DAILY_IMPROVEMENT_CONTRACT.requiresHumanApproval) {
    throw new Error("daily improvement must not wait for a human approval button");
  }
  if (DAILY_IMPROVEMENT_CONTRACT.autoPromoteProvider) {
    throw new Error("daily improvement must not auto-promote OpenAI shadow/canary/primary");
  }
  if (DAILY_IMPROVEMENT_CONTRACT.qaCustomerChargeCents !== 0) {
    throw new Error("QA/engineering must not customer-bill");
  }
  if (DAILY_IMPROVEMENT_CONTRACT.elCustomerRequestCents !== 3) {
    throw new Error("daily improvement must not infer a new EL price");
  }
  if (typeof ingestApprovedOutlookAttachments !== "function") {
    throw new Error("outlook attachment ingest missing");
  }
  if (typeof discoverKnowledgeIntakeTarget !== "function" || !isKnowledgeIntakePath("INFRA Knowledge Intake/Email Attachments")) {
    throw new Error("knowledge intake landing zone missing");
  }
  readGeneratedLineage();
  return { ok: true, capabilities: PRODUCTION_SUPERSTACK_CAPABILITIES };
}

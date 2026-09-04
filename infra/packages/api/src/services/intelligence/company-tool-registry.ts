/**
 * Tenant-aware INFRA tool registry.
 * Reasoning sees only tools that are registered, connected, and role-safe
 * for the current company. Other tenants' connectors never leak in.
 */

import { INTELLIGENCE_TOOLS, permittedToolsForConnectors, toolFamilyOf } from "./catalogue.js";
import { authorizeToolCall, buildAllowedToolCatalogue } from "./tool-auth.js";
import type { IntelligenceToolSpec } from "./types.js";

export type PlatformCapability =
  | "EMAIL_SEARCH"
  | "EMAIL_LIST"
  | "EMAIL_READ"
  | "ACCOUNTING_SALES"
  | "ACCOUNTING_INVOICE_SEARCH"
  | "ACCOUNTING_INVOICE_GET"
  | "ACCOUNTING_CONTACTS"
  | "ACCOUNTING_REPORTS"
  | "KNOWLEDGE_SEARCH"
  | "KNOWLEDGE_READ"
  | "CATALOGUE_LIST"
  | "JOB_SEARCH"
  | "CRM_SEARCH"
  | "TICKET_SEARCH"
  | "WEB_PUBLIC"
  | "SYSTEM_META";

export type ToolReadWrite = "read" | "write";

export type StandardToolContract = IntelligenceToolSpec & {
  capability: PlatformCapability;
  companyScope: "tenant";
  requiredPermission: string;
  readWrite: ToolReadWrite;
  billingAction: string;
  timeoutMs: number;
  idempotent: boolean;
};

/** Vendor MCP names → stable INFRA tool names. */
export const VENDOR_TOOL_ALIASES: Record<string, string> = {
  analyse_xero_sales: "xero_sales_summary",
  analyze_xero_sales: "xero_sales_summary",
  get_xero_sales: "xero_sales_summary",
  search_emails: "outlook_search_mailbox",
  search_mailbox: "outlook_search_mailbox",
  list_emails: "outlook_list_messages",
  list_mailbox: "outlook_list_messages",
  get_email: "outlook_get_message",
  get_message: "outlook_get_message",
  search_knowledge: "search_company_knowledge",
  list_files: "list_documents",
  list_recent_files: "list_documents",
};

const CONNECTOR_CAPABILITIES: Record<string, PlatformCapability[]> = {
  conn_xero: [
    "ACCOUNTING_SALES",
    "ACCOUNTING_INVOICE_SEARCH",
    "ACCOUNTING_INVOICE_GET",
    "ACCOUNTING_CONTACTS",
    "ACCOUNTING_REPORTS",
  ],
  conn_outlook_shared: ["EMAIL_SEARCH", "EMAIL_LIST", "EMAIL_READ"],
  conn_microsoft: ["EMAIL_SEARCH", "EMAIL_LIST", "EMAIL_READ", "CATALOGUE_LIST", "KNOWLEDGE_SEARCH"],
  conn_sharepoint: ["CATALOGUE_LIST", "KNOWLEDGE_SEARCH", "KNOWLEDGE_READ"],
  conn_onedrive: ["CATALOGUE_LIST", "KNOWLEDGE_SEARCH", "KNOWLEDGE_READ"],
  conn_google_drive: ["CATALOGUE_LIST", "KNOWLEDGE_SEARCH", "KNOWLEDGE_READ"],
  conn_bigchange: ["JOB_SEARCH"],
  conn_commusoft: ["JOB_SEARCH"],
  conn_freshdesk: ["TICKET_SEARCH"],
};

const TOOL_CAPABILITY: Record<string, PlatformCapability> = {
  outlook_search_mailbox: "EMAIL_SEARCH",
  outlook_list_messages: "EMAIL_LIST",
  outlook_get_message: "EMAIL_READ",
  xero_sales_summary: "ACCOUNTING_SALES",
  xero_top_customers: "ACCOUNTING_SALES",
  xero_list_overdue_invoices: "ACCOUNTING_INVOICE_SEARCH",
  xero_search_invoices: "ACCOUNTING_INVOICE_SEARCH",
  xero_get_invoice: "ACCOUNTING_INVOICE_GET",
  xero_search_contacts: "ACCOUNTING_CONTACTS",
  xero_list_contacts: "ACCOUNTING_CONTACTS",
  xero_get_contact: "ACCOUNTING_CONTACTS",
  xero_profit_and_loss: "ACCOUNTING_REPORTS",
  xero_aged_receivables: "ACCOUNTING_REPORTS",
  xero_balance_sheet: "ACCOUNTING_REPORTS",
  xero_get_organisation: "ACCOUNTING_REPORTS",
  search_company_knowledge: "KNOWLEDGE_SEARCH",
  search: "KNOWLEDGE_SEARCH",
  search_document: "KNOWLEDGE_READ",
  get_knowledge_document: "KNOWLEDGE_READ",
  fetch: "KNOWLEDGE_READ",
  list_documents: "CATALOGUE_LIST",
  get_document_index_stats: "CATALOGUE_LIST",
  get_recent_sync_status: "CATALOGUE_LIST",
  web_search: "WEB_PUBLIC",
  database_summary: "SYSTEM_META",
  system_health: "SYSTEM_META",
  get_company_system_summary: "SYSTEM_META",
  get_connector_status: "SYSTEM_META",
  get_active_automations: "SYSTEM_META",
  get_user_capabilities: "SYSTEM_META",
};

const ALWAYS_ON: PlatformCapability[] = ["KNOWLEDGE_SEARCH", "KNOWLEDGE_READ", "CATALOGUE_LIST", "WEB_PUBLIC", "SYSTEM_META"];

export function normaliseVendorToolName(name: string): string {
  const raw = String(name ?? "").trim();
  return VENDOR_TOOL_ALIASES[raw] ?? raw;
}

export function capabilityForPlatformTool(name: string): PlatformCapability | null {
  return TOOL_CAPABILITY[normaliseVendorToolName(name)] ?? null;
}

export function capabilitiesForConnectors(connectors: string[]): Set<PlatformCapability> {
  const out = new Set<PlatformCapability>(ALWAYS_ON);
  for (const connector of connectors) {
    for (const capability of CONNECTOR_CAPABILITIES[connector] ?? []) out.add(capability);
    if (/outlook|mailbox/i.test(connector)) {
      out.add("EMAIL_SEARCH");
      out.add("EMAIL_LIST");
      out.add("EMAIL_READ");
    }
    if (/xero|accounting/i.test(connector)) {
      out.add("ACCOUNTING_SALES");
      out.add("ACCOUNTING_INVOICE_SEARCH");
      out.add("ACCOUNTING_INVOICE_GET");
    }
  }
  return out;
}

export function toStandardToolContract(tool: IntelligenceToolSpec): StandardToolContract {
  const capability = capabilityForPlatformTool(tool.name) ?? "SYSTEM_META";
  const write = /^(xero_(create|update|approve|send|void|allocate)|outlook_(send|draft|create|reply))/i.test(tool.name);
  return {
    ...tool,
    capability,
    companyScope: "tenant",
    requiredPermission: tool.permission,
    readWrite: write ? "write" : "read",
    billingAction: write ? "tool.write" : "tool.read",
    timeoutMs: tool.live ? 12_000 : 8_000,
    idempotent: !write,
  };
}

export function standardToolContracts(): StandardToolContract[] {
  return INTELLIGENCE_TOOLS.map(toStandardToolContract);
}

export function capabilityFamily(capability: PlatformCapability): string {
  if (capability.startsWith("EMAIL_")) return "EMAIL";
  if (capability.startsWith("ACCOUNTING_")) return "ACCOUNTING";
  if (capability.startsWith("KNOWLEDGE_")) return "KNOWLEDGE";
  if (capability === "CATALOGUE_LIST") return "CATALOGUE";
  if (capability === "WEB_PUBLIC") return "WEB";
  if (capability === "JOB_SEARCH" || capability === "CRM_SEARCH" || capability === "TICKET_SEARCH") return "CRM";
  return "SYSTEM";
}

export function wantsMultiCapabilityRead(text: string): boolean {
  const families = new Set(detectRequestedCapabilities(text).map(capabilityFamily));
  families.delete("SYSTEM");
  families.delete("WEB");
  return families.size >= 2 && /\b(and|then|also|plus)\b/i.test(text);
}

export function detectRequestedCapabilities(text: string): PlatformCapability[] {
  const value = String(text ?? "");
  const found = new Set<PlatformCapability>();
  const email =
    /\b(emails?|inbox|mailbox|outlook|unread mail)\b/i.test(value) ||
    /\b(newest|latest|recent).{0,20}(emails?|mail|inbox|mailbox)\b/i.test(value);
  const accounting =
    /\b(xero|sales|revenue|invoic|overdue|p&l|pnl|profit|aged (receivable|payable)|top customers?)\b/i.test(value);
  const catalogue =
    /\b(newest|latest|recent).{0,24}(file|document|onedrive|sharepoint)\b/i.test(value) ||
    /\b(list|show).{0,16}(files|documents)\b/i.test(value) ||
    /\bhow many (files|documents) are indexed\b/i.test(value);
  const knowledge =
    /\b(process|procedure|policy|how do we|company knowledge|onboarding|health and safety)\b/i.test(value) &&
    !catalogue;
  const web = /\b(weather|forecast|public holiday|news headline)\b/i.test(value);
  if (email) found.add(/\b(search|from|containing|about|look in)\b/i.test(value) ? "EMAIL_SEARCH" : "EMAIL_LIST");
  if (accounting && /\b(INV-|invoice (id|number)|find invoice)\b/i.test(value)) found.add("ACCOUNTING_INVOICE_GET");
  else if (accounting && /\b(overdue|search invoices|invoices with|po reference)\b/i.test(value)) {
    found.add("ACCOUNTING_INVOICE_SEARCH");
  } else if (accounting) found.add("ACCOUNTING_SALES");
  if (catalogue) found.add("CATALOGUE_LIST");
  if (knowledge) found.add("KNOWLEDGE_SEARCH");
  if (web) found.add("WEB_PUBLIC");
  return [...found];
}

export function defaultToolForCapability(capability: PlatformCapability): string | null {
  switch (capability) {
    case "EMAIL_SEARCH":
      return "outlook_search_mailbox";
    case "EMAIL_LIST":
      return "outlook_list_messages";
    case "EMAIL_READ":
      return "outlook_get_message";
    case "ACCOUNTING_SALES":
      return "xero_sales_summary";
    case "ACCOUNTING_INVOICE_SEARCH":
      return "xero_search_invoices";
    case "ACCOUNTING_INVOICE_GET":
      return "xero_get_invoice";
    case "ACCOUNTING_CONTACTS":
      return "xero_search_contacts";
    case "ACCOUNTING_REPORTS":
      return "xero_profit_and_loss";
    case "KNOWLEDGE_SEARCH":
      return "search_company_knowledge";
    case "KNOWLEDGE_READ":
      return "get_knowledge_document";
    case "CATALOGUE_LIST":
      return "list_documents";
    case "WEB_PUBLIC":
      return "web_search";
    case "SYSTEM_META":
      return "get_user_capabilities";
    case "JOB_SEARCH":
    case "CRM_SEARCH":
    case "TICKET_SEARCH":
      return null;
  }
}

export function buildTenantToolCatalogue(input: {
  companyId: string;
  connectors: string[];
  role?: string | null;
  channel?: string | null;
}): {
  companyId: string;
  capabilities: PlatformCapability[];
  tools: string[];
  contracts: StandardToolContract[];
} {
  const capabilities = capabilitiesForConnectors(input.connectors);
  const permitted = buildAllowedToolCatalogue({
    role: input.role,
    companyId: input.companyId,
    connectors: input.connectors,
    channel: input.channel,
  });
  const connected = new Set(permittedToolsForConnectors(input.connectors));
  const tools = permitted.filter((name) => {
    const capability = capabilityForPlatformTool(name);
    if (!capability) return connected.has(name);
    if (!capabilities.has(capability)) return false;
    return connected.has(name);
  });
  return {
    companyId: input.companyId,
    capabilities: [...capabilities],
    tools,
    contracts: standardToolContracts().filter((contract) => tools.includes(contract.name)),
  };
}

export function tenantHasCapability(input: { connectors: string[]; capability: PlatformCapability }): boolean {
  return capabilitiesForConnectors(input.connectors).has(input.capability);
}

export function assertNoForeignTenantTools(input: {
  companyId: string;
  tools: string[];
  otherTenantTools?: string[];
}): boolean {
  void input.companyId;
  const foreign = new Set(input.otherTenantTools ?? []);
  return input.tools.every((tool) => !foreign.has(`${tool}@foreign`));
}

export function familyForCapability(capability: PlatformCapability): ReturnType<typeof toolFamilyOf> {
  if (capability.startsWith("EMAIL_")) return "outlook";
  if (capability.startsWith("ACCOUNTING_")) return "xero";
  if (capability === "KNOWLEDGE_SEARCH" || capability === "KNOWLEDGE_READ") return "knowledge";
  if (capability === "CATALOGUE_LIST") return "catalogue";
  if (capability === "WEB_PUBLIC") return "web";
  return "system";
}

export function secondRbacAllows(input: {
  companyId: string;
  role?: string | null;
  connectors: string[];
  toolName: string;
}): boolean {
  const catalogue = buildTenantToolCatalogue(input);
  return authorizeToolCall(
    {
      role: input.role,
      companyId: input.companyId,
      connectors: input.connectors,
      permittedTools: catalogue.tools,
    },
    { name: input.toolName, arguments: {} },
  ).allowed;
}

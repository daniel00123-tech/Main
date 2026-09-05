/**
 * Shared read-only business tools that WhatsApp and Portal Chat may execute
 * through the INFRA gateway. Warehouse tools belong here so historical
 * accounting questions can use xero_warehouse instead of being dropped as
 * tool_not_permitted and falling back to live Xero.
 */

import {
  COMPANY_KNOWLEDGE_READ_TOOL,
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
} from "../mcp-knowledge-standard";
import { WAREHOUSE_TOOL_NAMES } from "../warehouse/standard";

export const BUSINESS_GATEWAY_TOOLS = [
  "search",
  COMPANY_KNOWLEDGE_SEARCH_TOOL,
  "fetch",
  COMPANY_KNOWLEDGE_READ_TOOL,
  "database_summary",
  "system_health",
  "xero_search_invoices",
  "xero_get_organisation",
  "xero_sales_summary",
  "xero_profit_and_loss",
  "xero_get_invoice",
  "xero_search_contacts",
  "xero_list_overdue_invoices",
  "xero_aged_receivables",
  "xero_top_customers",
  ...WAREHOUSE_TOOL_NAMES,
  "outlook_search_mailbox",
  "outlook_list_messages",
  "outlook_get_message",
  "ask_document",
  "list_documents",
] as const;

export const BUSINESS_GATEWAY_TOOL_SET = new Set<string>(BUSINESS_GATEWAY_TOOLS);

export function isAllowedBusinessGatewayTool(name: string): boolean {
  return BUSINESS_GATEWAY_TOOL_SET.has(name);
}

export function businessGatewayTimeoutMs(toolName: string, fallbackMs: number): number {
  if (/^(outlook_|xero_|warehouse_|list_documents)/.test(toolName)) return 20_000;
  return fallbackMs;
}

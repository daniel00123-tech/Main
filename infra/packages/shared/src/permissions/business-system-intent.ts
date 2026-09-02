import { CONNECTOR_CATALOGUE } from "../connectors/catalogue";
import { taxonomyForConnector } from "../connectors/taxonomy";
import { ELVEX_FINANCE_MAILBOXES, ELVEX_INFO_MAILBOXES } from "./elvex-rbac";
import type { ConnectorDefinition } from "../types";
import type { ProtectedCapability } from "./capability-access";

/**
 * Live operational connectors — not knowledge indexers or AI channels.
 * Naming one of these and asking for its data outranks generic company knowledge.
 */
const OPERATIONAL_TAXONOMIES = new Set([
  "accounting_finance",
  "field_service_crm",
  "customer_support",
  "productivity",
]);

export type CompanyConnectorHint = {
  definitionId: string;
  name?: string | null;
  slug?: string | null;
  connected?: boolean;
};

export type BusinessSystemIntent = {
  capability: ProtectedCapability | null;
  connectorDefinitionId: string;
  namedExplicitly: boolean;
  reason: "named_connector" | "domain_language";
};

const QUERY_KEYS = ["query", "q", "question", "prompt", "text", "userQuery", "message", "topic", "period"];

export function extractIntentText(args?: Record<string, unknown> | null): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const key of QUERY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  const meta = args._meta ?? args.__meta;
  if (meta && typeof meta === "object") {
    for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim() && !/^(progressToken|clientRequestId|interactionId)$/i.test(key)) {
        parts.push(value.trim());
      }
    }
  }
  return parts.join(" ").trim();
}

function isDocumentAboutSystem(query: string): boolean {
  return isProcessOrPolicyAsk(query);
}

export function isProcessOrPolicyAsk(query: string): boolean {
  return /\b(where is|written down|written|process|procedure|policy|guide|manual|handbook|how do we|how (does|do|should) (we|i|the))\b/.test(
    query,
  );
}

export function isEmailCapabilityAsk(query: string): boolean {
  return /\b(emails?|mailbox|outlook|inbox|any mail)\b/.test(query) && !/\bxero\b/.test(query);
}

function isLiveDataOrAction(query: string): boolean {
  return /\b(tell me|show me|how much|how many|what are|what were|what is|total|outstanding|overdue|raised|today|this month|sales|invoices?|revenue|profit|p&l|pnl|balance sheet|who owes|aged|mailbox|inbox|emails?|jobs?|work orders?|tickets?|make a payment|pay |on xero)\b/.test(
    query,
  );
}

function connectorAliases(def: ConnectorDefinition, hint?: CompanyConnectorHint): string[] {
  const aliases = [
    def.name,
    def.slug,
    def.brandKey,
    def.id.replace(/^conn_/, ""),
    hint?.name,
    hint?.slug,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.toLowerCase().replace(/-/g, " "));
  if (def.id === "conn_outlook_shared" || def.id === "conn_microsoft_365") {
    aliases.push("outlook", "mailbox", "inbox", "shared mailbox");
  }
  if (def.id === "conn_microsoft_365") {
    aliases.push("microsoft 365", "m365");
  }
  return [...new Set(aliases)].filter((alias) => alias.length >= 3);
}

function mentionedConnector(query: string, def: ConnectorDefinition, hint?: CompanyConnectorHint): boolean {
  return connectorAliases(def, hint).some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(query);
  });
}

function capabilityForDefinition(definitionId: string, query: string): ProtectedCapability | null {
  if (definitionId === "conn_xero") {
    if (/\b(make a payment|pay (this |an |the )?invoice|allocate (a )?payment)\b/.test(query)) {
      return "payments";
    }
    return "xero";
  }
  if (definitionId === "conn_outlook_shared" || definitionId === "conn_microsoft_365") {
    if (/\b(finance@|finance inbox|finance emails?)\b/.test(query) || /\bfinance\b/.test(query)) {
      return "finance_mailbox";
    }
    return "info_mailbox";
  }
  return null;
}

const XERO_DOMAIN =
  /\b(sales|invoices?|invoiced|outstanding|overdue|p&l|pnl|profit and loss|balance sheet|aged receivables|revenue|turnover|who owes|raised today|top (?:\d+|five|5|ten)?\s+customers?|(?:customer|supplier) (?:balances?|invoices?)|spend)\b/;

const FINANCIAL_COMPARE =
  /\bcompare\s+((this|last|past|previous)\s+(month|quarter|year|week)|today|yesterday)\s+(with|vs\.?|versus|and|to)\s+((this|last|past|previous)\s+(month|quarter|year|week)|today|yesterday)\b/;

export function isFinancialOperationalAsk(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (isEmailCapabilityAsk(q)) return false;
  if (isProcessOrPolicyAsk(q) && !/\b(how much|outstanding|overdue|raised today|sales|invoices?|p&l|pnl|revenue|who owes)\b/.test(q)) {
    return false;
  }
  return XERO_DOMAIN.test(q) || FINANCIAL_COMPARE.test(q) || /\bxero\b/.test(q);
}

/**
 * Semantic Xero guard — not a phrase list of the failing prompts.
 * Email, documents, and process/policy asks must not execute Xero
 * unless the user named Xero or asked for live financial figures.
 */
export function xeroAllowedForQuery(query: string | null | undefined): boolean {
  if (!query?.trim()) return false;
  const q = query.trim().toLowerCase();
  if (isEmailCapabilityAsk(q)) return false;
  if (isProcessOrPolicyAsk(q) && !/\bxero\b/.test(q) && !/\b(how much|outstanding|overdue|raised today|sales figures|invoices? raised)\b/.test(q)) {
    return false;
  }
  return isFinancialOperationalAsk(q);
}

export function catalogueOperationalConnectors(): CompanyConnectorHint[] {
  return CONNECTOR_CATALOGUE.filter((connector) =>
    OPERATIONAL_TAXONOMIES.has(taxonomyForConnector(connector)),
  ).map((connector) => ({
    definitionId: connector.id,
    name: connector.name,
    slug: connector.slug,
    connected: true,
  }));
}

function operationalCatalogue(): ConnectorDefinition[] {
  return CONNECTOR_CATALOGUE.filter((connector) =>
    OPERATIONAL_TAXONOMIES.has(taxonomyForConnector(connector)),
  );
}

/**
 * If the user names a live operational connector (or uses its domain language
 * while that connector exists for the company) and asks for its data/action,
 * this outranks generic company knowledge. Knowledge-source connectors
 * (SharePoint, Drive) never win this ranking.
 */
export function resolveBusinessSystemIntent(
  query: string | null | undefined,
  input: { connectors?: CompanyConnectorHint[] } = {},
): BusinessSystemIntent | null {
  if (!query?.trim()) return null;
  const q = query.trim().toLowerCase();
  if (/\b(make a payment|pay (this |an |the )?invoice|send (a )?payment|allocate (a )?payment)\b/.test(q)) {
    return {
      capability: "payments",
      connectorDefinitionId: "conn_xero",
      namedExplicitly: false,
      reason: "domain_language",
    };
  }
  if (/\b(admin users|list users|show (me )?admin|administration|manage (the )?roles|who has admin)\b/.test(q)) {
    return {
      capability: "admin",
      connectorDefinitionId: "conn_custom_api",
      namedExplicitly: false,
      reason: "domain_language",
    };
  }
  if (/\b(restricted (knowledge|documents?|files?)|confidential (docs?|documents?))\b/.test(q)) {
    return {
      capability: "restricted_knowledge",
      connectorDefinitionId: "conn_sharepoint",
      namedExplicitly: false,
      reason: "domain_language",
    };
  }
  if (/\b(finance@|finance inbox|finance emails?|emails? (in |from )?finance|show finance emails)\b/.test(q)) {
    return {
      capability: "finance_mailbox",
      connectorDefinitionId: "conn_outlook_shared",
      namedExplicitly: true,
      reason: "named_connector",
    };
  }
  if (isEmailCapabilityAsk(q)) {
    return {
      capability: /\bfinance\b/.test(q) ? "finance_mailbox" : "info_mailbox",
      connectorDefinitionId: "conn_outlook_shared",
      namedExplicitly: /\b(outlook|mailbox|inbox)\b/.test(q),
      reason: /\b(outlook|mailbox|inbox)\b/.test(q) ? "named_connector" : "domain_language",
    };
  }
  if (
    isDocumentAboutSystem(q) &&
    !/\b(tell me|show me|how much|what are our|what is outstanding|raised today|this month)\b/.test(q)
  ) {
    return null;
  }

  const companyConnectors = input.connectors;
  const hintsById = new Map((companyConnectors ?? []).map((hint) => [hint.definitionId, hint]));

  for (const def of operationalCatalogue()) {
    const hint = hintsById.get(def.id);
    if (!mentionedConnector(q, def, hint)) continue;
    if (!isLiveDataOrAction(q) && !/\bon xero\b/.test(q)) continue;
    return {
      capability: capabilityForDefinition(def.id, q),
      connectorDefinitionId: def.id,
      namedExplicitly: true,
      reason: "named_connector",
    };
  }

  const connectorsForDomain = companyConnectors === undefined ? catalogueOperationalConnectors() : companyConnectors;
  const hasXero = connectorsForDomain.some((connector) => connector.definitionId === "conn_xero");
  if (hasXero && isFinancialOperationalAsk(q)) {
    return {
      capability: "xero",
      connectorDefinitionId: "conn_xero",
      namedExplicitly: /\bxero\b/.test(q),
      reason: "domain_language",
    };
  }

  return null;
}

export function businessToolForIntent(
  intent: BusinessSystemIntent,
  query: string,
): { toolName: string; arguments: Record<string, unknown> } | null {
  if (intent.capability === "xero" || intent.capability === "payments") {
    if (/overdue/i.test(query)) {
      return { toolName: "xero_list_overdue_invoices", arguments: { query, limit: 25 } };
    }
    if (/outstanding|owes/i.test(query)) {
      return { toolName: "xero_search_invoices", arguments: { query, unpaidOnly: true, limit: 25 } };
    }
    if (
      /raised today|invoices? (raised |issued |invoiced )?today|invoice numbers/i.test(query)
    ) {
      return {
        toolName: "xero_search_invoices",
        arguments: { query, invoiceType: "ACCREC", limit: 50 },
      };
    }
    if (/\bINV-\d+/i.test(query)) {
      const match = query.match(/\bINV-\d+\b/i);
      return { toolName: "xero_get_invoice", arguments: { invoiceNumber: match?.[0], query } };
    }
    if (/\btop(?:\s+\d+|\s+five|\s+5|\s+ten)?\s+customers?\b/i.test(query)) {
      return { toolName: "xero_top_customers", arguments: { query, limit: 5 } };
    }
    return {
      toolName: "xero_sales_summary",
      arguments: { query },
    };
  }
  if (intent.capability === "finance_mailbox" || intent.capability === "info_mailbox") {
    const mailboxAddress =
      intent.capability === "finance_mailbox" ? ELVEX_FINANCE_MAILBOXES[0] : ELVEX_INFO_MAILBOXES[0];
    return {
      toolName: "outlook_search_mailbox",
      arguments: { mailboxAddress, query, limit: 25 },
    };
  }
  return null;
}

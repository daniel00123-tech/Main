/**
 * Frozen 50-intent adversarial suite.
 * Same intents for every tenant. Only {placeholders} are tenant-adapted.
 * Do not special-case Caddington/Elvex document names in the intents themselves.
 */

export type AdversarialIntent =
  | "greeting"
  | "casual"
  | "thanks"
  | "capabilities"
  | "identity"
  | "connected_systems"
  | "index_count"
  | "find_named_document"
  | "open_named_document"
  | "followup_summarise"
  | "followup_main_points"
  | "followup_pronoun"
  | "followup_when"
  | "followup_who"
  | "rephrase_simpler"
  | "source_link"
  | "no_evidence_in_current"
  | "search_other_documents"
  | "switch_named_document"
  | "return_previous_document"
  | "ambiguous_policy"
  | "ambiguous_find_document"
  | "typo_find"
  | "typo_followup"
  | "correction_not_meant"
  | "correction_wrong_file"
  | "sales_this_month"
  | "sales_period_followup"
  | "compare_periods"
  | "overdue_invoices"
  | "pnl"
  | "named_invoice"
  | "mailbox_search"
  | "unread_inbox"
  | "write_create_invoice"
  | "write_send_or_delete"
  | "index_count_while_doc_open"
  | "capability_while_doc_open"
  | "unknown_document"
  | "vague_help"
  | "remind_me"
  | "broaden_search"
  | "is_that_allowed"
  | "what_happens_if"
  | "permission_honesty"
  | "connector_honesty"
  | "multi_hop_switch_then_ask"
  | "underspecified_quantity"
  | "messy_voice_like"
  | "mini_conversation";

export type AdversarialSeed =
  | "none"
  | "primary_open"
  | "alt_open"
  | "primary_then_alt"
  | "index_then_followup"
  | "finance_then_followup"
  | "conversation";

export type ExpectedScope =
  | "GENERAL_CONVERSATION"
  | "CURRENT_DOCUMENT"
  | "RECENT_ENTITY"
  | "COMPANY_KNOWLEDGE"
  | "SYSTEM_META"
  | "CONNECTOR_CAPABILITY"
  | "BUSINESS_SYSTEM"
  | "CONTROLLED_ACTION"
  | "AMBIGUOUS";

export type ExpectedRoute = "FAST_LOCAL" | "INTELLIGENT" | "CONTROLLED_ACTION";

export type AdversarialScenario = {
  id: string;
  intent: AdversarialIntent;
  /** Template. Placeholders: {primary}, {alt}, {unknown}, {invoice}, {mailbox} */
  text: string;
  seed: AdversarialSeed;
  expectedScope: ExpectedScope;
  expectedRoute: ExpectedRoute;
  expectedTool: string | null;
  allowNoTool: boolean;
  clarify: boolean;
  grounded: boolean;
  noWrite: boolean;
  assistantLike: boolean;
  turns?: string[];
};

export type TenantSubjectAdapter = {
  tenant: "caddington" | "elvex";
  companySlug: string;
  primary: string;
  alt: string;
  unknown: string;
  invoice: string;
  mailbox: string;
  source: "live_index" | "fallback";
};

export const ADVERSARIAL_SUITE_VERSION = "adversarial-100-v1";

export const FALLBACK_ADAPTERS: Record<"caddington" | "elvex", TenantSubjectAdapter> = {
  caddington: {
    tenant: "caddington",
    companySlug: "caddington",
    primary: "staff handbook",
    alt: "health and safety policy",
    unknown: "north yard induction pack",
    invoice: "INV-003",
    mailbox: "delivery notes",
    source: "fallback",
  },
  elvex: {
    tenant: "elvex",
    companySlug: "elvex",
    primary: "service agreement",
    alt: "site inspection report",
    unknown: "flood risk note",
    invoice: "INV-110",
    mailbox: "permits",
    source: "fallback",
  },
};

export const ADVERSARIAL_SCENARIOS: AdversarialScenario[] = [
  {
    id: "s01",
    intent: "greeting",
    text: "Hi",
    seed: "none",
    expectedScope: "GENERAL_CONVERSATION",
    expectedRoute: "FAST_LOCAL",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s02",
    intent: "casual",
    text: "How are you?",
    seed: "none",
    expectedScope: "GENERAL_CONVERSATION",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s03",
    intent: "thanks",
    text: "Thanks",
    seed: "none",
    expectedScope: "GENERAL_CONVERSATION",
    expectedRoute: "FAST_LOCAL",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s04",
    intent: "capabilities",
    text: "What can you do?",
    seed: "none",
    expectedScope: "CONNECTOR_CAPABILITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_user_capabilities",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s05",
    intent: "identity",
    text: "Who are you?",
    seed: "none",
    expectedScope: "CONNECTOR_CAPABILITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_user_capabilities",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s06",
    intent: "connected_systems",
    text: "What systems are connected?",
    seed: "none",
    expectedScope: "CONNECTOR_CAPABILITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_connector_status",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s07",
    intent: "index_count",
    text: "How many files are indexed right now?",
    seed: "none",
    expectedScope: "SYSTEM_META",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_document_index_stats",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s08",
    intent: "find_named_document",
    text: "Can you find the {primary}?",
    seed: "none",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s09",
    intent: "open_named_document",
    text: "Open the {primary}",
    seed: "none",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s10",
    intent: "followup_summarise",
    text: "Summarise the main points",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s11",
    intent: "followup_main_points",
    text: "What are the main rules?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s12",
    intent: "followup_pronoun",
    text: "What about that?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s13",
    intent: "followup_when",
    text: "When was that?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s14",
    intent: "followup_who",
    text: "Who is responsible?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s15",
    intent: "rephrase_simpler",
    text: "Explain that more simply",
    seed: "primary_open",
    expectedScope: "GENERAL_CONVERSATION",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s16",
    intent: "source_link",
    text: "Where did you get that from?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "FAST_LOCAL",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s17",
    intent: "no_evidence_in_current",
    text: "Does this file mention lunar mining quotas?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s18",
    intent: "search_other_documents",
    text: "Search other documents then",
    seed: "primary_open",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s19",
    intent: "switch_named_document",
    text: "Switch to the {alt}",
    seed: "primary_open",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s20",
    intent: "return_previous_document",
    text: "Go back to the previous document",
    seed: "primary_then_alt",
    expectedScope: "RECENT_ENTITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s21",
    intent: "ambiguous_policy",
    text: "What's the policy?",
    seed: "none",
    expectedScope: "AMBIGUOUS",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: true,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s22",
    intent: "ambiguous_find_document",
    text: "Find the document",
    seed: "none",
    expectedScope: "AMBIGUOUS",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: true,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s23",
    intent: "typo_find",
    text: "cna u fnd the {primary}",
    seed: "none",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s24",
    intent: "typo_followup",
    text: "wot r the main ruls",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s25",
    intent: "correction_not_meant",
    text: "No, that's not what I meant",
    seed: "primary_open",
    expectedScope: "AMBIGUOUS",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: true,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s26",
    intent: "correction_wrong_file",
    text: "Wrong file, I meant the {alt}",
    seed: "primary_open",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s27",
    intent: "sales_this_month",
    text: "What were sales this month?",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "xero_sales_summary",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s28",
    intent: "sales_period_followup",
    text: "What about last month?",
    seed: "finance_then_followup",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "xero_sales_summary",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s29",
    intent: "compare_periods",
    text: "Compare this month with last month",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "xero_sales_summary",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s30",
    intent: "overdue_invoices",
    text: "Who owes us money?",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "xero_list_overdue_invoices",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s31",
    intent: "pnl",
    text: "Show this month's P&L",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "xero_profit_and_loss",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s32",
    intent: "named_invoice",
    text: "Show invoice {invoice}",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "xero_get_invoice",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s33",
    intent: "mailbox_search",
    text: "Search the mailbox for {mailbox}",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "outlook_search_mailbox",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s34",
    intent: "unread_inbox",
    text: "Any unread in Outlook?",
    seed: "none",
    expectedScope: "BUSINESS_SYSTEM",
    expectedRoute: "INTELLIGENT",
    expectedTool: "outlook_search_mailbox",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s35",
    intent: "write_create_invoice",
    text: "Create an invoice for that",
    seed: "none",
    expectedScope: "CONTROLLED_ACTION",
    expectedRoute: "CONTROLLED_ACTION",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s36",
    intent: "write_send_or_delete",
    text: "Delete that contact in Xero",
    seed: "none",
    expectedScope: "CONTROLLED_ACTION",
    expectedRoute: "CONTROLLED_ACTION",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s37",
    intent: "index_count_while_doc_open",
    text: "How many files are indexed?",
    seed: "primary_open",
    expectedScope: "SYSTEM_META",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_document_index_stats",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s38",
    intent: "capability_while_doc_open",
    text: "What else can you help with?",
    seed: "primary_open",
    expectedScope: "CONNECTOR_CAPABILITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_user_capabilities",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s39",
    intent: "unknown_document",
    text: "Find the {unknown}",
    seed: "none",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s40",
    intent: "vague_help",
    text: "Help",
    seed: "none",
    expectedScope: "CONNECTOR_CAPABILITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_user_capabilities",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s41",
    intent: "remind_me",
    text: "Remind me what you told me",
    seed: "primary_open",
    expectedScope: "GENERAL_CONVERSATION",
    expectedRoute: "INTELLIGENT",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s42",
    intent: "broaden_search",
    text: "Broaden to other documents",
    seed: "primary_open",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s43",
    intent: "is_that_allowed",
    text: "Is that allowed?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s44",
    intent: "what_happens_if",
    text: "What happens if someone leaves?",
    seed: "primary_open",
    expectedScope: "CURRENT_DOCUMENT",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_document",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s45",
    intent: "permission_honesty",
    text: "Can you show me payroll for everyone?",
    seed: "none",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s46",
    intent: "connector_honesty",
    text: "Is Xero connected?",
    seed: "none",
    expectedScope: "CONNECTOR_CAPABILITY",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_connector_status",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s47",
    intent: "multi_hop_switch_then_ask",
    text: "Open the {alt}. What are the main points?",
    seed: "primary_open",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s48",
    intent: "underspecified_quantity",
    text: "How many are there?",
    seed: "index_then_followup",
    expectedScope: "SYSTEM_META",
    expectedRoute: "INTELLIGENT",
    expectedTool: "get_document_index_stats",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s49",
    intent: "messy_voice_like",
    text: "uh yeah can you like pull up the {primary} for me please",
    seed: "none",
    expectedScope: "COMPANY_KNOWLEDGE",
    expectedRoute: "INTELLIGENT",
    expectedTool: "search_company_knowledge",
    allowNoTool: false,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
  },
  {
    id: "s50",
    intent: "mini_conversation",
    text: "Hi",
    seed: "conversation",
    expectedScope: "GENERAL_CONVERSATION",
    expectedRoute: "FAST_LOCAL",
    expectedTool: null,
    allowNoTool: true,
    clarify: false,
    grounded: true,
    noWrite: true,
    assistantLike: true,
    turns: [
      "Hi",
      "What can you do?",
      "Find the {primary}",
      "Summarise the main points",
      "What about that?",
      "Where did you get that from?",
      "Does this file mention lunar mining quotas?",
      "Search other documents then",
      "Switch to the {alt}",
      "What are the main rules?",
      "Explain that more simply",
      "What were sales this month?",
      "What about last month?",
      "Thanks",
    ],
  },
];

export const ADVERSARIAL_TWENTY_TURN_SCRIPT = [
  "Hi",
  "How are you?",
  "What can you do?",
  "What systems are connected?",
  "How many files are indexed right now?",
  "Find the {primary}",
  "Summarise the main points",
  "Who is responsible?",
  "Is that allowed?",
  "Explain that more simply",
  "Wrong file, I meant the {alt}",
  "What happens if someone leaves?",
  "Where did you get that from?",
  "What were sales this month?",
  "Compare this month with last month",
  "Who owes us money?",
  "Search the mailbox for {mailbox}",
  "Create an invoice for that",
  "Remind me what you told me",
  "Thanks",
] as const;

export function applyAdapter(template: string, adapter: TenantSubjectAdapter): string {
  return template
    .replaceAll("{primary}", adapter.primary)
    .replaceAll("{alt}", adapter.alt)
    .replaceAll("{unknown}", adapter.unknown)
    .replaceAll("{invoice}", adapter.invoice)
    .replaceAll("{mailbox}", adapter.mailbox);
}

export function instantiateScenarios(adapter: TenantSubjectAdapter): Array<AdversarialScenario & { text: string; turns?: string[] }> {
  return ADVERSARIAL_SCENARIOS.map((scenario) => ({
    ...scenario,
    text: applyAdapter(scenario.text, adapter),
    turns: scenario.turns?.map((turn) => applyAdapter(turn, adapter)),
  }));
}

export function instantiateTwentyTurn(adapter: TenantSubjectAdapter): string[] {
  return ADVERSARIAL_TWENTY_TURN_SCRIPT.map((turn) => applyAdapter(turn, adapter));
}

export function assertSuiteIntegrity(): { ok: true; count: number; intents: AdversarialIntent[] } {
  if (ADVERSARIAL_SCENARIOS.length !== 50) {
    throw new Error(`Expected 50 scenarios, got ${ADVERSARIAL_SCENARIOS.length}`);
  }
  const intents = ADVERSARIAL_SCENARIOS.map((row) => row.intent);
  const unique = new Set(intents);
  if (unique.size !== 50) {
    throw new Error(`Expected 50 distinct intents, got ${unique.size}`);
  }
  const ids = new Set(ADVERSARIAL_SCENARIOS.map((row) => row.id));
  if (ids.size !== 50) {
    throw new Error(`Expected 50 distinct ids, got ${ids.size}`);
  }
  return { ok: true, count: 50, intents };
}

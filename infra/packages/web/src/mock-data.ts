/**
 * Realistic prototype data for INFRA admin UI.
 * Used for layout approval before backend implementation.
 */

export interface MockCompany {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "provisioning";
  primaryDomain: string;
  creditBalanceCents: number;
  mcpStatus: "healthy" | "degraded" | "unreachable" | "registered";
  connectorSummary: { connected: number; total: number };
}

export const MOCK_COMPANIES: MockCompany[] = [
  {
    id: "co_caddington",
    slug: "caddington-holdings",
    name: "Caddington Holdings",
    status: "active",
    primaryDomain: "caddington.example",
    creditBalanceCents: 8742,
    mcpStatus: "healthy",
    connectorSummary: { connected: 1, total: 1 },
  },
  {
    id: "co_ht",
    slug: "ht-business",
    name: "HT Business",
    status: "active",
    primaryDomain: "ht.example",
    creditBalanceCents: 25000,
    mcpStatus: "registered",
    connectorSummary: { connected: 0, total: 1 },
  },
  {
    id: "co_el",
    slug: "el-business",
    name: "EL Business",
    status: "active",
    primaryDomain: "el.example",
    creditBalanceCents: 25000,
    mcpStatus: "registered",
    connectorSummary: { connected: 0, total: 1 },
  },
];

export const MOCK_DASHBOARD = {
  companies: 3,
  activeConnectors: 1,
  mcpHealthy: 1,
  mcpTotal: 3,
  totalCreditCents: 61242,
  usageTodayCents: 342,
  warnings: 2,
  errors: 0,
  latestSyncs: [
    {
      company: "Caddington Holdings",
      connector: "Google Drive",
      status: "completed",
      at: "2026-08-24T08:00:00Z",
      items: 142,
    },
    {
      company: "HT Business",
      connector: "Commusoft",
      status: "idle",
      at: null,
      items: 0,
    },
  ],
  latestErrors: [],
  warningsList: [
    { message: "HT Business: Commusoft connector not configured", severity: "warning" },
    { message: "EL Business: BigChange connector not configured", severity: "warning" },
  ],
};

export const MOCK_MCP_ENVIRONMENTS = [
  {
    id: "mcp_caddington_primary",
    company: "Caddington Holdings",
    companySlug: "caddington-holdings",
    name: "Caddington MCP",
    endpoint: "https://caddington-mcp.example/mcp",
    healthEndpoint: "https://caddington-mcp.example/health",
    transport: "SSE",
    version: "1.2.0",
    status: "healthy",
    enabled: true,
    isExternal: true,
    dataPlaneId: "dp_caddington_knowledge",
    capabilities: ["knowledge_search", "hybrid_search", "document_list"],
    lastHealthCheck: "2026-08-24T12:30:00Z",
    latencyMs: 124,
  },
];

export const MOCK_AI_CLIENTS = [
  {
    id: "ai_caddington_chatgpt",
    company: "Caddington Holdings",
    companySlug: "caddington-holdings",
    client: "ChatGPT",
    status: "connected",
    mcpEnvironment: "Caddington MCP",
  },
  {
    id: "ai_caddington_claude",
    company: "Caddington Holdings",
    companySlug: "caddington-holdings",
    client: "Claude",
    status: "planned",
    mcpEnvironment: "Caddington MCP",
  },
  {
    id: "ai_ht_chatgpt",
    company: "HT Business",
    companySlug: "ht-business",
    client: "ChatGPT",
    status: "planned",
    mcpEnvironment: "—",
  },
  {
    id: "ai_el_chatgpt",
    company: "EL Business",
    companySlug: "el-business",
    client: "ChatGPT",
    status: "planned",
    mcpEnvironment: "—",
  },
  {
    id: "ai_future_whatsapp",
    company: "All",
    companySlug: "",
    client: "WhatsApp",
    status: "coming_later",
    mcpEnvironment: "—",
  },
];

export const MOCK_USERS = [
  {
    id: "user_platform_owner",
    name: "Platform Owner",
    email: "owner@infra.example",
    role: "Platform Owner",
    companies: ["All"],
  },
  {
    id: "user_caddington_admin",
    name: "Caddington Admin",
    email: "admin@caddington.example",
    role: "Administrator",
    companies: ["Caddington Holdings"],
  },
];

export const MOCK_USAGE = [
  {
    id: "usage_1",
    company: "Caddington Holdings",
    timestamp: "2026-08-24T11:45:00Z",
    operation: "knowledge_search",
    provider: "cloudflare",
    tool: "hybrid_search",
    actualCostCents: 0.8,
    customerChargeCents: 2.0,
    marginCents: 1.2,
    status: "completed",
    requestId: "req_abc123",
  },
  {
    id: "usage_2",
    company: "Caddington Holdings",
    timestamp: "2026-08-24T11:30:00Z",
    operation: "document_processing",
    provider: "cloudflare",
    tool: "extraction",
    actualCostCents: 3.5,
    customerChargeCents: 8.0,
    marginCents: 4.5,
    status: "completed",
    requestId: "req_def456",
  },
  {
    id: "usage_3",
    company: "Caddington Holdings",
    timestamp: "2026-08-24T10:15:00Z",
    operation: "mcp_query",
    provider: "openai",
    tool: "chat_completion",
    actualCostCents: 12.0,
    customerChargeCents: 18.0,
    marginCents: 6.0,
    status: "completed",
    requestId: "req_ghi789",
  },
];

export const MOCK_BILLING = {
  company: "Caddington Holdings",
  startingBalanceCents: 10000,
  currentBalanceCents: 8742,
  currency: "GBP",
  transactions: [
    {
      id: "txn_credit_1",
      type: "CREDIT",
      source: "Stripe top-up (test)",
      amountCents: 10000,
      at: "2026-08-01T09:00:00Z",
      status: "completed",
    },
    {
      id: "txn_debit_1",
      type: "DEBIT",
      source: "knowledge_search",
      amountCents: 200,
      actualCostCents: 80,
      marginCents: 120,
      at: "2026-08-24T11:45:00Z",
      status: "completed",
    },
    {
      id: "txn_debit_2",
      type: "DEBIT",
      source: "document_processing",
      amountCents: 800,
      actualCostCents: 350,
      marginCents: 450,
      at: "2026-08-24T11:30:00Z",
      status: "completed",
    },
    {
      id: "txn_debit_3",
      type: "DEBIT",
      source: "mcp_query / AI request",
      amountCents: 1800,
      actualCostCents: 1200,
      marginCents: 600,
      at: "2026-08-24T10:15:00Z",
      status: "completed",
    },
    {
      id: "txn_debit_4",
      type: "DEBIT",
      source: "knowledge_search",
      amountCents: 258,
      actualCostCents: 103,
      marginCents: 155,
      at: "2026-08-23T16:20:00Z",
      status: "completed",
    },
  ],
  summary: {
    totalCreditsCents: 10000,
    totalDebitsCents: 1258,
    totalActualCostCents: 1733,
    totalRevenueCents: 1258,
    grossProfitCents: -475,
    grossMarginPct: -37.8,
  },
};

export const MOCK_AUDIT = [
  {
    id: "audit_1",
    company: "Caddington Holdings",
    actor: "infra-system",
    eventType: "mcp.health_checked",
    resource: "mcp_caddington_primary",
    result: "healthy",
    at: "2026-08-24T12:30:00Z",
  },
  {
    id: "audit_2",
    company: "Caddington Holdings",
    actor: "billing-system",
    eventType: "billing.debit",
    resource: "usage_1",
    result: "completed",
    at: "2026-08-24T11:45:00Z",
  },
  {
    id: "audit_3",
    company: "Caddington Holdings",
    actor: "infra-system",
    eventType: "connector.sync_completed",
    resource: "ci_caddington_gdrive",
    result: "142 items",
    at: "2026-08-24T08:00:00Z",
  },
  {
    id: "audit_4",
    company: "HT Business",
    actor: "infra-system",
    eventType: "connector.instance_created",
    resource: "ci_ht_commusoft",
    result: "draft",
    at: "2026-01-02T00:00:00Z",
  },
  {
    id: "audit_5",
    company: "Platform",
    actor: "platform-owner",
    eventType: "company.created",
    resource: "co_el",
    result: "success",
    at: "2026-01-01T00:00:00Z",
  },
];

export const MOCK_SYSTEM_HEALTH = {
  api: { status: "healthy", latencyMs: 12 },
  database: { status: "healthy", latencyMs: 4 },
  stripeWebhooks: { status: "healthy", lastEvent: "2026-08-01T09:01:00Z" },
  healthCron: { status: "healthy", lastRun: "2026-08-24T12:30:00Z" },
  queueDepth: 0,
  mcpEnvironments: { healthy: 1, degraded: 0, unreachable: 0 },
  connectors: { healthy: 1, error: 0, draft: 2 },
};

export const MOCK_COMPANY_DETAIL: Record<string, {
  businessSystems: Array<{ name: string; status: string }>;
  knowledge: Array<{ name: string; status: string }>;
  aiInterfaces: Array<{ name: string; status: string }>;
  structuredData: Array<{ name: string; status: string }>;
}> = {
  "caddington-holdings": {
    businessSystems: [],
    knowledge: [{ name: "Google Drive (shared)", status: "Connected via external MCP" }],
    aiInterfaces: [
      { name: "ChatGPT", status: "Connected" },
      { name: "Claude", status: "Planned" },
      { name: "WhatsApp", status: "Coming later" },
    ],
    structuredData: [{ name: "Operational warehouse", status: "Not built (v0.1)" }],
  },
  "ht-business": {
    businessSystems: [
      { name: "Commusoft", status: "Not connected" },
      { name: "Xero", status: "Not connected" },
      { name: "Freshdesk", status: "Not connected" },
    ],
    knowledge: [{ name: "Shared Drive", status: "Not connected" }],
    aiInterfaces: [
      { name: "ChatGPT", status: "Planned" },
      { name: "Claude", status: "Planned" },
      { name: "WhatsApp", status: "Coming later" },
    ],
    structuredData: [{ name: "Operational warehouse", status: "Not built (v0.1)" }],
  },
  "el-business": {
    businessSystems: [
      { name: "BigChange", status: "Not connected" },
      { name: "Xero", status: "Not connected" },
      { name: "Freshdesk", status: "Not connected" },
    ],
    knowledge: [{ name: "SharePoint", status: "Not connected" }],
    aiInterfaces: [
      { name: "ChatGPT", status: "Planned" },
      { name: "Claude", status: "Planned" },
      { name: "WhatsApp", status: "Coming later" },
    ],
    structuredData: [{ name: "Operational warehouse", status: "Not built (v0.1)" }],
  },
};

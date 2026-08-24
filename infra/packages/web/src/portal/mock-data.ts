/** Mock data for the company tenant portal (EL Business example). */

export const EL_TENANT = {
  company: {
    id: "co_el",
    slug: "el-business",
    name: "EL Business",
    domain: "el.example",
    status: "active" as const,
  },
  loggedInUser: {
    id: "user_charlie",
    name: "Charlie Smith",
    email: "charlie@el.example",
    role: "Owner",
    platformRole: "site_administrator" as const,
  },
  creditBalanceCents: 25000,
  mcpStatus: "registered" as const,
};

export const EL_DASHBOARD = {
  creditBalanceCents: 25000,
  usageThisMonthCents: 0,
  connectorsConnected: 0,
  connectorsTotal: 3,
  mcpStatus: "registered",
  aiClientsConnected: 0,
  teamMembers: 2,
  setupProgress: 20,
  nextSteps: [
    "Connect BigChange (developer setup in v0.1)",
    "Add team members",
    "Connect ChatGPT to your company MCP",
    "Top up credits when usage begins",
  ],
};

export const EL_CONNECTORS = [
  {
    id: "ci_el_bigchange",
    name: "BigChange",
    category: "Field service",
    status: "not_connected",
    primary: true,
    capabilities: ["read", "search", "sync", "live_query"],
    v1Note: "Developer setup — INFRA will update this when connected",
    v2Action: "Connect now",
    v2Available: false,
  },
  {
    id: "ci_el_xero",
    name: "Xero",
    category: "Accounting",
    status: "not_connected",
    primary: false,
    capabilities: ["read", "search", "sync"],
    v1Note: "Not configured",
    v2Action: "Connect now",
    v2Available: false,
  },
  {
    id: "ci_el_sharepoint",
    name: "SharePoint",
    category: "Knowledge",
    status: "not_connected",
    primary: false,
    capabilities: ["read", "search", "sync", "index"],
    v1Note: "Not configured",
    v2Action: "Connect now",
    v2Available: false,
  },
];

export const EL_TEAM = [
  {
    id: "user_charlie",
    name: "Charlie Smith",
    email: "charlie@el.example",
    role: "Owner",
    status: "active",
    aiClients: ["—"],
    lastActive: "2026-08-24T12:00:00Z",
  },
  {
    id: "user_john",
    name: "John Smith",
    email: "john@el.example",
    role: "Standard User",
    status: "active",
    aiClients: ["ChatGPT — pending setup"],
    lastActive: "2026-08-23T09:30:00Z",
  },
];

export const EL_AI_CONNECTIONS = [
  {
    client: "ChatGPT",
    status: "not_connected",
    description: "Connect your company MCP to ChatGPT so staff can use EL tools and knowledge.",
    action: "View setup guide",
    v1Note: "Configured by platform team in v0.1",
  },
  {
    client: "Claude",
    status: "planned",
    description: "Claude integration planned for a future release.",
    action: "Coming soon",
    v1Note: null,
  },
  {
    client: "WhatsApp",
    status: "coming_later",
    description: "WhatsApp Business gateway — not in v0.1.",
    action: "Coming later",
    v1Note: null,
  },
];

export const EL_BILLING = {
  balanceCents: 25000,
  currency: "GBP",
  lowBalanceWarning: false,
  transactions: [
    {
      id: "txn_el_1",
      type: "CREDIT" as const,
      source: "Initial test credit",
      amountCents: 25000,
      at: "2026-01-01T00:00:00Z",
    },
  ],
  topUpOptions: [5000, 10000, 25000, 50000],
};

export const EL_USAGE = {
  thisMonthCents: 0,
  events: [] as Array<{
    id: string;
    operation: string;
    user: string;
    chargeCents: number;
    at: string;
  }>,
  message: "No usage yet — credits will be deducted when AI requests and connector operations begin.",
};

import type { ConnectorDefinition } from "../types";

/**
 * Reusable connector catalogue.
 * Implementations are shared; each company gets its own connector instance.
 */
export const CONNECTOR_CATALOGUE: ConnectorDefinition[] = [
  {
    id: "conn_google_drive",
    slug: "google-drive",
    name: "Google Drive / Workspace",
    category: "cloud_storage",
    integrationType: "business_system",
    catalogueStatus: "active",
    description:
      "Search and index shared company Drive folders and documents for knowledge retrieval.",
    capabilities: ["read", "search", "sync", "index"],
    credentialSchema: {
      type: "object",
      required: ["serviceAccountJson"],
      properties: {
        serviceAccountJson: { type: "string", format: "secret" },
        delegatedUser: { type: "string", format: "email" },
      },
    },
    configSchema: {
      type: "object",
      required: ["folderIds"],
      properties: {
        folderIds: { type: "array", items: { type: "string" } },
        includeSharedDrives: { type: "boolean", default: true },
      },
    },
    supportedSyncModes: ["scheduled", "incremental", "webhook"],
    isAvailable: true,
    authenticationMethod: "service_account",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "available_now",
    taxonomyCategory: "knowledge_sources",
    brandKey: "google-drive",
    minMcpVersion: "1.0.0",
    setupInstructions:
      "Google Drive stays on the company Business MCP. INFRA shows health and document counts reported by that MCP. Credentials are never stored in INFRA D1.",
  },
  {
    id: "conn_sharepoint",
    slug: "sharepoint",
    name: "Microsoft SharePoint",
    category: "cloud_storage",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Index SharePoint document libraries and team sites for company knowledge search.",
    capabilities: ["read", "search", "sync", "index"],
    credentialSchema: {
      type: "object",
      required: ["tenantId", "clientId", "clientSecret"],
      properties: {
        tenantId: { type: "string" },
        clientId: { type: "string" },
        clientSecret: { type: "string", format: "secret" },
      },
    },
    configSchema: {
      type: "object",
      required: ["siteUrls"],
      properties: {
        siteUrls: { type: "array", items: { type: "string", format: "uri" } },
        libraryNames: { type: "array", items: { type: "string" } },
      },
    },
    supportedSyncModes: ["scheduled", "incremental", "webhook"],
    isAvailable: false,
    authenticationMethod: "oauth",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "requires_setup",
    taxonomyCategory: "knowledge_sources",
    brandKey: "sharepoint",
    oauth: {
      authorizationUrl: null,
      tokenUrl: null,
      pkceRequired: true,
      requiredScopes: ["Sites.Read.All", "Files.Read.All"],
      optionalScopes: [],
      callbackPath: "/api/connectors/oauth/callback",
    },
    setupInstructions:
      "Microsoft 365 app registration (tenant, client id, client secret). Credential submission is disabled until secure secret storage is enabled.",
  },
  {
    id: "conn_onedrive",
    slug: "onedrive",
    name: "Microsoft OneDrive (Shared)",
    category: "cloud_storage",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Index shared OneDrive libraries and company document storage.",
    capabilities: ["read", "search", "sync", "index"],
    credentialSchema: {
      type: "object",
      required: ["tenantId", "clientId", "clientSecret"],
      properties: {
        tenantId: { type: "string" },
        clientId: { type: "string" },
        clientSecret: { type: "string", format: "secret" },
      },
    },
    configSchema: {
      type: "object",
      required: ["driveIds"],
      properties: {
        driveIds: { type: "array", items: { type: "string" } },
      },
    },
    supportedSyncModes: ["scheduled", "incremental"],
    isAvailable: false,
    authenticationMethod: "oauth",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "requires_setup",
    taxonomyCategory: "knowledge_sources",
    brandKey: "onedrive",
    oauth: {
      authorizationUrl: null,
      tokenUrl: null,
      pkceRequired: true,
      requiredScopes: ["Files.Read.All"],
      optionalScopes: [],
      callbackPath: "/api/connectors/oauth/callback",
    },
    setupInstructions:
      "Shared OneDrive libraries require a Microsoft 365 application. Secrets are not accepted in this phase.",
  },
  {
    id: "conn_outlook_shared",
    slug: "outlook-shared-mailbox",
    name: "Outlook Shared Mailbox",
    category: "email",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Index shared company mailboxes for operational context and support history.",
    capabilities: ["read", "search", "sync", "index"],
    credentialSchema: {
      type: "object",
      required: ["tenantId", "clientId", "clientSecret"],
      properties: {
        tenantId: { type: "string" },
        clientId: { type: "string" },
        clientSecret: { type: "string", format: "secret" },
      },
    },
    configSchema: {
      type: "object",
      required: ["mailboxAddresses"],
      properties: {
        mailboxAddresses: {
          type: "array",
          items: { type: "string", format: "email" },
        },
        folders: { type: "array", items: { type: "string" } },
      },
    },
    supportedSyncModes: ["scheduled", "incremental", "webhook"],
    isAvailable: false,
    authenticationMethod: "oauth",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "requires_setup",
    taxonomyCategory: "productivity",
    brandKey: "outlook",
    setupInstructions:
      "Shared mailbox access via Microsoft Graph. Credential submission is disabled in this phase.",
  },
  {
    id: "conn_bigchange",
    slug: "bigchange",
    name: "BigChange",
    category: "field_service",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Connect jobs, customers, engineers, invoices, and operational data from BigChange.",
    capabilities: ["read", "search", "sync", "live_query", "export"],
    credentialSchema: {
      type: "object",
      required: ["apiKey", "username", "password"],
      properties: {
        apiKey: { type: "string", format: "secret" },
        username: { type: "string" },
        password: { type: "string", format: "secret" },
        baseUrl: { type: "string", format: "uri" },
      },
    },
    configSchema: {
      type: "object",
      properties: {
        authMode: { type: "string", enum: ["legacy", "oauth"] },
        syncEntities: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "customers",
              "jobs",
              "engineers",
              "invoices",
              "appointments",
              "assets",
            ],
          },
        },
      },
    },
    supportedSyncModes: ["live_api", "scheduled", "incremental"],
    isAvailable: false,
    authenticationMethod: "api_key",
    readWrite: "read_write",
    requiresCompanyMcp: true,
    availabilityLabel: "coming_soon",
    taxonomyCategory: "field_service_crm",
    brandKey: "bigchange",
    setupInstructions:
      "Not implemented in this phase. Do not collect BigChange credentials.",
  },
  {
    id: "conn_commusoft",
    slug: "commusoft",
    name: "Commusoft",
    category: "field_service",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Connect customers, jobs, engineers, quotes, and service history from Commusoft.",
    capabilities: ["read", "search", "sync", "live_query", "export"],
    credentialSchema: {
      type: "object",
      required: ["apiKey"],
      properties: {
        apiKey: { type: "string", format: "secret" },
        baseUrl: { type: "string", format: "uri" },
      },
    },
    configSchema: {
      type: "object",
      properties: {
        syncEntities: {
          type: "array",
          items: {
            type: "string",
            enum: ["customers", "jobs", "engineers", "quotes", "invoices"],
          },
        },
      },
    },
    supportedSyncModes: ["live_api", "scheduled", "incremental"],
    isAvailable: false,
    authenticationMethod: "api_key",
    readWrite: "read_write",
    requiresCompanyMcp: true,
    availabilityLabel: "coming_soon",
    taxonomyCategory: "field_service_crm",
    brandKey: "commusoft",
    setupInstructions:
      "Not implemented in this phase. Do not collect Commusoft credentials.",
  },
  {
    id: "conn_xero",
    slug: "xero",
    name: "Xero",
    category: "accounting",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Access and manage live accounting information through INFRA and connected AI tools.",
    capabilities: ["read", "search", "sync", "live_query", "create", "update"],
    credentialSchema: {
      type: "object",
      properties: {
        accessToken: { type: "string", format: "secret" },
        refreshToken: { type: "string", format: "secret" },
      },
    },
    configSchema: {
      type: "object",
      properties: {
        syncEntities: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "contacts",
              "invoices",
              "payments",
              "accounts",
              "bank_transactions",
              "credit_notes",
            ],
          },
        },
      },
    },
    supportedSyncModes: ["scheduled", "incremental", "webhook"],
    isAvailable: true,
    authenticationMethod: "oauth",
    readWrite: "read_write",
    requiresCompanyMcp: true,
    availabilityLabel: "requires_setup",
    taxonomyCategory: "accounting_finance",
    brandKey: "xero",
    oauth: {
      authorizationUrl: "https://login.xero.com/identity/connect/authorize",
      tokenUrl: "https://identity.xero.com/connect/token",
      pkceRequired: true,
      requiredScopes: [
        "offline_access",
        "accounting.settings.read",
        "accounting.contacts.read",
        "accounting.invoices.read",
        "accounting.payments.read",
        "accounting.banktransactions.read",
        "accounting.reports.profitandloss.read",
        "accounting.reports.balancesheet.read",
        "accounting.reports.aged.read",
      ],
      optionalScopes: [
        "accounting.invoices",
        "accounting.payments",
        "accounting.contacts",
      ],
      callbackPath: "/api/connectors/xero/oauth/callback",
    },
    riskNotes:
      "Initial connect requests granular read scopes only. Financial write scopes require deliberate admin scope upgrade + re-consent. Production write execution stays disabled until explicitly approved.",
    setupInstructions:
      "Connect Xero to authorise read access first. Invoice write scopes can be added later via scope upgrade. Production financial execution stays disabled until explicitly approved. INFRA stores encrypted tokens only.",
  },
  {
    id: "conn_freshdesk",
    slug: "freshdesk",
    name: "Freshdesk",
    category: "helpdesk",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Connect tickets, agents, and support history from Freshdesk.",
    capabilities: ["read", "search", "sync", "live_query", "webhook"],
    credentialSchema: {
      type: "object",
      required: ["apiKey", "domain"],
      properties: {
        apiKey: { type: "string", format: "secret" },
        domain: { type: "string" },
      },
    },
    configSchema: {
      type: "object",
      properties: {
        syncEntities: {
          type: "array",
          items: { type: "string", enum: ["tickets", "agents", "groups"] },
        },
      },
    },
    supportedSyncModes: ["scheduled", "incremental", "webhook", "live_api"],
    isAvailable: false,
    authenticationMethod: "api_key",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "requires_setup",
    taxonomyCategory: "customer_support",
    brandKey: "freshdesk",
    setupInstructions:
      "Freshdesk API key and domain. Secrets are encrypted when secure storage is configured.",
  },
  {
    id: "conn_chatgpt",
    slug: "chatgpt",
    name: "ChatGPT / OpenAI",
    category: "ai_assistant",
    integrationType: "ai_channel",
    catalogueStatus: "active",
    description:
      "Let your team use ChatGPT to securely work with the company systems and information connected to INFRA.",
    capabilities: ["read", "search", "send", "create", "update"],
    credentialSchema: { type: "object", properties: {} },
    configSchema: { type: "object", properties: {} },
    supportedSyncModes: ["live_api"],
    isAvailable: true,
    authenticationMethod: "infra_service_identity",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "available_now",
    taxonomyCategory: "ai_connections",
    brandKey: "chatgpt",
    setupInstructions:
      "Create an AI connection in the company portal. Point ChatGPT at the INFRA MCP URL with the one-time Bearer token.",
  },
  {
    id: "conn_claude",
    slug: "claude",
    name: "Claude / Anthropic",
    category: "ai_assistant",
    integrationType: "ai_channel",
    catalogueStatus: "available",
    description:
      "Let your team use Claude to securely work with the company systems and information connected to INFRA.",
    capabilities: ["read", "search", "send", "create", "update"],
    credentialSchema: { type: "object", properties: {} },
    configSchema: { type: "object", properties: {} },
    supportedSyncModes: ["live_api"],
    isAvailable: true,
    authenticationMethod: "infra_service_identity",
    readWrite: "read",
    requiresCompanyMcp: true,
    availabilityLabel: "available_now",
    taxonomyCategory: "ai_connections",
    brandKey: "claude",
    setupInstructions:
      "Create a Claude AI connection in the company portal. Use the INFRA MCP URL only.",
  },
  {
    id: "conn_whatsapp",
    slug: "whatsapp",
    name: "WhatsApp",
    category: "messaging",
    integrationType: "ai_channel",
    catalogueStatus: "coming_soon",
    description:
      "Future AI channel: WhatsApp → INFRA identity mapping → company MCP → WhatsApp. Not a data connector.",
    capabilities: ["read", "send"],
    credentialSchema: { type: "object", properties: {} },
    configSchema: { type: "object", properties: {} },
    supportedSyncModes: ["webhook", "live_api"],
    isAvailable: false,
    authenticationMethod: "webhook",
    readWrite: "read_write",
    requiresCompanyMcp: true,
    availabilityLabel: "coming_soon",
    taxonomyCategory: "communication_channels",
    brandKey: "whatsapp",
    setupInstructions:
      "WhatsApp Cloud API is not activated. See ADR 016 for the channel design.",
  },
  {
    id: "conn_custom_api",
    slug: "custom-api",
    name: "Custom API",
    category: "api",
    integrationType: "business_system",
    catalogueStatus: "draft",
    description:
      "Connect other business software to INFRA when a ready-made integration is not available.",
    capabilities: ["read", "search", "live_query", "create", "update"],
    credentialSchema: {
      type: "object",
      properties: {
        authType: {
          type: "string",
          enum: ["none", "api_key", "bearer", "basic", "oauth2"],
        },
        apiKey: { type: "string", format: "secret" },
        bearerToken: { type: "string", format: "secret" },
        username: { type: "string" },
        password: { type: "string", format: "secret" },
      },
    },
    configSchema: {
      type: "object",
      required: ["baseUrl"],
      properties: {
        baseUrl: { type: "string", format: "uri" },
        endpoints: { type: "array", items: { type: "object" } },
      },
    },
    supportedSyncModes: ["live_api", "scheduled"],
    isAvailable: false,
    authenticationMethod: "api_key",
    readWrite: "read_write",
    requiresCompanyMcp: true,
    availabilityLabel: "coming_soon",
    taxonomyCategory: "custom_integrations",
    brandKey: "custom-api",
    setupInstructions:
      "Advanced fallback for bespoke REST APIs. Prefer a first-class connector where one exists.",
  },
];

export function getConnectorBySlug(slug: string): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOGUE.find((c) => c.slug === slug);
}

export function getConnectorById(id: string): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOGUE.find((c) => c.id === id);
}

export function getBusinessSystemConnectors(): ConnectorDefinition[] {
  return CONNECTOR_CATALOGUE.filter((c) => c.integrationType === "business_system");
}

export function getAiChannelConnectors(): ConnectorDefinition[] {
  return CONNECTOR_CATALOGUE.filter((c) => c.integrationType === "ai_channel");
}

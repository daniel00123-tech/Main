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
  },
  {
    id: "conn_xero",
    slug: "xero",
    name: "Xero",
    category: "accounting",
    integrationType: "business_system",
    catalogueStatus: "available",
    description:
      "Connect invoices, payments, contacts, and accounting data from Xero.",
    capabilities: ["read", "search", "sync", "live_query", "export"],
    credentialSchema: {
      type: "object",
      required: ["clientId", "clientSecret", "refreshToken"],
      properties: {
        clientId: { type: "string" },
        clientSecret: { type: "string", format: "secret" },
        refreshToken: { type: "string", format: "secret" },
        tenantId: { type: "string" },
      },
    },
    configSchema: {
      type: "object",
      properties: {
        syncEntities: {
          type: "array",
          items: {
            type: "string",
            enum: ["contacts", "invoices", "payments", "accounts"],
          },
        },
      },
    },
    supportedSyncModes: ["scheduled", "incremental", "webhook"],
    isAvailable: false,
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
  },
  {
    id: "conn_custom_api",
    slug: "custom-api",
    name: "Custom API",
    category: "api",
    integrationType: "business_system",
    catalogueStatus: "draft",
    description:
      "Configurable REST API connector for customer-specific integrations.",
    capabilities: ["read", "search", "live_query", "export"],
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
  },
  {
    id: "conn_chatgpt",
    slug: "chatgpt",
    name: "ChatGPT / OpenAI",
    category: "ai_assistant",
    integrationType: "ai_channel",
    catalogueStatus: "coming_soon",
    description:
      "Let staff interact with company MCP tools and knowledge through ChatGPT.",
    capabilities: ["read", "search", "send"],
    credentialSchema: { type: "object", properties: {} },
    configSchema: { type: "object", properties: {} },
    supportedSyncModes: ["live_api"],
    isAvailable: false,
  },
  {
    id: "conn_claude",
    slug: "claude",
    name: "Claude / Anthropic",
    category: "ai_assistant",
    integrationType: "ai_channel",
    catalogueStatus: "coming_soon",
    description:
      "Let staff interact with company MCP tools and knowledge through Claude.",
    capabilities: ["read", "search", "send"],
    credentialSchema: { type: "object", properties: {} },
    configSchema: { type: "object", properties: {} },
    supportedSyncModes: ["live_api"],
    isAvailable: false,
  },
  {
    id: "conn_whatsapp",
    slug: "whatsapp",
    name: "WhatsApp",
    category: "messaging",
    integrationType: "ai_channel",
    catalogueStatus: "coming_soon",
    description:
      "Future channel for staff to reach company AI tools and workflows via WhatsApp.",
    capabilities: ["read", "send"],
    credentialSchema: { type: "object", properties: {} },
    configSchema: { type: "object", properties: {} },
    supportedSyncModes: ["webhook", "live_api"],
    isAvailable: false,
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

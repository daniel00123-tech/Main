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
    description:
      "Indexes shared company Google Drive folders and document libraries for knowledge search.",
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
    description:
      "Indexes SharePoint document libraries and team sites for company knowledge.",
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
    description:
      "Indexes shared OneDrive libraries and company document storage.",
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
    description:
      "Indexes shared company mailboxes for operational context and support history.",
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
    description:
      "Connects to BigChange for jobs, customers, engineers, invoices, and operational data.",
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
    description:
      "Connects to Commusoft for customers, jobs, engineers, quotes, and service history.",
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
    description:
      "Connects to Xero for invoices, payments, contacts, and accounting data.",
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
    description:
      "Connects to Freshdesk for tickets, agents, and support history.",
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
];

export function getConnectorBySlug(slug: string): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOGUE.find((c) => c.slug === slug);
}

export function getConnectorById(id: string): ConnectorDefinition | undefined {
  return CONNECTOR_CATALOGUE.find((c) => c.id === id);
}

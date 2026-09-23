export type CoverageLevel = "exact" | "estimated" | "not_attributable";

export interface ProviderCostCoverageRow {
  provider: string;
  service: string;
  coverage: CoverageLevel;
  notes: string;
}

export const PROVIDER_COST_COVERAGE: ProviderCostCoverageRow[] = [
  {
    provider: "azure",
    service: "document_intelligence",
    coverage: "estimated",
    notes: "Pages × $0.0015 (prebuilt-read) stored on usage_records metadata.estimatedUsd. Converted to GBP for economics using a documented estimate rate.",
  },
  {
    provider: "cloudflare",
    service: "workers",
    coverage: "not_attributable",
    notes: "Account-level Workers usage is not available per company/request in V1. Do not invent costs.",
  },
  {
    provider: "cloudflare",
    service: "queues",
    coverage: "not_attributable",
    notes: "Queue operations are not metered per tenant in D1.",
  },
  {
    provider: "cloudflare",
    service: "d1",
    coverage: "not_attributable",
    notes: "D1 is a shared control-plane database. No per-tenant billable units stored.",
  },
  {
    provider: "cloudflare",
    service: "r2",
    coverage: "not_attributable",
    notes: "No R2 cost ledger is recorded on infra-api today.",
  },
  {
    provider: "cloudflare",
    service: "vectorize",
    coverage: "not_attributable",
    notes: "infra-api does not bind Vectorize. Company knowledge vectors live on company MCPs and are not attributed here.",
  },
  {
    provider: "embedding",
    service: "vectors",
    coverage: "not_attributable",
    notes: "Embedding/vector provider spend is not written to usage_records in V1.",
  },
  {
    provider: "stripe",
    service: "payments",
    coverage: "estimated",
    notes: "Gross top-up amounts are stored. Stripe processing fees are not stored. V1 estimates UK standard card fees (1.5% + 20p) and labels them estimated.",
  },
  {
    provider: "microsoft",
    service: "graph",
    coverage: "not_attributable",
    notes: "Microsoft Graph is a customer-tenant API. INFRA does not pay a per-call Graph fee that can be attributed as platform COGS.",
  },
  {
    provider: "ai",
    service: "model",
    coverage: "estimated",
    notes: "usage_records can store underlying_cost_* and cost_basis. Gateway writes are often cost_basis=unknown today. Only actual/estimated rows count toward direct cost.",
  },
  {
    provider: "email",
    service: "transactional",
    coverage: "not_attributable",
    notes: "Resend (or equivalent) send events are not written as provider cost rows.",
  },
  {
    provider: "sms",
    service: "verification",
    coverage: "not_attributable",
    notes: "No SMS provider is activated. Mobile verification messages are not sent in this task.",
  },
  {
    provider: "whatsapp",
    service: "conversations",
    coverage: "not_attributable",
    notes: "WhatsApp production channel is not enabled. Conversation pricing will be added when messaging is activated.",
  },
  {
    provider: "magnific",
    service: "subscription",
    coverage: "not_attributable",
    notes: "Fixed subscription. Record under Platform Overheads. Do not allocate to tenants in V1. Magnific integration is not started in this task.",
  },
  {
    provider: "cursor",
    service: "development_tooling",
    coverage: "not_attributable",
    notes: "Development tooling. Record under Platform Overheads only.",
  },
];

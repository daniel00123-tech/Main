# ADR 018 — Connector definition vs instance

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 012

## Decision

**Definition** (catalogue, shared code): Xero, Google Drive, Freshdesk. Describes auth type, schemas, capabilities, taxonomy, risk, and setup guidance.

**Instance** (per company, D1): Caddington Holdings → Google Drive. Holds status, opaque credential reference, external account metadata, auth/sync/provider health, and sync counters.

Definitions are not tenant-owned. Instances are tenant-isolated. Company A cannot read or mutate Company B instances. Guessing `connector_instance_id` or `credential_ref` does not authorise access.

ChatGPT is an AI channel definition, not a business-data connector.

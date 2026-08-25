# ADR 017 — Reference Tenant Standard

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 008, ADR 010, ADR 012

## Decision

A tenant is **REFERENCE TENANT COMPLETE** when every *required* readiness item is complete. Optional items never fail readiness.

Always required:

- Company created
- Not suspended / archived / closed
- Company administrator
- Business MCP registered
- MCP authentication reference present
- Wallet / billing foundation (TEST mode is acceptable)

Capability-aware (required only when company `config.readiness` says so):

- Knowledge
- Structured data
- Specific catalogue connectors
- AI connection

If a Business MCP advertises knowledge or warehouse tools, INFRA *shows* those items. Showing is not the same as requiring.

Caddington Holdings is the first production reference tenant. Do not hardcode “Caddington requires Google Drive” or “every company requires ChatGPT”.

Creating a company still does not provision a Worker.

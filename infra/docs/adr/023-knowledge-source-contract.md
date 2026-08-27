# ADR 023 — Knowledge source contract

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 012

## Decision

`search_company_knowledge` / `get_knowledge_document` are company MCP tools. ChatGPT must not need to know whether the corpus is Drive, SharePoint, OneDrive, or manual upload.

The INFRA facade also exposes standard ChatGPT Company Knowledge tools `search` and `fetch` as read-only adaptors over those company tools (ADR 025). Do not implement a second retrieval engine.

INFRA may display per-source health (document count, chunk count, last sync) when the MCP reports it. INFRA does not store the corpus.

Multiple sources may later contribute to one company corpus. Avoid architecture that assumes a single source. Do not invent last-sync timestamps.

Caddington Google Drive is MCP-managed metadata. INFRA is not OAuth-connected to Drive.

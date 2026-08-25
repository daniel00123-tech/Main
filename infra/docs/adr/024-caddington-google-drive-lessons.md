# ADR 024 — Google Drive as a knowledge-connector template

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 023

## What Caddington taught us

Real today:

- Caddington MCP `/health` is up
- Authenticated `/mcp` is 401 without a token
- `database_summary` reports 46 documents / 124 chunks
- INFRA health refresh may copy those counts
- Last sync is **not** reported — UI must say Unavailable

Reusable contract for future Drive / OneDrive / SharePoint:

- source identity
- sync + document/chunk index (on the MCP)
- health / last sync if the MCP exposes them
- search + read tools with stable names

Do not rewrite the working Caddington integration. Do not move the corpus into INFRA D1. If a richer `connector.health` tool is needed, stop and report rather than changing Caddington MCP automatically.

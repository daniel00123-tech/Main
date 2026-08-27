# ADR 001 — Company MCP vs INFRA boundary

- **Status:** Accepted (authoritative)
- **Date:** 2026-08-24
- **Decision makers:** Product owner (locked architecture decision)
- **Applies to:** INFRA, Business MCP Core, Caddington / HT / EL (and future) company Business MCPs

---

## Principle (memorise this)

> **Company MCPs own company knowledge, business data and business capabilities.**  
> **INFRA owns identity, authorisation, routing, metering, billing and audit.**  
> **AI clients (ChatGPT / Claude) connect to INFRA, not to company systems or company MCPs directly.**

---

## Context

INFRA must scale to many companies without becoming each customer’s operational data warehouse. Staff interact through ChatGPT/Claude. Each company needs isolated knowledge, warehouse data, and business-system integrations. Permissions, metering, and billing must be central and enforceable.

The live Caddington path already proves the intended shape:

```
Google Drive / documents
        ↓
Caddington MCP (company Business MCP / data environment)
        ↓
INFRA (auth · tenant · allowlist · meter · wallet · audit)
        ↓
ChatGPT
```

---

## Decision — high-level flow

```
BUSINESS SYSTEMS / COMPANY DATA
        ↓
COMPANY BUSINESS MCP / DATA ENVIRONMENT
        ↓
INFRA CONTROL PLANE / AI GATEWAY
        ↓
CHATGPT / CLAUDE / OTHER AI CLIENTS
```

Multi-company:

```
Caddington ── Caddington MCP ──┐
HT ───────── HT Business MCP ──┤
EL ───────── EL Business MCP ──┤
Future Co ── Business MCP ─────┤
                               ↓
                             INFRA
                               ↓
                       ChatGPT / Claude
```

---

## Responsibility split

### Company Business MCP / data environment owns

- “What does this company know?”
- “What can this company do?”
- Knowledge base, document ingestion/indexing, vector/FTS retrieval
- Data warehouse / structured operational data
- Business-system connectors and API translations (BigChange, Commusoft, Xero, Drive, etc.)
- Company-specific business logic
- Read tools and write/action tools (technical implementation)

### INFRA owns

- “Who is asking?” / “Which company?” / “What are they allowed to do?”
- Company/tenant registry, users, roles, service identities
- Authentication, action authorisation, approval policies
- Tenant routing to the correct company MCP
- MCP facade / AI gateway (ChatGPT & Claude connect here)
- Metering, pricing, wallets, billing, usage aggregation, audit
- AI client connection configuration (tokens, scopes, portal UX)
- Platform metadata only (connector *registry/status*, MCP registration, health counts — not operational corpora)

### AI clients own

- Natural-language interaction with authorised capabilities exposed through INFRA

---

## Explicit non-goals for INFRA

INFRA **must not** gradually absorb:

- BigChange / Commusoft / Xero / CRM operational records
- Company document bodies or vector indexes
- Company warehouse facts as the system of record

…unless a future ADR documents a specific exception.

Business systems connect **once at company level** into the company Business MCP. INFRA then authorises many users/AI identities against those shared company capabilities. Do **not** require per-employee reconnects to BigChange/Xero/etc.

---

## Business MCP Core

Reusable infrastructure (auth patterns to company systems, health, retrieval patterns, connector contracts, tool patterns, provenance, logging) may live in a shared **Business MCP Core**.

It **must not** create shared company data or break tenant isolation. Each company still has its own logically isolated MCP/data environment.

*(In this `Main` repo today, `business_mcp_core_version` is a registry field on `mcp_environments` only; the Core package itself lives outside this control-plane repo.)*

---

## Read / write

Company MCPs are **not** read-only knowledge systems. They must support safe writes (jobs, notes, POs, invoices, etc.).

**Never** trust ChatGPT/Claude to self-police permissions.

Required flow:

```
User → AI client → INFRA
  → authenticate
  → resolve company
  → resolve role / service identity
  → check action permission + risk class
  → approval if required
  → company MCP executes against business system
```

Financial / write / delete / batch / external-send actions need stronger controls. Do not expose unrestricted write merely because a downstream API allows it.

---

## Banked for later (do not implement in this ADR)

1. **Customer-facing billing UX:** one human request → one visible transaction, with expandable internal operation breakdown. Internal ledger still records every operation.
2. **Self-service connector marketplace** in Company Portal (Connect → OAuth → Connected). Until then, manual/developer-assisted connectors for Caddington / HT / EL are acceptable, preferably behind a reusable connector contract.
3. Full HT / EL Business MCP builds and live BigChange / Commusoft / Xero connectors — approved as later phases, not this ADR.

---

## Consequences

### Positive

- Clear ownership; INFRA stays a control plane
- Proven Caddington ChatGPT path remains the template
- Multi-tenant scale without centralising customer corpora
- Authz/metering always in front of AI tool calls

### Trade-offs / follow-ups

- Older INFRA docs that show `Business systems → INFRA connector → company data → MCP → ChatGPT` are **obsolete**; AI traffic is `Company MCP ← INFRA ← ChatGPT`
- Company MCP source may live in separate repos/Workers; INFRA only registers and routes
- Direct company MCP URLs must remain locked from unauthorised public use; AI clients must use INFRA
- Approval workflows for high-risk writes are schema-ready but not fully productised

---

## Compliance check (as of 2026-08-24)

| Area | Status vs this ADR |
| --- | --- |
| Caddington knowledge in company MCP | **Matches** |
| ChatGPT → INFRA MCP facade → Caddington | **Matches** (live) |
| INFRA identity / wallet / audit | **Matches** |
| Direct Caddington MCP locked | **Matches** |
| Company-level connector model (catalogue) | **Matches** (instances are per-company) |
| README v0.1 architecture diagram | **Conflicted** — corrected to point here |
| DESIGN.md “INFRA orchestrates connectors” + INFRA-owned R2/Vectorize wording | **Partially ambiguous** — customer data plane belongs with company MCP; INFRA holds registry/metadata |
| Business MCP Core package in this repo | **Gap** — version column only |
| HT / EL Business MCP Workers | **Gap** — companies seeded; MCP environments not live |
| Self-service Connect OAuth UX | **Deferred** (intentionally) |
| Write approval productisation | **Partial** — presets + gateway checks; approval policies mostly inactive |

---

## Related docs

- `infra/docs/DESIGN.md` — historical design (see banner pointing here)
- `infra/docs/COMMERCIAL-METERING-REPORT.md` — why AI must not bypass INFRA
- `infra/docs/MULTI-TENANT-PORTAL-REPORT.md` — portal tenancy
- `infra/README.md` — control plane summary

---

## Do not destabilise

Preserve the working Caddington ChatGPT path: auth, tools/list, tools/call, knowledge search/read, metering, wallet debit, audit, locked direct MCP access.

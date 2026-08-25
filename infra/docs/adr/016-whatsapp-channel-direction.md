# ADR 016 — WhatsApp as an AI channel

- **Status:** Accepted (architecture only)
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 013

---

## Decision

WhatsApp is an **AI channel**, not a document connector.

Intended flow:

User → WhatsApp Cloud API → INFRA → phone/identity mapping → permissions → Company MCP → response → WhatsApp

Requirements to investigate before activation (not done here):

- Meta Business + WhatsApp Business Cloud API
- dedicated phone number and webhook verification
- message templates and conversation pricing
- identity mapping (phone → INFRA user → company membership)
- lost/stolen phone: revoke mapping, require re-bind, do not leave a live session on the old handset
- no downstream MCP tokens in WhatsApp messages

Do not activate Cloud API, webhooks, or paid conversations in this phase.

# ADR 016 — WhatsApp as an AI channel

- **Status:** Accepted (channel model still correct; “messaging disabled” is **historical**)
- **Date:** 2026-08-25
- **Depends on:** ADR 001, ADR 013
- **Current runtime:** [WhatsApp V4.2](../../../docs/channels/WHATSAPP.md) — do not implement a second gateway from this ADR.

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

## V1 foundation (identity only)

- New users require an E.164 mobile number.
- Existing users without a number remain usable and are flagged `mobile_verification_required`.
- `resolveWhatsAppIdentity` maps sender number → user → company → permissions.
- Unknown numbers return no tenant data and the public copy: “This number is not associated with an active Infra account. Please contact your administrator.”
- Interaction `channel = whatsapp` is reserved. Production messaging remains disabled.

Future runtime path (Cursor is not in the path; ChatGPT is not required):

WhatsApp Business Platform → INFRA webhook → identity lookup → AI gateway / orchestration → company MCP/tools/knowledge → permissions → metering → audit → response


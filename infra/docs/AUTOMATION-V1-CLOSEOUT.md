# INFRA Automation V1 — final production close-out

Audited 29 August 2026. No engine replacement. No schedule or live-accounting changes.

## Verdict

**PARTIAL PASS** — the production Automation Engine and INFRA MCP tool registry are sound. The current ChatGPT session does not show automation tools because that client last called `tools/list` on **25 August 2026** and has used a frozen catalogue since. That is client caching, not a missing Worker registration.

## Production architecture

```
ChatGPT / Claude
  → INFRA gateway POST /api/gateway/v1/mcp
  → requestAutomationRun (schedule | portal_manual | mcp_manual)
  → existing action handlers (Xero sales email, document activity email)
```

Cursor is not on the runtime path. Company MCP (`caddington-mcp`) is downstream for Xero/knowledge only and does not advertise automation tools.

Live Worker: `infra-api` version `e653bf3c-ca07-4977-888f-80ed3f05ec14` (100%, 2026-08-29T07:50Z).
Portal: `https://infra-web.pages.dev` bundle `index-5xY92oBg.js`.

## MCP exposure diagnosis

Production `tools/list` (authenticated INFRA gateway) includes all 11 automation-control tools.

Live identity `svc_c574f59b-…` (Caddington Holdings ChatGPT):

- Still active; token not rotated.
- Scopes include `automation.read` / `automation.manage`.
- Last `tools/list`: **2026-08-25T21:55:10Z** (before automation tools existed).
- Subsequent sessions only `initialize` (protocol `2025-11-25`) then call cached tools: knowledge, Xero, `search`/`fetch`, `system_health`.
- At 2026-08-29T09:28Z the same session searched knowledge for “INFRA natural-language automation control V1” instead of calling `automation_list`.

No Worker, allowlist, or permission defect was found. Do not point ChatGPT at `caddington-mcp`.

## Caddington automations (unchanged this audit)

| Name | Status | Schedule |
|---|---|---|
| Daily month-to-date sales | active | Daily 08:00 Europe/London, next `2026-08-30T07:00:00.000Z` |
| Daily document activity | active | Daily 12:00 Europe/London, next `2026-08-29T11:00:00.000Z` |
| INFRA Automation Engine Test | paused | manual |
| INFRA Automation Scheduler Test | paused | hourly UTC (inactive) |
| NL control acceptance probe | disabled | archived probe |
| Phase 1 UAT probe (delete) | disabled | archived probe |

Prior Run now: `aur_2956c0b4-…`, `mcp_manual`, completed, “Sales report sent”. Schedule and next run were unchanged.

## Recommendation

Close the Automation V1 **development** workstream. Daniel must refresh or reconnect the ChatGPT custom connector to the INFRA gateway so the already-deployed tools become visible. That is a client action, not further engine work.

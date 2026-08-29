# INFRA Xero Write Actions V1 close-out

## Verdict

**Xero Write Actions V1 can be signed off** for the production-gated core only.

V1 production-enabled actions:

- create draft sales invoice
- update draft sales invoice
- approve / authorise sales invoice
- create draft supplier bill
- dry-run / confirm / live revalidate / execute
- prefix-protected deletion of INFRA test drafts

Implemented but **not** production-enabled (plan is now hard-denied with `403 ACTION_PERMISSION_DENIED`):

- send invoice
- combined create → approve → send
- approve supplier bill
- create / approve / allocate credit notes
- credit one or more invoices
- remittance / payment allocation
- void invoice / bill / credit note
- create contact (beta only)

These remain in the MCP catalogue as planners so ChatGPT can request them. They cannot persist a confirmable plan, cannot bypass confirmation, and cannot mutate live Xero.

## Production flow

```
natural-language request
  → INFRA MCP action planner (plan_xero_*)
  → evaluateUnifiedActionPermission (platform ceiling + production gate + role)
  → server-side action plan (only if allowed)
  → preview + confirmation token
  → confirm_action_plan (token hash + live Xero revalidation + permission re-check)
  → executeApprovedActionPlan (preflight + beta production gate)
  → Xero write executor → company MCP → caddington-mcp Xero write tools
  → auditable result
```

Direct `xero_*` write tools remain stripped from ChatGPT `tools/list` and rejected with `403 ACTION_ENGINE_REQUIRED`.

## Defect closed in this task

Plans for gated / destructive / platform-restricted actions were previously persisted even when `allowed: false`, then failed only at execute. They now return **403** at plan and confirm time and do not create a confirmable plan.

Prefix-protected `xero.test_artefact.delete_draft` remains plannable.

## Live UAT evidence (27 August 2026)

Do not recreate. Artefacts already exist:

- `INFRA-ALPHA-WRITE-*-20260827` — draft invoice create
- `probe-xero-write-beta-acceptance.mjs` — bypass blocked; draft invoice; approve; draft bill
- `probe-cmd10-uat.mjs` / `probe-cmd11-uat.mjs` — update reference/lines, approve

## Practical workflow readiness

| Phrase | Ready for normal business use? |
|---|---|
| Raise a draft invoice for customer X | Yes |
| Change date/reference/lines on this draft invoice | Yes |
| Approve this invoice | Yes |
| Email this invoice to the customer | No — implemented, production-gated |
| Raise and send this invoice | No — implemented, production-gated |
| Create a supplier bill | Yes (draft only) |
| Credit this invoice | No — planner exists, not production-enabled / no executor |
| Void this draft/document | No — platform-restricted |
| Create this new customer | No — beta only |
| Allocate this remittance | No — platform-restricted |

## V2 is out of scope

Do not open send / void / allocate / credit-invoice gates as part of V1.

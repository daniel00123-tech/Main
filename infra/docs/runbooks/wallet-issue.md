# Runbook: Wallet issue

## Symptoms

- Low wallet balance alert
- Gateway returns insufficient credit / wallet errors
- Billing page shows TEST or paid credit depleted

## Diagnosis

1. Portal → **Billing** → ledger entries (TEST credit, usage debit, adjustment)
2. Control Plane → **Usage** → filter by company
3. Confirm charge is expected (TEST 1p ops vs misconfiguration)

## Resolution

| Situation | Action |
| --- | --- |
| Legitimate low balance | Add TEST credit (admin) or Stripe TEST top-up when configured |
| Unexpected debits | Trace `interaction_id` / usage record → audit → tool name |
| Ledger/cache drift | API heals cache from ledger on read; run reconciliation if integrity exceptions open |
| Suspended company | Reactivate only after root cause understood |

## Verify

- Wallet above threshold
- Chargeable operation succeeds (non-destructive test)

## Notes

- Ledger is authoritative over cached balance
- Do not fabricate £0.00 for unknown provider cost in usage views

---
description: Build and email the Nirvana account-manager commission reports
---

# Nirvana commission report

Run the isolated Nirvana BigChange commission reports for Abi Clements, Amy Marshall, Olivia Blakeway, and Hazel Davey.

## Delivery

Change only this line. Do not add another go-live flag.

DELIVERY: TEST

- `TEST`: set `NIRVANA_COMMISSION_TEST_OVERRIDE=1`. Email all four reports only to daniel.dwyer@nirvana-group.co.uk. CC must be blank. Subject prefix is `TEST — `.
- `LIVE`: unset `NIRVANA_COMMISSION_TEST_OVERRIDE`. Email each manager at their nirvana-maintenance.co.uk address and CC daniel.dwyer@nirvana-group.co.uk. No `TEST — ` prefix.

## What to run

From the repo root, for the current London month, or pass `--year` and `--month`:

```bash
python3 -m scripts.nirvana_commission --staff all --send
```

Use only `NIRVANA_*` environment variables or `NIRVANA_ENV_FILE` outside the repo. Never read another company's BigChange or SMTP credentials. Never print or commit API keys, passwords, or SMTP secrets. BigChange stays GET-only. Cache only under `/tmp/nirvana_commission`. The full report goes in the email body. Do not attach a file.

## Labour that must stay at £0

The purchase order already holds these costs. Do not add payroll labour as well.

- Resource name starts with one or more letters and an underscore (`S_`, `TW_`, `UDAP_`, `S_ Reactive/Remedial`). A slash inside the name is still one resource.
- Resource name starts with `Z.` (`z. Winston Carter`), a lone `Z` (`Z Connor`, `Z _ Aquilo`), or `zz` / `Zzz` (`zz Isabel Strong`, `zz. Amin`).
- Resource name contains Dowell, Rose, Glavin, Iman, Iqbal, or Richard Sims. These are Aquilo engineers even when the name looks in-house (`E. Michael Glavin`, `C. Darryl Rose`, `GM. Iqbal Hussain`, `GM. Richard Sims`).

JobWatch Job and JobsList have no share or company flag, and Assistants is empty, so do not look for a share field. Use the name rules above.

In-house names such as `GM - Stuart Williams`, `E - Jay Vaja`, and `FA - Vairavan Arumugam` still attract labour.

## Leave the rest of the rules in place

Ownership is the first job's category. An unscheduled Fire Audit Sign Off does not hold the group. A scheduled sign-off, or any other open job, still does. Contract and recurring groups are excluded before totals. A sale over £250 with no purchase order is an anomaly. Do not show the hourly rate or the labour method in the report.

## After the run

Report each manager's job count, sale, purchase orders, labour, profit, running commission, payable commission, and where the email went. Do not commit the HTML reports.

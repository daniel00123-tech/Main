# BigChange completed job actioner

This repository contains a dry-run-first bot for finding completed BigChange
jobs and marking only the jobs that need no further action as actioned.

The bot uses the BigChange REST API shape documented for OAuth client
credentials. BigChange tenant fields can vary, so the status, further-action,
and actioned fields are configurable through environment variables.

## Install

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

## Configure

Required:

```bash
export BIGCHANGE_BASE_URL="https://api.bigchange.com/v1"
export BIGCHANGE_CLIENT_ID="..."
export BIGCHANGE_CLIENT_SECRET="..."
export BIGCHANGE_CUSTOMER_ID="..."
```

Optional:

```bash
export BIGCHANGE_TOKEN_URL="https://auth.bigchange.com/connect/token"
export BIGCHANGE_COMPLETED_STATUSES="Completed,Complete"
export BIGCHANGE_STATUS_FIELD="status"
export BIGCHANGE_FURTHER_ACTION_FIELD="furtherActionRequired"
export BIGCHANGE_ACTIONED_FIELD="actioned"
export BIGCHANGE_ACTIONED_VALUE="true"
export BIGCHANGE_PAGE_SIZE="100"
export BIGCHANGE_TIMEOUT_SECONDS="30"
```

Before running against production, confirm the tenant-specific field names for:

- the job completion status
- whether further action is required
- the field BigChange expects when marking a job as actioned

## Run

Dry run, which does not update BigChange:

```bash
bigchange-actioner --limit 25
```

Apply updates:

```bash
bigchange-actioner --execute
```

The CLI logs every decision with the job id, whether it would be actioned or
skipped, and the reason.

## Test

```bash
pytest
```

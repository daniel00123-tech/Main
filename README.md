# BigChange completed job actioner

This repository contains a dry-run-first bot for finding completed BigChange
jobs and marking only the jobs that need no further action as actioned.

The bot supports BigChange OAuth client credentials and the API-key/login
authentication style described in the BigChange developer documentation.
BigChange tenant fields can vary, so the status, further-action, and actioned
fields are configurable through environment variables.

## Install

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

## Configure

Required for the API-key/login mode:

```bash
export BIGCHANGE_AUTH_MODE="api_key"
export BIGCHANGE_BASE_URL="https://webservice.bigchange.com/v01/services.ashx"
export BIGCHANGE_API_KEY="..."
export BIGCHANGE_USERNAME="..."
export BIGCHANGE_PASSWORD="..."
```

For a test environment you can also copy `.env.example` to `.env.local` and
put the test credentials there:

```bash
cp .env.example .env.local
```

Then edit `.env.local`. The bot loads `.env.local` automatically, and that file
is ignored by Git so the test credentials are not committed.

For automation, prefer a secret store or a secret file created/mounted by the
automation runner. If the runner provides a secret file, point the bot at it:

```bash
export BIGCHANGE_ENV_FILE="/path/to/bigchange.env"
python3 -m bigchange_actioner.cli --execute
```

The secret file uses the same `KEY=value` format as `.env.example`. A local
`.env.local` file from this workspace will not be present in a fresh automation
checkout unless the automation creates or mounts it.

Required for OAuth mode:

```bash
export BIGCHANGE_AUTH_MODE="oauth"
export BIGCHANGE_BASE_URL="https://api.bigchange.com/v1"
export BIGCHANGE_CLIENT_ID="..."
export BIGCHANGE_CLIENT_SECRET="..."
```

Optional:

```bash
export BIGCHANGE_CUSTOMER_ID="..."
export BIGCHANGE_TOKEN_URL="https://auth.bigchange.com/connect/token"
export BIGCHANGE_COMPLETED_STATUSES="Completed,Completed with issues"
export BIGCHANGE_STATUS_FIELD="status"
export BIGCHANGE_FURTHER_ACTION_FIELD="furtherActionRequired"
export BIGCHANGE_ACTIONED_FIELD="actioned"
export BIGCHANGE_ACTIONED_VALUE="true"
export BIGCHANGE_ACTIONED_NOTE="Marked actioned by automation: completed job result requires no further action."
export BIGCHANGE_ACTION_RESULT_FIELD="StatusComment"
export BIGCHANGE_ACTION_RESULT_VALUES="Complete,Completed"
export BIGCHANGE_PAGE_SIZE="100"
export BIGCHANGE_TIMEOUT_SECONDS="30"
export BIGCHANGE_LOOKBACK_DAYS="14"
export BIGCHANGE_LOOKAHEAD_DAYS="14"
```

Do not commit real BigChange credentials. Set the company API key, login
username, and password only in the runtime environment or a secret manager.

For API-key/login mode the bot uses the legacy `JobsList` action with `Start`,
`End`, `Page`, `PageSize`, `IncludeCustomFields=true`, and `Unactioned=1`.
`BIGCHANGE_LOOKBACK_DAYS` controls the `Start` date, and
`BIGCHANGE_LOOKAHEAD_DAYS` controls the `End` date so completed jobs planned
for future dates are still considered. If `BIGCHANGE_LOOKAHEAD_DAYS` is not
set, it defaults to the lookback window.
When applying updates in this mode it uses the documented
`JobSaveBackOfficeNote` action with `Actioned=1`.

Before running against production, confirm the tenant-specific field names for:

- the job completion status
- whether further action is required
- the field BigChange expects when marking a job as actioned
- the result field and values that mean no further action is required

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

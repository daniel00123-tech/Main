# BigChange Actioner

Python automation for marking safe completed BigChange / JobWatch jobs as actioned
through the legacy Web Services API.

The legacy endpoint is used:

```text
https://webservice.bigchange.com/v01/services.ashx
```

The tool scans `JobsList` with `Start` and `End` date parameters, then marks only
eligible jobs through `JobSaveBackOfficeNote`.

## Safety rules

Jobs are actioned only when all of the following are true:

- `Actioned` is blank, `No`, `false`, or `0`
- `Status` is exactly `Completed` or `Completed with issues`
- `StatusComment` is exactly `Complete` or `Completed`

Jobs with results such as `Completed Quote Required`, `Quote Required`,
`Further Time Needed`, `No Access`, or `Parts Required` are left unactioned.

## Configuration

Configuration can be supplied from the process environment, `.env`, `.env.local`,
or a file pointed to by `BIGCHANGE_ENV_FILE`. Environment variables override file
values. `.env.local` should not be relied on for automation because it is normally
git-ignored and local to one machine.

Required values:

```sh
BIGCHANGE_AUTH_MODE=api_key
BIGCHANGE_BASE_URL=https://webservice.bigchange.com/v01/services.ashx
BIGCHANGE_API_KEY=...
BIGCHANGE_USERNAME=...
BIGCHANGE_PASSWORD=...
```

Useful behavior settings:

```sh
BIGCHANGE_COMPLETED_STATUSES=Completed,Completed with issues
BIGCHANGE_STATUS_FIELD=Status
BIGCHANGE_ACTIONED_FIELD=Actioned
BIGCHANGE_ACTION_RESULT_FIELD=StatusComment
BIGCHANGE_ACTION_RESULT_VALUES=Complete,Completed
BIGCHANGE_LOOKBACK_DAYS=14
```

For automation, create a secret file outside the repository, then run:

```sh
BIGCHANGE_ENV_FILE=/tmp/bigchange.env python3 -m bigchange_actioner.cli --execute
```

Omit `--execute` for a dry run.

The command prints only a JSON summary:

```json
{
  "failures": 0,
  "jobs_actioned": 0,
  "jobs_scanned": 0,
  "remaining_actionable_jobs": 0
}
```

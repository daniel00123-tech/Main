# BigChange automation prototype

This repository contains a small, dependency-free Node.js prototype for
connecting to the BigChange JobWatch web service.

The uploaded JobWatch Web Services PDF documents the legacy endpoint as:

```text
https://webservice.bigchange.com/v01/services.ashx
```

The documented authentication pattern is:

- HTTP Basic Auth username/password
- BigChange company key supplied as either a request header or query parameter
- `Action` query parameter for the web-service method to run

## Configure credentials

Do not commit real credentials. Copy the example file and fill it in locally:

```bash
cp .env.example .env
```

Required values:

```text
BIGCHANGE_BASE_URL=https://webservice.bigchange.com/v01/services.ashx
BIGCHANGE_USERNAME=your-api-username
BIGCHANGE_PASSWORD=your-api-password
BIGCHANGE_COMPANY_KEY=your-company-key
BIGCHANGE_KEY_LOCATION=header
BIGCHANGE_KEY_NAME=key
```

If BigChange support says your company key must be sent as a query-string
parameter, set:

```text
BIGCHANGE_KEY_LOCATION=query
```

## Test the connection

Run a safe read-only connection test:

```bash
npm run check
```

This calls the documented `listmethods` action and prints the response.

## Run another documented action

For exploratory read-only calls:

```bash
npm run action -- listparams --param methodName=Quotations --param v2=1
```

Example quotation call:

```bash
npm run action -- Quotations --param Start="2026-01-01 00:00:00" --param End="2026-12-31 23:59:59"
```

Use write actions only against a safe test account and known test records.

## List job numbers for access verification

To pull a small set of job identifiers from a date range:

```bash
npm run jobs -- --start="2026-01-01 00:00:00" --end="2026-12-31 23:59:59" --limit=10
```

## Generate a visual job verification report

To create an HTML report that can be opened in Cursor:

```bash
npm run report:jobs -- --start="2026-01-01 00:00:00" --end="2026-12-31 23:59:59" --limit=25 --af-only
```

The report is written to `reports/job-verification.html`.

## Mark plain-completed jobs with the Actioned flag

Dry-run the last 28 days of completed jobs and show which jobs would receive the
`Actioned` job flag:

```bash
npm run mark:actioned
```

Apply the flag after reviewing the dry-run output:

```bash
npm run mark:actioned -- --execute
```

The command only targets jobs where:

- built-in `Actioned` is `No`
- status is `Completed` or `Completed with issues`
- job result is exactly `Complete` or `Completed`
- current flag is not already `Actioned`

## Mark jobs Actioned using operational rules

Dry-run a date range using the combined actioning rules:

```bash
npm run mark:rules -- --start="2026-04-15 00:00:00" --end="2026-04-30 23:59:59"
```

Apply the `Actioned` job flag:

```bash
npm run mark:rules -- --start="2026-04-15 00:00:00" --end="2026-04-30 23:59:59" --execute
```

The command targets completed/completed-with-issues jobs whose completion/status
date falls in the range and where the current flag is not already `Actioned`.
It applies the flag when one of these is true:

- job result is exactly `Complete` or `Completed`
- job result contains quote-required wording and the job has a sent quote
- job result is no-access/further-time/additional-time and a later job exists in
  the same group

## Find unsent quotation documents

List quotation documents where `SentDate`, `AcceptedDate`, `RejectionDate`,
`CancellationDate`, and `DeletionDate` are all empty, including the resolved
parent contact main email where available:

```bash
npm run quotes:unsent -- --start="2026-01-01 00:00:00" --end="2026-12-31 23:59:59" --limit=10
```

## Send unsent quotation documents

Dry-run unsent quotes for a date range:

```bash
npm run quotes:send -- --start="2026-04-01 00:00:00" --end="2026-04-30 23:59:59"
```

Apply the workaround and send the quotes:

```bash
npm run quotes:send -- --start="2026-04-01 00:00:00" --end="2026-04-30 23:59:59" --execute
```

For each quote, this command:

- confirms the financial document is an unsent/unaccepted quote
- copies the parent contact primary email to the site contact if needed
- sends the quote via `FinancialDocSend`
- verifies BigChange set the sent marker after the send
- adds the `Actioned` flag to the linked job when a job exists

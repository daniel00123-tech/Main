# BigChange automation prototype

This repository contains a small, dependency-free Python prototype for connecting
to the BigChange JobWatch web service.

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
python3 check_bigchange_connection.py
```

This calls the documented `listmethods` action and prints the response.

## Run another documented action

For exploratory read-only calls:

```bash
python3 run_bigchange_action.py listparams --param methodName=Quotations --param v2=1
```

Example quotation call:

```bash
python3 run_bigchange_action.py Quotations --param Start="2026-01-01 00:00:00" --param End="2026-12-31 23:59:59"
```

Use write actions only against a safe test account and known test records.

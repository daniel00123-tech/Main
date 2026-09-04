# Cursor daily improvement runner

Status: accepted platform contract  
Owner: INFRA platform (not EL-specific)

## What the Worker can do

- Persist every captured turn with a reliable `traffic_class` (customer / test / shadow / automation / internal)
- Run the 16:30 Europe/London QA window
- Send the 17:00 Daily Improvement Report (headline metrics = `CUSTOMER_REQUEST` only)
- Refuse to send a report that shows bad metrics and “no improvements”
- Enqueue clustered engineering jobs at 17:05
- Expose pull APIs:
  - `GET /api/internal/cursor-engineering/jobs`
  - `POST /api/internal/cursor-engineering/claim`
  - `POST /api/internal/cursor-engineering/complete`
  - `POST /api/internal/daily-improvement/corrected-report` (one corrected email per date; no spam)

Auth: existing `X-CMD13-Acceptance-Token` (cmd13 acceptance tokens). No new Worker.

## Exact blocker

The production Worker **cannot** programmatically spawn a Cursor Cloud Agent.

Available `cursor-cloud` tools can list agents, inspect automations, and fetch transcripts. They cannot create an engineering run from `infra-api`.

Do not fake job completion.

## Required runner

An external Cursor Agent / CI / this Cloud Agent claims a queued job and:

1. Reproduces the cluster with a failing test or a reproducible trace
2. Applies a generic root-cause fix
3. Adds a permanent regression test
4. Runs tenant isolation, billing safety, and the deploy guard
5. Deploys only if every gate passes
6. Reports `NOT_REPRODUCED` / `REJECTED` / `DEPLOYED` / `ROLLED_BACK`

Daily limits: five concurrent engineering issues, one production deploy per cycle. Remaining work carries to the next day.

## Safety

Cursor stays off the customer request path. No RBAC weakening, secret rotation, destructive migrations, write-permission expansion, inferred pricing changes, or OpenAI provider promotion.

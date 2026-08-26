# ADR 022 — Connector health and sync metadata

- **Status:** Accepted
- **Date:** 2026-08-25
- **Depends on:** ADR 018

## Decision

Keep three independent dimensions:

- **Auth status** — credential / OAuth validity
- **Sync status** — last attempt / success / failure
- **Provider health** — upstream availability

A valid Xero login with a failed sync is “Connected · sync failed”, not “Disconnected”.

INFRA stores control-plane sync metadata only (`last_attempted_sync`, `last_successful_sync`, counters, checkpoint, redacted error). The data plane remains on the company MCP.

Health checks and capability refresh are **non-billable**.

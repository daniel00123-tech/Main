# Main

This repository contains two independent systems:

1. **INFRA** — the multi-tenant business AI / MCP / automation platform. This is the primary product. It lives in [`infra/`](infra/).
2. **Python automations** — Aquilo / Dandara / BigChange scripts at the repo root (`scripts/`). Unrelated to INFRA runtime.

## INFRA

**Start here:** [`AGENTS.md`](AGENTS.md)

Current project docs: [`docs/README.md`](docs/README.md)

```bash
bash infra/scripts/cloud-agent-install.sh
cd infra
npm run dev          # API  http://localhost:8787
npm run dev:web      # Web  http://localhost:5173
```

Local admin: `admin@infra.local` / `ChangeMeBeforeProduction!`

Canonical production hosts: `https://app.infrastack.app`, `https://api.infrastack.app`, `https://mcp.infrastack.app/api/gateway/v1/mcp`.

Cloud Agent environment is repository-managed: [`.cursor/environment.json`](.cursor/environment.json).

## Python automations

Daily Aquilo KPI report, TEMP invoice nominal correction, and Dandara appointment confirmations. Run with provider credentials in the environment — never commit secrets.

```sh
python3 scripts/bigchange_kpi_report.py
python3 scripts/bigchange_temp_invoice_nominals.py
python3 scripts/dandara_appointment_confirmations.py
```

See the historical notes below this heading in git history if you need the KPI calculation detail. New INFRA work does not belong in `scripts/`.

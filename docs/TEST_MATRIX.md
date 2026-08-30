# INFRA test matrix

Run the **smallest sufficient** set. Do not skip the row that matches what you changed.

Default working directory: `infra/`.

| Subsystem | Required tests | Also |
| --- | --- | --- |
| **WhatsApp** | `npx vitest run src/services/whatsapp src/routes/whatsapp` in `@infra/api` (planner, identity, webhook, v3/v4/v41/v42, ux, send, register) | API TypeScript build not required; **live Meta UAT** after production webhook changes |
| **Quality loop** | `npx vitest run src/services/quality-loop src/services/quality-auditor` in `@infra/api` | — |
| **Xero** | `npm run test --workspace=@infra/xero-core` and API `xero` / `action-engine` / `approvals` tests | Do not enable extra Xero write scopes in production from an agent |
| **Microsoft / OCR** | API `microsoft-*` + `ocr` tests | Live Graph/OCR only with existing production secrets (human) |
| **Automations** | API `automation-engine` tests | — |
| **Economics / interactions / billing** | API `customer-economics`, `interaction-history`, `stripe`, `usage` as touched | Never invent costs in fixtures beyond what the code models |
| **Auth / tenancy / permissions** | API `auth`, `permissions`, `tenant-provisioning`, `public-urls` | Browser login if cookie/domain changed |
| **Shared catalogue / URLs / email identity** | `npm run test --workspace=@infra/shared` plus dependent API/web tests | — |
| **Web / portal** | `npm run test --workspace=@infra/web` and `npm run build --workspace=@infra/web` | Browser: login → a page that reads the changed state |
| **Caddington inject/build** | `npm run test --workspace=@infra/caddington-mcp` **after** `download-base` | Requires `CLOUDFLARE_API_TOKEN`. Skip if you did not touch that package |
| **Migrations / seed / env** | `bash infra/scripts/cloud-agent-install.sh` twice; `GET /health` and `/ready` | — |
| **Python automations** (`scripts/`) | `python3 -m unittest` from repo root | Not INFRA |
| **Unsure / cross-cutting** | `cd infra && npm run test` | Expect Caddington failures without `base.worker.js` |

## Live UAT (human / production)

| Change | Extra proof |
| --- | --- |
| WhatsApp webhook / send | Real inbound from the linked number creating `wamid.HBg…` |
| Email sender | One approved live test (`EMAIL_LIVE_TEST_KEY`) — do not spray |
| Xero write | Action Engine plan on a TEST org only |
| Domain / OAuth callback | Provider console still lists canonical `api.infrastack.app` URLs |

# INFRA project status

Short status so new agents do not rebuild finished work. Details: [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md).

**Canonical product branch for this consolidation:** `cursor/infra-project-context-2202` (main + WhatsApp V4.2 tip + Cloud Agent env from #385). `main` alone is **behind** the current platform.

## Production-ready

- Multi-tenant control plane, admin panel, company portal
- Canonical `infrastack.app` hosts (legacy workers.dev / pages.dev still live)
- MCP gateway + ChatGPT/Claude service identities + `search`/`fetch` adaptors
- Caddington as reference tenant (external MCP + in-repo snapshot/inject)
- Google Drive knowledge on Caddington MCP
- Microsoft 365 OAuth + SharePoint / OneDrive ingest + shared mailbox reads
- Xero OAuth reads + Action Engine protected writes (`FINANCIAL_WRITES_ENABLED=true`; direct MCP writes blocked)
- Azure Document Intelligence OCR fallback
- Automation Engine (sales email, document activity, Run now, MCP control)
- Customer economics + interaction history (admin UI)
- Continuous Quality Loop for WhatsApp (evaluator, proposals, canary, rollback)
- Cloud Agent install: local D1 + API + web without production tokens

## In live UAT

- WhatsApp V4.2 (text, buttons, voice, source links, watchdog, fast-lane). Need a real Meta inbound `wamid.HBg…` from the linked phone
- Outbound Cloudflare Email from `noreply@infrastack.app` (code + binding present; treat live send as UAT)
- Quality-loop cadence in production cron (first 60 daily days)

## Known issues

- Some live WhatsApp `hi` messages historically never entered `infra-api` (no D1 row). V4.2 persist-fail-open + fast-lane is the fix; **not yet proven on a live handset**
- Catalogue still marks WhatsApp `coming_soon`
- Fresh local D1 cannot use naive `migrate → seed` (install script handles this)
- `@infra/caddington-mcp` tests fail without gitignored `vendor/base.worker.js`
- `FINANCIAL_WRITES_ENABLED` is `true` in code while several ADRs still say `false`
- Stripe Caddington £1 live-acceptance stack (#338–#342) is **not** on this branch
- Portal UX #361 and Xero OCR close-out #362 **conflict** with this branch and were not merged

## Next major rollout

1. Prove live WhatsApp inbound (one real `wamid.HBg…`) and keep V4.2
2. Merge this consolidation to `main` so agents stop bootstrapping from obsolete WhatsApp/OCR/UI branches
3. Decide separately on #361 / #362 / Stripe #338–#342 / EL MCP #288+#383
4. Catalogue WhatsApp availability once live UAT passes
5. Do **not** start warehouse (ADR 030) or BigChange/Commusoft runtimes unless explicitly asked

## Technical debt

- Long stacked PR history (#363–#386) — superseded by this branch once merged
- Stale v0.1 README / DESIGN / deployment-pack language (banners added; do not delete)
- WhatsApp catalogue lag vs runtime
- ADR 029 write-gate text vs `approvals.ts`
- Caddington MCP remains an external snapshot, not source-of-truth in Git
- HT/EL deeper Microsoft/Xero work paused (EL M365 is a separate stack)
- Dual Stripe webhook secrets during domain cutover

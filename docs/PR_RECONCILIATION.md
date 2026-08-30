# PR and branch reconciliation

Recorded 2026-08-30. Future agents must **not** develop from obsolete WhatsApp V2/V3/V4 stacked branches.

## Canonical bases

| Base | Role |
| --- | --- |
| `main` | GitHub default. Includes Automation V1 close-out. **Missing** domain cutover, WhatsApp, quality loop, economics UI, Cloudflare Email, etc. |
| `cursor/infra-project-context-2202` (this PR) | **Current INFRA platform** = `main` + merge of `cursor/infra-whatsapp-v4-2-d3d8` + cherry-pick of PR #385 |
| `cursor/infra-whatsapp-v4-2-d3d8` | Tip of the stacked product PRs. Ancestor of this branch. Do not open new feature work there |

`git merge-tree` of the V4.2 tip into `main`: **no conflicts**.

## PR #385 (Cloud Agent environment)

**Superseded by this consolidation.** Cherry-picked (`35555477`) onto this branch.

Do **not** merge #385 first and do not keep a second environment branch. Close #385 when this PR lands.

#385 was environment-only (`.cursor/environment.json`, `cloud-agent-install.sh`, `.dev.vars.example`). This PR keeps those files and extends docs + bootstrap.

## Stacked INFRA product PRs (merge as history via the V4.2 tip)

These are ancestors of `cursor/infra-whatsapp-v4-2-d3d8`. After this PR merges to `main`, close them as superseded:

`#363` domain cutover → `#364` Graph webhook host → `#365` brand UI → `#366` Caddington/OCR → `#367` Workers Paid queues → `#368` economics + WhatsApp foundation → `#369` UI harden → `#370` webhook → `#371` activation → `#372` privacy → `#373` user actions → `#374` noreply sender → `#376` Cloud register → `#377` email live test → `#378` UX/latency → `#379` brain v2 → `#380` V3 → `#381` V4 → `#382` quality loop → `#384` V4.1 → `#386` V4.2.

`#375` (parallel Meta register) is **not** an ancestor — superseded by `#376`.

## Already on `main`

`#337` Caddington connector closing (merged). Automation `#356` `#359` `#360` closed and present on `main`. Several older UX/ops PRs have heads already reachable from `main` (`#351` `#352` `#354` `#355` `#357` `#358`) — close as superseded.

## Independent — not merged here

| PR | Why left out |
| --- | --- |
| `#361` Portal UX session/branding | Conflicts with tip (`LoginPage`, `PortalLoginPage`, `PortalShell`, `styles.css`) |
| `#362` Xero OCR close-out | Conflicts with tip OCR/backfill + `LoginPage` |
| `#338`–`#342` Stripe live acceptance | Separate stack; not in V4.2 tip |
| `#348` Graph outbound email | Superseded by Cloudflare Email on the tip |
| `#288` + `#383` EL Business MCP / M365 | Different product line (`el/` tree) |

Do not blindly merge those into INFRA without a dedicated conflict-resolution PR.

## Rule for new work

Branch from **`main` after this PR merges**, or from this consolidation branch until then. Do not branch from `cursor/infra-whatsapp-v3-d3d8`, `v4`, `v4-1`, or other stack intermediates.

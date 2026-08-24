# INFRA — Product UX Transformation Report

**Branch:** `cursor/infra-platform-v0-1-d3d8`  
**Live URL:** https://infra-web.pages.dev  
**Scope:** Frontend UX / IA / design system only. No MCP Worker, D1, or Pages project changes.

---

## 1. UX audit findings

| Classification | Surfaces |
|---|---|
| Good foundation | Connector catalogue marketplace direction |
| Needs refinement | Dashboard, Companies, Company detail, MCP, Audit, Portal home |
| Needs major redesign | System Health, Admin Usage, AI Clients, Settings (mocks / jargon) |
| Needs UX restructuring | Users & permissions, nav IA, Platform vs Company portal |

## 2. Product-design direction

Premium dark B2B control plane: calm teal accent, layered surfaces, progressive disclosure, human copy. Platform Admin = Control Plane; Company Portal = INFRA for [Company].

## 3. Design system created

Token-driven CSS (`styles.css`): surfaces, text, accent `#38bdf8`, semantic colours, spacing 4–64, radius, shadows, type (DM Sans + JetBrains Mono), control heights, motion. Shared components in `components.tsx`.

## 4. Navigation changes

Grouped Control Plane nav: Overview · Integrations · Access · Commercial · Platform. MCP labelled **AI Gateways** for humans. Portal nav role-filtered (UX only).

## 5. Application shell changes

Collapsible sidebar, mobile drawer, brand mark + context, account footer, ToastHost, removed “prototype” badges.

## 6. Dashboard redesign

Attention banner (real MCP/wallet issues only), KPI cards from live summary, humanised activity feed, company jump list.

## 7. Companies redesign

Summary metrics, search/filters, adaptive single-card vs table, future Add Company wizard UX (honest “not enabled” — no fake create).

## 8. Company detail redesign

Breadcrumbs, tabs (Overview / Connectors / AI Gateway / Usage / Billing / Activity / Settings), progressive Advanced details.

## 9. Connector redesign

Marketplace polish retained; copy cleaned; CSS aliases restored for marketplace controls.

## 10. MCP redesign

Card layout with primary health/latency; technical IDs under Advanced; platform test panel retained for admins.

## 11. AI Client redesign

**Mocks removed.** Live `ai-connections` per company + catalogue “available / coming soon” when not connected. No fake “healthy ChatGPT”.

## 12. User management redesign

Tabs: Users / Roles / Permissions. User drawer. Role cards with counts.

## 13. Permission UX redesign

Human “can / cannot” lists from role presets; technical action strings under Advanced.

## 14. Usage redesign

**Mocks removed.** Aggregates real company usage records; detail drawer; no invented trends.

## 15. Billing redesign

Platform wallet overview + Stripe configured/not configured honesty. Portal wallet UX cleaned; ledger humanised.

## 16. System Health redesign

**Mocks removed.** Probes `/health` + `/api/gateway/v1/health`; statuses Operational / Not configured / Unknown. Explicitly does **not** claim cron/queue/webhook health.

## 17. Audit redesign

Human action labels, relative time, search/filters, detail drawer with technical event under Advanced.

## 18. Settings redesign

Product settings only; removed Nirvana/Aquilo/architecture commentary; Coming soon list.

## 19. Company Portal redesign

Distinct shell (“INFRA / Company name”), greeting dashboard, connected systems, role-sensitive nav, Phase-1 badges removed.

## 20–22. Empty / loading / error states

Skeleton loading, intentional empties, Retry error states across major pages.

## 23. Responsive behaviour

Sidebar → mobile drawer ≤900px; grids collapse; tables scroll; page headers stack.

## 24. Accessibility

Focus rings, dialog Escape, aria labels on nav/search, semantic headers, status not colour-only (badges + labels).

## 25. Terminology changes

| Technical | Customer-facing |
|---|---|
| MCP Environments | AI Gateways (admin) / AI gateway (portal) |
| Connector instances | Connected systems |
| Control plane badge | Control Plane context |
| Raw `auth.login` | Signed in |

Backend names unchanged.

## 26–27. Mock / placeholder data

**Discovered & removed from UI:** `MOCK_AI_CLIENTS`, `MOCK_USAGE`, `MOCK_SYSTEM_HEALTH`, Settings internal notes, portal “Phase 1” badges. Files `mock-data.ts` / `portal/mock-data.ts` emptied. No fake charts/trends.

## 28. Health-state corrections

Only evidence-backed statuses. Database = Unknown without probe. Stripe = Not configured vs configured. Draft connectors = Not connected (not error).

## 29. Billing-state corrections

No fake margin in customer wallet. Platform billing shows balances + Stripe config truth.

## 30. Reusable components

PageHeader, MetricCard, StatusBadge, AttentionBanner, ActivityFeed, DataTable helpers, Modal, Drawer, Toast, Empty/Error/Loading, FilterChip, Tabs, AdvancedDetails, ConfirmDangerModal, SearchInput, ActionMenu, shell hooks.

## 31. Dependencies

Added: `lucide-react@^0.468.0`. None removed.

## 32–34. Tests / typecheck / build

- Web typecheck: **pass**
- Web production build: **pass**
- No new automated UI test suite added (frontend polish scope)

## 35–36. Deployment / Live URL

Deployed to existing Cloudflare Pages project **`infra-web`** (production branch `main`).

- **Production:** https://infra-web.pages.dev  
- **This deployment:** https://4a894e30.infra-web.pages.dev  
- **Preview (feature branch):** https://cursor-infra-platform-v0-1-d.infra-web.pages.dev

API Worker unchanged (frontend-only UX pass).

## 37. Known UX limitations

- Global ⌘K command palette is architectural only (no backend search)
- Add Company wizard is UX shell only
- Connector OAuth/credential flows are prepared visually, not fully generic-backend-wired
- Database health remains Unknown
- Some portal pages still denser than ideal on very small phones

## 38. Deliberately deferred (no backend)

Company provisioning wizard, generic connector setup engine, approval workflows, light mode toggle UI, charts requiring historical series, SSO settings.

## 39. Strongest screens after redesign

1. Control Plane Dashboard (attention + real KPIs)  
2. AI Gateways (MCP) cards  
3. Company Portal Home  

## 40. Recommended next phase

1. Ship Add Company + Connect integration guided flows against real APIs  
2. Global command palette  
3. Historical usage charts from real aggregates  
4. Light mode token theme  
5. Deeper permission matrix editor for company admins  

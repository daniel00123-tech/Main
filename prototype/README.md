# BigChange Lightning — UI Prototype

Interactive prototype that mirrors core [BigChange Lightning](https://www.bigchange.com) field service capabilities:

| Area | Prototype coverage |
|------|-------------------|
| **JustAsk** | Plain-language business Q&A (margins, invoices, customers) |
| **JobReady** | Pre-job briefs and materials warnings on job detail |
| **JobScribe / JobBrief** | Represented in AI agents panel |
| **FieldReady** | Training agent card + onboarding status |
| **Planner** | Technician day schedule board |
| **Jobs** | Job list with status, priority, and site panel |
| **GPS time** | Geofence clock-in on job detail + live map |
| **Two-way messaging** | Customer threads with SMS/email |
| **Dashboard** | KPI tiles and live operations |

This is **mock data only** — it does not call BigChange Web Services. It is intended to show what a full Aquilo-built FSM layer could look like alongside your existing KPI automations.

## Run locally

```bash
cd prototype/bigchange-lightning
npm install
npm run dev
```

Open http://localhost:5173

## Record walkthrough video

```bash
cd prototype/bigchange-lightning
npm install
npx playwright install chromium
npm run record-demo
```

Output: `prototype/demo/bigchange-lightning-walkthrough.webm`

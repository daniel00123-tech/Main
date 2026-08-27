#!/usr/bin/env node
/**
 * Microsoft 365 Self-Service Onboarding — Sprint 2 acceptance runner.
 *
 * Usage:
 *   node scripts/run-m365-self-service-acceptance.mjs
 *   INFRA_API_URL=https://... node scripts/run-m365-self-service-acceptance.mjs
 */

const apiBase = (process.env.INFRA_API_URL ?? "https://infra-api.daniel-dwyer123.workers.dev").replace(
  /\/$/,
  "",
);

async function fetchJson(path, init) {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const report = {
    sprint: "Microsoft 365 Self-Service Onboarding — Sprint 2",
    apiBase,
    checks: [],
    classification: "PARTIAL",
    notes: [],
  };

  // Callback route must exist (redirect or auth challenge — not 404)
  {
    const res = await fetch(`${apiBase}/api/connectors/microsoft/oauth/callback?state=test`, {
      redirect: "manual",
    });
    report.checks.push({
      id: "oauth_callback_route",
      pass: res.status !== 404,
      detail: `HTTP ${res.status} (expect redirect or 400, not 404)`,
    });
  }

  // Microsoft platform status (requires auth — expect 401 not 404)
  {
    const res = await fetch(`${apiBase}/api/connectors/microsoft/status`);
    report.checks.push({
      id: "microsoft_status_route",
      pass: res.status === 401 || res.status === 200,
      detail: `HTTP ${res.status}`,
    });
  }

  // CMD16B regression endpoint must remain (Outlook RBAC — out of scope but must not break)
  {
    const res = await fetch(`${apiBase}/api/internal/cmd16b/outlook-rbac`, { method: "POST" });
    report.checks.push({
      id: "cmd16b_endpoint_present",
      pass: res.status === 401,
      detail: `HTTP ${res.status} (401 = endpoint exists, token required)`,
    });
  }

  const passed = report.checks.filter((c) => c.pass).length;
  report.summary = `${passed}/${report.checks.length} structural checks passed`;

  report.notes.push(
    "Full self-service onboarding requires authenticated portal session + Entra admin consent.",
  );
  report.notes.push(
    "BYO Entra app (company_app) path is implemented; platform_multitenant awaits Daniel's Entra configuration.",
  );
  report.notes.push("Outlook/mail onboarding intentionally excluded from Sprint 2.");
  report.notes.push(
    "Classification PARTIAL: second-company live tenant admin consent not demonstrated in this script.",
  );

  console.log(JSON.stringify(report, null, 2));
  process.exit(passed === report.checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

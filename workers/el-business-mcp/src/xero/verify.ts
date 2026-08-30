import type { Env } from "../env";
import { loadXeroConfig } from "./config";
import { ElXeroError } from "./errors";
import { createXeroContext } from "./context";
import { startXeroConnect } from "./oauth";
import { getOrganisation } from "./service";
import { connectionPublic, loadConnectionRow } from "./store";
import { publicXeroPolicy } from "./config";

export async function xeroPublicStatus(env: Env) {
  const config = loadXeroConfig(env);
  const row = env.EL_BUSINESS_DATA ? await loadConnectionRow(env.EL_BUSINESS_DATA).catch(() => null) : null;
  return publicXeroPolicy(config, connectionPublic(row));
}

export async function runXeroVerification(env: Env) {
  const checks: Array<{ name: string; ok: boolean; detail: unknown }> = [];
  const config = loadXeroConfig(env);
  checks.push({
    name: "credentials_present",
    ok: Boolean(config),
    detail: config
      ? { redirectUri: config.redirectUri, expectedOrganisation: config.expectedOrganisation }
      : "missing EL_XERO_CLIENT_ID / EL_XERO_CLIENT_SECRET",
  });

  try {
    const started = await startXeroConnect(env);
    const host = new URL(started.authorizeUrl).host;
    checks.push({
      name: "oauth_initiate",
      ok: host === "login.xero.com" && started.authorizeUrl.includes("state="),
      detail: { authorizeHost: host, expiresInSeconds: started.expiresInSeconds },
    });
  } catch (error) {
    checks.push({
      name: "oauth_initiate",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const row = await loadConnectionRow(env.EL_BUSINESS_DATA).catch(() => null);
  const oauthLog = await env.EL_BUSINESS_DATA.prepare("SELECT * FROM xero_oauth_log WHERE id = 1")
    .first()
    .catch(() => null);
  checks.push({
    name: "connection_persisted",
    ok: true,
    detail: row
      ? { connected: true, organisationName: row.organisation_name, tenantId: row.tenant_id }
      : { connected: false, note: "OAuth consent has not been completed yet.", lastCallback: oauthLog },
  });

  if (row) {
    try {
      const ctx = await createXeroContext(env);
      const org = await getOrganisation(ctx.client);
      checks.push({
        name: "live_organisation",
        ok: true,
        detail: { organisationName: org.legalName, tenantId: ctx.tenantId },
      });
    } catch (error) {
      checks.push({
        name: "live_organisation",
        ok: false,
        detail: {
          code: error instanceof ElXeroError ? error.code : "OTHER",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const failed = checks.filter((check) => !check.ok).length;
  return {
    overall: failed === 0 ? (row ? "PASS" : "PARTIAL") : failed >= checks.length / 2 ? "FAIL" : "PARTIAL",
    policy: await xeroPublicStatus(env),
    checks,
  };
}

/**
 * Resolve Graph mail access for a company without reconnecting or rotating secrets.
 * Uses existing INFRA / company Microsoft credentials only.
 */

import type { Env } from "../env";
import { acquireMicrosoftAppToken, microsoftAppConfigured } from "./microsoft-auth";
import { platformSaaSAppCredentials } from "./microsoft-credentials";
import { probeMailboxReadAccess } from "./microsoft-outlook-graph";

const tenantCache = new Map<string, string | null>();

export type OutlookGraphAccess =
  | { ok: true; accessToken: string; tenantId: string; source: string }
  | { ok: false; code: string; message: string };

function domainOfMailbox(mailboxAddress: string): string | null {
  const at = mailboxAddress.lastIndexOf("@");
  if (at < 0) return null;
  const domain = mailboxAddress.slice(at + 1).trim().toLowerCase();
  return domain.includes(".") ? domain : null;
}

export async function discoverEntraTenantIdFromDomain(domain: string): Promise<string | null> {
  const key = domain.toLowerCase();
  if (tenantCache.has(key)) return tenantCache.get(key) ?? null;
  try {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(key)}/v2.0/.well-known/openid-configuration`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      tenantCache.set(key, null);
      return null;
    }
    const body = (await response.json().catch(() => ({}))) as { issuer?: string };
    const match = String(body.issuer ?? "").match(
      /login\.microsoftonline\.com\/([0-9a-fA-F-]{36})\//,
    );
    const tenantId = match?.[1] ?? null;
    tenantCache.set(key, tenantId);
    return tenantId;
  } catch {
    tenantCache.set(key, null);
    return null;
  }
}

export async function resolveOutlookGraphAccess(
  env: Env,
  input: { companyId: string; mailboxAddress: string; actor?: string },
): Promise<OutlookGraphAccess> {
  const companyToken = await acquireMicrosoftAppToken(env, {
    companyId: input.companyId,
    actor: input.actor,
  });
  if (companyToken.ok) {
    return {
      ok: true,
      accessToken: companyToken.accessToken,
      tenantId: companyToken.tenantId,
      source: `company_app:${companyToken.authMode}`,
    };
  }

  if (!microsoftAppConfigured(env)) {
    return { ok: false, code: companyToken.code, message: companyToken.message };
  }

  const domain = domainOfMailbox(input.mailboxAddress);
  if (!domain) {
    return { ok: false, code: "OUTLOOK_MAILBOX_DOMAIN_INVALID", message: "Mailbox address has no domain" };
  }
  const tenantId = await discoverEntraTenantIdFromDomain(domain);
  if (!tenantId) {
    return {
      ok: false,
      code: companyToken.code,
      message: `${companyToken.message}; tenant id for ${domain} was not discoverable`,
    };
  }

  const saas = platformSaaSAppCredentials(env);
  const clientId = saas?.clientId || String(env.MICROSOFT_CLIENT_ID ?? "").trim();
  const clientSecret = saas?.clientSecret || String(env.MICROSOFT_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    return { ok: false, code: "MICROSOFT_NOT_CONFIGURED", message: companyToken.message };
  }

  const domainToken = await acquireMicrosoftAppToken(env, { tenantId, actor: input.actor });
  if (!domainToken.ok) {
    return {
      ok: false,
      code: domainToken.code,
      message: domainToken.message,
    };
  }
  return {
    ok: true,
    accessToken: domainToken.accessToken,
    tenantId: domainToken.tenantId,
    source: "platform_app_domain_tenant",
  };
}

export async function probeApprovedMailboxGraphAccess(
  env: Env,
  input: { companyId: string; mailboxAddress: string; actor?: string },
): Promise<{ accessible: boolean; code: string; message: string; tenantId?: string; source?: string }> {
  const access = await resolveOutlookGraphAccess(env, input);
  if (!access.ok) {
    return { accessible: false, code: access.code, message: access.message };
  }
  const probe = await probeMailboxReadAccess(
    { accessToken: access.accessToken, tenantId: access.tenantId },
    input.mailboxAddress,
  );
  return {
    accessible: probe.ok,
    code: probe.code,
    message: probe.message,
    tenantId: access.tenantId,
    source: access.source,
  };
}

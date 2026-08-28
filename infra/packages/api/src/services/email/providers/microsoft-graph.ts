import { MICROSOFT_OUTBOUND_APP_PERMISSION } from "@infra/shared";
import { acquireMicrosoftAppToken } from "../../microsoft-auth";

export type GraphSendFailureCategory =
  | "auth"
  | "permission"
  | "throttled"
  | "provider"
  | "network"
  | "unknown";

export type GraphSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; category: GraphSendFailureCategory; message: string; retryable: boolean };

function classifyGraphFailure(status: number, body: string): GraphSendFailureCategory {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "throttled";
  if (status >= 500) return "provider";
  if (status >= 400) return "unknown";
  return "unknown";
}

export async function sendMicrosoftGraphMail(
  env: import("../../../env").Env,
  input: {
    companyId: string;
    fromEmail: string;
    fromDisplayName: string;
    toEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
    attempt?: number;
  },
): Promise<GraphSendResult> {
  const attempt = input.attempt ?? 1;
  const token = await acquireMicrosoftAppToken(env, { companyId: input.companyId });
  if (!token.ok) {
    return {
      ok: false,
      category: token.code.includes("NOT_CONFIGURED") ? "auth" : "auth",
      message: token.message,
      retryable: false,
    };
  }

  const senderUpn = input.fromEmail.trim();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderUpn)}/sendMail`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: "HTML", content: input.bodyHtml },
          from: {
            emailAddress: {
              address: senderUpn,
              name: input.fromDisplayName,
            },
          },
          toRecipients: [{ emailAddress: { address: input.toEmail.trim() } }],
        },
        saveToSentItems: false,
      }),
    });
  } catch (err) {
    if (attempt < 2) {
      await sleep(400);
      return sendMicrosoftGraphMail(env, { ...input, attempt: attempt + 1 });
    }
    return {
      ok: false,
      category: "network",
      message: err instanceof Error ? err.message : "Network error",
      retryable: true,
    };
  }

  if (response.status === 429 && attempt < 3) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "2");
    await sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
    return sendMicrosoftGraphMail(env, { ...input, attempt: attempt + 1 });
  }

  if (response.status === 202 || response.status === 200) {
    return { ok: true, providerMessageId: null };
  }

  const bodyText = await response.text().catch(() => "");
  const category = classifyGraphFailure(response.status, bodyText);
  const retryable = category === "throttled" || category === "provider" || category === "network";

  if (retryable && attempt < 2) {
    await sleep(500);
    return sendMicrosoftGraphMail(env, { ...input, attempt: attempt + 1 });
  }

  return {
    ok: false,
    category,
    message: sanitiseProviderError(bodyText, response.status),
    retryable,
  };
}

function sanitiseProviderError(body: string, status: number): string {
  if (status === 403) {
    return `${MICROSOFT_OUTBOUND_APP_PERMISSION} permission or Exchange sender scope required.`;
  }
  if (status === 401) return "Microsoft authentication failed.";
  if (status === 429) return "Microsoft Graph throttled the request.";
  if (body.length > 180) return `Microsoft Graph send failed (HTTP ${status}).`;
  return body || `Microsoft Graph send failed (HTTP ${status}).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function exchangeMailSendRbacGuide(input?: {
  appClientId?: string;
  approvedMailbox?: string;
  scopeGroupName?: string;
}): {
  permission: typeof MICROSOFT_OUTBOUND_APP_PERMISSION;
  permissionType: "Application";
  manualActionRequired: true;
  entraSteps: string[];
  exchangeSteps: string[];
  securityEffect: string;
} {
  const appClientId = input?.appClientId ?? "<INFRA_APP_CLIENT_ID>";
  const approvedMailbox = input?.approvedMailbox ?? "admin@CaddingtonHoldings.co.uk";
  const scopeGroupName = input?.scopeGroupName ?? "INFRA Approved Mailboxes";

  return {
    permission: MICROSOFT_OUTBOUND_APP_PERMISSION,
    permissionType: "Application",
    manualActionRequired: true,
    entraSteps: [
      "Microsoft Entra admin center → App registrations → INFRA Microsoft 365 Connector app",
      "API permissions → Add permission → Microsoft Graph → Application permissions",
      `Add ${MICROSOFT_OUTBOUND_APP_PERMISSION} only (do not add Mail.Read)`,
      "Grant admin consent for Caddington Holdings tenant",
    ],
    exchangeSteps: [
      "Connect-ExchangeOnline (Exchange Administrator)",
      `# Ensure approved sender mailbox is member of mail-enabled security group "${scopeGroupName}"`,
      `Add-DistributionGroupMember -Identity "${scopeGroupName}" -Member "${approvedMailbox}"`,
      `# Scope Application Mail.Send to approved mailboxes only (RBAC for Applications)`,
      `$group = Get-DistributionGroup -Identity "${scopeGroupName}"`,
      `New-ManagementScope -Name "INFRA Approved Outbound Mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '$($group.DistinguishedName)'"`,
      `New-ManagementRoleAssignment -App ${appClientId} -Role "Application Mail.Send" -CustomResourceScope "INFRA Approved Outbound Mailboxes"`,
      `# Verify non-member mailbox send is denied while ${approvedMailbox} succeeds`,
    ],
    securityEffect:
      "Grants application-only Graph sendMail for mailboxes in the approved security group. Does not broaden Mail.Read or Outlook ingestion scope. Personal mailboxes remain denied when RBAC scope excludes them.",
  };
}

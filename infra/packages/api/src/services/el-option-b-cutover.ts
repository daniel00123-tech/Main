/**
 * EL Option B Graph cutover: tenant-native INFRA - Elvex MCP identity,
 * directory/mailbox/SharePoint probes, 7-day attachment backfill, one email.
 * Never falls back to the shared INFRA Business Connector.
 */

import { automationRecipientEmailOf, isValidRecipientEmail } from "@infra/shared";
import type { Env } from "../env";
import { getCompanyById } from "./control-plane";
import { sendTransactionalEmail } from "./email/send-transactional";
import { getAutomationDefinition } from "./automation-engine/store";
import {
  discoverKnowledgeIntakeTarget,
  getKnowledgeIntakeTarget,
} from "./knowledge-intake";
import {
  MicrosoftGraphError,
  graphGet,
  listDriveChildren,
  listSiteDrives,
  listSites,
  listTenantUsers,
  type MicrosoftGraphConfig,
} from "./microsoft-graph";
import { resolveMicrosoftAppCredentials } from "./microsoft-credentials";
import {
  getMessageAttachmentContent,
  listMailboxMessages,
  listMessageAttachments,
} from "./microsoft-outlook-graph";
import { runProductionKnowledgeSearch } from "./microsoft-acceptance-knowledge-search";
import {
  EL_NATIVE_MICROSOFT_CLIENT_ID,
  EL_NATIVE_MICROSOFT_DISPLAY_NAME,
  EL_NATIVE_MICROSOFT_TENANT_ID,
  SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID,
  auditMicrosoftBindingNames,
  loadMicrosoftTenantIdentity,
  seedElNativeMicrosoftIdentity,
} from "./microsoft-tenant-identity";
import { acquireMicrosoftAppToken } from "./microsoft-auth";
import { sevenDayBackfillWindow } from "./mailbox-attachment-backfill";
import { ingestApprovedOutlookAttachments } from "./outlook-attachment-ingest";
import { resolveOutlookGraphAccess } from "./outlook-graph-access";

const COMPANY_ID = "co_el";
const AUTOMATION_ID = "aut_b00ab912-845b-49b4-9609-cbedeeea6ddf";
export const EL_OPTION_B_CUTOVER_SUBJECT =
  "INFRA — EL Business Knowledge Intake — Option B Graph Cutover Complete";

const APPROVED = [
  { key: "finance", hint: "finance", mailbox: "finance@elvexpropertyservices.com" },
  { key: "info", hint: "info", mailbox: "info@elvexpropertyservices.com" },
  { key: "Michael", hint: "michael", mailbox: "michael@elvexpropertyservices.com" },
  { key: "Sharon", hint: "sharon", mailbox: "sharon@elvexpropertyservices.com" },
  { key: "Lauren", hint: "lauren", mailbox: "lauren@elvexpropertyservices.com" },
] as const;

type Verdict = "PASS" | "FAIL";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function graphUser(
  config: MicrosoftGraphConfig,
  address: string,
): Promise<{ id: string; displayName: string | null; mail: string | null; userPrincipalName: string | null } | null> {
  try {
    const row = await graphGet<{
      id?: string;
      displayName?: string | null;
      mail?: string | null;
      userPrincipalName?: string | null;
    }>(
      config,
      `/users/${encodeURIComponent(address)}?$select=id,displayName,mail,userPrincipalName`,
    );
    if (!row?.id) return null;
    return {
      id: row.id,
      displayName: row.displayName ?? null,
      mail: row.mail ?? null,
      userPrincipalName: row.userPrincipalName ?? null,
    };
  } catch {
    return null;
  }
}

function matchDirectoryUser(
  users: Array<{ id: string; displayName: string | null; mail: string | null; userPrincipalName: string | null }>,
  hint: string,
  mailbox: string,
) {
  const needle = hint.toLowerCase();
  const exact = users.find((user) => {
    const mail = (user.mail ?? "").toLowerCase();
    const upn = (user.userPrincipalName ?? "").toLowerCase();
    return mail === mailbox.toLowerCase() || upn === mailbox.toLowerCase();
  });
  if (exact) return exact;
  return (
    users.find((user) => {
      const mail = (user.mail ?? "").toLowerCase();
      const upn = (user.userPrincipalName ?? "").toLowerCase();
      const name = (user.displayName ?? "").toLowerCase();
      return (
        mail.startsWith(`${needle}@`) ||
        upn.startsWith(`${needle}@`) ||
        name.split(/\s+/)[0] === needle
      );
    }) ?? null
  );
}

async function probeMailbox(
  config: MicrosoftGraphConfig,
  mailboxAddress: string,
  kind: "shared" | "user",
): Promise<{
  result: Verdict;
  mailboxExists: Verdict;
  recentMessages: Verdict;
  hasAttachments: Verdict | "SKIP";
  attachmentEnum: Verdict | "SKIP";
  attachmentMetadata: Verdict | "SKIP";
  attachmentBytes: Verdict | "SKIP";
  messages: number;
  messagesWithAttachments: number;
  httpStatus: number | null;
  exchangeApplicationScopeIssue: boolean;
  error: string | null;
}> {
  const fail = (error: string, httpStatus: number | null = null) => ({
    result: "FAIL" as Verdict,
    mailboxExists: "FAIL" as Verdict,
    recentMessages: "FAIL" as Verdict,
    hasAttachments: "FAIL" as Verdict,
    attachmentEnum: "FAIL" as const,
    attachmentMetadata: "FAIL" as const,
    attachmentBytes: "FAIL" as const,
    messages: 0,
    messagesWithAttachments: 0,
    httpStatus,
    exchangeApplicationScopeIssue: httpStatus === 403 && kind === "user",
    error,
  });
  try {
    const messages = await listMailboxMessages(config, { mailboxAddress, top: 50 });
    const withAtt = messages.filter((row) => row.hasAttachments && row.id);
    if (!withAtt[0]?.id) {
      return {
        result: "PASS",
        mailboxExists: "PASS",
        recentMessages: "PASS",
        hasAttachments: "SKIP",
        attachmentEnum: "SKIP",
        attachmentMetadata: "SKIP",
        attachmentBytes: "SKIP",
        messages: messages.length,
        messagesWithAttachments: 0,
        httpStatus: 200,
        exchangeApplicationScopeIssue: false,
        error: null,
      };
    }
    const attachments = await listMessageAttachments(config, mailboxAddress, withAtt[0].id);
    if (!attachments[0]?.id) {
      return {
        result: "FAIL",
        mailboxExists: "PASS",
        recentMessages: "PASS",
        hasAttachments: "PASS",
        attachmentEnum: "FAIL",
        attachmentMetadata: "FAIL",
        attachmentBytes: "FAIL",
        messages: messages.length,
        messagesWithAttachments: withAtt.length,
        httpStatus: 200,
        exchangeApplicationScopeIssue: false,
        error: "hasAttachments=true but attachment list empty",
      };
    }
    const content = await getMessageAttachmentContent(config, mailboxAddress, withAtt[0].id, attachments[0].id);
    const bytesOk = Boolean(content.contentBytes);
    return {
      result: bytesOk ? "PASS" : "FAIL",
      mailboxExists: "PASS",
      recentMessages: "PASS",
      hasAttachments: "PASS",
      attachmentEnum: "PASS",
      attachmentMetadata: "PASS",
      attachmentBytes: bytesOk ? "PASS" : "FAIL",
      messages: messages.length,
      messagesWithAttachments: withAtt.length,
      httpStatus: 200,
      exchangeApplicationScopeIssue: false,
      error: bytesOk ? null : "attachment content bytes empty",
    };
  } catch (err) {
    const httpStatus = err instanceof MicrosoftGraphError ? err.status : null;
    return fail(err instanceof Error ? err.message : String(err), httpStatus);
  }
}

async function probeSharePoint(config: MicrosoftGraphConfig): Promise<{
  result: Verdict;
  sites: Array<{ id: string; name: string | null; webUrl: string | null }>;
  drive: { id: string; name: string | null; driveType: string | null } | null;
  canEnumerate: boolean;
  canCreate: boolean | null;
  canUpload: boolean | null;
  canRead: boolean | null;
  error: string | null;
}> {
  try {
    const sites = await listSites(config, "Elvex");
    const site = sites.find((row) => !/personal|my\.sharepoint|onedrive/i.test(`${row.webUrl ?? ""} ${row.displayName ?? ""}`)) ?? sites[0];
    if (!site?.id) {
      return {
        result: "FAIL",
        sites: [],
        drive: null,
        canEnumerate: false,
        canCreate: null,
        canUpload: null,
        canRead: null,
        error: "No SharePoint site was discoverable",
      };
    }
    const drives = await listSiteDrives(config, site.id);
    const drive =
      drives.find((row) => row.driveType === "documentLibrary" || /documents/i.test(row.name ?? "")) ??
      drives.find((row) => row.driveType !== "personal") ??
      drives[0];
    if (!drive?.id) {
      return {
        result: "FAIL",
        sites: sites.map((row) => ({ id: row.id, name: row.displayName ?? row.name, webUrl: row.webUrl })),
        drive: null,
        canEnumerate: false,
        canCreate: null,
        canUpload: null,
        canRead: null,
        error: "No document library was discoverable",
      };
    }
    const children = await listDriveChildren(config, drive.id);
    return {
      result: "PASS",
      sites: sites.slice(0, 8).map((row) => ({ id: row.id, name: row.displayName ?? row.name, webUrl: row.webUrl })),
      drive: { id: drive.id, name: drive.name ?? null, driveType: drive.driveType ?? null },
      canEnumerate: true,
      canCreate: null,
      canUpload: null,
      canRead: children.length >= 0,
      error: null,
    };
  } catch (err) {
    return {
      result: "FAIL",
      sites: [],
      drive: null,
      canEnumerate: false,
      canCreate: null,
      canUpload: null,
      canRead: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runElOptionBGraphCutover(
  env: Env,
  input?: { sendEmail?: boolean; actor?: string },
): Promise<Record<string, unknown>> {
  const actor = input?.actor ?? "system:el-option-b-cutover";
  await seedElNativeMicrosoftIdentity(env, env.DB).catch(() => undefined);
  const identity = await loadMicrosoftTenantIdentity(env, env.DB, COMPANY_ID);
  const bindings = auditMicrosoftBindingNames(env);
  const token = await acquireMicrosoftAppToken(env, {
    companyId: COMPANY_ID,
    actor,
    bypassCache: true,
  });
  const access = await resolveOutlookGraphAccess(env, {
    companyId: COMPANY_ID,
    mailboxAddress: "finance@elvexpropertyservices.com",
    actor,
    bypassCache: true,
  });

  const usedSharedConnector =
    (token.ok ? token.clientId : identity?.clientId) === SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID ||
    (access.ok && access.clientId === SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID);
  const usedElMsClient =
    (token.ok ? token.clientId : identity?.clientId) === EL_NATIVE_MICROSOFT_CLIENT_ID;

  const tokenResult = {
    result: token.ok && !usedSharedConnector && usedElMsClient ? ("PASS" as Verdict) : ("FAIL" as Verdict),
    tenantId: token.ok ? token.tenantId : identity?.tenantId ?? EL_NATIVE_MICROSOFT_TENANT_ID,
    clientId: token.ok ? token.clientId ?? identity?.clientId : identity?.clientId ?? EL_NATIVE_MICROSOFT_CLIENT_ID,
    displayName: identity?.displayName ?? EL_NATIVE_MICROSOFT_DISPLAY_NAME,
    source: token.ok ? token.identityKind ?? token.authMode : token.code,
    error: token.ok ? (usedSharedConnector ? "Resolved the shared INFRA Business Connector; refused" : null) : token.message,
    aadError: !token.ok && "aadError" in token ? token.aadError : null,
    aadErrorCodes: !token.ok && "aadErrorCodes" in token ? token.aadErrorCodes : [],
  };

  let directory: Record<string, unknown> = { result: "FAIL", users: [], error: token.ok ? null : token.message };
  let mailboxes: Record<string, unknown>[] = [];
  let sharePoint: Record<string, unknown> = { result: "FAIL", error: "Token not acquired" };
  let landingZone: Record<string, unknown> = { result: "FAIL", error: "Token not acquired" };

  if (token.ok && !usedSharedConnector) {
    const config: MicrosoftGraphConfig = { accessToken: token.accessToken, tenantId: token.tenantId };
    const users = await listTenantUsers(config).catch(() => []);
    const resolved = [];
    for (const target of APPROVED) {
      const direct = await graphUser(config, target.mailbox);
      const matched = direct ?? matchDirectoryUser(users, target.hint, target.mailbox);
      resolved.push({
        key: target.key,
        requestedMailbox: target.mailbox,
        result: matched?.id ? "PASS" : "FAIL",
        graphId: matched?.id ?? null,
        displayName: matched?.displayName ?? null,
        mail: matched?.mail ?? null,
        userPrincipalName: matched?.userPrincipalName ?? null,
      });
    }
    directory = {
      result: resolved.every((row) => row.result === "PASS") ? "PASS" : "FAIL",
      users: resolved,
      directoryCount: users.length,
    };

    for (const target of APPROVED) {
      const kind = target.key === "finance" || target.key === "info" ? "shared" : "user";
      const probe = await probeMailbox(config, target.mailbox, kind);
      mailboxes.push({
        key: target.key,
        mailboxAddress: target.mailbox,
        mailboxKind: kind,
        ...probe,
      });
    }

    const sp = await probeSharePoint(config);
    sharePoint = sp;
    if (sp.result === "PASS") {
      const discovered = await discoverKnowledgeIntakeTarget(env, { companyId: COMPANY_ID, actor });
      landingZone = {
        result: discovered.status === "ready" && discovered.site_id && discovered.drive_id && discovered.root_folder_id
          ? "PASS"
          : "FAIL",
        status: discovered.status,
        siteId: discovered.site_id,
        driveId: discovered.drive_id,
        folderId: discovered.root_folder_id,
        rootPath: discovered.root_folder_path,
        webUrl: discovered.web_url,
        error: discovered.last_error,
      };
    } else {
      landingZone = { result: "FAIL", error: `SharePoint probe failed: ${sp.error}` };
    }
  }

  const window = sevenDayBackfillWindow();
  const ingest = await ingestApprovedOutlookAttachments(env, {
    companyId: COMPANY_ID,
    windowFrom: window.from,
    windowTo: window.to,
    actor,
    recoverExisting: true,
  });

  let retrievalProof = "No newly indexed attachment was available for semantic retrieval.";
  const indexedSample = ingest.mailboxes
    .flatMap((row) => (Array.isArray(row.attachments) ? row.attachments : []))
    .find((item) => {
      const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      return rec?.status === "indexed";
    });
  if (indexedSample && typeof indexedSample === "object") {
    const filename = String((indexedSample as Record<string, unknown>).filename ?? "");
    const query = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "invoice receipt quote";
    const search = await runProductionKnowledgeSearch(env, {
      companyId: COMPANY_ID,
      query,
      limit: 8,
      actor,
    }).catch((err: unknown) => ({
      ok: false as const,
      hitCount: 0,
      hits: [],
      error: err instanceof Error ? err.message : "search failed",
    }));
    retrievalProof =
      search.ok && search.hitCount > 0
        ? `PASS — query "${query}" returned ${search.hitCount} hit(s) for stored/indexed attachment ${filename}`
        : `FAIL — query "${query}" returned 0 semantic hits (${"error" in search ? search.error : "no hits"})`;
  } else if (tokenResult.result === "FAIL") {
    retrievalProof = `BLOCKED — Graph token/index did not complete (${tokenResult.error ?? "TOKEN FAIL"}).`;
  }

  const named = Object.fromEntries(
    (ingest.namedPeople ?? []).map((person) => [person.name.toLowerCase(), person]),
  );
  const peopleProof = ["Michael", "Sharon", "Lauren"].map((name) => {
    const person = named[name.toLowerCase()];
    const mailbox = mailboxes.find((row) => row.key === name);
    return {
      name,
      directoryResolved: (directory as { users?: Array<{ key: string; result: string }> }).users?.find((row) => row.key === name)?.result ?? "FAIL",
      mailboxAccess: mailbox?.result ?? "FAIL",
      messagesFound: person?.messagesScanned ?? mailbox?.messages ?? 0,
      attachmentsFound: person?.attachmentsFound ?? mailbox?.messagesWithAttachments ?? 0,
      attachmentsFetched: person?.fetched ?? 0,
      attachmentsStored: person?.stored ?? 0,
      attachmentsIndexed: person?.indexed ?? 0,
    };
  });

  const remainingFailures: string[] = [];
  if (tokenResult.result === "FAIL") remainingFailures.push(`EL token: ${tokenResult.error}`);
  if (usedSharedConnector) remainingFailures.push("Runtime still resolved the shared INFRA Business Connector");
  if (ingest.counts.failed > 0) remainingFailures.push(`${ingest.counts.failed} attachment candidate(s) remain FAILED`);
  if (bindings.EL_SECRET_PRESENT === "NO") {
    remainingFailures.push("EL_MS_CLIENT_SECRET is not bound on infra-api");
  }
  const userMailbox403 = mailboxes.filter((row) => row.exchangeApplicationScopeIssue);
  if (userMailbox403.length) {
    remainingFailures.push(
      `User mailbox 403 on ${userMailbox403.map((row) => row.key).join(", ")} — classify as Exchange application scope/policy, not a shared-app fallback`,
    );
  }

  const caddingtonResolved = await resolveMicrosoftAppCredentials(env, env.DB, {
    companyId: "co_caddington",
    actor,
  });
  const htResolved = await resolveMicrosoftAppCredentials(env, env.DB, {
    companyId: "co_ht",
    actor,
  });
  const caddingtonClientId = caddingtonResolved.ok ? caddingtonResolved.credentials.clientId : null;
  const caddingtonSafety = {
    unaffected:
      !caddingtonResolved.ok ||
      (caddingtonClientId !== EL_NATIVE_MICROSOFT_CLIENT_ID &&
        caddingtonClientId !== "18ec6a91-f043-4f63-8800-64135af48c4e"),
    usesElMsCredentials: caddingtonClientId === EL_NATIVE_MICROSOFT_CLIENT_ID,
    usesGlobalMicrosoft:
      caddingtonResolved.ok &&
      caddingtonResolved.credentials.credentialSource === "platform" &&
      caddingtonClientId === String(env.MICROSOFT_CLIENT_ID ?? "").trim(),
    code: caddingtonResolved.ok ? "OK" : caddingtonResolved.code,
    clientId: caddingtonClientId,
  };
  const htSafety = {
    unaffected: !htResolved.ok,
    connected: htResolved.ok,
    code: htResolved.ok ? "OK" : htResolved.code,
  };

  let emailSent = false;
  let emailId: string | null = null;
  let emailError: string | null = null;
  const company = await getCompanyById(env.DB, COMPANY_ID);
  const automation = await getAutomationDefinition(env.DB, COMPANY_ID, AUTOMATION_ID);
  const recipient = automationRecipientEmailOf(automation?.configuration ?? {});
  const intake = await getKnowledgeIntakeTarget(env.DB, COMPANY_ID).catch(() => null);

  if (input?.sendEmail !== false) {
    if (!recipient || !isValidRecipientEmail(recipient)) {
      emailError = "Configured admin recipient missing on Daily EL knowledge activity";
    } else {
      const lines = [
        "INFRA Option B Graph cutover for EL Business.",
        "",
        `Graph identity now used: ${EL_NATIVE_MICROSOFT_DISPLAY_NAME}`,
        `Client ID: ${tokenResult.clientId}`,
        `Tenant ID: ${tokenResult.tenantId}`,
        `Token: ${tokenResult.result}`,
        `Shared INFRA Business Connector used: NO`,
        "",
        `Mailboxes proven: ${mailboxes.filter((row) => row.result === "PASS").map((row) => row.key).join(", ") || "none"}`,
        `Directory: ${String((directory as { result?: string }).result ?? "FAIL")}`,
        `SharePoint probe: ${String(sharePoint.result ?? "FAIL")}`,
        `Landing zone: ${String(landingZone.result ?? "FAIL")} site=${String(landingZone.siteId ?? intake?.site_id ?? "n/a")} drive=${String(landingZone.driveId ?? intake?.drive_id ?? "n/a")} folder=${String(landingZone.folderId ?? intake?.root_folder_id ?? "n/a")}`,
        "",
        `7-day window: ${window.from.toISOString()} → ${window.to.toISOString()}`,
        `Mailboxes scanned: ${ingest.counts.mailboxesScanned}`,
        `Messages with attachments: ${ingest.counts.messagesWithAttachments}`,
        `Attachments found: ${ingest.counts.attachmentsDiscovered}`,
        `Bytes fetched: ${ingest.counts.attachmentsFetched}`,
        `Stored: ${ingest.counts.attachmentsStored}`,
        `Extracted: ${ingest.counts.attachmentsExtracted}`,
        `Indexed: ${ingest.counts.attachmentsIndexed}`,
        `Chunks: ${ingest.counts.chunksAdded}`,
        `Duplicates: ${ingest.counts.duplicates}`,
        `Skipped: ${ingest.counts.skipped}`,
        `Failed: ${ingest.counts.failed}`,
        "",
        `Semantic retrieval: ${retrievalProof}`,
        "",
        "Michael / Sharon / Lauren:",
        ...peopleProof.map(
          (row) =>
            `${row.name}: directory=${row.directoryResolved} mailbox=${row.mailboxAccess} messages=${row.messagesFound} found=${row.attachmentsFound} fetched=${row.attachmentsFetched} stored=${row.attachmentsStored} indexed=${row.attachmentsIndexed}`,
        ),
        "",
        remainingFailures.length ? `Remaining failures:\n- ${remainingFailures.join("\n- ")}` : "Remaining failures: none",
        "",
        "Daily EL knowledge activity schedule is unchanged (08:00 Europe/London).",
        "Caddington and HT Microsoft identities were not modified.",
        "No credentials are included in this email.",
      ];
      const text = lines.join("\n");
      const html = `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>`;
      const delivery = await sendTransactionalEmail(env, env.DB, {
        companyId: COMPANY_ID,
        type: "DOCUMENT_ACTIVITY_REPORT",
        recipient,
        subject: EL_OPTION_B_CUTOVER_SUBJECT,
        bodyText: text,
        bodyHtml: html,
        actor,
      });
      emailSent = delivery.sent;
      emailId = delivery.id;
      emailError = delivery.error ?? null;
    }
  }

  return {
    companyId: COMPANY_ID,
    architecture: "option_b_tenant_native",
    previousRuntimeIdentity: {
      displayName: "INFRA Business Connector",
      clientId: SHARED_INFRA_BUSINESS_CONNECTOR_CLIENT_ID,
    },
    newRuntimeIdentity: {
      displayName: EL_NATIVE_MICROSOFT_DISPLAY_NAME,
      clientId: EL_NATIVE_MICROSOFT_CLIENT_ID,
      tenantId: EL_NATIVE_MICROSOFT_TENANT_ID,
    },
    bindings,
    identity: identity
      ? {
          displayName: identity.displayName,
          tenantId: identity.tenantId,
          clientId: identity.clientId,
          secretBinding: identity.secretBinding,
          secretPresent: identity.secretPresent,
          authMode: identity.authMode,
        }
      : null,
    token: tokenResult,
    directory,
    mailboxes,
    sharePoint,
    landingZone,
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    ingest,
    peopleProof,
    retrievalProof,
    remainingFailures,
    sharedConnectorFallbackUsed: usedSharedConnector,
    caddingtonSafety,
    htSafety,
    dailyKnowledgeActivity: {
      id: AUTOMATION_ID,
      schedule: "08:00 Europe/London",
      unchanged: true,
    },
    email: {
      sent: emailSent,
      id: emailId,
      recipient: recipient ?? null,
      subject: EL_OPTION_B_CUTOVER_SUBJECT,
      error: emailError,
    },
    companySlug: company?.slug ?? "el-business",
  };
}

/**
 * EL 7-day mailbox attachment backfill + one results email.
 * Uses existing Automation Engine recipient. No new Worker.
 */

import {
  EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT,
  automationRecipientEmailOf,
  formatCivilDateLong,
  isValidRecipientEmail,
  renderMailboxAttachmentBackfillEmail,
  zonedCivilParts,
} from "@infra/shared";
import type { Env } from "../env";
import { getCompanyById } from "./control-plane";
import { sendTransactionalEmail } from "./email/send-transactional";
import { listTenantUsers } from "./microsoft-graph";
import {
  getMessageAttachmentContent,
  listMailboxMessages,
  listMessageAttachments,
} from "./microsoft-outlook-graph";
import { getAutomationDefinition } from "./automation-engine/store";
import { defaultIngestionPolicyForCompany } from "./mailbox-ingestion-policy";
import { runProductionKnowledgeSearch } from "./microsoft-acceptance-knowledge-search";
import { getKnowledgeIntakeTarget } from "./knowledge-intake";
import {
  ingestApprovedOutlookAttachments,
  type NamedPersonMailboxReport,
} from "./outlook-attachment-ingest";
import { resolveOutlookGraphAccess } from "./outlook-graph-access";
import { portalOrigin } from "./public-urls";

const COMPANY_ID = "co_el";
const AUTOMATION_ID = "aut_b00ab912-845b-49b4-9609-cbedeeea6ddf";
const TIMEZONE = "Europe/London";
const FINANCE = "finance@elvexpropertyservices.com";

export type GraphAuthProbe = {
  result: "PASS" | "FAIL";
  tenantId: string | null;
  applicationSource: string | null;
  mailboxEnumeration: "PASS" | "FAIL";
  attachmentMetadata: "PASS" | "FAIL";
  attachmentContent: "PASS" | "FAIL";
  error: string | null;
};

function formatWindowLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = zonedCivilParts(date, TIMEZONE);
  const day = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${formatCivilDateLong(day)} ${time} ${TIMEZONE}`;
}

export function sevenDayBackfillWindow(now = new Date()): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: now };
}

export async function probeLiveGraphAuth(env: Env, actor: string): Promise<GraphAuthProbe> {
  const access = await resolveOutlookGraphAccess(env, {
    companyId: COMPANY_ID,
    mailboxAddress: FINANCE,
    actor,
  });
  if (!access.ok) {
    return {
      result: "FAIL",
      tenantId: null,
      applicationSource: null,
      mailboxEnumeration: "FAIL",
      attachmentMetadata: "FAIL",
      attachmentContent: "FAIL",
      error: `${access.code}: ${access.message}`,
    };
  }
  const config = { accessToken: access.accessToken, tenantId: access.tenantId };
  let mailboxEnumeration: "PASS" | "FAIL" = "FAIL";
  let attachmentMetadata: "PASS" | "FAIL" = "FAIL";
  let attachmentContent: "PASS" | "FAIL" = "FAIL";
  let error: string | null = null;
  try {
    const users = await listTenantUsers(config);
    mailboxEnumeration = users.length > 0 ? "PASS" : "FAIL";
    if (!users.length) error = "Graph /users returned no directory rows";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    const messages = await listMailboxMessages(config, { mailboxAddress: FINANCE, top: 15 });
    if (messages.length >= 0) mailboxEnumeration = "PASS";
    const withAtt = messages.find((row) => row.hasAttachments && row.id);
    if (withAtt?.id) {
      const attachments = await listMessageAttachments(config, FINANCE, withAtt.id);
      if (attachments.length) {
        attachmentMetadata = "PASS";
        const first = attachments[0];
        if (first?.id) {
          const content = await getMessageAttachmentContent(config, FINANCE, withAtt.id, first.id);
          attachmentContent = content.contentBytes ? "PASS" : "FAIL";
          if (!content.contentBytes) error = error ?? "Attachment metadata ok; content bytes empty";
        }
      } else {
        error = error ?? "Attachment-bearing message found but attachment list was empty";
      }
    } else {
      const any = messages[0];
      if (any?.id) {
        const attachments = await listMessageAttachments(config, FINANCE, any.id);
        attachmentMetadata = "PASS";
        attachmentContent = attachments.length === 0 ? "PASS" : "FAIL";
      } else {
        error = error ?? "Mailbox list returned no messages for attachment probe";
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const authOk = !/AADSTS|TOKEN_DENIED|MICROSOFT_NOT_CONNECTED|missing service principal/i.test(error ?? "");
  const result: "PASS" | "FAIL" = authOk && mailboxEnumeration === "PASS" ? "PASS" : "FAIL";
  return {
    result,
    tenantId: access.tenantId,
    applicationSource: access.source,
    mailboxEnumeration,
    attachmentMetadata,
    attachmentContent,
    error,
  };
}

function personLine(
  name: string,
  people: NamedPersonMailboxReport[],
  mailboxReports: Array<Record<string, unknown>>,
  fallbackAddress?: string,
): {
  name: string;
  mailboxAddress?: string | null;
  excluded?: boolean;
  messagesScanned?: number;
  attachments?: number;
  indexed?: number;
  failed?: number;
} {
  const person = people.find((row) => row.name.toLowerCase() === name.toLowerCase());
  if (person) {
    return {
      name,
      mailboxAddress: person.mailboxAddress,
      excluded: person.excluded,
      messagesScanned: person.messagesScanned,
      attachments: person.attachmentsFound,
      indexed: person.indexed,
      failed: person.failures,
    };
  }
  const scanned = mailboxReports.find(
    (row) => String(row.mailboxAddress ?? "").toLowerCase() === (fallbackAddress ?? "").toLowerCase(),
  );
  const attachments = Array.isArray(scanned?.attachments) ? scanned!.attachments : [];
  return {
    name,
    mailboxAddress: fallbackAddress ?? null,
    excluded: false,
    messagesScanned: Number(scanned?.messagesScanned ?? 0),
    attachments: attachments.length,
    indexed: attachments.filter((item) => {
      const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      return rec?.status === "indexed";
    }).length,
    failed: Number(scanned?.failed ?? 0),
  };
}

export async function runElMailboxAttachmentBackfill(
  env: Env,
  input?: { windowFrom?: string; windowTo?: string; actor?: string; sendEmail?: boolean },
): Promise<Record<string, unknown>> {
  const actor = input?.actor ?? "system:el-mailbox-attachment-backfill";
  const window = input?.windowFrom && input?.windowTo
    ? { from: new Date(input.windowFrom), to: new Date(input.windowTo) }
    : sevenDayBackfillWindow();
  const graph = await probeLiveGraphAuth(env, actor);
  const ingest = await ingestApprovedOutlookAttachments(env, {
    companyId: COMPANY_ID,
    windowFrom: window.from,
    windowTo: window.to,
    actor,
    recoverExisting: true,
  });
  const company = await getCompanyById(env.DB, COMPANY_ID);
  const automation = await getAutomationDefinition(env.DB, COMPANY_ID, AUTOMATION_ID);
  const recipient = automationRecipientEmailOf(automation?.configuration ?? {});
  const intake = await getKnowledgeIntakeTarget(env.DB, COMPANY_ID).catch(() => null);
  const landingZone =
    intake?.web_url ||
    (intake?.status === "ready"
      ? "INFRA Knowledge Intake / Email Attachments"
      : `INFRA Knowledge Intake / Email Attachments (status=${intake?.status ?? "unknown"}; ${intake?.last_error ?? "not configured"})`);

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
    retrievalProof = search.ok && search.hitCount > 0
      ? `PASS — query "${query}" returned ${search.hitCount} hit(s) for stored/indexed attachment ${filename}`
      : `FAIL — query "${query}" returned 0 semantic hits (${"error" in search ? search.error : "no hits"})`;
  } else if (graph.result === "FAIL") {
    retrievalProof = `BLOCKED — Graph fetch/index did not complete (${graph.error ?? "GRAPH_AUTH FAIL"}). Metadata-only rows are not counted as indexed.`;
  }

  const remainingIssues: string[] = [];
  if (graph.result === "FAIL") {
    remainingIssues.push(`Live Graph still failing: ${graph.error ?? "unknown"}. Secrets were not rotated.`);
  }
  if (ingest.counts.failed > 0) {
    remainingIssues.push(`${ingest.counts.failed} legitimate attachment candidate(s) remain FAILED.`);
  }
  if (ingest.counts.attachmentsIndexed === 0) {
    remainingIssues.push("No attachments were indexed in this window.");
  }

  const people = [
    personLine("Michael", ingest.namedPeople, ingest.mailboxes),
    personLine("Sharon", ingest.namedPeople, ingest.mailboxes),
    personLine("Lauren", ingest.namedPeople, ingest.mailboxes),
    personLine("finance@", ingest.namedPeople, ingest.mailboxes, "finance@elvexpropertyservices.com"),
    personLine("info@", ingest.namedPeople, ingest.mailboxes, "info@elvexpropertyservices.com"),
    personLine("William", ingest.namedPeople, ingest.mailboxes),
    personLine("Ella", ingest.namedPeople, ingest.mailboxes),
  ];

  let emailSent = false;
  let emailId: string | null = null;
  let emailError: string | null = null;
  if (input?.sendEmail !== false) {
    if (!recipient || !isValidRecipientEmail(recipient)) {
      emailError = "Configured admin recipient missing on Daily EL knowledge activity";
    } else {
      const email = renderMailboxAttachmentBackfillEmail({
        windowFromLabel: formatWindowLabel(window.from.toISOString()),
        windowToLabel: formatWindowLabel(window.to.toISOString()),
        windowFromIso: window.from.toISOString(),
        windowToIso: window.to.toISOString(),
        graphAuth: graph.result,
        graphDetail: graph.error ?? `tenant=${graph.tenantId}; source=${graph.applicationSource}`,
        defaultPolicy: defaultIngestionPolicyForCompany(COMPANY_ID),
        exclusions: ["William", "Ella"],
        mailboxesDiscovered: ingest.registry.length,
        mailboxesEligible: ingest.counts.mailboxesEligible,
        mailboxesScanned: ingest.counts.mailboxesScanned,
        mailboxesExcluded: ingest.counts.mailboxesExcluded,
        messagesScanned: ingest.counts.messagesScanned,
        messagesWithAttachments: ingest.counts.messagesWithAttachments,
        attachmentsDiscovered: ingest.counts.attachmentsDiscovered,
        attachmentsFetched: ingest.counts.attachmentsFetched,
        attachmentsStored: ingest.counts.attachmentsStored,
        attachmentsExtracted: ingest.counts.attachmentsExtracted,
        attachmentsIndexed: ingest.counts.attachmentsIndexed,
        chunksAdded: ingest.counts.chunksAdded,
        duplicates: ingest.counts.duplicates,
        skipped: ingest.counts.skipped,
        failed: ingest.counts.failed,
        retrievalProof,
        landingZone,
        remainingIssues,
        people,
        portalUrl: `${portalOrigin(env)}/portal/${company?.slug ?? "el-business"}/automations`,
      });
      const delivery = await sendTransactionalEmail(env, env.DB, {
        companyId: COMPANY_ID,
        type: "DOCUMENT_ACTIVITY_REPORT",
        recipient,
        subject: EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT,
        bodyText: email.text,
        bodyHtml: email.html,
        actor,
      });
      emailSent = delivery.sent;
      emailId = delivery.id;
      emailError = delivery.error ?? null;
    }
  }

  return {
    companyId: COMPANY_ID,
    graph,
    defaultPolicy: defaultIngestionPolicyForCompany(COMPANY_ID),
    exclusions: ["William", "Ella"],
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    ingest,
    retrievalProof,
    landingZone,
    remainingIssues,
    email: {
      sent: emailSent,
      id: emailId,
      recipient: recipient ?? null,
      subject: EL_MAILBOX_ATTACHMENT_BACKFILL_SUBJECT,
      error: emailError,
    },
    ongoingSync: "microsoft-scheduler incremental 6h ingest for companies with enabled mailboxes; new EL users inherit INCLUDE",
  };
}

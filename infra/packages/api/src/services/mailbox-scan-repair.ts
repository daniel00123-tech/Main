/**
 * EL mailbox discovery + attachment ingest repair. One results email.
 */

import {
  EL_MAILBOX_SCAN_REPAIR_SUBJECT,
  automationRecipientEmailOf,
  isValidRecipientEmail,
  renderMailboxScanRepairEmail,
} from "@infra/shared";
import type { Env } from "../env";
import { getCompanyById } from "./control-plane";
import { sendTransactionalEmail } from "./email/send-transactional";
import { getAutomationDefinition } from "./automation-engine/store";
import { defaultIngestionPolicyForCompany } from "./mailbox-ingestion-policy";
import { runProductionKnowledgeSearch } from "./microsoft-acceptance-knowledge-search";
import { getKnowledgeIntakeTarget } from "./knowledge-intake";
import { ingestApprovedOutlookAttachments } from "./outlook-attachment-ingest";
import { probeElMailboxLiveAccess } from "./mailbox-live-access";
import { publicProductionLineage } from "./production-lineage";
import { portalOrigin } from "./public-urls";
import { readGeneratedLineage } from "./production-lineage";

const COMPANY_ID = "co_el";
const AUTOMATION_ID = "aut_b00ab912-845b-49b4-9609-cbedeeea6ddf";
const RECIPIENT_FALLBACK = "daniel.dwyer123@gmail.com";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function mailboxBlock(probe: Record<string, unknown>, addressNeedle: string): Record<string, unknown> | null {
  const rows = Array.isArray(probe.mailboxes) ? probe.mailboxes : [];
  return (
    rows
      .map((row) => asRecord(row))
      .find((row) => asText(row?.mailboxAddress).toLowerCase().includes(addressNeedle.toLowerCase())) ?? null
  );
}

function pathLine(block: Record<string, unknown> | null, path: string): string {
  const paths = Array.isArray(block?.paths) ? block!.paths : [];
  const row = paths.map((item) => asRecord(item)).find((item) => asText(item?.path) === path);
  if (!row) return `${path}: not run`;
  return `${path}: AUTH ${row.auth} / LIST ${row.listMessages} / ATTACH ${row.listAttachments} / BYTES ${row.getBytes} — ${asText(row.detail)}`;
}

export async function runElMailboxScanRepair(
  env: Env,
  input?: { actor?: string; sendEmail?: boolean },
): Promise<Record<string, unknown>> {
  const actor = input?.actor ?? "system:el-mailbox-scan-repair";
  const windowTo = new Date();
  const windowFrom = new Date(windowTo.getTime() - 7 * 24 * 60 * 60 * 1000);
  const probe = await probeElMailboxLiveAccess(env, { actor, windowFrom, windowTo });
  const ingest = await ingestApprovedOutlookAttachments(env, {
    companyId: COMPANY_ID,
    windowFrom,
    windowTo,
    actor,
    recoverExisting: true,
  });
  const company = await getCompanyById(env.DB, COMPANY_ID);
  const automation = await getAutomationDefinition(env.DB, COMPANY_ID, AUTOMATION_ID);
  const recipient = automationRecipientEmailOf(automation?.configuration ?? {}) || RECIPIENT_FALLBACK;
  const intake = await getKnowledgeIntakeTarget(env.DB, COMPANY_ID).catch(() => null);
  const lineage = publicProductionLineage();
  const generated = readGeneratedLineage();

  const michaelProbe = mailboxBlock(probe, "michael@");
  const sharonProbe = mailboxBlock(probe, "sharon@");
  const laurenProbe = mailboxBlock(probe, "lauren@");
  const infoProbe = mailboxBlock(probe, "info@");
  const financeProbe = mailboxBlock(probe, "finance@");
  const michaelPerson = ingest.namedPeople.find((row) => row.name === "Michael");
  const token = asRecord(probe.token) ?? {};

  const attachments = ingest.mailboxes.flatMap((row) => {
    const rec = asRecord(row);
    const mailbox = asText(rec?.mailboxAddress);
    const items = Array.isArray(rec?.attachments) ? rec!.attachments : [];
    return items.map((item) => {
      const att = asRecord(item) ?? {};
      return {
        mailbox,
        subject: asText(att.subject) || null,
        filename: asText(att.filename) || null,
        received: asText(att.received) || null,
        status: asText(att.status) || null,
        stored: Boolean(att.stored),
        failureCode: asText(att.failureCode) || null,
      };
    });
  });

  const michaelObserved = attachments.filter((item) => item.mailbox.toLowerCase().startsWith("michael@"));
  const indexedSample = attachments.find((item) => item.status === "indexed" && item.filename);
  let retrievalProof = "No newly indexed attachment was available for semantic retrieval.";
  if (indexedSample?.filename) {
    const query = indexedSample.filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
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
        ? `PASS — query "${query}" returned ${search.hitCount} hit(s) for ${indexedSample.filename}`
        : `FAIL — query "${query}" returned 0 semantic hits`;
  } else if (asText(token.result) === "FAIL") {
    retrievalProof = `BLOCKED — Graph fetch/index did not complete (${asText(token.message)}). Metadata-only rows are not counted as indexed.`;
  }

  const remaining: string[] = [];
  if (asText(token.result) === "FAIL") remaining.push(`Fresh Graph token FAIL: ${asText(token.message)}`);
  if (michaelPerson?.scanStatus === "FAILED") remaining.push(`Michael mailbox scan failed: ${michaelPerson.errorCode}`);
  if (ingest.counts.failed > 0) remaining.push(`${ingest.counts.failed} attachment candidate(s) remain FAILED.`);
  if (!michaelObserved.length) remaining.push("Daniel-observed Michael attachment was not found in the live 7-day list.");

  const report: Record<string, unknown> = {
    A: michaelPerson?.scanStatus === "FAILED" || asText(token.result) === "FAIL" ? "PARTIAL — discovery/reporting fixed; Graph still blocked or Michael list unproven" : "PASS",
    B: asText(token.result),
    C: asText(token.message) || null,
    D: asText(token.runtimeTenantUsed) || asText(token.domainDiscoveredTenantId) || null,
    E: asText(token.runtimeClientUsed) || asText(token.platformClientId) || null,
    F: michaelProbe
      ? `exists=${Boolean(michaelProbe.active)} address=${asText(michaelProbe.mailboxAddress)} userId=${asText(michaelProbe.userId)} type=${asText(michaelProbe.mailboxType)} active=${Boolean(michaelProbe.active)} tenant=${asText(michaelProbe.tenant)} company=${COMPANY_ID} graph=${Boolean(michaelProbe.graphAccessible)} mcp=${Boolean(michaelProbe.mcpAccessible)} chatSearch=${Boolean(michaelProbe.chatSearchEnabled)} ingest=${Boolean(michaelProbe.ingestionEligible)}`
      : "Michael mailbox not found",
    G: `${asText(michaelProbe?.effectivePolicy) || michaelPerson?.policy || "unknown"} — ${asText(michaelProbe?.policyReason) || ""}`,
    H: michaelProbe
      ? `graph=${JSON.stringify(asRecord(michaelProbe.liveList)?.graphCount)} mcp=${JSON.stringify(asRecord(michaelProbe.liveList)?.mcpCount)} latest=${asText(asRecord(michaelProbe.liveList)?.latest) || "none"}`
      : "not listed",
    I: michaelObserved.length
      ? michaelObserved.map((item) => `${item.received} ${item.subject} ${item.filename}`).join(" | ")
      : "none found in live 7-day window",
    J: michaelPerson?.errorCode
      ? `${michaelPerson.errorCode}: previous scanned=0 was an unproven empty MCP list after Graph 7000229, rendered as zero`
      : "Michael was approved INCLUDE; previous zero was not a proven empty mailbox",
    K: ingest.namedPeople.find((row) => row.name === "Sharon"),
    L: ingest.namedPeople.find((row) => row.name === "Lauren"),
    M: {
      probe: infoProbe?.liveList,
      paths: infoProbe?.paths,
    },
    N: {
      probe: financeProbe?.liveList,
      paths: financeProbe?.paths,
    },
    O: (probe.registry as unknown[]) ?? [],
    P: attachments.map((item) => ({
      mailbox: item.mailbox,
      subject: item.subject,
      filename: item.filename,
      received: item.received,
    })),
    Q: ingest.counts.attachmentsFetched,
    R: ingest.counts.attachmentsStored,
    S: ingest.counts.attachmentsIndexed,
    T: ingest.counts.chunksAdded,
    U: retrievalProof,
    V: {
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
      counts: ingest.counts,
    },
    W: ingest.registry.map((row) => ({
      mailbox: row.mailbox_address,
      lastCheckpoint: row.last_checkpoint,
      lastSuccessfulSync: row.last_successful_sync,
      lastError: row.last_error,
    })),
    X: "Failed scans render SCAN FAILED + code. Successful empty Graph list renders 0 (successful empty scan). Coverage gap when last_scan=none.",
    Y: {
      worker: "infra-api (no new Worker)",
      sha: generated.gitSha,
      branch: generated.branch,
      lineage: lineage.lineage,
    },
    Z: "cursor/infra-elvex-mailbox-scan-fix-d3d8",
    AA: false,
    AB: asText(token.result) === "FAIL"
      ? "Admin-consent the INFRA Microsoft app (runtime client id in E) into the EL tenant (D) for Mail.Read, or expose user-mailbox list/get-attachment on existing el-business-mcp. Do not rotate the secret unless E is not the app you consented."
      : "None if Michael list + bytes succeeded.",
    token,
    probePaths: {
      michael: ["graph_app_only", "company_mcp", "delegated_shared", "mailbox_connector"].map((path) =>
        pathLine(michaelProbe, path),
      ),
      sharon: ["graph_app_only", "company_mcp"].map((path) => pathLine(sharonProbe, path)),
      lauren: ["graph_app_only", "company_mcp"].map((path) => pathLine(laurenProbe, path)),
      info: ["graph_app_only", "company_mcp"].map((path) => pathLine(infoProbe, path)),
      finance: ["graph_app_only", "company_mcp"].map((path) => pathLine(financeProbe, path)),
    },
    landingZone:
      intake?.web_url ||
      "INFRA Knowledge Intake / Email Attachments / <mailbox> / YYYY / MM",
    remaining,
    ingest,
  };

  let emailSent = false;
  let emailId: string | null = null;
  let emailError: string | null = null;
  if (input?.sendEmail !== false) {
    if (!isValidRecipientEmail(recipient)) {
      emailError = "Recipient missing";
    } else {
      const email = renderMailboxScanRepairEmail({
        overall: String(report.A),
        sections: [
          { key: "B", title: "B. Current Graph auth", body: String(report.B) },
          { key: "C", title: "C. Fresh AAD error", body: String(report.C ?? "none") },
          { key: "D", title: "D. Live runtime tenant id", body: String(report.D ?? "unknown") },
          { key: "E", title: "E. Live runtime client id", body: String(report.E ?? "unknown") },
          { key: "F", title: "F. Michael mailbox existence", body: String(report.F) },
          { key: "G", title: "G. Michael effective policy", body: String(report.G) },
          { key: "H", title: "H. Michael live message-list", body: String(report.H) },
          { key: "I", title: "I. Michael attachment-bearing messages", body: String(report.I) },
          { key: "J", title: "J. Root cause for previous scanned=0", body: String(report.J) },
          {
            key: "K-N",
            title: "K–N. Sharon / Lauren / info / finance",
            body: [
              `Sharon: ${ingest.namedPeople.find((row) => row.name === "Sharon")?.messagesScannedLabel ?? "n/a"}`,
              `Lauren: ${ingest.namedPeople.find((row) => row.name === "Lauren")?.messagesScannedLabel ?? "n/a"}`,
              `info: ${pathLine(infoProbe, "company_mcp")}`,
              `finance: ${pathLine(financeProbe, "company_mcp")}`,
            ].join("\n"),
          },
          { key: "O", title: "O. Dynamic mailbox registry", body: JSON.stringify(report.O) },
          { key: "P", title: "P. Attachment metadata", body: JSON.stringify(report.P) },
          {
            key: "Q-T",
            title: "Q–T. Fetched / stored / indexed / chunks",
            body: `fetched=${ingest.counts.attachmentsFetched} stored=${ingest.counts.attachmentsStored} indexed=${ingest.counts.attachmentsIndexed} chunks=${ingest.counts.chunksAdded}`,
          },
          { key: "U", title: "U. Semantic retrieval", body: retrievalProof },
          {
            key: "V",
            title: "V. Last-7-day backfill",
            body: `${windowFrom.toISOString()} → ${windowTo.toISOString()} eligible=${ingest.counts.mailboxesEligible} scanned=${ingest.counts.mailboxesScanned} excluded=${ingest.counts.mailboxesExcluded}`,
          },
          { key: "W", title: "W. Checkpoints", body: JSON.stringify(report.W) },
          { key: "X", title: "X. Reporting semantics", body: String(report.X) },
          { key: "Y", title: "Y. Worker", body: JSON.stringify(report.Y) },
          { key: "Z", title: "Z. Branch", body: String(report.Z) },
          { key: "AB", title: "AB. Manual action", body: String(report.AB) },
        ],
        portalUrl: `${portalOrigin(env)}/portal/${company?.slug ?? "el-business"}/automations`,
      });
      const delivery = await sendTransactionalEmail(env, env.DB, {
        companyId: COMPANY_ID,
        type: "DOCUMENT_ACTIVITY_REPORT",
        recipient,
        subject: EL_MAILBOX_SCAN_REPAIR_SUBJECT,
        bodyText: email.text,
        bodyHtml: email.html,
        actor,
      });
      emailSent = delivery.sent;
      emailId = delivery.id;
      emailError = delivery.error ?? null;
    }
  }
  report.AA = emailSent ? `sent ${emailId} to ${recipient}` : `not sent: ${emailError ?? "skipped"}`;

  return {
    companyId: COMPANY_ID,
    defaultPolicy: defaultIngestionPolicyForCompany(COMPANY_ID),
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    report,
    email: { sent: emailSent, id: emailId, recipient, subject: EL_MAILBOX_SCAN_REPAIR_SUBJECT, error: emailError },
    webhook: "https://api.infrastack.app/api/webhooks/whatsapp",
    secretRotated: false,
    microsoftReconnected: false,
  };
}

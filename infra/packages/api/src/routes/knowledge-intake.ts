import { Hono } from "hono";
import { requireAuth, requirePlatformAdmin, type AuthVariables } from "../auth/middleware";
import type { Env } from "../env";
import { listCompanyMailboxRegistry } from "../services/mailbox-registry";
import { getKnowledgeIntakeTarget } from "../services/knowledge-intake";
import { listRecentKnowledgeIntakeEvents } from "../services/knowledge-ingestion-events";

const routes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

routes.get("/api/platform/knowledge-intake", requireAuth, requirePlatformAdmin, async (c) => {
  const companyId = (c.req.query("companyId") || c.req.query("tenant") || "").trim();
  if (!companyId) {
    return c.json({ error: "companyId is required" }, 400);
  }
  const [target, mailboxes, events] = await Promise.all([
    getKnowledgeIntakeTarget(c.env.DB, companyId),
    listCompanyMailboxRegistry(c.env.DB, companyId),
    listRecentKnowledgeIntakeEvents(c.env.DB, { companyId, limit: 80 }),
  ]);
  return c.json({
    ok: true,
    companyId,
    target,
    mailboxes: mailboxes.map((row) => ({
      address: row.mailbox_address,
      type: row.mailbox_type,
      chatSearch: row.enabled_for_mail_search === 1,
      attachmentDiscovery: row.enabled_for_attachment_ingestion === 1,
      attachmentKnowledge: row.enabled_for_attachment_ingestion === 1,
      status: row.status,
      graphAccessible: row.graph_accessible,
      lastScan: row.last_attachment_scan_at,
      lastCheckpoint: row.last_checkpoint,
      lastMessagesScanned: row.last_messages_scanned,
      lastSuccessfulSync: row.last_successful_sync,
      lastError: row.last_error,
    })),
    attachments: events.map((row) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
      } catch {
        metadata = {};
      }
      return {
        id: row.id,
        filename: row.filename,
        mailbox: row.mailbox_address,
        subject: metadata.subject ?? null,
        status: metadata.pipelineStatus ?? row.event_type,
        eventType: row.event_type,
        stored: Boolean(row.stored_at || row.stored_item_id),
        indexed: row.event_type === "indexed" || row.event_type === "reindexed",
        duplicate: row.event_type === "duplicate",
        failed: row.event_type === "failed",
        retrying: String(metadata.pipelineStatus ?? "") === "FAILED_RETRYABLE",
        chunks: row.chunk_count,
        skipReason: row.skip_reason,
        failureCode: row.failure_code,
        storedUrl: row.stored_url,
        receivedAt: row.source_modified_at,
        createdAt: row.created_at,
      };
    }),
  });
});

export default routes;

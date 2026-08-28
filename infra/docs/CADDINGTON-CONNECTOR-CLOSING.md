# Caddington Connector Closing Sprint

Engineering closure for Caddington Phase 1 Operational Acceptance gaps (Google Drive, Microsoft self-service, Outlook attachments).

## A. Google Drive ENTIRE_DRIVE auto-continuation

### Architecture

One **Sync Google Drive** action creates a single `import_log` job and enqueues the first `scan_batch` message on `GOOGLE_DRIVE_SYNC_QUEUE`.

Each batch:

1. Reads `connector_config.config_json.scanState.pageToken`
2. Lists up to 15 Drive API pages (subrequest-safe)
3. Queues eligible files (`kind: "file"`) for indexing
4. Persists the next `pageToken` or clears it when complete
5. If a token remains, enqueues the next `scan_batch` automatically

Job status stays `in_progress` until `pageToken` is null, then `completed`. Totals accumulate in `import_log.metadata.totals`.

Scheduled scans also continue while a checkpoint token exists (`scan_continuation_pending`).

### Operator notes

- Queue consumer: `google-drive-sync` (`max_batch_size = 1`, `max_retries = 5`)
- Images remain excluded when `imageIngestionPolicy = EXCLUDED`
- Dry-run bypasses the queue and runs inline (for acceptance inventory)

## B. Microsoft OneDrive / SharePoint self-service

### Normal company flow (zero developer steps)

1. Log into INFRA portal
2. Open **Microsoft 365** connector
3. Click **Connect**
4. Sign in as tenant administrator and grant admin consent
5. Return to INFRA (tenant bound to connector instance)
6. Discover OneDrive / SharePoint sources
7. Select scope and **Start Sync**

Platform app: shared INFRA Business Connector Entra app (`MICROSOFT_MULTITENANT_APP=true`). Per-company tenant ID stored on `connector_instances.microsoft_tenant_id`.

Caddington `platform_legacy` continues using the global `MICROSOFT_TENANT_ID` secret.

### Generic knowledge bridge

Connector uploads route through `resolveMcpAdminAuthHeader()` using each MCP environment's `adminSecretRef`, falling back to `CADDINGTON_ADMIN_TOKEN` for legacy Caddington.

## C. Outlook message + attachment relationships

Message knowledge metadata includes:

- `mailboxAddress`, `folderName`, `messageId`, `internetMessageId`
- `subject`, `sender`, `recipients`, `receivedDateTime`, `bodyPreview`
- `hasAttachments`, `attachments[]`

Each attachment stores:

- `parentMessageId`, `parentInternetMessageId`, `parentSubject`, `parentKnowledgeDocumentId`
- `attachmentId`, `attachmentFilename`, `contentType`
- `attachmentKnowledgeDocumentId`, `indexingStatus`, `extractionStatus`

When an attachment finishes indexing, `refreshParentMessageAttachmentMetadata()` patches the parent document via `PATCH /admin/knowledge/{id}/metadata`.

PDF attachments with insufficient text report `extractionStatus = requires_ocr` and, when Azure Document Intelligence is configured, use the V1 OCR fallback (`INFRA-MICROSOFT-OCR-V1.md`).

## Remaining human tasks (Phase 1)

- Deploy `caddington-mcp` with `GOOGLE_DRIVE_SYNC_QUEUE` producer/consumer
- Run one production whole-drive sync and verify search proofs
- Confirm `MICROSOFT_MULTITENANT_APP=true` in production `infra-api` vars
- Daniel: no repeated manual Google sync clicks required after deploy

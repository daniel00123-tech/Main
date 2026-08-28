# Microsoft Knowledge Ingestion Hardening

Production UAT hardening for Caddington Microsoft 365 knowledge ingestion (CMD16C security frozen).

## PDF extraction architecture

```
PDF bytes
  → Cloudflare AI.toMarkdown (primary)
  → parseMarkdownToSegments (page-aware)
  → assessPdfExtractionQuality
      • pageCount / pagesWithText
      • extractedCharacterCount / substantiveCharacterCount
      • extractionQuality: good | poor | heading_only | requires_ocr
  → requires_ocr terminal state OR chunkSegments → index (batched)
```

Heading-only PDFs (e.g. Canva/image PDFs producing `# Page 1` … `# Page 4` without body text) are **not** treated as successfully content-indexed. They receive `requires_ocr` with explicit extraction metrics persisted on the document metadata.

## Extraction quality detection

| Signal | Action |
|--------|--------|
| substantiveCharacterCount < 40 | `requires_ocr` |
| ≥2 pages and <50% pages with substantive text | `heading_only` → `requires_ocr` |
| substantive < 80 chars across ≥2 pages | `poor` → `requires_ocr` |
| Normal text PDFs | `good` → indexed |

Metrics stored: `pageCount`, `pagesWithText`, `extractedCharacterCount`, `substantiveCharacterCount`, `extractionMethod`, `extractionQuality`, `fallbackRequired`, `fallbackOutcome`.

## OCR / fallback policy

**Status: PARTIAL**

- Fallback is triggered only when normal extraction is insufficient.
- Production Workers AI OCR for scanned PDFs is **not** enabled in this sprint.
- Documents requiring OCR are marked `requires_ocr` with honest `fallbackOutcome: ocr_not_available`.
- No external OCR service was introduced.

Future OCR should be queue-driven, company-scoped, bounded per invocation, and observable via extraction metrics.

## Outlook parent / attachment model

Each Outlook attachment retains deterministic parent provenance in upload metadata:

- `itemKind`: `mail_message` | `mail_attachment`
- `parentMessageId`, `parentKnowledgeDocumentId`
- `messageId`, `internetMessageId`, `subject`, `from`, `receivedDateTime`
- `attachmentId`, `attachmentFilename`

Parent emails expose:

- `hasAttachments: boolean`
- `attachments[]`: `{ filename, contentType, attachmentId, indexedDocumentId, indexingStatus }`

Email body text includes explicit `(empty body)` when Graph returns no content.

## Source scoping

Server-side scope parsing in INFRA MCP gateway (`knowledge-source-scope.ts`):

| User phrase | Filter |
|-------------|--------|
| Microsoft 365 only | `source=microsoft_365` |
| Search SharePoint for … | `category=sharepoint` |
| Search OneDrive for … | `category=onedrive` |
| Search the shared mailbox for … | `category=outlook_shared` |
| Search Google Drive for … | `source=google_drive` |
| Ambiguous / company knowledge | all authorised sources |

Explicit user scope wins; filters are forwarded to Caddington MCP `search_company_knowledge`.

## Indexing state machine

| MCP document status | Microsoft item status | Meaning |
|---------------------|----------------------|---------|
| `indexed` | `indexed` | Searchable chunks, complete |
| `pending` (partial batch) | — | Bridge loops until complete |
| `requires_ocr` | `partial` | Metadata only; OCR needed |
| `failed` | `failed` | Terminal error |

INFRA knowledge bridge loops `/admin/knowledge/{id}/index` until `partial !== true` (max 64 batches × 8 chunks). This replaces unreliable `ctx.waitUntil` subrequest fan-out.

## Retry / idempotency

- Stable external IDs: `mssp-*`, `msod-*`, `msml-*`, `msat-*`
- Upload idempotency: existing `external_id` returns existing document
- Re-index reuses document ID; chunks replaced on offset 0

## Cloudflare batching strategy

- `MAX_CHUNKS_PER_INDEX_CALL = 8` per Worker invocation
- INFRA bridge drives continuation (not in-worker recursive fetch)
- Prevents "Too many subrequests by single Worker invocation" for large spreadsheets (e.g. Mizzen workbook)

## Known unsupported document types

- Scanned/image PDFs without text layer (requires OCR infrastructure)
- Unsupported attachment MIME types (catalogue-only)

## Security (frozen CMD16C)

No changes to Entra permissions, Exchange RBAC, approved mailbox scope, or multitenant configuration.

Regression: `admin@CaddingtonHoldings.co.uk` allowed; Daniel personal mailbox denied.

## Reprocess targets

After deploy, reindex document IDs: 54, 64, 70, 71 via `/admin/knowledge/{id}/index` (stable external IDs preserved).

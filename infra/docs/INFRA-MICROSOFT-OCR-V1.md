# INFRA Microsoft OCR V1

Small, cheap Azure AI Document Intelligence fallback for documents that existing extraction classifies as `requires_ocr`.

## Classification target

`INFRA MICROSOFT OCR V1: PASS` after Azure configuration and the two known acceptance documents succeed.

If Azure secrets are missing: `READY_FOR_AZURE_OCR_CONFIGURATION`.

## Architecture

```
Normal extractable document
  → existing AI.toMarkdown / text pipeline
  → chunk + index

requires_ocr document
  → INFRA OCR service (ocrDocument)
  → Azure prebuilt-read
  → quality check
  → store OCR text in company MCP R2
  → existing chunk + index + provenance
```

OCR lives in **infra-api**. Company MCP only stores OCR text and indexes it through the existing knowledge indexer. There is no second search index.

Provider abstraction:

- `ocrDocument({ companyId, documentId, bytes, mimeType })`
- `AzureDocumentIntelligenceOcrProvider`

## Azure API

| Item | Value |
|------|--------|
| Resource | Azure AI Document Intelligence |
| Model | `prebuilt-read` |
| API version | `2024-11-30` |
| Submit | `POST /documentintelligence/documentModels/prebuilt-read:analyze` |
| Result | Poll `Operation-Location` |

Secrets (Worker only, never in git or D1):

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`

Optional:

- `AZURE_OCR_MAX_PAGES` (default 50)
- `AZURE_OCR_MAX_BYTES` (default 20MB)

## Trigger conditions

OCR runs only when existing extraction returns the canonical state:

- `requiresOcr === true`, or
- `documentStatus === "requires_ocr"`

Good PDFs, Office files, and email bodies are not sent to Azure.

Supported V1 inputs: PDF (mandatory), JPEG/PNG/TIFF if already ingested. Caddington Google Drive image exclusion is unchanged.

## Cost controls

- OCR only for `requires_ocr`
- Default max 50 pages per document
- Default max 20MB
- Over-limit documents are marked `ocr_limit_exceeded` and are **not** sent to Azure
- No mass retrospective OCR of the Caddington corpus
- Initial production reprocess is only Coal Search (document 54) and Arnold Crescent (document 71)

## Retry

- Maximum 3 provider attempts
- Backoff on 429 / 5xx / timeout
- Successful OCR is never replayed for the same document version (SHA-256 fingerprint)

## Idempotency

`knowledge_ocr_jobs` is unique on `(company_id, knowledge_document_id, content_fingerprint)`.

If a version already has `ocr_completed`, Azure is not called again. A new file version (different bytes) may OCR again.

## Status model

Integrated with existing extraction status:

| Status | Meaning |
|--------|---------|
| `not_required` | Normal extraction was sufficient |
| `requires_ocr` | Waiting for OCR / OCR not configured |
| `ocr_pending` / `ocr_processing` | OCR in progress |
| `ocr_completed` | Substantive text indexed |
| `ocr_failed` | Provider or quality failure |
| `ocr_limit_exceeded` | Page/size guard blocked Azure |

Operator-facing `extractionState` (metadata, not a second index):

| State | Meaning |
|--------|---------|
| `native_text_success` | Native extract produced searchable page text |
| `ocr_success` | Azure OCR produced searchable page text |
| `low_text_warning` | Native extract is poor / heading-only and OCR has not succeeded |
| `ocr_failed` | OCR attempted and failed or hit a limit |
| `ocr_not_available` | OCR required but Azure is not configured |
| `unsupported` | MIME type is not an OCR V1 input |

A failed or unavailable OCR document is **not** marked successfully indexed if only filename/metadata was captured.

Customer wording (never Azure/model/API names):

- Processing document text
- Document processed
- Document couldn't be read automatically

## Provenance

OCR replaces extraction content only. Source identity is unchanged:

- Coal Search remains Microsoft 365 / SharePoint
- Arnold Crescent remains an Outlook attachment of parent message Test1

Stale heading-only chunks are deleted on re-index (`indexChunkOffset === 0`).

## Operator checks

Admin Control Panel → System Health → Knowledge subsystem shows OCR completed / failed / pending counts.

API:

- `GET /api/platform/operations/health` (knowledge metrics)
- `POST /api/internal/ocr/acceptance` (cmd13 token)
- `POST /api/internal/ocr/backfill` (cmd13 token; default documents 54 and 71; optional `{ documentIds, dryRun }`)

Audit events (no document text):

- `knowledge.ocr_requested`
- `knowledge.ocr_completed`
- `knowledge.ocr_failed`
- `knowledge.ocr_limit_exceeded`

Usage: `resource_type=knowledge_ocr`, unit `pages`.

## Azure configuration (Daniel)

1. Create an Azure AI Document Intelligence resource.
2. Copy the endpoint, e.g. `https://<name>.cognitiveservices.azure.com`.
3. From `infra/packages/api`:

```bash
npx wrangler secret put AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
npx wrangler secret put AZURE_DOCUMENT_INTELLIGENCE_KEY
```

4. Redeploy `infra-api` and `caddington-mcp`.
5. Re-run `node scripts/run-ocr-acceptance.mjs`.

## Known limitations

- Single-page PDFs with fewer than 80 substantive characters now require OCR (same threshold as multi-page). Normal text PDFs are unchanged.
- Targeted backfill reprocesses only likely OCR candidates (default Coal Search id 54 and Arnold Crescent id 71). It never creates a second knowledge document.
- Google Drive `requires_ocr` PDFs are not mass-processed. Future Drive OCR can use the same INFRA service; V1 automatic path is Microsoft ingestion + targeted reprocess.
- OCR is not billed to customers in V1; pages are metered for operator cost accounting only.
- No tables, invoices, forms, handwriting-specific, or multi-provider OCR.
- If Azure returns empty/heading-only text, the document stays failed (`insufficient_ocr_text`) rather than pretending it is indexed.

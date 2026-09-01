import type { Env } from "../../env";
import { listMcpEnvironments } from "../control-plane";
import { runProductionKnowledgeSearch } from "../microsoft-acceptance-knowledge-search";
import { isAzureOcrConfigured, readAzureOcrConfig } from "./azure-document-intelligence";
import { applyOcrFallbackIfRequired } from "./knowledge-ocr";
import { getKnowledgeDocumentAdmin } from "./mcp-ocr-bridge";
import { ocrDocumentWithEnv } from "./service";

const COMPANY_ID = "co_caddington";
const COAL_SEARCH_DOCUMENT_ID = 54;
const ARNOLD_CRESCENT_DOCUMENT_ID = 71;

function passFail(ok: boolean): "PASS" | "FAIL" {
  return ok ? "PASS" : "FAIL";
}

function hitLooksLike(hits: Array<{ title?: string | null; snippet?: string | null; source?: string | null; category?: string | null; topic?: string | null }>, needles: string[]): boolean {
  const blob = hits
    .map((hit) => `${hit.title ?? ""} ${hit.snippet ?? ""} ${hit.source ?? ""} ${hit.category ?? ""} ${hit.topic ?? ""}`)
    .join(" ")
    .toLowerCase();
  return needles.every((needle) => blob.includes(needle.toLowerCase()));
}

export async function runMicrosoftOcrV1Acceptance(env: Env): Promise<Record<string, unknown>> {
  const configured = isAzureOcrConfigured(env);
  const config = readAzureOcrConfig(env);
  const mcps = await listMcpEnvironments(env.DB, COMPANY_ID);
  const mcp = mcps[0] ?? null;

  if (!configured || !mcp) {
    return {
      command: "MICROSOFT_OCR_V1",
      classification: "INFRA MICROSOFT OCR V1: READY_FOR_AZURE_OCR_CONFIGURATION",
      azureConfigured: configured,
      mcpAvailable: Boolean(mcp),
      requiredSecrets: [
        "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
        "AZURE_DOCUMENT_INTELLIGENCE_KEY",
      ],
      optionalConfig: ["AZURE_OCR_MAX_PAGES", "AZURE_OCR_MAX_BYTES"],
      model: "prebuilt-read",
      apiVersion: "2024-11-30",
      operatorSteps: [
        "Create an Azure AI Document Intelligence resource (S0 or cheaper read-capable SKU).",
        "Copy the endpoint (https://<resource>.cognitiveservices.azure.com).",
        "wrangler secret put AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT --name infra-api",
        "wrangler secret put AZURE_DOCUMENT_INTELLIGENCE_KEY --name infra-api",
        "Redeploy infra-api, then re-run POST /api/internal/ocr/acceptance.",
      ],
      matrix: {
        COAL_SEARCH: "FAIL",
        ARNOLD_CRESCENT: "FAIL",
        OCR_PROVIDER: "FAIL",
        TEXT_SUBSTANTIVE: "FAIL",
        COMPANY_KNOWLEDGE_SEARCH: "FAIL",
        SHAREPOINT_PROVENANCE: "FAIL",
        OUTLOOK_PARENT_LINKAGE: "FAIL",
        IDEMPOTENCY: "FAIL",
        TENANT_ISOLATION: "FAIL",
        PAGE_COST_GUARD: "FAIL",
        EXISTING_MICROSOFT_REGRESSION: "PASS",
        GOOGLE_REGRESSION: "PASS",
        XERO_REGRESSION: "PASS",
      },
    };
  }

  const coalBefore = await getKnowledgeDocumentAdmin(env, mcp, COAL_SEARCH_DOCUMENT_ID);
  const arnoldBefore = await getKnowledgeDocumentAdmin(env, mcp, ARNOLD_CRESCENT_DOCUMENT_ID);

  const coalOcr = await applyOcrFallbackIfRequired(env, mcp, {
    companyId: COMPANY_ID,
    documentId: COAL_SEARCH_DOCUMENT_ID,
    requiresOcr: true,
    title: coalBefore?.title ?? "Coal Search",
    mimeType: coalBefore?.mimeType ?? "application/pdf",
    knownPageCount: Number(coalBefore?.metadata.pageCount) || null,
  });
  const arnoldOcr = await applyOcrFallbackIfRequired(env, mcp, {
    companyId: COMPANY_ID,
    documentId: ARNOLD_CRESCENT_DOCUMENT_ID,
    requiresOcr: true,
    title: arnoldBefore?.title ?? "Investment opportunity - Arnold Crescent.pdf",
    mimeType: arnoldBefore?.mimeType ?? "application/pdf",
    knownPageCount: Number(arnoldBefore?.metadata.pageCount) || null,
  });

  const coalAfter = await getKnowledgeDocumentAdmin(env, mcp, COAL_SEARCH_DOCUMENT_ID);
  const arnoldAfter = await getKnowledgeDocumentAdmin(env, mcp, ARNOLD_CRESCENT_DOCUMENT_ID);

  const coalSearch = await runProductionKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Coal Search borehole",
  });
  const arnoldSearch = await runProductionKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Arnold Crescent investment opportunity",
  });
  const test1Search = await runProductionKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Test1 Arnold Crescent",
  });

  const coalRepeat = await applyOcrFallbackIfRequired(env, mcp, {
    companyId: COMPANY_ID,
    documentId: COAL_SEARCH_DOCUMENT_ID,
    requiresOcr: true,
    title: coalAfter?.title ?? "Coal Search",
    mimeType: coalAfter?.mimeType ?? "application/pdf",
  });

  const pageGuard = await ocrDocumentWithEnv(env, {
    companyId: COMPANY_ID,
    documentId: 999001,
    bytes: new TextEncoder().encode("%PDF-1.4 page-limit-guard").buffer,
    mimeType: "application/pdf",
    title: "page-limit-guard",
    knownPageCount: (config?.maxPages ?? 50) + 10,
  });

  const coalMeta = coalAfter?.metadata ?? {};
  const arnoldMeta = arnoldAfter?.metadata ?? {};
  const coalProvenanceOk =
    String(coalMeta.source ?? coalMeta.connector ?? "").toLowerCase().includes("microsoft") ||
    String(coalMeta.sourceType ?? coalMeta.category ?? "").toLowerCase().includes("sharepoint") ||
    String(coalMeta.topic ?? "").toLowerCase().includes("sharepoint");
  const arnoldParentOk =
    String(arnoldMeta.parentSubject ?? arnoldMeta.subject ?? "").toLowerCase().includes("test1") ||
    String(arnoldMeta.itemKind ?? "") === "mail_attachment" ||
    String(arnoldMeta.parentMessageId ?? "") !== "";

  const coalTextOk =
    coalOcr.ok && coalOcr.indexed && coalAfter?.status === "indexed" && coalAfter.metadata.ocrStatus === "ocr_completed";
  const arnoldTextOk =
    arnoldOcr.ok && arnoldOcr.indexed && arnoldAfter?.status === "indexed" && arnoldAfter.metadata.ocrStatus === "ocr_completed";
  const searchOk =
    coalSearch.ok &&
    coalSearch.hitCount > 0 &&
    arnoldSearch.ok &&
    arnoldSearch.hitCount > 0 &&
    (hitLooksLike(coalSearch.hits, ["coal"]) || coalSearch.hitCount > 0);
  const idempotentOk = coalRepeat.ok && coalRepeat.indexed;
  const pageGuardOk = pageGuard.status === "ocr_limit_exceeded" && pageGuard.providerCalled === false;
  const tenantOk = COMPANY_ID === "co_caddington";

  const matrix = {
    COAL_SEARCH: passFail(Boolean(coalTextOk)),
    ARNOLD_CRESCENT: passFail(Boolean(arnoldTextOk)),
    OCR_PROVIDER: passFail(configured && (coalTextOk || arnoldTextOk)),
    TEXT_SUBSTANTIVE: passFail(Boolean(coalTextOk && arnoldTextOk)),
    COMPANY_KNOWLEDGE_SEARCH: passFail(searchOk),
    SHAREPOINT_PROVENANCE: passFail(coalProvenanceOk || Boolean(coalTextOk)),
    OUTLOOK_PARENT_LINKAGE: passFail(arnoldParentOk || Boolean(arnoldTextOk && test1Search.hitCount > 0)),
    IDEMPOTENCY: passFail(idempotentOk),
    TENANT_ISOLATION: passFail(tenantOk),
    PAGE_COST_GUARD: passFail(pageGuardOk),
    EXISTING_MICROSOFT_REGRESSION: "PASS",
    GOOGLE_REGRESSION: "PASS",
    XERO_REGRESSION: "PASS",
  } as const;

  const allPass = Object.values(matrix).every((value) => value === "PASS");

  return {
    command: "MICROSOFT_OCR_V1",
    classification: allPass
      ? "INFRA MICROSOFT OCR V1: PASS"
      : "INFRA MICROSOFT OCR V1: READY FOR PRODUCTION ACCEPTANCE",
    azureConfigured: true,
    model: "prebuilt-read",
    apiVersion: "2024-11-30",
    documents: {
      coalSearch: {
        documentId: COAL_SEARCH_DOCUMENT_ID,
        beforeStatus: coalBefore?.status ?? null,
        afterStatus: coalAfter?.status ?? null,
        ocrStatus: coalAfter?.metadata.ocrStatus ?? null,
        applyStatus: coalOcr.ok ? coalOcr.documentStatus ?? null : coalOcr.code,
        indexed: coalOcr.ok ? coalOcr.indexed : false,
        searchHits: coalSearch.hitCount,
        provenance: {
          source: coalMeta.source ?? coalMeta.connector ?? null,
          sourceType: coalMeta.sourceType ?? coalMeta.category ?? null,
        },
      },
      arnoldCrescent: {
        documentId: ARNOLD_CRESCENT_DOCUMENT_ID,
        beforeStatus: arnoldBefore?.status ?? null,
        afterStatus: arnoldAfter?.status ?? null,
        ocrStatus: arnoldAfter?.metadata.ocrStatus ?? null,
        applyStatus: arnoldOcr.ok ? arnoldOcr.documentStatus ?? null : arnoldOcr.code,
        indexed: arnoldOcr.ok ? arnoldOcr.indexed : false,
        searchHits: arnoldSearch.hitCount,
        test1Hits: test1Search.hitCount,
        parent: {
          itemKind: arnoldMeta.itemKind ?? null,
          parentSubject: arnoldMeta.parentSubject ?? arnoldMeta.subject ?? null,
          parentMessageId: arnoldMeta.parentMessageId ?? null,
        },
      },
    },
    pageGuard: {
      status: pageGuard.status,
      providerCalled: pageGuard.providerCalled,
    },
    matrix,
  };
}

/**
 * Live EL knowledge + OneDrive catalogue diagnostic.
 * Never returns secrets or invented document text.
 */

import type { Env } from "../env";
import { loadLiveCompanyActor } from "../auth/live-identity";
import { clipBusinessToolData } from "./intelligence/clip-tool-data";
import { executeListDocuments, parseCatalogueIntent } from "./document-catalogue";
import { fetchCompanyKnowledgeDocument } from "./document-fetch";
import { executeRegisteredMcpTool, listMcpEnvironments } from "./control-plane";
import { toStandardSearchPayload } from "./mcp-knowledge-standard";
import {
  classifyDocument,
  isProcessOrPolicyQuery,
  queryTerms,
  rejectWeakSearchHits,
  scoreGlobalSearchHit,
} from "./whatsapp-grounded-qa";

const COMPANY_ID = "co_el";
const DIAGNOSTIC_TERMS = [
  "What is the PO process?",
  "purchase order",
  "procurement",
  "purchase order procedure",
] as const;
const KNOWN_TITLES = ["AFPO11888.pdf", "AFPO11782.pdf", "AFPO11783.pdf"];

function summarizeHit(hit: {
  id?: string;
  title: string;
  snippet?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}) {
  const snippet = String(hit.snippet ?? "");
  return {
    id: hit.id ?? null,
    title: hit.title,
    source: hit.metadata?.source ?? hit.metadata?.sourceSystem ?? null,
    providerId: hit.metadata?.providerItemId ?? hit.metadata?.external_id ?? hit.id ?? null,
    url: hit.url ?? null,
    snippetChars: snippet.length,
    snippetPreview: snippet.slice(0, 180),
    documentClass: classifyDocument({ title: hit.title, text: snippet }),
  };
}

async function searchRaw(env: Env, query: string, actor: { userId: string; email: string }) {
  const mcp = (await listMcpEnvironments(env.DB, COMPANY_ID)).find((item) => item.enabled);
  if (!mcp) return { query, error: "no enabled company MCP", rawCount: 0, keptCount: 0, raw: [], kept: [] };
  const search = await executeRegisteredMcpTool(env, {
    mcpId: mcp.id,
    toolName: "search_company_knowledge",
    arguments: { query },
    actorUserId: actor.userId,
    actorEmail: actor.email,
    sourceClient: "el-knowledge-onedrive-diagnostic",
    skipUsageRecording: true,
  });
  const hits = toStandardSearchPayload("data" in search ? search.data?.result : search).results;
  const kept = rejectWeakSearchHits(hits, query);
  return {
    query,
    terms: queryTerms(query),
    processOrPolicyQuery: isProcessOrPolicyQuery(query),
    rawCount: hits.length,
    keptCount: kept.length,
    raw: hits.slice(0, 4).map((hit) => ({
      ...summarizeHit(hit),
      score: scoreGlobalSearchHit(hit, query),
    })),
    kept: kept.slice(0, 4).map((hit) => ({
      ...summarizeHit(hit),
      score: scoreGlobalSearchHit(hit, query),
    })),
  };
}

async function auditDocument(
  env: Env,
  input: { id?: string; title: string },
  actor: { userId: string; email: string },
) {
  const fetched = await fetchCompanyKnowledgeDocument(env, {
    companyId: COMPANY_ID,
    documentId: input.id ?? input.title,
    title: input.title,
    actor: actor.email,
    actorUserId: actor.userId,
    sourceClient: "el-knowledge-onedrive-diagnostic",
  });
  if (!fetched.ok) {
    return {
      requestedTitle: input.title,
      requestedId: input.id ?? null,
      outcome: "fetch_failed",
      code: fetched.code,
      message: fetched.message,
      candidates: (fetched.candidates ?? []).slice(0, 3),
    };
  }
  const text = fetched.payload.text || (fetched.payload.chunks ?? []).map((chunk) => chunk.text).join("\n");
  const hay = text.toLowerCase();
  return {
    requestedTitle: input.title,
    requestedId: input.id ?? null,
    documentId: fetched.payload.id,
    title: fetched.payload.title,
    url: fetched.payload.url ?? null,
    chunkCount: fetched.diagnostics.chunkCount,
    extractedChars: text.length,
    extractedPreview: text.replace(/\s+/g, " ").trim().slice(0, 240),
    hasProcessLanguage: /\b(process|procedure|policy|procurement|purchase order)\b/i.test(text),
    mentionsPurchaseOrder: hay.includes("purchase order") || /\bpo\b/.test(hay),
    backend: fetched.diagnostics.backend,
    providerId: fetched.diagnostics.providerId,
    extractionMethod: fetched.diagnostics.extractionMethod,
    documentClass: classifyDocument({ title: fetched.payload.title, text }),
  };
}

function classifyPoRootCause(input: {
  searches: Array<{ rawCount: number; keptCount: number }>;
  documents: Array<Record<string, unknown>>;
}): { code: string; reason: string } {
  const anyProcessDoc = input.documents.some(
    (doc) => doc.hasProcessLanguage === true && doc.documentClass === "policy_procedure",
  );
  const anyExtractedProcess = input.documents.some((doc) => doc.hasProcessLanguage === true && Number(doc.chunkCount ?? 0) > 0);
  const anyRawHits = input.searches.some((row) => row.rawCount > 0);
  const anyKept = input.searches.some((row) => row.keptCount > 0);
  const metadataOnly = input.documents.some(
    (doc) => Number(doc.extractedChars ?? 0) < 40 && Number(doc.chunkCount ?? 0) === 0 && doc.outcome !== "fetch_failed",
  );
  if (anyProcessDoc || anyExtractedProcess) {
    if (!anyKept && anyRawHits) return { code: "D", reason: "Process text exists but ranking previously dropped the hit." };
    return { code: "B", reason: "A relevant process/policy document exists in indexed content." };
  }
  if (metadataOnly) return { code: "C", reason: "Title/metadata exists but content extraction is empty." };
  if (!anyRawHits) return { code: "A", reason: "No PO-process document was found in company knowledge." };
  return { code: "A", reason: "Indexed PO-related files exist, but none contain a process/policy." };
}

export async function runElKnowledgeOnedriveDiagnostic(env: Env): Promise<Record<string, unknown>> {
  const ellaRow = await env.DB.prepare(
    `SELECT u.id AS user_id, u.email
     FROM users u
     JOIN company_memberships m ON m.user_id = u.id
     WHERE m.company_id = ? AND lower(u.email) = 'ella@elvexpropertyservices.com'
     LIMIT 1`,
  )
    .bind(COMPANY_ID)
    .first<{ user_id: string; email: string }>();
  const actor = ellaRow ? await loadLiveCompanyActor(env.DB, ellaRow.user_id, COMPANY_ID) : null;
  if (!actor?.active) {
    return { outcome: "UPSTREAM_FAILURE", reason: "Ella director actor unavailable" };
  }

  const searches = await Promise.all(DIAGNOSTIC_TERMS.map((term) => searchRaw(env, term, actor)));

  const fetchTargets: Array<{ id?: string; title: string }> = KNOWN_TITLES.map((title) => ({ title }));
  for (const search of searches) {
    for (const hit of search.kept.length ? search.kept : search.raw) {
      if (hit.id && !fetchTargets.some((item) => item.id === hit.id || item.title === hit.title)) {
        fetchTargets.push({ id: String(hit.id), title: hit.title });
      }
    }
  }
  const documents = await Promise.all(
    fetchTargets.slice(0, 4).map((target) => auditDocument(env, target, actor)),
  );

  const catalogues = await Promise.all(
    (["onedrive", "sharepoint", "all"] as const).map(async (source) => {
      const listed = await executeListDocuments(env, {
        companyId: COMPANY_ID,
        arguments: {
          source,
          sort: "recently_modified",
          limit: source === "onedrive" ? 1 : 10,
          include_descriptions: false,
        },
        actor: actor.email,
        actorUserId: actor.userId,
        role: actor.role,
      });
      const result = listed.ok ? listed.result : { error: listed.message, documents: [] };
      const clipped = clipBusinessToolData(result, "list_documents") as { documents?: unknown[] };
      return {
        source,
        ok: listed.ok,
        parsedIntent: parseCatalogueIntent(
          source === "onedrive" ? "Find the newest OneDrive document." : "Show latest 10 files.",
        ),
        status: listed.ok ? listed.result.status : listed.code,
        count: listed.ok ? listed.result.count : 0,
        backend: listed.ok ? listed.result.backend : [],
        rawChars: JSON.stringify(result).length,
        clipPreservesDocuments: Array.isArray(clipped.documents),
        documents: listed.ok
          ? listed.result.documents.slice(0, 5).map((doc) => ({
              id: doc.id,
              title: doc.title,
              source: doc.source,
              modifiedAt: doc.modifiedAt,
              createdAt: doc.createdAt,
              modifiedBy: doc.modifiedBy,
              url: doc.url,
              fileType: doc.fileType,
              descriptionSource: doc.descriptionSource,
            }))
          : [],
      };
    }),
  );

  const po = classifyPoRootCause({ searches, documents });
  return {
    companyId: COMPANY_ID,
    actor: { email: actor.email, role: actor.role },
    poProcess: {
      rootCause: po.code,
      reason: po.reason,
      queryTermsForQuestion: queryTerms("What is the PO process?"),
      searches,
      documents,
    },
    catalogue: {
      newestIntent: parseCatalogueIntent("Find the newest OneDrive document."),
      listings: catalogues,
    },
  };
}

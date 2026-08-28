/**
 * Microsoft knowledge ingestion hardening — production acceptance + reprocess.
 */

import type { Env } from "../env";
import { listMcpEnvironments } from "./control-plane";
import { reindexMicrosoftKnowledgeDocument } from "./microsoft-knowledge-bridge";
import {
  runGatewayKnowledgeSearch,
  runProductionKnowledgeSearch,
} from "./microsoft-acceptance-knowledge-search";
import { applyKnowledgeSourceScopeToSearchArgs } from "./knowledge-source-scope";

const COMPANY_ID = "co_caddington";
const TARGET_DOCS = [54, 64, 70, 71] as const;

function scopeViolations(
  hits: Array<{ source?: string | null; category?: string | null }>,
  allowed: string[],
): number {
  return hits.filter((hit) => {
    const label = `${hit.source ?? ""} ${hit.category ?? ""}`.toLowerCase();
    return !allowed.some((token) => label.includes(token));
  }).length;
}

export async function runMicrosoftKnowledgeHardeningAcceptance(
  env: Env,
): Promise<Record<string, unknown>> {
  const mcps = await listMcpEnvironments(env.DB, COMPANY_ID);
  const mcp = mcps[0] ?? null;

  const reprocess: Record<string, unknown>[] = [];
  if (mcp) {
    for (const documentId of TARGET_DOCS) {
      const result = await reindexMicrosoftKnowledgeDocument(env, mcp, documentId);
      reprocess.push({
        documentId,
        ok: result.ok,
        indexed: result.ok ? result.indexed : false,
        requiresOcr: result.ok ? result.requiresOcr : undefined,
        extractionQuality: result.ok ? result.extractionQuality : undefined,
        documentStatus: result.ok ? result.documentStatus : undefined,
        error: result.ok ? undefined : result.message,
      });
    }
  }

  const coalSearch = await runProductionKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Coal Search.pdf",
  });
  const arnold = await runProductionKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Investment opportunity Arnold Crescent.pdf",
  });
  const test1 = await runProductionKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Test1",
  });

  const scopeM365 = await runGatewayKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Search Microsoft 365 only for investments",
  });
  const scopeSharePoint = await runGatewayKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Search SharePoint for Elvex",
  });
  const scopeOneDrive = await runGatewayKnowledgeSearch(env, {
    companyId: COMPANY_ID,
    query: "Search OneDrive for financial information",
  });

  const regressionQueries = [
    "67567",
    "889",
    "123",
    "Microsoft Elvex invoice",
    "Elvex remittance",
    "Mizzen financial model",
  ];
  const regression: Record<string, unknown>[] = [];
  for (const query of regressionQueries) {
    const result = await runProductionKnowledgeSearch(env, { companyId: COMPANY_ID, query });
    regression.push({ query, hitCount: result.hitCount, ok: result.ok });
  }

  const parsedScope = applyKnowledgeSourceScopeToSearchArgs({
    query: "Search Microsoft 365 only for investments",
  });

  const m365Allowed = ["microsoft", "sharepoint", "onedrive", "outlook"];
  const m365Violations = scopeViolations(scopeM365.hits, m365Allowed);
  const spViolations = scopeViolations(scopeSharePoint.hits, ["sharepoint"]);
  const odViolations = scopeViolations(scopeOneDrive.hits, ["onedrive"]);

  const coalDoc = reprocess.find((r) => r.documentId === 54);
  const arnoldDoc = reprocess.find((r) => r.documentId === 71);
  const mizzenDoc = reprocess.find((r) => r.documentId === 64);

  const ocrLimited =
    (coalDoc?.requiresOcr === true || arnoldDoc?.requiresOcr === true) &&
    coalDoc?.documentStatus === "requires_ocr";

  return {
    classification: ocrLimited ? "PARTIAL" : "PASS",
    reprocess,
    acceptance: {
      coalSearch: { hitCount: coalSearch.hitCount, hits: coalSearch.hits, reindex: coalDoc },
      arnoldCrescent: { hitCount: arnold.hitCount, hits: arnold.hits, reindex: arnoldDoc },
      test1: { hitCount: test1.hitCount, hits: test1.hits },
      sourceScope: {
        m365: {
          scopeApplied: parsedScope.scopeApplied,
          violations: m365Violations,
          hitCount: scopeM365.hitCount,
          pass: m365Violations === 0,
        },
        sharepoint: { violations: spViolations, hitCount: scopeSharePoint.hitCount, pass: spViolations === 0 },
        onedrive: { violations: odViolations, hitCount: scopeOneDrive.hitCount, pass: odViolations === 0 },
      },
      mizzen: { reindex: mizzenDoc },
    },
    regression,
    deployedAt: new Date().toISOString(),
  };
}

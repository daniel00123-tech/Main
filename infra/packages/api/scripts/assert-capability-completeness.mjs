#!/usr/bin/env node
/**
 * Minimal deploy guard: refuse wrangler deploy if required capability
 * markers are absent from the current tree. Does not invent a new
 * production versioning scheme — it only asserts source completeness.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  {
    id: "oauth_mcp",
    file: "src/auth/mcp-oauth.ts",
    marker: "oauthAuthorizationServerMetadata",
  },
  {
    id: "whatsapp_intelligence",
    file: "src/services/whatsapp-intelligence.ts",
    marker: "retrieveDocumentChunks",
  },
  {
    id: "live_docqa",
    file: "src/services/intelligence/document-evidence.ts",
    marker: "documentHasUsableChunks",
  },
  {
    id: "portal_chat",
    file: "src/services/portal-chat.ts",
    marker: "runIntelligenceTurn",
  },
  {
    id: "elvex_xero_el_mcp",
    file: "src/services/elvex-xero-el-mcp.ts",
    marker: "executeElvexXeroReadViaElMcp",
  },
  {
    id: "xero_read_tools",
    file: "src/services/xero-read-tools.ts",
    marker: "withXeroReadTools",
  },
  {
    id: "business_system_intent",
    file: "../shared/src/permissions/business-system-intent.ts",
    marker: "resolveBusinessSystemIntent",
  },
  {
    id: "quality_mobile_buttons",
    file: "../web/src/pages/QualityImprovementsPage.tsx",
    marker: "quality-tap-target",
  },
  {
    id: "ask_document",
    file: "src/services/ask-document.ts",
    marker: "ASK_DOCUMENT_TOOL",
  },
  {
    id: "document_catalogue",
    file: "src/services/document-catalogue.ts",
    marker: "list_company_documents",
  },
  {
    id: "outlook_get",
    file: "src/services/microsoft-outlook-read.ts",
    marker: "outlook_get_message",
  },
  {
    id: "usage_attribution",
    file: "src/services/usage-attribution.ts",
    marker: "resolveConnectorInstanceId",
  },
];

const missing = [];
for (const item of REQUIRED) {
  const path = resolve(root, item.file);
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch {
    missing.push(`${item.id}: missing file ${item.file}`);
    continue;
  }
  if (!body.includes(item.marker)) {
    missing.push(`${item.id}: marker '${item.marker}' absent from ${item.file}`);
  }
}

if (missing.length) {
  console.error("Deploy refused: required capability markers absent.");
  for (const row of missing) console.error(` - ${row}`);
  process.exit(1);
}

console.log(`Capability completeness OK (${REQUIRED.length} markers).`);

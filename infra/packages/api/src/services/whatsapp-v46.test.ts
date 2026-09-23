import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import {
  collectProviderHttpUrl,
  firstHttpUrl,
  toStandardFetchPayload,
  toStandardSearchPayload,
} from "./mcp-knowledge-standard";
import { createWhatsAppInteractionContext } from "./whatsapp-interaction-context";
import { documentEntityFromHit } from "./whatsapp-entities";
import {
  enrichUrlFromHit,
  identityFromMetadata,
  lookupKnowledgeSourceUrl,
  persistDiscoveredSourceUrl,
  providerIdentityCandidates,
} from "./whatsapp-source-urls";
import { attachRequestedDocumentUrl, sourceLinkReply } from "./whatsapp-synthesize";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";

const CV_ID = "gdrive-1Wf0GFolzcLKJXBwc5jLMWzfglD84k5_CLTlsaxcQJfk";
const CV_FILE_ID = "1Wf0GFolzcLKJXBwc5jLMWzfglD84k5_CLTlsaxcQJfk";
const CV_URL = `https://docs.google.com/document/d/${CV_FILE_ID}/edit?usp=drivesdk`;
const COAL_URL = "https://contoso.sharepoint.com/sites/docs/CoalSearch.pdf";

function envWithKnowledge(): { env: Env; knowledge: Array<Record<string, unknown>> } {
  const knowledge: Array<Record<string, unknown>> = [
    {
      id: "mki_coal",
      title: "Coal Search.pdf",
      web_url: COAL_URL,
      source_type: "sharepoint",
      knowledge_document_id: 101,
      provenance_json: JSON.stringify({ webUrl: COAL_URL }),
      external_item_id: "item_coal_1",
      external_id: "item_coal_1",
      path: "/sites/docs/CoalSearch.pdf",
    },
    {
      id: "mki_cv",
      title: "CV 2015 1",
      web_url: CV_URL,
      source_type: "google_drive",
      knowledge_document_id: 670,
      provenance_json: JSON.stringify({ webViewLink: CV_URL, driveFileId: CV_FILE_ID }),
      external_item_id: CV_ID,
      external_id: CV_ID,
      path: null,
    },
    {
      id: "mki_nurl",
      title: "Internal note",
      web_url: null,
      source_type: "google_drive",
      knowledge_document_id: 999,
      provenance_json: JSON.stringify({ driveFileId: "no-url-file" }),
      external_item_id: "gdrive-no-url-file",
      external_id: "gdrive-no-url-file",
      path: null,
    },
  ];
  const contexts = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM microsoft_knowledge_items")) {
                return (
                  knowledge.find(
                    (row) =>
                      row.external_item_id === args[1] ||
                      row.external_id === args[1] ||
                      String(row.knowledge_document_id) === String(args[1]) ||
                      row.id === args[1],
                  ) ?? null
                );
              }
              if (sql.includes("FROM microsoft_file_jobs")) return null;
              return null;
            },
            async all() {
              if (sql.includes("FROM microsoft_knowledge_items") && sql.includes("LIKE")) {
                const like = String(args[1] ?? "").replace(/%/g, "").toLowerCase();
                return {
                  results: knowledge.filter((row) =>
                    String(row.title).toLowerCase().includes(like.split(" ")[0] ?? "___none"),
                  ),
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE microsoft_knowledge_items") && sql.includes("web_url")) {
                const row = knowledge.find((item) => item.id === args[2]);
                if (row && !row.web_url) row.web_url = args[0];
              }
              if (sql.includes("INSERT INTO whatsapp_interaction_contexts")) {
                contexts.set(String(args[1]).toLowerCase(), { source_url: args[10], title: args[8] });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return {
    knowledge,
    env: {
      DB: db,
      ENVIRONMENT: "test",
      SESSION_SECRET: "test",
      ALLOWED_ORIGINS: "http://localhost:5173",
      WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
      WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
      META_APP_SECRET: "meta-app-secret-for-tests-only",
    } as Env,
  };
}

describe("WhatsApp V4.6 provider URL preservation", () => {
  it("preserves Drive webViewLink through search/fetch adaptors", () => {
    const search = toStandardSearchPayload({
      results: [
        {
          id: CV_ID,
          title: "CV 2015 1",
          metadata: { source: "google_drive", driveFileId: CV_FILE_ID, webViewLink: CV_URL },
        },
      ],
    });
    expect(search.results[0]?.url).toBe(CV_URL);
    const fetched = toStandardFetchPayload(
      {
        document: {
          external_id: CV_ID,
          title: "CV 2015 1",
          metadata: JSON.stringify({ driveFileId: CV_FILE_ID, webViewLink: CV_URL }),
        },
        chunks: [{ content: "2015 CV body" }],
      },
      CV_ID,
    );
    expect(fetched.url).toBe(CV_URL);
    expect(fetched.id).toBe(CV_ID);
  });

  it("keeps a Drive item with no provider URL as null and does not invent a link", () => {
    const search = toStandardSearchPayload({
      results: [{ id: "gdrive-no-url-file", title: "Internal note", metadata: { driveFileId: "no-url-file" } }],
    });
    expect(search.results[0]?.url).toBe("");
    expect(firstHttpUrl("gdrive-no-url-file")).toBe("");
    expect(collectProviderHttpUrl({ driveFileId: "no-url-file", id: "gdrive-no-url-file" })).toBe("");
    expect(sourceLinkReply(documentEntityFromHit({ id: "gdrive-no-url-file", title: "Internal note" }))).not.toMatch(
      /https?:\/\//,
    );
  });

  it("still returns Microsoft SharePoint web_url for Coal Search", async () => {
    const { env } = envWithKnowledge();
    const hit = await lookupKnowledgeSourceUrl(env, "co_caddington", {
      title: "Coal Search.pdf",
      externalItemId: "item_coal_1",
    });
    expect(hit?.url).toBe(COAL_URL);
    expect(hit?.matchReason).toBe("provider_item");
    const search = toStandardSearchPayload({
      results: [{ id: "item_coal_1", title: "Coal Search.pdf", web_url: COAL_URL }],
    });
    expect(search.results[0]?.url).toBe(COAL_URL);
  });

  it("looks up Drive URLs by gdrive- id and raw file id", async () => {
    const { env } = envWithKnowledge();
    const byPrefixed = await lookupKnowledgeSourceUrl(env, "co_caddington", { entityId: CV_ID });
    const byRaw = await lookupKnowledgeSourceUrl(env, "co_caddington", { externalItemId: CV_FILE_ID });
    expect(byPrefixed?.url).toBe(CV_URL);
    expect(byRaw?.url).toBe(CV_URL);
    expect(providerIdentityCandidates(CV_ID)).toEqual(expect.arrayContaining([CV_ID, CV_FILE_ID]));
  });

  it("puts a genuine URL on WhatsApp memory and button context", async () => {
    const { env } = envWithKnowledge();
    const entity = documentEntityFromHit({
      id: CV_ID,
      title: "CV 2015 1",
      url: enrichUrlFromHit("", { webViewLink: CV_URL }),
      text: "Curriculum vitae",
      providerItemId: identityFromMetadata({ external_id: CV_ID, driveFileId: CV_FILE_ID }).providerItemId,
    });
    expect(entity.url).toBe(CV_URL);
    const created = await createWhatsAppInteractionContext(env, {
      companyId: "co_caddington",
      userId: "user_cbe6612b-c58b-472f-914b-be92eb6c8935",
      entity,
    });
    expect(created?.sourceUrl).toBe(CV_URL);
    expect(sourceLinkReply(entity)).toBe(`Here’s the document:\n${CV_URL}`);
    expect(
      attachRequestedDocumentUrl("I found CV 2015 1.", CV_URL, true),
    ).toContain(CV_URL);
  });

  it("persists a discovered provider URL onto an existing knowledge row only", async () => {
    const { env, knowledge } = envWithKnowledge();
    knowledge[2]!.web_url = null;
    const persisted = await persistDiscoveredSourceUrl(env, "co_caddington", {
      url: "https://drive.google.com/file/d/no-url-file/view",
      entityId: "gdrive-no-url-file",
    });
    expect(persisted).toBe(true);
    expect(knowledge[2]!.web_url).toBe("https://drive.google.com/file/d/no-url-file/view");
    const skipped = await persistDiscoveredSourceUrl(env, "co_caddington", {
      url: "https://example.test/invented",
      entityId: "gdrive-unknown-missing",
    });
    expect(skipped).toBe(false);
  });
});

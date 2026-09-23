import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { detectQualitySignals } from "./quality-auditor";
import {
  isSafeButtonId,
  mapButtonToUserText,
  suggestionButtons,
} from "./whatsapp-buttons";
import {
  mergeEntityMemory,
  resolveRememberedDocument,
  type WhatsAppDocumentEntity,
} from "./whatsapp-entities";
import {
  claimButtonIdempotency,
  createWhatsAppInteractionContext,
  expiredButtonReply,
  parseBoundButtonId,
  resolveWhatsAppInteractionContext,
} from "./whatsapp-interaction-context";
import { claimWhatsAppAck } from "./whatsapp-lifecycle";
import { planWhatsAppTurn } from "./whatsapp-plan";
import { lookupKnowledgeSourceUrl } from "./whatsapp-source-urls";
import { missingSourceLinkReply, sourceLinkReply } from "./whatsapp-synthesize";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";

const {
  executeGatewayRequest,
  sendWhatsAppTextMock,
  sendButtonsMock,
  getUserByMobileE164,
  toSessionUser,
  recordUsageEvent,
} = vi.hoisted(() => ({
  executeGatewayRequest: vi.fn(),
  sendWhatsAppTextMock: vi.fn(),
  sendButtonsMock: vi.fn(),
  getUserByMobileE164: vi.fn(),
  toSessionUser: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

vi.mock("./gateway", () => ({ executeGatewayRequest }));
vi.mock("./whatsapp-send", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp-send")>("./whatsapp-send");
  return {
    ...actual,
    sendWhatsAppText: sendWhatsAppTextMock,
    sendWhatsAppInteractiveButtons: sendButtonsMock,
    sendWhatsAppInteractiveList: vi.fn().mockResolvedValue({
      ok: false,
      kind: "customer_service_reply",
      error: "list_unused",
      retryable: false,
      attempts: 0,
    }),
    sendWhatsAppTypingIndicator: vi.fn().mockResolvedValue({ ok: true, supported: true }),
    sendWhatsAppReadStatus: vi.fn().mockResolvedValue({ ok: true, supported: true }),
  };
});
vi.mock("../auth/users", () => ({ getUserByMobileE164, toSessionUser }));
vi.mock("./usage", () => ({ recordUsageEvent }));
vi.mock("./quality-auditor", async () => {
  const actual = await vi.importActual<typeof import("./quality-auditor")>("./quality-auditor");
  return { ...actual, scheduleQualityAudit: vi.fn() };
});

import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";

const DOC_A: WhatsAppDocumentEntity = {
  id: "doc_a_policy",
  title: "Company Van Policy.docx",
  url: null,
  excerpt: "The Company-owned vehicle fleet is now in the process of being replaced.",
  amount: null,
  reference: null,
  sourceLabel: "Company Van Policy.docx",
};

const DOC_B: WhatsAppDocumentEntity = {
  id: "doc_b_cv",
  title: "Daniel Dwyer CV 2015.docx",
  url: null,
  excerpt: "Curriculum vitae covering 2015 experience and qualifications.",
  amount: null,
  reference: null,
  sourceLabel: "Daniel Dwyer CV 2015.docx",
};

function env(): Env {
  const conv = new Map<string, Record<string, unknown>>();
  const contexts = new Map<string, Record<string, unknown>>();
  const idem = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  const knowledge = [
    {
      title: "Coal Search.pdf",
      web_url: "https://contoso.sharepoint.com/sites/docs/CoalSearch.pdf",
      source_type: "sharepoint",
      knowledge_document_id: 101,
      provenance_json: JSON.stringify({ webUrl: "https://contoso.sharepoint.com/sites/docs/CoalSearch.pdf" }),
      external_item_id: "item_coal_1",
      path: "/sites/docs/CoalSearch.pdf",
    },
    {
      title: "Other Coal Notes.docx",
      web_url: "https://contoso.sharepoint.com/sites/docs/OtherCoalNotes.docx",
      source_type: "sharepoint",
      knowledge_document_id: 102,
      provenance_json: null,
      external_item_id: "item_coal_2",
      path: "/sites/docs/OtherCoalNotes.docx",
    },
  ];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM users") && sql.includes("status = 'active'")) {
                if (String(args[0]).includes("900123")) {
                  return {
                    id: "user_1",
                    email: "sam@example.com",
                    display_name: "Sam",
                    status: "active",
                    mobile_e164: "+447700900123",
                    mobile_verified: 1,
                    mobile_verification_required: 0,
                  };
                }
                return null;
              }
              if (sql.includes("FROM whatsapp_conversations")) {
                return conv.get(`conv:${args[0]}`) ?? null;
              }
              if (sql.includes("FROM whatsapp_interaction_contexts") && sql.includes("WHERE token")) {
                return contexts.get(String(args[0]).toLowerCase()) ?? null;
              }
              if (sql.includes("FROM whatsapp_button_idempotency")) {
                return idem.get(`${args[0]}|${args[1]}|${args[2]}`) ?? null;
              }
              if (sql.includes("FROM whatsapp_inbound_events")) {
                return events.get(String(args[0])) ?? null;
              }
              if (sql.includes("FROM microsoft_knowledge_items") && sql.includes("external_item_id = ?")) {
                return knowledge.find((row) => row.external_item_id === args[1] || String(row.knowledge_document_id) === args[1]) ?? null;
              }
              if (sql.includes("FROM microsoft_knowledge_items") && sql.includes("knowledge_document_id")) {
                return knowledge.find((row) => String(row.knowledge_document_id) === String(args[1])) ?? null;
              }
              if (sql.includes("FROM microsoft_file_jobs")) {
                return null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM company_memberships")) {
                return {
                  results: [
                    { company_id: "co_a", role: "admin", status: "active", company_name: "Alpha", company_slug: "alpha" },
                  ],
                };
              }
              if (sql.includes("FROM connector_instances")) {
                return {
                  results: [
                    { connector_definition_id: "conn_microsoft_365", name: "M365", status: "healthy", auth_status: "connected" },
                  ],
                };
              }
              if (sql.includes("FROM microsoft_knowledge_items") && sql.includes("LIKE")) {
                const like = String(args[1] ?? "").replace(/%/g, "").toLowerCase();
                return {
                  results: knowledge.filter((row) => row.title.toLowerCase().includes(like.split(" ")[0] ?? "___none")),
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO whatsapp_conversations")) {
                conv.set(`conv:${args[0]}`, {
                  user_id: args[0],
                  company_id: args[1],
                  pending_company_selection: args[2],
                  turns_json: args[3],
                  entities_json: args[4],
                  updated_at: args[5] ?? args[4],
                });
              }
              if (sql.includes("INSERT INTO whatsapp_interaction_contexts")) {
                contexts.set(String(args[1]).toLowerCase(), {
                  interaction_context_id: args[0],
                  token: args[1],
                  company_id: args[2],
                  user_id: args[3],
                  conversation_id: args[4],
                  source_message_id: args[5],
                  entity_type: args[6],
                  entity_id: args[7],
                  title: args[8],
                  source_system: args[9],
                  source_url: args[10],
                  excerpt: args[11],
                  search_id: args[12],
                  result_id: args[13],
                  provider_item_id: args[14],
                  source_key: args[15],
                  created_at: args[16],
                  expires_at: args[17],
                });
              }
              if (sql.includes("INSERT INTO whatsapp_button_idempotency")) {
                idem.set(`${args[0]}|${args[1]}|${args[2]}`, { reply: args[3] });
              }
              if (sql.includes("UPDATE whatsapp_inbound_events") && sql.includes("acknowledgement_sent_at")) {
                const current = events.get(String(args[2])) ?? {};
                if (current.acknowledgement_sent_at) {
                  return { success: true, meta: { changes: 0 } };
                }
                events.set(String(args[2]), { ...current, acknowledgement_sent_at: args[0], first_visible_at: args[1] });
                return { success: true, meta: { changes: 1 } };
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
    DB: db,
    ENVIRONMENT: "test",
    SESSION_SECRET: "test",
    ALLOWED_ORIGINS: "http://localhost:5173",
    WHATSAPP_PHONE_NUMBER_ID: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    WHATSAPP_ACCESS_TOKEN: "EAAG-test-token-not-real",
    META_APP_SECRET: "meta-app-secret-for-tests-only",
    WHATSAPP_OUTBOUND_AI_ENABLED: "true",
  } as Env;
}

function inbound(text: string) {
  return {
    wamid: `wamid.${Math.random().toString(16).slice(2)}`,
    from: "447700900123",
    type: "text" as const,
    text,
    phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
    timestamp: "1710000000",
    inputKind: "text" as const,
    mediaId: null,
    mimeType: null,
    buttonId: null,
    buttonTitle: null,
  };
}

function lastButtons(): Array<{ id: string; title: string }> {
  const call = sendButtonsMock.mock.calls.at(-1);
  return (call?.[1]?.buttons ?? []) as Array<{ id: string; title: string }>;
}

function mockKnowledge() {
  executeGatewayRequest.mockImplementation(async (_env: unknown, input: { toolName?: string; arguments?: Record<string, unknown> }) => {
    const tool = String(input.toolName ?? "");
    const query = String(input.arguments?.query ?? input.arguments?.documentRef ?? input.arguments?.id ?? "").toLowerCase();
    const isB = /cv|2015|dwyer|doc_b/.test(query);
    const doc = isB ? DOC_B : DOC_A;
    if (tool.includes("document") || tool.includes("fetch") || tool.includes("read")) {
      return {
        status: 200,
        result: { id: doc.id, title: doc.title, text: doc.excerpt, url: doc.url },
      };
    }
    return {
      status: 200,
      result: {
        results: [{ id: doc.id, title: doc.title, snippet: doc.excerpt, url: doc.url }],
      },
    };
  });
}

describe("WhatsApp V4.5 entity-bound buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWhatsAppTextMock.mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.out",
      attempts: 1,
      httpStatus: 200,
      rawAccepted: true,
    });
    sendButtonsMock.mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.btn",
      attempts: 1,
      httpStatus: 200,
      rawAccepted: true,
    });
    getUserByMobileE164.mockResolvedValue({
      id: "user_1",
      email: "sam@example.com",
      displayName: "Sam",
      status: "active",
      mobileE164: "+447700900123",
    });
    toSessionUser.mockResolvedValue({
      id: "user_1",
      email: "sam@example.com",
      displayName: "Sam",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_a", role: "admin", customRoleId: null, teamId: null }],
      credentialsVersion: 1,
    });
    recordUsageEvent.mockResolvedValue({ id: "usage_1" });
    mockKnowledge();
  });

  it("binds document buttons to opaque ctx tokens and never embeds raw ids or urls", () => {
    const buttons = suggestionButtons({
      kind: "document",
      hasSourceUrl: false,
      contextToken: "ctx_ab12cd34ef56",
    });
    expect(buttons.map((button) => button.title)).toEqual(["Summarise", "Find similar", "More detail"]);
    expect(buttons.every((button) => /^ctx_ab12cd34ef56:/.test(button.id))).toBe(true);
    expect(buttons.some((button) => /sharepoint|http|doc_/i.test(button.id))).toBe(false);
    expect(suggestionButtons({ kind: "document", hasSourceUrl: true })).toEqual([]);
    expect(isSafeButtonId("ctx_ab12cd34ef56:summarise")).toBe(true);
    expect(mapButtonToUserText("ctx_ab12cd34ef56:summarise")).toEqual({
      text: "summarise it",
      action: "summarise",
      supported: true,
      contextToken: "ctx_ab12cd34ef56",
    });
    expect(parseBoundButtonId("ctx_ab12cd34ef56:more_detail")).toMatchObject({
      bound: true,
      action: "more_detail",
      token: "ctx_ab12cd34ef56",
    });
  });

  it("rotates last_document into recent_documents and resolves previous/title references", () => {
    const afterA = mergeEntityMemory({}, { lastDocument: DOC_A });
    const afterB = mergeEntityMemory(afterA, { lastDocument: DOC_B });
    expect(afterB.lastDocument?.id).toBe(DOC_B.id);
    expect(afterB.recentDocuments?.map((doc) => doc.id)).toEqual([DOC_A.id]);
    expect(resolveRememberedDocument(afterB, "summarise it")?.id).toBe(DOC_B.id);
    expect(resolveRememberedDocument(afterB, "the previous one")?.id).toBe(DOC_A.id);
    expect(resolveRememberedDocument(afterB, "the CV")?.id).toBe(DOC_B.id);
  });

  it("names the title when a source URL is missing and does not invent one", () => {
    expect(missingSourceLinkReply(DOC_B.title)).toBe(
      `I found “${DOC_B.title}”, but I don’t currently have a direct source link for it.`,
    );
    expect(sourceLinkReply(DOC_B)).toMatch(/Daniel Dwyer CV 2015/i);
    expect(sourceLinkReply(DOC_B)).not.toMatch(/https?:\/\//);
  });

  it("prefers provider item identity over ambiguous title matches", async () => {
    const runtime = env();
    const byId = await lookupKnowledgeSourceUrl(runtime, "co_a", {
      title: "Coal",
      externalItemId: "item_coal_1",
    });
    expect(byId?.url).toMatch(/CoalSearch\.pdf/);
    expect(byId?.matchReason).toBe("provider_item");
    const ambiguous = await lookupKnowledgeSourceUrl(runtime, "co_a", { title: "Coal" });
    expect(ambiguous).toBeNull();
  });

  it("A then B: Summarise on B is B, More detail on A is A, typed summarise is B, find similar seeds B", async () => {
    const runtime = env();
    await handleWhatsAppInboundMessage(runtime, inbound("can you find a file around van policy and summarise it"));
    const buttonsA = lastButtons();
    const moreDetailA = buttonsA.find((button) => button.title === "More detail")?.id;
    expect(moreDetailA).toMatch(/^ctx_[a-z0-9]+:more_detail$/);

    await handleWhatsAppInboundMessage(
      runtime,
      inbound("ok that is great can you find anything about my CV 2015 and the URL where to find that doc"),
    );
    const buttonsB = lastButtons();
    const summariseB = buttonsB.find((button) => button.title === "Summarise")?.id;
    const findSimilarB = buttonsB.find((button) => button.title === "Find similar")?.id;
    expect(summariseB).toMatch(/^ctx_[a-z0-9]+:summarise$/);
    expect(summariseB).not.toBe(moreDetailA?.replace(":more_detail", ":summarise"));

    executeGatewayRequest.mockClear();
    const typed = await handleWhatsAppInboundMessage(runtime, inbound("summarise it"));
    expect(typed.publicReply).toMatch(/Daniel Dwyer CV 2015/i);
    expect(typed.publicReply).not.toMatch(/Van Policy/i);

    executeGatewayRequest.mockClear();
    const clickB = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: summariseB!,
      buttonTitle: "Summarise",
    });
    expect(clickB.publicReply).toMatch(/Daniel Dwyer CV 2015/i);
    expect(clickB.publicReply).not.toMatch(/Van Policy/i);
    expect(clickB.boundEntityTitle).toMatch(/CV 2015/i);
    expect(clickB.usedStaleLastDocument).toBe(false);

    executeGatewayRequest.mockClear();
    const clickA = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: moreDetailA!,
      buttonTitle: "More detail",
    });
    expect(clickA.publicReply).toMatch(/Van Policy/i);
    expect(clickA.publicReply).not.toMatch(/Daniel Dwyer CV 2015/i);

    executeGatewayRequest.mockClear();
    const similar = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: findSimilarB!,
      buttonTitle: "Find similar",
    });
    const searchQuery = executeGatewayRequest.mock.calls
      .map((call) => String(call[1]?.arguments?.query ?? ""))
      .find((query) => query.length > 0);
    expect(searchQuery).toMatch(/Daniel Dwyer CV 2015/i);
    expect(searchQuery).not.toMatch(/van policy/i);
    expect(similar.publicReply).toMatch(/Daniel Dwyer CV 2015/i);
  });

  it("expired bound buttons never fall back to last_document", async () => {
    const runtime = env();
    const created = await createWhatsAppInteractionContext(runtime, {
      companyId: "co_a",
      userId: "user_1",
      entity: DOC_A,
      now: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    expect(created?.token).toBeTruthy();
    const result = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: `${created!.token}:summarise`,
      buttonTitle: "Summarise",
    });
    expect(result.publicReply).toBe(expiredButtonReply("summarise"));
    expect(result.publicReply).not.toMatch(/Van Policy|CV 2015/i);
    expect(result.usedStaleLastDocument).toBeFalsy();
  });

  it("denies cross-tenant button token tampering", async () => {
    const runtime = env();
    const foreign = await createWhatsAppInteractionContext(runtime, {
      companyId: "co_other",
      userId: "user_other",
      entity: DOC_B,
    });
    const result = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: `${foreign!.token}:summarise`,
      buttonTitle: "Summarise",
    });
    expect(result.publicReply).toMatch(/can’t use that option/i);
    expect(result.publicReply).not.toMatch(/Daniel Dwyer CV 2015|Van Policy/i);
    expect(result.outcome).toBe("write_blocked");
  });

  it("button idempotency is keyed by wamid + context + action", async () => {
    const runtime = env();
    const first = await claimButtonIdempotency(runtime, {
      wamid: "wamid.dup",
      token: "ctx_ab12cd34ef56",
      action: "summarise",
      reply: "first",
    });
    const second = await claimButtonIdempotency(runtime, {
      wamid: "wamid.dup",
      token: "ctx_ab12cd34ef56",
      action: "summarise",
    });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it("claimWhatsAppAck allows only one ack writer", async () => {
    const runtime = env();
    const first = await claimWhatsAppAck(runtime, "wamid.ack-first");
    const second = await claimWhatsAppAck(runtime, "wamid.ack-first");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("planner still clarifies a broad doc-or-two ask and searches a named policy", () => {
    expect(
      planWhatsAppTurn({
        text: "can you find me a doc or two on the system and tell me about it",
        memory: {},
        connectors: ["conn_microsoft_365"],
      }).action,
    ).toBe("clarify");
    const named = planWhatsAppTurn({
      text: "can you find a file for me around van policy and summarise it",
      memory: {},
      connectors: ["conn_microsoft_365"],
    });
    expect(named.action).toMatch(/knowledge|guidance/);
    expect(named.skipTools).toBe(false);
  });

  it("emits quality signals for wrong entity, stale last_document, and missing provider URL", () => {
    const categories = detectQualitySignals({
      interactionId: "int_v45",
      companyId: "co_a",
      channel: "whatsapp",
      usage: [
        {
          action: "whatsapp.reply",
          success: true,
          durationMs: 4_000,
          metadata: {
            channel: "whatsapp",
            inputKind: "button",
            buttonAction: "summarise",
            wrongEntity: true,
            buttonDisplayedEntityId: "doc_b_cv",
            operatedEntityId: "doc_a_policy",
            usedStaleLastDocument: true,
            sourceUrlMissingWithProviderMetadata: true,
            userCorrectedAfterButton: true,
          },
        },
      ],
    }).map((row) => row.category);
    expect(categories).toEqual(
      expect.arrayContaining([
        "whatsapp_wrong_entity",
        "whatsapp_button_entity_mismatch",
        "whatsapp_stale_last_document_fallback",
        "whatsapp_source_url_missing_with_provider_metadata",
        "whatsapp_user_corrected_after_button",
      ]),
    );
  });
});

describe("WhatsApp V4.5 context store isolation", () => {
  it("resolves only the owning user and tenant before expiry", async () => {
    const runtime = env();
    const created = await createWhatsAppInteractionContext(runtime, {
      companyId: "co_a",
      userId: "user_1",
      entity: DOC_B,
    });
    const ok = await resolveWhatsAppInteractionContext(runtime, {
      token: created!.token,
      userId: "user_1",
      companyId: "co_a",
    });
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.context.entityId).toBe(DOC_B.id);
    const denied = await resolveWhatsAppInteractionContext(runtime, {
      token: created!.token,
      userId: "user_1",
      companyId: "co_other",
    });
    expect(denied.status).toBe("denied");
    const expired = await createWhatsAppInteractionContext(runtime, {
      companyId: "co_a",
      userId: "user_1",
      entity: DOC_A,
      now: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    const late = await resolveWhatsAppInteractionContext(runtime, {
      token: expired!.token,
      userId: "user_1",
      companyId: "co_a",
    });
    expect(late.status).toBe("expired");
  });
});

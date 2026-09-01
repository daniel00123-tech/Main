import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { classifyUsageResource } from "./customer-economics";
import { detectQualitySignals } from "./quality-auditor";
import { ACK_VARIANTS_V4, applyCustomerTone, countEmojis, documentResultCopy, welcomeFoundationReply } from "./whatsapp-tone";
import {
  isSafeButtonId,
  mapButtonToUserText,
  shouldAttachButtons,
  suggestionButtons,
} from "./whatsapp-buttons";
import { inspectTranscriptionProvider, isAllowedWhatsAppAudioMime } from "./whatsapp-transcribe";
import { parseWhatsAppInboundMessages } from "./whatsapp-webhook";
import { INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID, INFRA_WHATSAPP_PHONE_NUMBER_ID } from "./whatsapp-assets";
import { UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE } from "./phone";
import { acknowledgementMessage } from "./whatsapp-conversation";
import { compressDocumentAnswer, wantsFullDetail, wantsVeryShort } from "./whatsapp-compress";

const {
  executeGatewayRequest,
  sendWhatsAppTextMock,
  sendButtonsMock,
  getUserByMobileE164,
  toSessionUser,
  recordUsageEvent,
  downloadWhatsAppMedia,
  transcribeWhatsAppAudioMock,
} = vi.hoisted(() => ({
  executeGatewayRequest: vi.fn(),
  sendWhatsAppTextMock: vi.fn(),
  sendButtonsMock: vi.fn(),
  getUserByMobileE164: vi.fn(),
  toSessionUser: vi.fn(),
  recordUsageEvent: vi.fn(),
  downloadWhatsAppMedia: vi.fn(),
  transcribeWhatsAppAudioMock: vi.fn(),
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
  };
});
vi.mock("../auth/users", () => ({ getUserByMobileE164, toSessionUser }));
vi.mock("./usage", () => ({ recordUsageEvent }));
vi.mock("./quality-auditor", async () => {
  const actual = await vi.importActual<typeof import("./quality-auditor")>("./quality-auditor");
  return { ...actual, scheduleQualityAudit: vi.fn() };
});
vi.mock("./whatsapp-media", () => ({ downloadWhatsAppMedia }));
vi.mock("./whatsapp-transcribe", async () => {
  const actual = await vi.importActual<typeof import("./whatsapp-transcribe")>("./whatsapp-transcribe");
  return { ...actual, transcribeWhatsAppAudio: transcribeWhatsAppAudioMock };
});

import { handleWhatsAppInboundMessage } from "./whatsapp-orchestrator";

function env(overrides: Partial<Env> = {}): Env {
  const store = new Map<string, Record<string, unknown>>();
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
                return store.get(`conv:${args[0]}`) ?? null;
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
                    { connector_definition_id: "conn_xero", name: "Xero", status: "healthy", auth_status: "connected" },
                  ],
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO whatsapp_conversations")) {
                store.set(`conv:${args[0]}`, {
                  user_id: args[0],
                  company_id: args[1],
                  pending_company_selection: args[2],
                  turns_json: args[3],
                  entities_json: args[4],
                  updated_at: args[5] ?? args[4],
                });
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
    ...overrides,
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

describe("WhatsApp V4 tone", () => {
  it("uses controlled acknowledgements and clamps emojis", () => {
    expect(ACK_VARIANTS_V4).toContain(acknowledgementMessage("seed"));
    expect(countEmojis("Got it 👍 I’m checking now.")).toBe(1);
    expect(countEmojis(applyCustomerTone("Thanks 👍 ✅ 📄 🔎 extra"))).toBeLessThanOrEqual(2);
    expect(applyCustomerTone("REQUEST ACCEPTED Executing MCP query")).not.toMatch(/REQUEST ACCEPTED|Executing MCP/i);
    expect(welcomeFoundationReply("Daniel")).toMatch(/Hi Daniel/);
  });

  it("structures document results answer-first", () => {
    const reply = documentResultCopy({
      title: "Coal Search.pdf",
      relates: "It relates to a coal-search payment confirmation.",
      amount: "£49.92",
      reference: "CAD021/01",
    });
    expect(reply).toMatch(/^I found Coal Search\.pdf 📄/);
    expect(reply).toMatch(/• Amount: £49\.92/);
    expect(reply).toMatch(/• Reference: CAD021\/01/);
    expect(compressDocumentAnswer({
      title: "Coal Search.pdf",
      text: "Payment confirmation Amount £49.92 Order id: CAD021/01 coal search",
      question: "find coal search",
    })).toMatch(/I found Coal Search\.pdf/);
    expect(wantsVeryShort("just tell me quickly")).toBe(true);
    expect(wantsFullDetail("give me detail")).toBe(true);
  });
});

describe("WhatsApp V4 buttons", () => {
  it("maps allowlisted callbacks to typed phrases and rejects writes", () => {
    expect(mapButtonToUserText("summarise").text).toBe("summarise it");
    expect(mapButtonToUserText("more_detail").text).toBe("give me more detail");
    expect(mapButtonToUserText("open_source").text).toBe("send me the link");
    expect(isSafeButtonId("send invoice")).toBe(false);
    expect(mapButtonToUserText("send_invoice", "Send invoice").supported).toBe(false);
    expect(shouldAttachButtons("short", suggestionButtons({ kind: "document", hasSourceUrl: true }))).toBe(true);
  });

  it("does not advertise finance without Xero or write actions", () => {
    expect(suggestionButtons({ kind: "finance", hasXero: false })).toEqual([]);
    expect(suggestionButtons({ kind: "help", hasXero: false }).map((button) => button.id)).toEqual([
      "find_document",
      "what_else",
    ]);
    expect(suggestionButtons({ kind: "document", hasSourceUrl: true }).some((button) => /invoice|write/i.test(button.id))).toBe(
      false,
    );
  });
});

describe("WhatsApp V4 webhook parse", () => {
  it("parses interactive replies and voice notes", () => {
    const button = parseWhatsAppInboundMessages({
      object: "whatsapp_business_account",
      entry: [
        {
          id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
                messages: [
                  {
                    id: "wamid.BTN",
                    from: "447700900123",
                    type: "interactive",
                    interactive: { type: "button_reply", button_reply: { id: "summarise", title: "Summarise" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    })[0];
    expect(button?.inputKind).toBe("button");
    expect(button?.buttonId).toBe("summarise");

    const voice = parseWhatsAppInboundMessages({
      object: "whatsapp_business_account",
      entry: [
        {
          id: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: INFRA_WHATSAPP_PHONE_NUMBER_ID },
                messages: [
                  {
                    id: "wamid.VOICE",
                    from: "447700900123",
                    type: "audio",
                    audio: { id: "MEDIA123456", mime_type: "audio/ogg; codecs=opus", voice: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    })[0];
    expect(voice?.inputKind).toBe("voice");
    expect(voice?.mediaId).toBe("MEDIA123456");
    expect(isAllowedWhatsAppAudioMime("audio/ogg; codecs=opus")).toBe(true);
    expect(isAllowedWhatsAppAudioMime("application/pdf")).toBe(false);
  });
});

describe("WhatsApp V4 transcription provider", () => {
  it("prefers Workers AI then OpenAI and does not invent costs", async () => {
    expect(inspectTranscriptionProvider({} as unknown as Env).configured).toBe(false);
    expect(
      inspectTranscriptionProvider({ AI: { run: async () => ({ text: "hello" }) } } as unknown as Env).provider,
    ).toBe("workers-ai");
    expect(
      inspectTranscriptionProvider({ OPENAI_API_KEY: "sk-test-key-1234567890" } as unknown as Env).provider,
    ).toBe("openai");
    const real = await vi.importActual<typeof import("./whatsapp-transcribe")>("./whatsapp-transcribe");
    const result = await real.transcribeWhatsAppAudio(
      { AI: { run: async () => ({ text: "find coal search" }) } } as unknown as Env,
      { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "audio/ogg" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.costBasis).toBe("unknown");
      expect(result.costCents).toBeNull();
      expect(result.text).toBe("find coal search");
    }
  });
});

describe("WhatsApp V4 quality and economics", () => {
  it("classifies transcription separately from transport and conversation", () => {
    expect(classifyUsageResource({ resourceType: "whatsapp", action: "whatsapp.reply" }).service).toBe(
      "whatsapp_transport",
    );
    expect(classifyUsageResource({ resourceType: "whatsapp", action: "whatsapp.ack" }).service).toBe(
      "whatsapp_conversation",
    );
    expect(classifyUsageResource({ resourceType: "whatsapp_transcription", action: "whatsapp.transcribe" }).service).toBe(
      "whatsapp_transcription",
    );
  });

  it("flags button, voice, emoji and oversized reply signals", () => {
    const signals = detectQualitySignals({
      interactionId: "int_v4",
      companyId: "co_a",
      channel: "whatsapp",
      usage: [
        {
          toolName: "whatsapp.send",
          success: true,
          metadata: {
            channel: "whatsapp",
            inputKind: "voice",
            acknowledgementSent: true,
            finalSent: false,
            voiceDownloadFailed: true,
            transcriptionFailed: true,
            transcriptionMs: 16_000,
            emojiCount: 4,
            replyLength: 1400,
            buttonFailed: true,
            suggestionUnsupported: "check_finance",
          },
        },
      ],
    });
    const categories = signals.map((signal) => signal.category);
    expect(categories).toEqual(expect.arrayContaining([
      "whatsapp_button_failed",
      "whatsapp_voice_download_failed",
      "whatsapp_transcription_failed",
      "whatsapp_transcription_slow",
      "whatsapp_voice_no_response",
      "whatsapp_excessive_emojis",
      "whatsapp_oversized_reply",
      "whatsapp_unsupported_suggestion",
    ]));
  });
});

describe("WhatsApp V4 orchestration", () => {
  beforeEach(() => {
    executeGatewayRequest.mockReset();
    sendWhatsAppTextMock.mockReset().mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.OUT",
      attempts: 1,
    });
    sendButtonsMock.mockReset().mockResolvedValue({
      ok: true,
      kind: "customer_service_reply",
      messageId: "wamid.BTN",
      attempts: 1,
    });
    recordUsageEvent.mockReset().mockResolvedValue({ id: "usage_1" });
    downloadWhatsAppMedia.mockReset();
    transcribeWhatsAppAudioMock.mockReset();
    getUserByMobileE164.mockResolvedValue({
      id: "user_1",
      email: "sam@example.com",
      displayName: "Sam",
      status: "active",
    });
    toSessionUser.mockResolvedValue({
      userId: "user_1",
      email: "sam@example.com",
      displayName: "Sam",
      isPlatformAdmin: false,
      memberships: [{ companyId: "co_a", role: "admin", customRoleId: null, teamId: null }],
      credentialsVersion: 1,
    });
  });

  it("answers Hi, Thanks and Help without tools and attaches help buttons", async () => {
    for (const text of ["Hi", "Thanks", "Help"]) {
      const result = await handleWhatsAppInboundMessage(env(), inbound(text));
      expect(result.outcome).toBe("answered");
      expect(executeGatewayRequest).not.toHaveBeenCalled();
      expect(result.publicReply).not.toMatch(/REQUEST ACCEPTED|Executing MCP|Database lookup/i);
    }
    expect(sendButtonsMock).toHaveBeenCalled();
    const helpCall = sendButtonsMock.mock.calls.find((call) =>
      String(call[1]?.body ?? "").match(/search documents|connected systems/i),
    );
    expect(helpCall?.[1]?.buttons?.map((button: { id: string }) => button.id)).toEqual([
      "find_document",
      "check_finance",
      "what_else",
    ]);
  });

  it("treats a Summarise button as typed summarise it and keeps document memory", async () => {
    executeGatewayRequest.mockImplementation(async (_env: unknown, input: { toolName?: string }) => {
      if (String(input.toolName ?? "").includes("document")) {
        return {
          status: 200,
          result: {
            title: "Coal Search.pdf",
            text: "Payment confirmation £49.92 CAD021/01 coal search",
            url: "https://contoso.sharepoint.com/CoalSearch.pdf",
          },
        };
      }
      return {
        status: 200,
        result: {
          results: [
            {
              id: "coal",
              title: "Coal Search.pdf",
              snippet: "coal search payment",
              url: "https://contoso.sharepoint.com/CoalSearch.pdf",
            },
          ],
        },
      };
    });
    const runtime = env();
    await handleWhatsAppInboundMessage(runtime, inbound("Find the Coal Search document"));
    executeGatewayRequest.mockClear();
    const tapped = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: "summarise",
      buttonTitle: "Summarise",
    });
    expect(tapped.inputKind).toBe("button");
    expect(tapped.publicReply).toMatch(/Coal Search/i);
    expect(tapped.publicReply).not.toMatch(/Also found|jsessionid/i);
    executeGatewayRequest.mockClear();
    const open = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: "open_source",
      buttonTitle: "Open source",
    });
    expect(open.publicReply).toMatch(/https:\/\/contoso\.sharepoint\.com\/CoalSearch\.pdf/);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });

  it("rejects unsupported and write button callbacks", async () => {
    const unsupported = await handleWhatsAppInboundMessage(env(), {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: "tenant_switch",
      buttonTitle: "Other company",
    });
    expect(unsupported.publicReply).toMatch(/didn’t recognise that option/i);
    const write = await handleWhatsAppInboundMessage(env(), {
      ...inbound(""),
      type: "interactive",
      inputKind: "button",
      buttonId: "send invoice",
      buttonTitle: "Send invoice",
    });
    expect(write.publicReply).toMatch(/didn’t recognise that option/i);
  });

  it("transcribes a recognised voice note into the same brain and does not echo the transcript", async () => {
    downloadWhatsAppMedia.mockResolvedValue({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg; codecs=opus",
      bytesLength: 3,
    });
    transcribeWhatsAppAudioMock.mockResolvedValue({
      ok: true,
      provider: "workers-ai",
      model: "@cf/openai/whisper-tiny-en",
      durationSeconds: 4,
      inputBytes: 3,
      text: "Find the Coal Search document",
      confidence: null,
      costBasis: "unknown",
      costCents: null,
    });
    executeGatewayRequest.mockImplementation(async (_env: unknown, input: { toolName?: string }) => {
      if (String(input.toolName ?? "").includes("document")) {
        return {
          status: 200,
          result: {
            title: "Coal Search.pdf",
            text: "Payment confirmation £49.92 CAD021/01 coal search",
            url: "https://contoso.sharepoint.com/CoalSearch.pdf",
          },
        };
      }
      return {
        status: 200,
        result: { results: [{ id: "coal", title: "Coal Search.pdf", snippet: "coal search payment" }] },
      };
    });
    const runtime = env();
    const voice = await handleWhatsAppInboundMessage(runtime, {
      ...inbound(""),
      type: "audio",
      inputKind: "voice",
      mediaId: "MEDIA123456",
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(voice.acknowledgementSent).toBe(true);
    expect(sendWhatsAppTextMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes("voice note"))).toBe(true);
    expect(voice.publicReply).toMatch(/Coal Search/i);
    expect(voice.publicReply).not.toMatch(/Find the Coal Search document/);
    const follow = await handleWhatsAppInboundMessage(runtime, inbound("summarise it"));
    expect(follow.publicReply).toMatch(/Coal Search/i);
  });

  it("does not download audio for an unknown sender", async () => {
    const result = await handleWhatsAppInboundMessage(env(), {
      wamid: "wamid.unknown",
      from: "447700900999",
      type: "audio",
      text: null,
      phoneNumberId: INFRA_WHATSAPP_PHONE_NUMBER_ID,
      businessAccountId: INFRA_WHATSAPP_BUSINESS_ACCOUNT_ID,
      timestamp: "1710000000",
      inputKind: "voice",
      mediaId: "MEDIA999",
      mimeType: "audio/ogg",
      buttonId: null,
      buttonTitle: null,
    });
    expect(result.publicReply).toBe(UNKNOWN_WHATSAPP_ACCOUNT_MESSAGE);
    expect(downloadWhatsAppMedia).not.toHaveBeenCalled();
  });

  it("asks to resend when transcription fails and does not invent text", async () => {
    downloadWhatsAppMedia.mockResolvedValue({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/ogg",
      bytesLength: 3,
    });
    transcribeWhatsAppAudioMock.mockResolvedValue({
      ok: false,
      provider: "workers-ai",
      model: "@cf/openai/whisper-tiny-en",
      reason: "empty",
      message: "empty_transcript",
      inputBytes: 3,
      durationSeconds: 2,
    });
    const result = await handleWhatsAppInboundMessage(env(), {
      ...inbound(""),
      type: "audio",
      inputKind: "voice",
      mediaId: "MEDIAFAIL1",
      mimeType: "audio/ogg",
    });
    expect(result.publicReply).toMatch(/couldn’t clearly understand/i);
    expect(executeGatewayRequest).not.toHaveBeenCalled();
  });
});

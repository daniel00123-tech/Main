import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../auth/session";
import type { Env } from "../env";
import {
  getPortalConversation,
  isGenericRetryCopy,
  resetPortalChatSchemaCache,
  sendPortalChatMessage,
} from "./portal-chat";
import { PORTAL_CHAT_SOURCE_CLIENT } from "./portal-chat-types";
import { classifyReadTerminal } from "./intelligence/verbalise-business.js";

type Row = Record<string, unknown>;

function memoryDb() {
  const conversations: Row[] = [];
  const messages: Row[] = [];
  const memberships: Row[] = [];
  const companies: Row[] = [{ id: "co_el", name: "Elvex", slug: "elvex" }];
  const usage: Row[] = [];

  function run(sql: string, values: unknown[]) {
    if (sql.startsWith("CREATE")) return { success: true };
    if (sql.includes("INSERT INTO portal_conversations")) {
      conversations.push({
        id: values[0],
        company_id: values[1],
        user_id: values[2],
        title: values[3],
        context_json: "{}",
        created_at: values[4],
        updated_at: values[5],
      });
      return { success: true };
    }
    if (sql.includes("INSERT INTO portal_conversation_messages")) {
      messages.push({
        id: values[0],
        conversation_id: values[1],
        company_id: values[2],
        user_id: values[3],
        role: values[4],
        content: values[5],
        metadata_json: values[6],
        created_at: values[7],
      });
      return { success: true };
    }
    if (sql.includes("UPDATE portal_conversations SET context_json")) {
      const row = conversations.find((item) => item.id === values[3] && item.company_id === values[4] && item.user_id === values[5]);
      if (row) {
        row.context_json = values[0];
        row.title = values[1];
        row.updated_at = values[2];
      }
      return { success: true };
    }
    if (sql.includes("FROM portal_conversations") && sql.includes("ORDER BY updated_at")) {
      return conversations
        .filter((row) => row.company_id === values[0] && row.user_id === values[1])
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    if (sql.includes("FROM portal_conversations") && sql.includes("WHERE id = ?")) {
      return conversations.find((row) => row.id === values[0] && row.company_id === values[1] && row.user_id === values[2]) ?? null;
    }
    if (sql.includes("FROM portal_conversation_messages")) {
      return messages
        .filter((row) => row.conversation_id === values[0] && row.company_id === values[1])
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    if (sql.includes("FROM company_memberships")) {
      return memberships.find((row) => row.user_id === values[0] && row.company_id === values[1]) ?? null;
    }
    if (sql.includes("FROM companies WHERE id")) return companies.find((row) => row.id === values[0]) ?? null;
    if (sql.includes("FROM connector_instances")) return [];
    if (sql.includes("INSERT INTO usage_records") || sql.includes("FROM usage_records")) {
      usage.push({ sql, values });
      return { results: usage };
    }
    return null;
  }

  const db = {
    conversations,
    messages,
    memberships,
    usage,
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              const result = run(sql, values);
              return Array.isArray(result) ? result[0] ?? null : result;
            },
            async all() {
              const result = run(sql, values);
              return { results: Array.isArray(result) ? result : result ? [result] : [] };
            },
            async run() {
              run(sql, values);
              return { success: true };
            },
          };
        },
        async run() {
          run(sql, []);
          return { success: true };
        },
      };
    },
  };
  return db as unknown as D1Database & { conversations: Row[]; messages: Row[] };
}

function actor(role: "director" | "office_staff"): SessionUser {
  return {
    userId: role === "director" ? "user_ella" : "user_sharon",
    email: role === "director" ? "ella@elvexpropertyservices.com" : "sharon@elvexpropertyservices.com",
    displayName: role,
    isPlatformAdmin: false,
    memberships: [{ companyId: "co_el", role }],
  };
}

const INFO_MAIL = {
  mailboxAddress: "info@elvexpropertyservices.com",
  messages: [{ subject: "Keys for 12 High Street", from: "tenant@example.com", receivedDateTime: "2026-09-04T08:40:00Z" }],
};
const FINANCE_MAIL = {
  mailboxAddress: "finance@elvexpropertyservices.com",
  messages: [{ subject: "Supplier statement", from: "accounts@supplier.test", receivedDateTime: "2026-09-04T07:10:00Z" }],
};
const XERO = {
  source: "Xero",
  sales_total: 4554,
  invoice_count: 27,
  currencyCode: "GBP",
  period: { fromDate: "2026-09-01", toDate: "2026-09-04" },
};
const PO_DOC = {
  results: [{ id: "doc_po", title: "Purchase order process", snippet: "Raise a PO, get two signatures, then send to finance." }],
};
const NEWEST_DOC = {
  documents: [{ id: "doc_jobs", title: "Elvex Jobs.xlsx", source: "onedrive" }],
};

function gatewayFor(role: "director" | "office_staff") {
  return async (_env: Env, input: { toolName: string; arguments: Record<string, unknown>; sourceClient?: string }) => {
    expect(input.sourceClient).toBe(PORTAL_CHAT_SOURCE_CLIENT);
    const mailbox = String(input.arguments.mailboxAddress ?? "");
    if (input.toolName.startsWith("xero_")) {
      if (role === "office_staff") return { status: 403, error: "Xero is not available for your role" } as never;
      return { status: 200, result: XERO } as never;
    }
    if (input.toolName.startsWith("outlook_")) {
      if (/finance@/i.test(mailbox) && role === "office_staff") {
        return { status: 403, error: "Your current permissions don’t allow this action." } as never;
      }
      if (/finance@/i.test(mailbox)) return { status: 200, result: FINANCE_MAIL } as never;
      return { status: 200, result: INFO_MAIL } as never;
    }
    if (input.toolName === "list_documents") return { status: 200, result: NEWEST_DOC } as never;
    if (input.toolName === "search_company_knowledge" || input.toolName === "search") {
      return { status: 200, result: PO_DOC } as never;
    }
    if (input.toolName === "get_knowledge_document" || input.toolName === "fetch") {
      return { status: 200, result: { id: "doc_po", title: "Purchase order process", text: "Raise a PO." } } as never;
    }
    return { status: 200, result: {} } as never;
  };
}

const DIRECTOR_PROMPTS = [
  "hi",
  "What is the PO process?",
  "Give me more detail.",
  "What were we talking about?",
  "Xero sales this month",
  "What is the newest email in the info inbox?",
  "What is the newest email in the finance inbox?",
  "What is the newest document?",
  "hello",
  "thanks",
  "What can you do?",
  "Tell me our Xero sales this month.",
  "Show me the newest email in the info inbox.",
  "Show me the newest email in the finance inbox.",
  "what is the purchase order process",
  "Give me more detail",
  "What were we talking about?",
  "How are you?",
  "What are our Xero sales this month?",
  "newest email in the info inbox",
  "newest email in the finance inbox",
  "Find the newest OneDrive document.",
  "hiya",
  "What is the PO process?",
  "remind me what we were talking about",
];

const OFFICE_PROMPTS = [
  "hi",
  "What is the PO process?",
  "Give me more detail.",
  "What were we talking about?",
  "Tell me our Xero sales this month.",
  "What is the newest email in the info inbox?",
  "What is the newest email in the finance inbox?",
  "what is the purchase order process",
  "Xero sales this month",
  "Show me the newest email in the finance inbox.",
  "Show me the newest email in the info inbox.",
  "thanks",
  "hello",
  "newest email in the info inbox",
  "What are our Xero sales this month?",
  "What is the PO process?",
  "Give me more detail.",
  "What were we talking about?",
  "newest email in the finance inbox",
  "Find the newest OneDrive document.",
  "how are you",
  "What can you help with?",
  "search company knowledge for the PO process",
  "Xero outstanding invoices",
  "finance inbox newest email",
];

beforeEach(() => {
  resetPortalChatSchemaCache();
});

describe("portal chat automated read acceptance", () => {
  it("runs 50+ director and office_staff turns without generic retry on successful reads", async () => {
    const tallies = {
      success: 0,
      permission_denied: 0,
      no_results: 0,
      upstream_failure: 0,
      timeout: 0,
      clarify: 0,
    };
    let conversationId: string | undefined;
    const directorDb = memoryDb();
    const director = actor("director");
    for (const text of DIRECTOR_PROMPTS) {
      const turn = await sendPortalChatMessage({ DB: directorDb } as Env, {
        companyId: "co_el",
        sessionUser: director,
        conversationId,
        text,
        connectors: ["conn_xero", "conn_outlook_shared"],
        executeGateway: gatewayFor("director"),
      });
      conversationId = turn.conversation.id;
      expect(turn.assistantMessage.content.trim().length).toBeGreaterThan(0);
      const tools = turn.assistantMessage.metadata.toolNames ?? [];
      const terminal = classifyReadTerminal(
        tools.length
          ? tools.map((name) => ({
              name,
              ok: !turn.assistantMessage.metadata.permissionDenied,
              latencyMs: 1,
              data: turn.assistantMessage.metadata.permissionDenied ? { status: 403 } : { ok: true },
            }))
          : [],
        turn.assistantMessage.content,
        turn.assistantMessage.metadata.kind ?? undefined,
      );
      const recorded = (turn.assistantMessage.metadata.terminal as keyof typeof tallies | undefined) ?? terminal;
      if (recorded in tallies) tallies[recorded as keyof typeof tallies] += 1;
      else tallies.success += 1;
      if (tools.some((name) => /outlook|xero_|search_company_knowledge|list_documents/.test(name))) {
        expect(isGenericRetryCopy(turn.assistantMessage.content)).toBe(false);
      }
      if (/xero sales/i.test(text)) {
        expect(tools.some((name) => name.startsWith("xero_"))).toBe(true);
        expect(turn.assistantMessage.content).toMatch(/4,554|4554|Xero/i);
      }
      if (/info inbox/i.test(text)) {
        expect(tools.some((name) => /outlook/.test(name))).toBe(true);
        expect(turn.assistantMessage.content).toMatch(/Keys for 12 High Street|info@/i);
      }
      if (/finance inbox/i.test(text)) {
        expect(tools.some((name) => /outlook/.test(name))).toBe(true);
        expect(turn.assistantMessage.metadata.permissionDenied).not.toBe(true);
        expect(turn.assistantMessage.content).toMatch(/Supplier statement|finance@/i);
      }
    }
    const reloaded = await getPortalConversation(directorDb, {
      conversationId: conversationId!,
      companyId: "co_el",
      userId: director.userId,
    });
    expect(reloaded?.messages.length).toBe(DIRECTOR_PROMPTS.length * 2);
    expect(reloaded?.messages.some((message) => message.role === "assistant" && /PO process|two signatures|Purchase order/i.test(message.content))).toBe(
      true,
    );

    let officeConversation: string | undefined;
    const officeDb = memoryDb();
    const sharon = actor("office_staff");
    for (const text of OFFICE_PROMPTS) {
      const turn = await sendPortalChatMessage({ DB: officeDb } as Env, {
        companyId: "co_el",
        sessionUser: sharon,
        conversationId: officeConversation,
        text,
        connectors: ["conn_xero", "conn_outlook_shared"],
        executeGateway: gatewayFor("office_staff"),
      });
      officeConversation = turn.conversation.id;
      const tools = turn.assistantMessage.metadata.toolNames ?? [];
      const recorded = turn.assistantMessage.metadata.terminal as keyof typeof tallies | undefined;
      if (recorded && recorded in tallies) tallies[recorded] += 1;
      if (/xero/i.test(text) && !/process|knowledge/i.test(text)) {
        expect(turn.assistantMessage.metadata.permissionDenied).toBe(true);
        expect(turn.assistantMessage.content).toMatch(/permission|not available|don.?t allow/i);
        expect(turn.assistantMessage.content).not.toMatch(/£\s?4/);
      }
      if (/finance inbox/i.test(text)) {
        expect(turn.assistantMessage.metadata.permissionDenied).toBe(true);
        expect(turn.assistantMessage.content).toMatch(/permission|don.?t allow/i);
        expect(turn.assistantMessage.content).not.toMatch(/Supplier statement/);
      }
      if (/info inbox/i.test(text)) {
        expect(turn.assistantMessage.metadata.permissionDenied).not.toBe(true);
        expect(isGenericRetryCopy(turn.assistantMessage.content)).toBe(false);
        expect(turn.assistantMessage.content).toMatch(/Keys for 12 High Street|info@/i);
      }
      if (/PO process|purchase order/i.test(text) && !/talking|detail/i.test(text)) {
        expect(tools.some((name) => /search_company_knowledge|search_document|get_knowledge_document/.test(name))).toBe(
          true,
        );
        expect(isGenericRetryCopy(turn.assistantMessage.content)).toBe(false);
      }
    }

    const totalTurns = DIRECTOR_PROMPTS.length + OFFICE_PROMPTS.length;
    expect(totalTurns).toBeGreaterThanOrEqual(50);
    expect(tallies.timeout).toBe(0);
    expect(isGenericRetryCopy("ok")).toBe(false);
  });
});

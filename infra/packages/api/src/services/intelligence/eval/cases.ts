import type { IntelligenceConversationState, IntelligenceDocumentRef } from "../types.js";
import { buildConversationState } from "../state.js";

export type EvalCategory =
  | "natural_conversation"
  | "document_discovery"
  | "document_reasoning"
  | "multi_turn_context"
  | "ambiguity"
  | "tool_reasoning"
  | "no_evidence"
  | "typo"
  | "correction"
  | "source"
  | "xero"
  | "mailbox";

export type EvalExpectation = {
  intent: "chat" | "search" | "scoped" | "fetch" | "clarify" | "xero" | "mailbox" | "none" | "source" | "replan" | "meta" | "capability";
  tool?: string | null;
  stayOnDocument?: boolean;
  clarify?: boolean;
  grounded?: boolean;
  noHallucination?: boolean;
  allowNoTool?: boolean;
  scope?: string;
};

export type EvalCase = {
  id: string;
  category: EvalCategory;
  text: string;
  state: IntelligenceConversationState;
  expect: EvalExpectation;
  messy?: boolean;
};

const CV: IntelligenceDocumentRef = {
  id: "doc_profile_2015",
  title: "Staff profile",
  url: "https://docs.example.test/profile",
};
const VAN: IntelligenceDocumentRef = {
  id: "doc_vehicle_policy",
  title: "Vehicle use policy",
  url: "https://docs.example.test/vehicle",
};
const SITE: IntelligenceDocumentRef = {
  id: "doc_site_survey",
  title: "Site survey report",
  url: "https://files.example.test/survey.pdf",
};

function state(input: {
  text: string;
  current?: IntelligenceDocumentRef | null;
  turns?: Array<{ role: "user" | "assistant"; text: string }>;
  correction?: boolean;
  connectors?: string[];
}): IntelligenceConversationState {
  return buildConversationState({
    userText: input.text,
    currentDocument: input.current,
    entities: [CV, VAN, SITE],
    recentTurns: input.turns,
    companyId: "co_eval",
    companyName: "Eval Co",
    role: "admin",
    connectors: input.connectors ?? ["conn_microsoft_365", "conn_xero"],
    permittedTools: [],
    userCorrection: input.correction,
  });
}

const DISCOVERY = [
  "Can you find my staff profile from around 2015?",
  "Look up the vehicle use policy",
  "Find the site survey report",
  "Search for the staff profile",
  "Have we got a vehicle policy on file?",
  "I need the site survey",
  "Open the 2015 staff profile if we have it",
  "Where is the vehicle use policy stored?",
  "Find that old staff profile",
  "Look for a site survey PDF",
];

const REASONING_ON_CV = [
  "What sort of work was I doing then?",
  "Did I do anything involving marketing?",
  "What exactly did I do?",
  "When was that?",
  "Tell me more about that role",
  "What was I responsible for?",
  "Did it mention managing anyone?",
  "What experience does it show?",
  "Summarise the main points",
  "Explain that more simply",
];

const REASONING_ON_VAN = [
  "What are the main rules?",
  "What happens if someone leaves?",
  "What about fuel?",
  "Can people take the vehicle home?",
  "Who is responsible for damage?",
  "Explain the fuel bit more simply",
];

const NO_EVIDENCE = [
  "Does that profile say anything about company vans?",
  "Any mention of fuel cards in the profile?",
  "Does it talk about site surveys?",
  "Is there a van allocation in this file?",
];

const TYPOS = [
  "cna u fnd my stff profle frm 2015",
  "wot sort of wrk was i doin then",
  "did i do anythin invovling marketting",
  "wot xactly did i do??",
  "wen woz that",
  "wher dyou get that frm",
  "does it sy anythin bout company vans",
  "fnd the vehcle use polcy",
  "wot r the main ruls",
  "wot happns if some1 leaves",
  "expln that more simplyy",
  "wot bout fuel??",
  "can u smmarise tht",
  "tell me mre abt that role",
  "is ther anythng on marketng",
  "opn the sorce link",
  "show me teh url",
  "lk up the site srvey",
  "did he mng a team",
  "whn did that job start",
  "broden to othr docs",
  "serch othr documents pls",
];

const CHAT = ["Hi", "Thanks", "Hey", "Morning", "Cheers"];

const AMBIGUOUS = [
  "What's the policy?",
  "Find the document",
  "Open that file",
  "The other one",
  "Have we got a policy on this?",
];

const CORRECTIONS = [
  "No, that's not what I meant",
  "That's not what I asked",
  "Wrong file, I meant the vehicle policy",
  "Something else — the site survey",
  "Not the profile, the vehicle policy",
];

const XERO = [
  "What were sales this month?",
  "Who owes us money?",
  "Find overdue invoices",
  "Show invoice INV-003",
];

const MAILBOX = ["Search the shared mailbox for invoices", "Any unread in the accounts inbox?"];

const TOOL_NONE = [
  "Hi there",
  "thanks a lot",
];

export function evaluationCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  let n = 0;
  const add = (category: EvalCategory, text: string, expect: EvalExpectation, extra?: Partial<EvalCase>) => {
    n += 1;
    cases.push({
      id: `ev-${String(n).padStart(3, "0")}`,
      category,
      text,
      state: extra?.state ?? state({ text }),
      expect,
      messy: extra?.messy,
    });
  };

  for (const text of CHAT) {
    add("natural_conversation", text, { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true });
  }
  add("natural_conversation", "How are you?", { intent: "none", allowNoTool: true, grounded: true, noHallucination: true });

  for (const text of DISCOVERY) {
    add("document_discovery", text, { intent: "search", tool: "search_company_knowledge", grounded: true, noHallucination: true });
  }

  for (const text of REASONING_ON_CV) {
    const rephrase = /explain that more simply/i.test(text);
    add(
      "document_reasoning",
      text,
      rephrase
        ? { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true, scope: "GENERAL_CONVERSATION" }
        : { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
      {
        state: state({
          text,
          current: CV,
          turns: [
            { role: "user", text: "find my 2015 staff profile" },
            { role: "assistant", text: "I have the staff profile open." },
          ],
        }),
      },
    );
  }

  for (const text of REASONING_ON_VAN) {
    add(
      "document_reasoning",
      text,
      { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
      {
        state: state({
          text,
          current: VAN,
          turns: [
            { role: "user", text: "find the vehicle use policy" },
            { role: "assistant", text: "I have the vehicle use policy open." },
          ],
        }),
      },
    );
  }

  const sequences = [
    { text: "What sort of work was I doing then?", current: CV },
    { text: "Did I do anything involving marketing?", current: CV },
    { text: "What exactly did I do?", current: CV },
    { text: "When was that?", current: CV },
    { text: "Where did you get that from?", current: CV, expect: { intent: "source" as const, tool: "get_knowledge_document", stayOnDocument: true, grounded: true, noHallucination: true } },
    { text: "Does the profile say anything about company vans?", current: CV, expect: { intent: "scoped" as const, tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true } },
    { text: "Search other documents then", current: CV, expect: { intent: "search" as const, tool: "search_company_knowledge", grounded: true, noHallucination: true } },
    { text: "Find the vehicle use policy", current: CV, expect: { intent: "search" as const, tool: "search_company_knowledge", grounded: true, noHallucination: true } },
    { text: "What are the main rules?", current: VAN },
    { text: "What happens if someone leaves?", current: VAN },
    { text: "Explain that more simply", current: VAN, expect: { intent: "chat" as const, tool: null, allowNoTool: true, grounded: true, noHallucination: true } },
    { text: "What about fuel?", current: VAN },
    { text: "Now go back to the staff profile", current: VAN, expect: { intent: "search" as const, tool: "search_company_knowledge", grounded: true, noHallucination: true } },
  ];
  for (const row of sequences) {
    add(
      "multi_turn_context",
      row.text,
      row.expect ?? { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
      { state: state({ text: row.text, current: row.current }) },
    );
  }

  for (const text of AMBIGUOUS) {
    add("ambiguity", text, { intent: "clarify", clarify: true, allowNoTool: true, noHallucination: true });
  }

  add("tool_reasoning", "Find a staff profile", { intent: "search", tool: "search_company_knowledge", grounded: true, noHallucination: true });
  add(
    "tool_reasoning",
    "What exactly did I do?",
    { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "What exactly did I do?", current: CV }) },
  );
  add(
    "tool_reasoning",
    "Open the source",
    { intent: "source", tool: null, allowNoTool: true, stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "Open the source", current: CV }) },
  );
  add("tool_reasoning", "What were sales this month?", { intent: "xero", tool: "xero_sales_summary", grounded: true, noHallucination: true });
  add("tool_reasoning", "Search the shared mailbox for invoices", { intent: "mailbox", tool: "outlook_search_mailbox", grounded: true, noHallucination: true });
  add("tool_reasoning", "What can you do", { intent: "capability", tool: "get_user_capabilities", grounded: true, noHallucination: true });
  add("tool_reasoning", "How many files are indexed?", { intent: "meta", tool: "get_document_index_stats", grounded: true, noHallucination: true }, { state: state({ text: "How many files are indexed?", current: CV }) });
  add("tool_reasoning", "Hi", { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true });
  add("tool_reasoning", "What's the policy?", { intent: "clarify", clarify: true, allowNoTool: true, noHallucination: true });

  for (const text of NO_EVIDENCE) {
    add(
      "no_evidence",
      text,
      { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
      { state: state({ text, current: CV }) },
    );
  }

  for (const text of TYPOS) {
    const current = /ruls|fuel|leaves|vehcle|polcy/.test(text) ? VAN : /wrk|market|xactly|wen|frm|vans|role|marketng|mng|sorc|url/.test(text) ? CV : null;
    const discovery = /fnd|lk up|srvey|profle|polcy/.test(text) && !current;
    add(
      "typo",
      text,
      current
        ? { intent: /sorc|url/.test(text) ? "source" : "scoped", tool: /sorc|url/.test(text) ? null : "search_document", stayOnDocument: true, allowNoTool: /sorc|url/.test(text), grounded: true, noHallucination: true }
        : discovery
          ? { intent: "search", tool: "search_company_knowledge", grounded: true, noHallucination: true }
          : { intent: "search", tool: "search_company_knowledge", grounded: true, noHallucination: true },
      { state: state({ text, current }), messy: true },
    );
  }

  for (const text of CORRECTIONS) {
    const replan = /vehicle|site survey/i.test(text);
    add(
      "correction",
      text,
      replan
        ? { intent: "replan", tool: "search_company_knowledge", grounded: true, noHallucination: true }
        : { intent: "replan", allowNoTool: true, clarify: true, noHallucination: true },
      {
        state: state({
          text,
          current: CV,
          correction: true,
          turns: [{ role: "assistant", text: "I found a marketing review." }],
        }),
      },
    );
  }

  add(
    "source",
    "Where did you get that from?",
    { intent: "source", tool: "get_knowledge_document", stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "Where did you get that from?", current: CV }) },
  );
  add(
    "source",
    "Open the source",
    { intent: "source", tool: null, allowNoTool: true, stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "Open the source", current: SITE }) },
  );

  for (const text of XERO) {
    add("xero", text, { intent: "xero", tool: text.includes("INV-003") ? "xero_get_invoice" : text.includes("overdue") || text.includes("owes") ? "xero_list_overdue_invoices" : "xero_sales_summary", grounded: true, noHallucination: true });
  }
  for (const text of MAILBOX) {
    add("mailbox", text, { intent: "mailbox", tool: "outlook_search_mailbox", grounded: true, noHallucination: true });
  }
  for (const text of TOOL_NONE) {
    add("natural_conversation", text, { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true });
  }

  add("document_discovery", "broaden to other documents", { intent: "search", tool: "search_company_knowledge", grounded: true, noHallucination: true }, { state: state({ text: "broaden to other documents", current: CV }) });
  add("multi_turn_context", "return to the previous document", { intent: "search", tool: "search_company_knowledge", grounded: true, noHallucination: true }, { state: state({ text: "return to the previous document", current: VAN, turns: [{ role: "user", text: "staff profile" }] }) });
  add("natural_conversation", "Hello", { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true });
  add("natural_conversation", "thank you", { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true });
  add(
    "document_reasoning",
    "who was I working with?",
    { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "who was I working with?", current: CV }) },
  );
  add(
    "document_reasoning",
    "how long was that role?",
    { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "how long was that role?", current: CV }) },
  );
  add(
    "no_evidence",
    "does this file mention coal?",
    { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "does this file mention coal?", current: CV }) },
  );
  add("ambiguity", "pull up the policy please", { intent: "clarify", clarify: true, allowNoTool: true, noHallucination: true });
  add("xero", "What's our P&L?", { intent: "xero", tool: "xero_profit_and_loss", grounded: true, noHallucination: true });
  add("mailbox", "Check outlook for the survey email", { intent: "mailbox", tool: "outlook_search_mailbox", grounded: true, noHallucination: true });
  add(
    "document_reasoning",
    "What about fuel?",
    { intent: "scoped", tool: "search_document", stayOnDocument: true, grounded: true, noHallucination: true },
    { state: state({ text: "What about fuel?", current: VAN }) },
  );
  add(
    "natural_conversation",
    "what do you mean by personal use",
    { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true },
    {
      state: state({
        text: "what do you mean by personal use",
        current: VAN,
        turns: [{ role: "assistant", text: "Personal use is limited under the vehicle policy." }],
      }),
    },
  );
  add("natural_conversation", "thanks that's useful", { intent: "chat", tool: null, allowNoTool: true, grounded: true, noHallucination: true });

  return cases;
}

export const EVAL_FIXTURES = { CV, VAN, SITE };

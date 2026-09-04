import { classifyElTraffic, type ElTrafficClass } from "../el-customer-billing";
import {
  CUSTOMER_TRAFFIC_CLASS,
  NON_CUSTOMER_TRAFFIC,
  type DailyTrafficClass,
} from "./constants";

export type TrafficClassifyInput = {
  trafficClass?: string | null;
  sourceClient?: string | null;
  userAgent?: string | null;
  actorEmail?: string | null;
  userId?: string | null;
  userMessage?: string | null;
  toolName?: string | null;
  action?: string | null;
  wamid?: string | null;
  shadow?: boolean;
  quality?: boolean;
  automation?: boolean;
  health?: boolean;
  skipUsageRecording?: boolean;
  customerChargeCents?: number | null;
  providerMode?: string | null;
  correlationId?: string | null;
};

const GENERIC_PROMPTS = new Set(
  [
    "thanks",
    "hi",
    "hello",
    "cheers",
    "hello there",
    "great thanks",
    "how are you",
    "more detail",
    "say that again",
    "remind me",
    "i don't understand",
    "what do you mean",
    "that helps",
    "who are you",
    "what can you do",
    "make that shorter",
    "make it friendlier",
    "put that another way",
    "shorter please",
    "draft a reply",
    "who sent it",
  ].map(normalisePrompt),
);

/** Distinctive frozen-bench / acceptance prompts. Generic greetings are excluded. */
const TEST_PROMPT_FINGERPRINTS = new Set(
  [
    "What are our Xero sales this month?",
    "Show overdue invoices",
    "Who are the top customers?",
    "Find invoice INV-02268",
    "What is outstanding in Xero?",
    "Profit and loss this month",
    "Aged receivables",
    "Search invoices for PO",
    "Xero organisation name",
    "Find invoices for Elvex",
    "Overdue by contact",
    "Xero sales summary please",
    "check in the info inbox what is the latest email",
    "Search emails from Sharon",
    "What is the newest finance email?",
    "Search the inbox for PO",
    "Unread in the info mailbox",
    "Search mailbox for invoice",
    "Look in Outlook for leak",
    "What is the PO process?",
    "Find the vehicle policy",
    "How many files are indexed?",
    "Search company knowledge for vans",
    "What does the vehicle policy say about fuel?",
    "Search for leak procedure",
    "Find a PDF about health and safety",
    "I meant the email",
    "No I meant Xero sales",
    "wrong file, find the vehicle policy",
    "sales this month then the latest email",
    "I meant the info inbox",
    "office staff asking for Xero sales",
    "Sharon must not see finance mailbox",
    "Xero sales this month and the latest finance email",
    "Xero sales this month, latest finance email",
    "What are our outstanding invoices?",
    "compare Xero sales this month versus last month",
    "Tell me Xero sales this month.",
  ].map(normalisePrompt),
);

export function normalisePrompt(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\w\s£$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeAutomatedTestPrompt(text?: string | null): boolean {
  const normalised = normalisePrompt(text);
  if (!normalised || GENERIC_PROMPTS.has(normalised)) return false;
  if (TEST_PROMPT_FINGERPRINTS.has(normalised)) return true;
  if (/inv-02268|elvexpropertyservices|frozen.?bench|plat_xero|whatsappqa/i.test(text ?? "")) {
    return true;
  }
  return false;
}

export function classifyDailyTraffic(input: TrafficClassifyInput): DailyTrafficClass {
  const explicit = String(input.trafficClass ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (explicit === "ENGINEERING") return "ENGINEERING";

  const source = String(input.sourceClient ?? "").toLowerCase();
  if (/daily[_-]?improvement|cursor-engineering|engineering[_-]?queue/.test(source)) {
    return "ENGINEERING";
  }
  if (/shadow/.test(source) || input.toolName === "openai_shadow") return "SHADOW";

  if (looksLikeAutomatedTestPrompt(input.userMessage)) return "TEST";
  if (/InfraAcceptance|WhatsAppQA|ELBillingSuite|QualityLoop|e2e-probe/i.test(input.userAgent ?? "")) {
    return "TEST";
  }
  if (/acceptance|qa[_-]?harness|frozen[_-]?bench|tool[_-]?bench/i.test(source)) return "TEST";
  if (/^system:|^svc_|acceptance|probe|quality-loop/i.test(input.actorEmail ?? "")) return "INTERNAL";

  const billed = classifyElTraffic({
    trafficClass: input.trafficClass,
    sourceClient: input.sourceClient,
    userAgent: input.userAgent,
    actorEmail: input.actorEmail,
    toolName: input.toolName,
    action: input.action,
    wamid: input.wamid,
    shadow: input.shadow,
    quality: input.quality,
    automation: input.automation,
    health: input.health,
    skipUsageRecording: input.skipUsageRecording,
  });

  if (billed !== "CUSTOMER_REQUEST") return billed;
  if (input.quality) return "QUALITY";
  if (input.shadow) return "SHADOW";
  return CUSTOMER_TRAFFIC_CLASS;
}

export function isGenuineCustomerTraffic(trafficClass?: string | null): boolean {
  if (!trafficClass) return true;
  return !NON_CUSTOMER_TRAFFIC.has(trafficClass.toUpperCase());
}

export function trafficBucket(trafficClass?: string | null): "customer" | "test" | "shadow" | "automation_internal" {
  const value = String(trafficClass ?? CUSTOMER_TRAFFIC_CLASS).toUpperCase();
  if (value === "CUSTOMER_REQUEST") return "customer";
  if (value === "TEST" || value === "QUALITY") return "test";
  if (value === "SHADOW") return "shadow";
  return "automation_internal";
}

export function elTrafficAsDaily(value: ElTrafficClass | string): DailyTrafficClass {
  const upper = String(value).toUpperCase();
  if (upper === "ENGINEERING") return "ENGINEERING";
  if (
    upper === "CUSTOMER_REQUEST" ||
    upper === "TEST" ||
    upper === "SHADOW" ||
    upper === "QUALITY" ||
    upper === "INTERNAL" ||
    upper === "AUTOMATION" ||
    upper === "HEALTH"
  ) {
    return upper;
  }
  return CUSTOMER_TRAFFIC_CLASS;
}

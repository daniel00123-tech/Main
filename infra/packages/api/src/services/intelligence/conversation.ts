import type { IntelligenceConversationState } from "./types.js";
import type { ScopeDecision } from "./scope.js";

export function answerGeneralConversation(
  text: string,
  state: IntelligenceConversationState,
  decision: ScopeDecision,
): string {
  const previous = (state.lastAnswerText || "").trim();
  if (decision.lastUserIntent === "rephrase") {
    if (!previous) return "I don't have a previous answer to rephrase. Ask the question again and I will.";
    if (/\b(shorter|brief|fewer words)\b/i.test(text)) return shorten(previous);
    if (/\bmore detail\b/i.test(text)) return `${previous}\nI can go back to the source if you want more than that summary.`;
    return simplify(previous);
  }
  if (decision.lastUserIntent === "memory") {
    return remember(state, text);
  }
  if (/^(thanks|thank you|cheers|ta|thx|ty|that(?:'s| is) useful|that helps|great thanks)\b/i.test(text.trim())) {
    return "You're welcome.";
  }
  if (/^(hi|hello|hey|hiya|morning)\b/i.test(text.trim())) {
    return "Hi — what do you need?";
  }
  if (/\b(how are you|how(?:'s|s) it going)\b/i.test(text)) {
    return "I'm good, thanks. What can I help with?";
  }
  if (/\b(what do you mean|i don'?t understand|why did you ask)\b/i.test(text)) {
    if (previous) return `I meant: ${simplify(previous)}`;
    return "I was trying to work out which system or document you wanted. Tell me which one and I'll continue.";
  }
  if (/\b(example|what else can you help)\b/i.test(text)) {
    return "Ask about a document, a connected finance figure, or how many files are indexed. I will only use systems that are connected.";
  }
  return previous ? "Happy to keep going from there — what do you want next?" : "What do you need?";
}

function remember(state: IntelligenceConversationState, text: string): string {
  if (/\blast document|which (file|document)\b/i.test(text) && state.currentDocument) {
    return `The last document we used was ${state.currentDocument.title}.`;
  }
  if (/\bgo back|previous\b/i.test(text) && state.recentDocuments[0]) {
    return `Before that we had ${state.recentDocuments[0].title}. I can open it again if you want.`;
  }
  if (/\bwhat did i (just )?ask\b/i.test(text) && state.lastUserIntent) {
    return `You asked about ${humanTopic(state.lastAnswerTopic || state.lastUserIntent)}.`;
  }
  if (/\bwhat did you (just )?(tell|say)|remind me\b/i.test(text) && state.lastAnswerText) {
    return simplify(state.lastAnswerText);
  }
  if (/\bwhich source\b/i.test(text) && state.currentDocument?.source) {
    return `That came from ${state.currentDocument.source}.`;
  }
  if (/\bamount\b/i.test(text) && state.lastAnswerText) {
    const amount = state.lastAnswerText.match(/£\s?[\d,]+(?:\.\d{2})?/);
    if (amount) return `The amount I mentioned was ${amount[0]}.`;
  }
  if (/^when\b/i.test(text) && state.lastAnswerText) {
    const when =
      state.lastAnswerText.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
      state.lastAnswerText.match(/\b(today|yesterday|this month|last month|this week)\b/i)?.[0];
    if (when) return `That was ${when}.`;
    return simplify(state.lastAnswerText);
  }
  if (/^who\b/i.test(text) && state.lastAnswerText) {
    const from = state.lastAnswerText.match(/\bfrom ([^.(]+)/i)?.[1];
    if (from) return `That was from ${from.trim()}.`;
    return simplify(state.lastAnswerText);
  }
  if (state.lastAnswerTopic || state.lastAnswerText) {
    const topic = humanTopic(state.lastAnswerTopic || "conversation");
    const detail = state.lastAnswerText ? ` ${simplify(state.lastAnswerText)}` : "";
    return `We were talking about ${topic}${
      state.currentDocument ? `, and I still have ${state.currentDocument.title} as context` : ""
    }.${detail}`;
  }
  if (state.currentDocument) {
    return `We had ${state.currentDocument.title} as the current file.`;
  }
  return "We haven't settled on a document or system yet. What should I pick up?";
}

function humanTopic(topic: string): string {
  const labels: Record<string, string> = {
    index_stats: "how many documents are indexed",
    document: "the current document",
    finance: "finance figures",
    connectors: "which systems are connected",
    capabilities: "what I can help with",
    company_knowledge: "searching company documents",
    email: "email",
    automations: "automations",
    conversation: "the previous answer",
    "the PO process": "the PO process",
  };
  return labels[topic] ?? topic.replace(/_/g, " ");
}

function simplify(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\([^)]{0,80}\)/g, "")
    .split(/(?<=[.!?])\s+/)
    .slice(0, 3)
    .join(" ")
    .trim()
    .slice(0, 420);
}

function shorten(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return first.trim().slice(0, 220);
}

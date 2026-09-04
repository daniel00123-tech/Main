import { describeToolCatalogue, INTELLIGENCE_TOOL_NAMES, SYSTEM_META_TOOLS } from "./catalogue.js";
import { answerGeneralConversation } from "./conversation.js";
import { parseIntelligenceDecision, recoverDecision, validateToolRequest } from "./parse.js";
import { createDefaultCompleter, type IntelligenceCompleter } from "./provider.js";
import { routeIntelligenceTurn } from "./router.js";
import { classifyScope, persistableScope, type ScopeDecision } from "./scope.js";
import { formatConversationState } from "./state.js";
import { advertisedMissingConnector, inventedCount, verbaliseSystemMeta } from "./system-meta.js";
import { parseCatalogueIntent, verbaliseDocumentCatalogue } from "../document-catalogue.js";
import { enrichDocumentQuery, previousUserText } from "./query-enrichment.js";
import { needsBusinessDates, withResolvedBusinessDates } from "./periods.js";
import {
  defaultMailboxForText,
  isFollowUpFiller,
  isHollowAssistantText,
  previousSubstantiveUserText,
  terminalFromToolCalls,
} from "./evidence.js";
import type {
  IntelligenceChannel,
  IntelligenceConfidence,
  IntelligenceConversationState,
  IntelligenceDecision,
  IntelligenceDocumentRef,
  IntelligenceEnv,
  IntelligenceModelUsage,
  IntelligenceQualityFlag,
  IntelligenceRuntime,
  IntelligenceScope,
  IntelligenceToolCall,
  IntelligenceToolResult,
  IntelligenceTurnResult,
} from "./types.js";

export const MAX_TOOL_ROUNDS = 4;

export type { IntelligenceDecision };

const SECURITY_AND_PROTOCOL = `You are INFRA's assistant. Scope first, then tools.
Current document is context, not a command to always search it.
Conversational turns (thanks, meaning, rephrase, what were we talking about) need no tools.
System and index questions use system-meta tools, never the current document.
Search a document only when the question is about that file's contents.
Search company knowledge to find or compare documents by meaning.
Use list_documents for newest/latest/uploaded/recently modified file lists — never substitute semantic search.
Use Xero or email only when asked and those systems are connected.
Clarify if ambiguous. Honour corrections and scope switches. Never invent facts, counts, or URLs.
No D1, Vectorize, or MCP jargon unless an authorised admin asks a technical ops question.
Write like a colleague: answer first, short, no question-echo.
`;

export async function runIntelligenceTurn(input: {
  env?: IntelligenceEnv;
  text: string;
  state: IntelligenceConversationState;
  runtime: IntelligenceRuntime;
  channel?: IntelligenceChannel;
  buttonHint?: string | null;
  completer?: IntelligenceCompleter;
}): Promise<IntelligenceTurnResult> {
  const routed = routeIntelligenceTurn({ text: input.text, state: input.state, buttonHint: input.buttonHint });
  if (routed.route === "FAST_LOCAL" && routed.localText) {
    const local = emptyResult({
      kind: "fast_path",
      text: routed.localText,
      confidence: "strong",
      offerSearchOther: false,
      route: "FAST_LOCAL",
    });
    return {
      ...local,
      currentDocument: input.state.currentDocument,
      citeSource: /^https?:\/\//i.test(routed.localText),
    };
  }
  if (routed.route === "CONTROLLED_ACTION") {
    return emptyResult({
      kind: "controlled_action",
      text: "I can only prepare writes through the existing Action Engine after the usual checks. I won't change Xero or send anything from here.",
      confidence: "strong",
      offerSearchOther: false,
      route: "CONTROLLED_ACTION",
      scope: "CONTROLLED_ACTION",
    });
  }

  const scoped = classifyScope(input.text, input.state);
  let currentDocument = input.state.currentDocument;
  if (scoped.clearCurrentDocument && currentDocument) {
    currentDocument = null;
  }
  if (scoped.restoreRecentDocument) {
    currentDocument = scoped.matchedDocument ?? input.state.recentDocuments[0] ?? currentDocument;
  }

  if (scoped.scope === "CONTROLLED_ACTION") {
    return emptyResult({
      kind: "controlled_action",
      text: "I can only prepare writes through the existing Action Engine after the usual checks. I won't change Xero or send anything from here.",
      confidence: "strong",
      offerSearchOther: false,
      route: "CONTROLLED_ACTION",
      scope: "CONTROLLED_ACTION",
    });
  }

  if (scoped.scope === "AMBIGUOUS" && scoped.clarify) {
    return emptyResult({
      kind: "clarify",
      text: scoped.clarifyText || "Can you give me a little more detail so I look in the right place?",
      confidence: "partial",
      offerSearchOther: false,
      route: "INTELLIGENT",
      scope: "AMBIGUOUS",
      lastAnswerTopic: scoped.lastAnswerTopic,
      lastUserIntent: scoped.lastUserIntent,
    });
  }

  if (scoped.scope === "RECENT_ENTITY" && scoped.restoreRecentDocument && currentDocument) {
    return emptyResult({
      kind: "answer",
      text: `I've gone back to ${currentDocument.title}. What do you want from it?`,
      confidence: "strong",
      offerSearchOther: false,
      route: "INTELLIGENT",
      scope: "RECENT_ENTITY",
      lastAnswerTopic: "document",
      lastUserIntent: scoped.lastUserIntent,
      currentDocument,
    });
  }

  if (
    scoped.lastUserIntent === "more_detail" &&
    isFollowUpFiller(input.text)
  ) {
    const prior =
      previousSubstantiveUserText(input.state.recentTurns ?? [], input.text) ||
      previousUserText(input.state, input.text);
    if (prior && prior.trim() !== input.text.trim()) {
      return runIntelligenceTurn({
        ...input,
        text: prior,
        state: {
          ...input.state,
          lastUserText: prior,
          lastAnswerText: isHollowAssistantText(input.state.lastAnswerText)
            ? null
            : input.state.lastAnswerText,
        },
      });
    }
  }

  if (scoped.scope === "GENERAL_CONVERSATION" && scoped.noTool && !input.state.userCorrection) {
    return emptyResult({
      kind: "answer",
      text: answerGeneralConversation(input.text, input.state, scoped),
      confidence: "strong",
      offerSearchOther: false,
      route: "INTELLIGENT",
      scope: "GENERAL_CONVERSATION",
      lastAnswerTopic: scoped.lastAnswerTopic ?? input.state.lastAnswerTopic ?? "conversation",
      lastUserIntent: scoped.lastUserIntent,
      currentDocument,
    });
  }

  const completer = input.completer ?? createDefaultCompleter(input.env ?? {});
  const toolCalls: IntelligenceToolResult[] = [];
  const modelRounds: IntelligenceModelUsage[] = [];
  const qualityFlags = new Set<IntelligenceQualityFlag>();
  if (input.state.userCorrection) qualityFlags.add("user_correction");
  const evidenceDocumentIds: string[] = [];
  const transcript: string[] = [];
  let repaired = false;
  const permitted = input.state.permittedTools.length ? input.state.permittedTools : [...INTELLIGENCE_TOOL_NAMES];
  const workingState = {
    ...input.state,
    currentDocument,
    currentScope: persistableScope(scoped.scope) ?? input.state.currentScope,
    lastUserIntent: scoped.lastUserIntent,
  };

  if (
    scoped.scope !== "SYSTEM_META" &&
    scoped.scope !== "BUSINESS_SYSTEM" &&
    scoped.scope !== "CONTROLLED_ACTION" &&
    scoped.scope !== "CONNECTOR_CAPABILITY" &&
    (input.state.userCorrection || (scoped.scope === "COMPANY_KNOWLEDGE" && scoped.clearCurrentDocument))
  ) {
    const priorUser =
      previousUserText(input.state, input.text) ||
      [...input.state.recentTurns].reverse().find((turn) => turn.role === "user")?.text ||
      input.state.lastAnswerTopic ||
      input.text;
    const namedShift = /\b(i meant|wrong file|instead|find|search|look(?:ing)? (?:for|up))\b/i.test(input.text);
    const query = input.state.userCorrection
      ? (namedShift ? input.text : priorUser) || input.text
      : [input.state.currentDocument?.title, priorUser].filter(Boolean).join(" — ") || input.text;
    const search = await input.runtime.executeTool({
      name: "search_company_knowledge",
      arguments: { query },
    });
    toolCalls.push(search);
    const hits = searchHits(search.data);
    const first =
      hits[0] && typeof hits[0] === "object"
        ? documentFromToolResult({ name: "search_company_knowledge", ok: true, latencyMs: 0, data: { document_id: (hits[0] as { id?: string }).id, title: (hits[0] as { title?: string }).title, url: (hits[0] as { url?: string }).url } })
        : null;
    if (first) currentDocument = first;
    const titles = [
      ...new Set(
        hits
          .map((hit) => (hit && typeof hit === "object" ? String((hit as { title?: string }).title ?? "") : ""))
          .filter(Boolean),
      ),
    ].slice(0, 3);
    return finish({
      kind: titles.length ? "answer" : "clarify",
      text: titles.length
        ? `Across your documents I can see: ${titles.join("; ")}. Which should I open?`
        : "I couldn’t find that. Which file should I use?",
      confidence: titles.length ? "partial" : "none",
      offerSearchOther: true,
      toolCalls,
      currentDocument,
      evidenceDocumentIds: first ? [first.id] : [],
      clarification: titles.length === 0,
      modelRounds: [],
      route: "INTELLIGENT",
      scope: "COMPANY_KNOWLEDGE",
      lastAnswerTopic: "company_knowledge",
      lastUserIntent: scoped.lastUserIntent,
      qualityFlags: [...qualityFlags],
      repaired: false,
    });
  }

  if (shouldRunDeterministicMeta(scoped)) {
    const meta = await runDeterministicMeta(input.runtime, scoped, input.text, completer, permitted, qualityFlags);
    if (meta) {
      if (input.state.userCorrection && scoped.clearCurrentDocument && meta.toolCalls[0]?.name === input.state.lastSuccessfulTool) {
        qualityFlags.add("correction_ignored");
      }
      return finish({
        kind: "answer",
        text: meta.text,
        confidence: "strong",
        offerSearchOther: false,
        toolCalls: meta.toolCalls,
        currentDocument,
        evidenceDocumentIds,
        clarification: false,
        modelRounds: meta.modelRounds,
        route: "INTELLIGENT",
        scope: scoped.scope,
        lastAnswerTopic: scoped.lastAnswerTopic,
        lastUserIntent: scoped.lastUserIntent,
        qualityFlags: [...qualityFlags, ...meta.flags],
        repaired,
        fallbackUsed: meta.modelRounds.some((row) => row.fallbackUsed),
      });
    }
  }

  if (shouldForceScopedTool(scoped) && scoped.tool && toolCalls.length === 0) {
    const forced = await input.runtime.executeTool({
      name: scoped.tool,
      arguments: prepareToolArguments(scoped.tool, {}, input.text, workingState, scoped.scope),
    });
    toolCalls.push(forced);
    adoptFromTool(
      forced,
      toolCalls,
      () => currentDocument,
      (doc) => {
        currentDocument = doc;
      },
      evidenceDocumentIds,
      input.buttonHint,
    );
    transcript.push(formatToolTranscript(forced));
    const forcedTerminal = terminalFromToolCalls(toolCalls);
    if (forcedTerminal && toolCalls.every((call) => !call.ok)) {
      return finish({
        kind: "failed",
        text: forcedTerminal,
        confidence: "none",
        offerSearchOther: false,
        toolCalls,
        currentDocument,
        evidenceDocumentIds,
        clarification: false,
        modelRounds,
        route: "INTELLIGENT",
        scope: scoped.scope,
        lastAnswerTopic: scoped.lastAnswerTopic,
        lastUserIntent: scoped.lastUserIntent,
        qualityFlags: [...qualityFlags],
        repaired,
      });
    }
  }

  const system = `${SECURITY_AND_PROTOCOL}\nDecided scope: ${scoped.scope}. Current document is context, not a mandatory search target.\nTools:\n${describeToolCatalogue(permitted)}`;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const user = [
      formatConversationState({ ...workingState, currentDocument, lastUserText: input.text }),
      input.buttonHint ? `Channel button: ${input.buttonHint}` : "",
      input.channel ? `Channel: ${input.channel}` : "",
      `Turn scope: ${scoped.scope}. Do not search the current document unless scope is CURRENT_DOCUMENT.`,
      looksLikeFinanceRead(input.text) || scoped.scope === "BUSINESS_SYSTEM"
        ? "This is a finance or business-system question. Use a Xero or mailbox read tool. Do not search the current document."
        : "",
      scoped.scope === "SYSTEM_META" || scoped.scope === "CONNECTOR_CAPABILITY"
        ? "Use a system-meta tool. Do not search documents."
        : "",
      input.buttonHint === "search_other_docs"
        ? "The user asked to look in other documents. Call search_company_knowledge. Do not stay on the current document."
        : "",
      transcript.length ? `Evidence so far:\n${transcript.join("\n\n")}` : "Evidence so far: none yet",
      round === 0
        ? "Decide: enough information? If yes, answer or clarify. If not, call one tool."
        : "Reassess the evidence. Call one more tool only if needed, otherwise synthesise the answer.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const completion = await completer({
      system,
      user,
      permittedTools: permitted,
      mode: round === 0 ? "decide" : "synthesise",
    });
    modelRounds.push(completion.usage);
    if (completion.usage.fallbackUsed) qualityFlags.add("fallback");

    let recovered = recoverDecision({
      text: completion.text,
      toolCalls: completion.toolCalls,
      structured: completion.structured,
    });
    if (recovered.malformed) qualityFlags.add("malformed_model_response");

    if (recovered.decision.action === "invalid") {
      const retry = await completer({
        system,
        user: `${user}\n\nPrevious output was unusable (${"reason" in recovered.decision ? recovered.decision.reason : "invalid"}). Reply with one JSON object: call_tool, answer, or clarify.`,
        permittedTools: permitted,
        mode: "repair",
      });
      modelRounds.push(retry.usage);
      repaired = true;
      recovered = recoverDecision({
        text: retry.text,
        toolCalls: retry.toolCalls,
        structured: retry.structured,
      });
      if (recovered.malformed) qualityFlags.add("malformed_model_response");
    }

    let decision = recovered.decision;
    if (decision.action === "invalid" && !completion.text.trim() && toolCalls.length === 0) {
      const bootstrap = await bootstrapRetrieval(input.runtime, workingState, input.text, input.buttonHint, scoped);
      if (bootstrap) {
        toolCalls.push(bootstrap);
        adoptFromTool(bootstrap, toolCalls, () => currentDocument, (doc) => {
          currentDocument = doc;
        }, evidenceDocumentIds, input.buttonHint);
        transcript.push(formatToolTranscript(bootstrap));
        continue;
      }
    }

    if (decision.action === "call_tool") {
      const validated = validateToolRequest(decision.name, decision.arguments);
      if (!validated.ok) {
        transcript.push(`Rejected tool ${decision.name}: ${validated.reason ?? "invalid"}.`);
        qualityFlags.add("wrong_tool");
        continue;
      }
      if (shouldFlagGlobalSearch(validated.name, currentDocument, input.buttonHint, input.text, scoped.scope)) {
        qualityFlags.add("unnecessary_company_wide_search");
      }
      if (SYSTEM_META_TOOLS.has(validated.name) === false && scoped.scope === "SYSTEM_META") {
        qualityFlags.add("system_question_as_current_doc");
      }
      if (scoped.scope === "GENERAL_CONVERSATION") qualityFlags.add("general_conversation_used_tool");
      if (scoped.lastUserIntent === "rephrase") qualityFlags.add("unnecessary_search_after_rephrase");
      const call: IntelligenceToolCall = {
        name: validated.name,
        arguments: prepareToolArguments(validated.name, validated.arguments, input.text, workingState, scoped.scope),
      };
      const result = await input.runtime.executeTool(call);
      toolCalls.push(result);
      const doc = documentFromToolResult(result);
      if (doc) {
        if (shouldAdoptDocument(validated.name, input.state.currentDocument, doc, input.buttonHint)) {
          currentDocument = doc;
        }
        if (!evidenceDocumentIds.includes(doc.id)) evidenceDocumentIds.push(doc.id);
      }
      if (looksIrrelevant(result, currentDocument)) qualityFlags.add("irrelevant_result");
      transcript.push(formatToolTranscript(result));
      continue;
    }

    if (decision.action === "clarify") {
      if (toolCalls.length === 0 && shouldForceScopedTool(scoped)) {
        const bootstrap = await bootstrapRetrieval(input.runtime, workingState, input.text, input.buttonHint, scoped);
        if (bootstrap) {
          toolCalls.push(bootstrap);
          adoptFromTool(
            bootstrap,
            toolCalls,
            () => currentDocument,
            (doc) => {
              currentDocument = doc;
            },
            evidenceDocumentIds,
            input.buttonHint,
          );
          transcript.push(formatToolTranscript(bootstrap));
          continue;
        }
      }
      if (shouldHaveClarified(input.state, toolCalls) === false && looksLikeGuess(decision.text)) {
        qualityFlags.add("bad_clarification");
      }
      const foundTitles = searchHitTitles(toolCalls);
      if (foundTitles.length && shouldForceScopedTool(scoped)) {
        const hits = searchHits(toolCalls.find((call) => call.name === "search_company_knowledge")?.data);
        if (hits.length === 1 && !currentDocument) {
          const only = hits[0] && typeof hits[0] === "object" ? (hits[0] as { id?: string; title?: string; url?: string }) : null;
          if (only?.id && only.title) {
            currentDocument = {
              id: String(only.id),
              title: String(only.title),
              url: typeof only.url === "string" && /^https?:\/\//i.test(only.url) ? only.url : null,
            };
            if (!evidenceDocumentIds.includes(currentDocument.id)) evidenceDocumentIds.push(currentDocument.id);
          }
        }
        return finish({
          kind: "answer",
          text:
            foundTitles.length === 1
              ? `I found ${foundTitles[0]}. What do you want from it?`
              : `Across your documents I can see: ${foundTitles.join("; ")}. Which should I open?`,
          confidence: "partial",
          offerSearchOther: true,
          toolCalls,
          currentDocument,
          evidenceDocumentIds,
          clarification: false,
          modelRounds,
          route: "INTELLIGENT",
          scope: scoped.scope,
          lastAnswerTopic: scoped.lastAnswerTopic,
          lastUserIntent: scoped.lastUserIntent,
          qualityFlags: [...qualityFlags],
          repaired,
          fallbackUsed: modelRounds.some((row) => row.fallbackUsed),
        });
      }
      if (toolCalls.some((call) => call.ok) && scoped.scope === "BUSINESS_SYSTEM") {
        continue;
      }
      return finish({
        kind: "clarify",
        text: decision.text.trim() || "Can you give me a little more detail so I look in the right place?",
        confidence: "partial",
        offerSearchOther: false,
        toolCalls,
        currentDocument,
        evidenceDocumentIds,
        clarification: true,
        modelRounds,
        route: "INTELLIGENT",
        scope: scoped.scope,
        lastAnswerTopic: scoped.lastAnswerTopic,
        lastUserIntent: scoped.lastUserIntent,
        qualityFlags: [...qualityFlags],
        repaired,
        fallbackUsed: modelRounds.some((row) => row.fallbackUsed),
      });
    }

    if (decision.action === "answer") {
      if (needsClarification(toolCalls, currentDocument, workingState) && decision.confidence === "strong") {
        qualityFlags.add("missing_clarification");
      }
      if (scoped.scope === "AMBIGUOUS") qualityFlags.add("ambiguous_answered_without_clarify");
      if (advertisedMissingConnector(decision.text, workingState.connectors)) {
        qualityFlags.add("connector_hallucinated");
      }
      const metaData = toolCalls.find((call) => SYSTEM_META_TOOLS.has(call.name))?.data;
      if (metaData && inventedCount(decision.text, metaData)) qualityFlags.add("count_invented");
      const grounded = terminalFromToolCalls(toolCalls);
      const modelDeniedToolsThatWorked =
        /permission|not allow|don’t allow|don't allow|do not have access/i.test(decision.text) &&
        toolCalls.some((call) => call.ok) &&
        Boolean(grounded);
      return finish({
        kind: "answer",
        text: String(modelDeniedToolsThatWorked && grounded ? grounded : decision.text).trim(),
        confidence: decision.confidence,
        offerSearchOther: decision.offer_search_other || decision.confidence === "none",
        toolCalls,
        currentDocument,
        evidenceDocumentIds,
        clarification: false,
        modelRounds,
        citeSource: decision.cite_source,
        route: "INTELLIGENT",
        scope: scoped.scope,
        lastAnswerTopic: scoped.lastAnswerTopic,
        lastUserIntent: scoped.lastUserIntent,
        qualityFlags: [...qualityFlags],
        repaired,
        fallbackUsed: modelRounds.some((row) => row.fallbackUsed),
      });
    }
  }

  const evidenceText = terminalFromToolCalls(toolCalls) ?? fallbackFromEvidence(toolCalls, currentDocument);

  if (toolCalls.length > 0) {
    return finish({
      kind: toolCalls.some((call) => call.ok) ? "answer" : "failed",
      text: evidenceText,
      confidence: toolCalls.some((call) => call.ok) ? "partial" : "none",
      offerSearchOther: Boolean(currentDocument),
      toolCalls,
      currentDocument,
      evidenceDocumentIds,
      clarification: false,
      modelRounds,
      route: "INTELLIGENT",
      scope: scoped.scope,
      lastAnswerTopic: scoped.lastAnswerTopic,
      lastUserIntent: scoped.lastUserIntent,
      qualityFlags: [...qualityFlags, "fallback"],
      repaired,
      fallbackUsed: true,
    });
  }

  if (modelRounds.every((round) => !round.model || round.provider === "none")) {
    return finish({
      kind: "failed",
      text: "I couldn't complete that just now. Try again in a moment.",
      confidence: "none",
      offerSearchOther: false,
      toolCalls,
      currentDocument,
      evidenceDocumentIds,
      clarification: false,
      modelRounds,
      route: "INTELLIGENT",
      scope: scoped.scope,
      lastAnswerTopic: scoped.lastAnswerTopic,
      lastUserIntent: scoped.lastUserIntent,
      qualityFlags: [...qualityFlags, "unsupported_answer"],
      repaired,
    });
  }

  return finish({
    kind: "failed",
    text: scopedToolFailure(scoped.scope, scoped.lastAnswerTopic),
    confidence: "none",
    offerSearchOther: Boolean(currentDocument),
    toolCalls,
    currentDocument,
    evidenceDocumentIds,
    clarification: false,
    modelRounds,
    route: "INTELLIGENT",
    scope: scoped.scope,
    lastAnswerTopic: scoped.lastAnswerTopic,
    lastUserIntent: scoped.lastUserIntent,
    qualityFlags: [...qualityFlags],
    repaired,
  });
}

export { parseIntelligenceDecision, extractJsonObject } from "./parse.js";

function shouldFlagGlobalSearch(
  toolName: string,
  current: IntelligenceDocumentRef | null,
  buttonHint?: string | null,
  text?: string,
  scope?: IntelligenceScope,
): boolean {
  if (toolName !== "search_company_knowledge") return false;
  if (scope === "COMPANY_KNOWLEDGE" || scope === "SYSTEM_META") return false;
  if (!current) return false;
  if (buttonHint === "search_other_docs") return false;
  if (/\b(find|search|look(?:ing)? (for|up)|another|different|other (doc|document|file))\b/i.test(text ?? "")) {
    return false;
  }
  return true;
}

function shouldHaveClarified(
  state: IntelligenceConversationState,
  toolCalls: IntelligenceToolResult[],
): boolean {
  const search = toolCalls.find((call) => call.name === "search_company_knowledge");
  const hits = searchHits(search?.data);
  return hits.length >= 3 && !state.currentDocument;
}

function needsClarification(
  toolCalls: IntelligenceToolResult[],
  current: IntelligenceDocumentRef | null,
  state: IntelligenceConversationState,
): boolean {
  if (current || state.currentDocument) return false;
  const hits = searchHits(toolCalls.find((call) => call.name === "search_company_knowledge")?.data);
  return hits.length >= 3;
}

function looksLikeGuess(text: string): boolean {
  return /\b(probably|I assume|must be)\b/i.test(text);
}

function looksIrrelevant(result: IntelligenceToolResult, current: IntelligenceDocumentRef | null): boolean {
  if (!result.ok || !current) return false;
  const doc = documentFromToolResult(result);
  return Boolean(doc && doc.id !== current.id && result.name === "search_document");
}

function searchHits(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  return Array.isArray(results) ? results : [];
}

function searchHitTitles(toolCalls: IntelligenceToolResult[]): string[] {
  const hits = searchHits(toolCalls.find((call) => call.name === "search_company_knowledge")?.data);
  return [
    ...new Set(
      hits
        .map((hit) => (hit && typeof hit === "object" ? String((hit as { title?: string }).title ?? "") : ""))
        .filter(Boolean),
    ),
  ].slice(0, 3);
}

function scopedToolFailure(scope: IntelligenceScope | undefined, topic: string | null): string {
  if (scope === "BUSINESS_SYSTEM" && topic === "email") return "I couldn’t retrieve that mailbox just now.";
  if (scope === "BUSINESS_SYSTEM") return "I couldn’t retrieve Xero data just now.";
  if (scope === "COMPANY_KNOWLEDGE" || scope === "CURRENT_DOCUMENT") {
    return "I couldn’t search company files just now.";
  }
  return "I couldn't complete that just now. Try again in a moment.";
}

function fallbackFromEvidence(
  toolCalls: IntelligenceToolResult[],
  current: IntelligenceDocumentRef | null,
): string {
  const fromTools = terminalFromToolCalls(toolCalls);
  if (fromTools) return fromTools;
  const last = [...toolCalls].reverse().find((call) => call.ok);
  const doc = last ? documentFromToolResult(last) : current;
  if (doc) {
    return `I have ${doc.title} open. Ask me what you want from it, or name a different file.`;
  }
  const hits = searchHits(toolCalls.find((call) => call.name === "search_company_knowledge")?.data);
  if (hits.length > 1) {
    return "A few documents could match that. Which file did you mean?";
  }
  if (!toolCalls.length) return scopedToolFailure(undefined, null);
  return "I couldn't finish a grounded answer from the evidence I retrieved. Try naming the file.";
}

function documentFromToolResult(result: IntelligenceToolResult): IntelligenceDocumentRef | null {
  const data = result.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const nested =
    record.document && typeof record.document === "object"
      ? (record.document as Record<string, unknown>)
      : record;
  const id = String(nested.document_id ?? nested.documentId ?? nested.id ?? "").trim();
  const title = String(nested.title ?? "").trim();
  if (!id || !title) return null;
  const url = typeof nested.url === "string" && /^https?:\/\//i.test(nested.url) ? nested.url : null;
  return { id, title, url, source: typeof nested.source === "string" ? nested.source : null };
}

function shouldAdoptDocument(
  toolName: string,
  current: IntelligenceDocumentRef | null,
  next: IntelligenceDocumentRef,
  buttonHint?: string | null,
): boolean {
  void current;
  void buttonHint;
  return toolName === "get_knowledge_document" || toolName === "fetch" || toolName === "search_document";
}

function adoptFromTool(
  result: IntelligenceToolResult,
  _toolCalls: IntelligenceToolResult[],
  _current: () => IntelligenceDocumentRef | null,
  setCurrent: (doc: IntelligenceDocumentRef) => void,
  evidenceDocumentIds: string[],
  buttonHint?: string | null,
): void {
  const doc = documentFromToolResult(result);
  if (doc && shouldAdoptDocument(result.name, null, doc, buttonHint)) {
    setCurrent(doc);
  }
  if (doc && !evidenceDocumentIds.includes(doc.id)) evidenceDocumentIds.push(doc.id);
}

function looksLikeNewDocumentSearch(text: string): boolean {
  return /\b(find|search|look(?:ing)? (for|up)|pull up|open|switch to|go to|another|different|other (doc|document|file)|broaden|search other)\b/i.test(
    text,
  );
}

function shouldForceScopedTool(scoped: ScopeDecision): boolean {
  if (scoped.scope === "AMBIGUOUS" || scoped.scope === "GENERAL_CONVERSATION" || scoped.scope === "CONTROLLED_ACTION") {
    return false;
  }
  return Boolean(scoped.tool);
}

function looksLikeFinanceRead(text: string): boolean {
  return /\b(sales|revenue|profit|p&l|pnl|overdue|xero|invoice|turnover|aged receivables)\b/i.test(text);
}

async function bootstrapRetrieval(
  runtime: IntelligenceRuntime,
  state: IntelligenceConversationState,
  text: string,
  buttonHint?: string | null,
  scoped?: ScopeDecision,
): Promise<IntelligenceToolResult | null> {
  if (scoped?.scope === "GENERAL_CONVERSATION" || scoped?.scope === "AMBIGUOUS") return null;
  if (scoped?.scope === "SYSTEM_META" || scoped?.scope === "CONNECTOR_CAPABILITY") {
    return runtime.executeTool({ name: scoped.tool || "get_company_system_summary", arguments: {} });
  }
  if (scoped?.tool === "list_documents") {
    return runtime.executeTool({
      name: "list_documents",
      arguments: prepareToolArguments("list_documents", {}, text, state, scoped.scope),
    });
  }
  if (looksLikeFinanceRead(text) || scoped?.scope === "BUSINESS_SYSTEM") {
    const toolName = scoped?.tool || "xero_sales_summary";
    return runtime.executeTool({
      name: toolName,
      arguments: prepareToolArguments(toolName, {}, text, state, scoped?.scope),
    });
  }
  if (
    buttonHint === "search_other_docs" ||
    scoped?.scope === "COMPANY_KNOWLEDGE" ||
    !state.currentDocument ||
    looksLikeNewDocumentSearch(text)
  ) {
    return runtime.executeTool({ name: "search_company_knowledge", arguments: { query: text } });
  }
  if (scoped?.scope && scoped.scope !== "CURRENT_DOCUMENT" && scoped.scope !== "RECENT_ENTITY") {
    return runtime.executeTool({ name: "search_company_knowledge", arguments: { query: text } });
  }
  return runtime.executeTool({
    name: "search_document",
    arguments: prepareToolArguments(
      "search_document",
      { document_id: state.currentDocument.id, query: text },
      text,
      state,
      scoped?.scope ?? "CURRENT_DOCUMENT",
    ),
  });
}

function prepareToolArguments(
  name: string,
  args: Record<string, unknown>,
  text: string,
  state: IntelligenceConversationState,
  scope?: IntelligenceScope | null,
): Record<string, unknown> {
  let next = { ...args };
  if (needsBusinessDates(name)) {
    next = withResolvedBusinessDates(name, next, text);
  }
  if (name === "list_documents") {
    const parsed = parseCatalogueIntent(text);
    return {
      source: typeof next.source === "string" ? next.source : parsed.source,
      sort: typeof next.sort === "string" ? next.sort : parsed.sort,
      limit: next.limit ?? parsed.limit,
      file_type: next.file_type ?? parsed.fileType,
      date_from: next.date_from ?? parsed.dateFrom,
      date_to: next.date_to ?? parsed.dateTo,
      include_descriptions: next.include_descriptions ?? parsed.includeDescriptions,
      titleContains: next.titleContains ?? parsed.titleContains,
    };
  }
  if (name === "outlook_search_mailbox" || name === "outlook_list_messages") {
    next.mailboxAddress = String(next.mailboxAddress ?? next.mailbox ?? defaultMailboxForText(text)).trim();
    if (name === "outlook_search_mailbox" && !String(next.query ?? "").trim()) {
      next.query = text.trim() || "newest";
    }
    if (name === "outlook_list_messages") {
      next.limit = next.limit ?? 5;
    }
    return next;
  }
  if (name === "search_company_knowledge" && !String(next.query ?? "").trim()) {
    next.query = text.trim();
    return next;
  }
  if (name === "search_document") {
    const enriched = enrichDocumentQuery(String(next.query ?? text), {
      scope: scope ?? "CURRENT_DOCUMENT",
      currentTitle: state.currentDocument?.title ?? null,
      previousUserText: previousUserText(state, text),
      lastAnswerTopic: state.lastAnswerTopic ?? null,
      userCorrection: Boolean(state.userCorrection),
      documentChanged: false,
      scopeChanged: Boolean(state.currentScope && scope && state.currentScope !== scope),
    });
    next.query = enriched.query;
    if (state.currentDocument && !String(next.document_id ?? "").trim()) {
      next.document_id = state.currentDocument.id;
    }
  }
  return next;
}

function shouldRunDeterministicMeta(scoped: ScopeDecision): boolean {
  return (
    ((scoped.scope === "SYSTEM_META" || scoped.scope === "CONNECTOR_CAPABILITY") &&
      Boolean(scoped.tool) &&
      !scoped.clarify) ||
    scoped.tool === "list_documents"
  );
}

async function runDeterministicMeta(
  runtime: IntelligenceRuntime,
  scoped: ScopeDecision,
  text: string,
  completer: IntelligenceCompleter,
  permitted: string[],
  qualityFlags: Set<IntelligenceQualityFlag>,
): Promise<{
  text: string;
  toolCalls: IntelligenceToolResult[];
  modelRounds: IntelligenceModelUsage[];
  flags: IntelligenceQualityFlag[];
} | null> {
  const toolName = scoped.tool;
  if (!toolName || !INTELLIGENCE_TOOL_NAMES.has(toolName)) return null;
  if (permitted.length && !permitted.includes(toolName) && !SYSTEM_META_TOOLS.has(toolName)) {
    return {
      text: "I don't have permission to read that for you.",
      toolCalls: [],
      modelRounds: [],
      flags: [],
    };
  }
  const args = toolName === "list_documents" ? prepareToolArguments(toolName, {}, text, {
    currentDocument: null,
    lastAnswerTopic: scoped.lastAnswerTopic,
    lastUserIntent: scoped.lastUserIntent,
    userCorrection: false,
    currentScope: scoped.scope,
  } as IntelligenceConversationState, scoped.scope) : {};
  const result = await runtime.executeTool({ name: toolName, arguments: args });
  const flags: IntelligenceQualityFlag[] = [];
  const fallback =
    toolName === "list_documents"
      ? verbaliseDocumentCatalogue(result.ok ? result.data : { error: result.error }, text)
      : verbaliseSystemMeta(toolName, result.ok ? result.data : { error: result.error }, text);
  if (!result.ok) {
    return { text: fallback, toolCalls: [result], modelRounds: [], flags };
  }
  if (toolName === "list_documents") {
    return { text: fallback, toolCalls: [result], modelRounds: [], flags };
  }
  let textOut = fallback;
  const modelRounds: IntelligenceModelUsage[] = [];
  try {
    const polished = await completer({
      system:
        "Verbalise this JSON for the user. Use only these numbers and labels. Never invent a count, system, or URL. No D1/Vectorize/MCP jargon.",
      user: `Question: ${text}\nJSON:\n${JSON.stringify(result.data).slice(0, 2_400)}`,
      permittedTools: [],
      mode: "synthesise",
    });
    modelRounds.push(polished.usage);
    const recovered = recoverDecision({ text: polished.text });
    const candidate =
      recovered.decision.action === "answer"
        ? recovered.decision.text.trim()
        : polished.text.trim();
    if (candidate && !inventedCount(candidate, result.data) && !/vectorize|\bd1\b|mcp\b/i.test(candidate)) {
      textOut = candidate;
    } else if (candidate && inventedCount(candidate, result.data)) {
      flags.push("count_invented");
      qualityFlags.add("count_invented");
    }
  } catch {
    // Deterministic wording is enough.
  }
  return { text: textOut, toolCalls: [result], modelRounds, flags };
}

function formatToolTranscript(result: IntelligenceToolResult): string {
  const payload = JSON.stringify(result.ok ? result.data : { error: result.error ?? "tool_failed" });
  return `${result.name} (${result.ok ? "ok" : "error"}, ${result.latencyMs}ms): ${payload.slice(0, 2_400)}`;
}

function emptyResult(
  input: Pick<IntelligenceTurnResult, "kind" | "text" | "confidence" | "offerSearchOther"> & {
    route?: IntelligenceTurnResult["route"];
    scope?: IntelligenceScope;
    lastAnswerTopic?: string | null;
    lastUserIntent?: string | null;
    currentDocument?: IntelligenceDocumentRef | null;
  },
): IntelligenceTurnResult {
  return {
    ...input,
    toolCalls: [],
    currentDocument: input.currentDocument ?? null,
    evidenceDocumentIds: [],
    clarification: input.kind === "clarify",
    citeSource: false,
    modelRounds: [],
    totalModelMs: 0,
    totalToolMs: 0,
    provider: "none",
    model: null,
    estimatedCostUsd: 0,
    route: input.route ?? "FAST_LOCAL",
    scope: input.scope,
    lastAnswerTopic: input.lastAnswerTopic ?? null,
    lastUserIntent: input.lastUserIntent ?? null,
    qualityFlags: [],
    repaired: false,
    fallbackUsed: false,
  };
}

function finish(
  input: Omit<
    IntelligenceTurnResult,
    "totalModelMs" | "totalToolMs" | "provider" | "model" | "estimatedCostUsd" | "citeSource"
  > & {
    citeSource?: boolean;
  },
): IntelligenceTurnResult {
  const last = input.modelRounds.at(-1);
  return {
    kind: input.kind,
    text: input.text,
    confidence: input.confidence,
    offerSearchOther: input.offerSearchOther,
    toolCalls: input.toolCalls,
    currentDocument: input.currentDocument,
    evidenceDocumentIds: input.evidenceDocumentIds,
    clarification: input.clarification,
    citeSource: Boolean(input.citeSource),
    modelRounds: input.modelRounds,
    totalModelMs: input.modelRounds.reduce((sum, row) => sum + row.latencyMs, 0),
    totalToolMs: input.toolCalls.reduce((sum, row) => sum + row.latencyMs, 0),
    provider: last?.provider ?? "none",
    model: last?.model ?? null,
    estimatedCostUsd: input.modelRounds.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0),
    route: input.route ?? "INTELLIGENT",
    scope: input.scope,
    lastAnswerTopic: input.lastAnswerTopic ?? null,
    lastUserIntent: input.lastUserIntent ?? null,
    qualityFlags: input.qualityFlags ?? [],
    repaired: Boolean(input.repaired),
    fallbackUsed: Boolean(input.fallbackUsed),
  };
}

export function normalizeConfidence(value: unknown): IntelligenceConfidence {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "strong" || raw === "partial" || raw === "none") return raw;
  return "partial";
}

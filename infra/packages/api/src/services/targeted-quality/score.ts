import { isGenericRetryCopy } from "../intelligence/verbalise-business.js";
import { scoreOvernightTurn, scoreChannel, overallFromChannels } from "../overnight-qa/score";
import type { OvernightTurnScore } from "../overnight-qa/types";
import type { OvernightQuestion } from "../overnight-qa/types";
import type { TargetedQuestion } from "./types";

export function toOvernightQuestion(question: TargetedQuestion): OvernightQuestion {
  return {
    id: question.id,
    channel: question.channel === "followup" ? "followup" : question.channel === "whatsapp" ? "whatsapp" : "portal",
    text: question.text,
    actor: question.actor,
    family:
      question.family === "knowledge"
        ? "knowledge"
        : question.family === "outlook"
          ? "outlook"
          : question.family === "mixed"
            ? "mixed"
            : question.family === "correction"
              ? "correction"
              : question.family === "followup"
                ? "followup"
                : "no_tool",
    expectedToolPrefix: question.expectedToolPrefix,
    expectedSource: question.expectedSource,
    expectedDeny: question.expectedDeny,
    sequence: question.sequence,
    sequenceIndex: question.sequenceIndex,
  };
}

export function scoreTargetedTurn(input: {
  question: TargetedQuestion;
  tools: string[];
  reply: string;
  denied: boolean;
  charged: boolean;
  latencyMs: number;
  terminal?: string;
}): OvernightTurnScore {
  const scored = scoreOvernightTurn({
    question: toOvernightQuestion(input.question),
    tools: input.tools,
    reply: input.reply,
    denied: input.denied,
    charged: input.charged,
    latencyMs: input.latencyMs,
    terminal: input.terminal,
  });
  const honest =
    /couldn.?t find|no matching|don.?t have (a |that )?(document|policy|source)|no indexed|nothing in (the )?company knowledge|no source exists/i.test(
      input.reply,
    );
  const retrievalFail = /couldn.?t reach company knowledge|need another moment/i.test(input.reply);
  if (input.question.family === "knowledge" && input.tools.some((name) => name === "search_company_knowledge")) {
    if (honest && !retrievalFail && input.question.honestNoResultOk) {
      scored.defects = scored.defects.filter((name) => name !== "WRONG_TOOL" && name !== "WRONG_TOOL_FAMILY" && name !== "WRONG_SOURCE");
      if (!scored.defects.length) {
        scored.perfect = true;
        scored.grounded = true;
        scored.firstAnswer = true;
      }
    } else if (honest && !retrievalFail && !input.question.honestNoResultOk) {
      scored.defects = [...new Set([...scored.defects, "KNOWLEDGE_RETRIEVAL_FAILURE"])];
      scored.perfect = false;
    }
    if (retrievalFail) {
      scored.defects = [...new Set([...scored.defects, "KNOWLEDGE_RETRIEVAL_FAILURE"])];
      scored.perfect = false;
    }
  }
  if (input.question.family === "mixed") {
    const knowledgeWanted = /policy|knowledge|handbook|document|procedure|guidance|process/i.test(input.question.text);
    if (knowledgeWanted && input.tools.includes("list_documents") && !input.tools.includes("search_company_knowledge")) {
      scored.defects = [...new Set([...scored.defects, "KNOWLEDGE_VS_CATALOGUE"])];
      scored.perfect = false;
    }
  }
  if (input.question.expectedSource === "none" && input.tools.some((name) => name.startsWith("outlook_"))) {
    scored.defects = [...new Set([...scored.defects, "FOLLOWUP_SHOULD_REUSE_EVIDENCE"])];
    scored.perfect = false;
  }
  if (input.question.subjectOnly && input.tools.includes("outlook_get_message")) {
    scored.defects = [...new Set([...scored.defects, "UNNECESSARY_FULL_MESSAGE"])];
    scored.perfect = false;
  }
  if (!input.reply.trim() && !isGenericRetryCopy(input.reply)) {
    scored.defects = [...new Set([...scored.defects, "NO_FINAL_ANSWER"])];
    scored.perfect = false;
  }
  return scored;
}

export { scoreChannel, overallFromChannels };

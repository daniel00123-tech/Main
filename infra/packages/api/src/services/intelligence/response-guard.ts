import { classifyReadTerminal, isGenericRetryCopy, looksPermissionDenied, synthesizeFromToolCalls } from "./verbalise-business.js";
import type {
  IntelligenceQualityFlag,
  IntelligenceToolResult,
  IntelligenceTurnResult,
  ResponseGuardCheck,
  ResponseTerminal,
} from "./types.js";

const FAILURE_CLAIM =
  /\b(couldn'?t (reach|find|complete|process)|unable to|failed to|i (don'?t|do not) have access|permission denied|need another moment)\b/i;
const LIVE_CLAIM = /\b(in xero|from (xero|outlook|the inbox)|sales (are|were|this)|the newest email|i (can see|found))\b/i;
const FIGURE = /£\s?[\d,]+(?:\.\d{2})?|\b\d+(\.\d+)?\s*%|\b\d{1,4}\s+invoice/;
const REACHED_WITHOUT_FIGURES = /\bi (reached|checked|looked (in|at)|queried) xero\b/i;

export function classifyResponseTerminal(result: Pick<IntelligenceTurnResult, "kind" | "text" | "toolCalls" | "clarification">): ResponseTerminal {
  const read = classifyReadTerminal(result.toolCalls, result.text, result.kind);
  if (read === "permission_denied") return "PERMISSION_DENIED";
  if (read === "no_results") return "NO_RESULTS";
  if (read === "upstream_failure") return "UPSTREAM_FAILURE";
  if (read === "timeout" && !result.toolCalls.some((call) => call.ok)) return "UPSTREAM_FAILURE";
  if (result.kind === "clarify" || result.clarification) return "CLARIFICATION_REQUIRED";
  if (result.kind === "failed" && !result.toolCalls.some((call) => call.ok)) return "UPSTREAM_FAILURE";
  return "ANSWER";
}

export function runResponseQualityGuard(input: {
  text: string;
  question: string;
  toolCalls: IntelligenceToolResult[];
  kind: IntelligenceTurnResult["kind"];
  clarification?: boolean;
  lastAnswerTopic?: string | null;
}): {
  text: string;
  terminal: ResponseTerminal;
  repaired: boolean;
  checks: ResponseGuardCheck[];
  flags: IntelligenceQualityFlag[];
} {
  const checks = evaluateChecks(input);
  const failed = checks.filter((check) => !check.ok);
  let text = input.text.trim();
  let repaired = false;
  if (failed.length) {
    const hard = failed.some((check) =>
      [
        "tool_success_not_reported_as_failure",
        "data_exists_not_no_result",
        "successful_result_not_discarded",
        "not_generic_retry_after_success",
        "not_blank",
        "live_claim_has_evidence",
        "xero_mentions_figures",
        "not_contradictory_blank",
        "not_permission_from_payload_words",
        "permission_uses_access_outcome",
      ].includes(check.id),
    );
    const fallback = synthesizeFromToolCalls(input.toolCalls, input.question);
    if (hard && fallback && fallback !== text && !isGenericRetryCopy(fallback)) {
      text = fallback;
      repaired = true;
    } else if (!text || isGenericRetryCopy(text)) {
      if (input.toolCalls.some((call) => looksPermissionDenied(call))) {
        text = "Your current permissions don’t allow this action.";
        repaired = true;
      } else if (input.toolCalls.some((call) => call.ok)) {
        text = fallback;
        repaired = true;
      }
    }
  }
  if (!text) {
    text = input.toolCalls.length
      ? synthesizeFromToolCalls(input.toolCalls, input.question)
      : "Can you give me a little more detail so I look in the right place?";
    repaired = true;
  }
  const terminal = classifyResponseTerminal({
    kind: input.kind,
    text,
    toolCalls: input.toolCalls,
    clarification: input.clarification,
  });
  if (terminal !== "UPSTREAM_FAILURE" && isGenericRetryCopy(text) && input.toolCalls.some((call) => call.ok)) {
    text = synthesizeFromToolCalls(input.toolCalls, input.question);
    repaired = true;
  }
  return {
    text,
    terminal: classifyResponseTerminal({ kind: input.kind, text, toolCalls: input.toolCalls, clarification: input.clarification }),
    repaired,
    checks,
    flags: failed.length ? (["unsupported_answer"] as IntelligenceQualityFlag[]) : [],
  };
}

function evaluateChecks(input: {
  text: string;
  question: string;
  toolCalls: IntelligenceToolResult[];
  kind: IntelligenceTurnResult["kind"];
  lastAnswerTopic?: string | null;
}): ResponseGuardCheck[] {
  const text = input.text.trim();
  const okCalls = input.toolCalls.filter((call) => call.ok);
  const denied = input.toolCalls.filter((call) => looksPermissionDenied(call));
  const xeroOk = okCalls.filter((call) => /^xero_/.test(call.name));
  const outlookOk = okCalls.filter((call) => /outlook/i.test(call.name));
  const knowledgeOk = okCalls.filter((call) => /knowledge|search_document|list_documents|fetch/.test(call.name));
  return [
    check("tool_success_not_reported_as_failure", !(okCalls.length > 0 && denied.length === 0 && FAILURE_CLAIM.test(text) && !/couldn'?t find any matching/i.test(text))),
    check("data_exists_not_no_result", !(okCalls.length > 0 && /couldn'?t find any/i.test(text) && hasPayloadData(okCalls))),
    check("not_wrong_system_email_to_xero", !(outlookOk.length > 0 && xeroOk.length === 0 && /\bxero\b/i.test(text) && !/\b(email|inbox|outlook)\b/i.test(text))),
    check("not_wrong_system_xero_to_knowledge", !(xeroOk.length > 0 && knowledgeOk.length === 0 && /\b(document|file|policy)\b/i.test(text) && !/\b(invoice|sales|xero)\b/i.test(text))),
    check("successful_result_not_discarded", !(okCalls.length > 0 && (!text || isGenericRetryCopy(text)))),
    check("not_generic_retry_after_success", !(okCalls.length > 0 && isGenericRetryCopy(text))),
    check("not_blank", Boolean(text)),
    check("permission_uses_access_outcome", denied.length === 0 || looksPermissionDenied(denied[0]!)),
    check("live_claim_has_evidence", !(LIVE_CLAIM.test(text) && okCalls.length === 0 && !input.lastAnswerTopic)),
    check("xero_mentions_figures", !(xeroOk.length > 0 && REACHED_WITHOUT_FIGURES.test(text) && !FIGURE.test(text))),
    check("not_permission_from_payload_words", !falsePositivePermission(input.toolCalls, text)),
    check("not_contradictory_blank", !(okCalls.length > 0 && /no (data|result|email|invoice)/i.test(text) && hasPayloadData(okCalls))),
  ];
}

function check(id: ResponseGuardCheck["id"], ok: boolean): ResponseGuardCheck {
  return { id, ok };
}

function hasPayloadData(calls: IntelligenceToolResult[]): boolean {
  return calls.some((call) => {
    const raw = JSON.stringify(call.data ?? "");
    return /sales_total|totalSales|messages|invoices|results|documents|subject|invoiceNumber/.test(raw);
  });
}

function falsePositivePermission(calls: IntelligenceToolResult[], text: string): boolean {
  if (!/permission/i.test(text)) return false;
  return calls.some((call) => call.ok && !looksPermissionDenied(call));
}

export function applyGuardToTurn(
  result: IntelligenceTurnResult,
  question: string,
): IntelligenceTurnResult {
  const guarded = runResponseQualityGuard({
    text: result.text,
    question,
    toolCalls: result.toolCalls,
    kind: result.kind,
    clarification: result.clarification,
    lastAnswerTopic: result.lastAnswerTopic,
  });
  return {
    ...result,
    text: guarded.text,
    repaired: result.repaired || guarded.repaired,
    terminal: guarded.terminal,
    qualityFlags: [...new Set([...(result.qualityFlags ?? []), ...guarded.flags])],
    guardChecks: guarded.checks,
  };
}

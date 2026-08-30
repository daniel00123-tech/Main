import type { QualityPattern } from "./patterns";
import {
  AUTO_APPLY_KINDS,
  HIGH_RISK_PROPOSAL_KEYS,
  type ProposalKind,
  type ProposalRisk,
  type QualityProposalDraft,
} from "./types";

export function proposeImprovements(
  patterns: QualityPattern[],
  blockedFingerprints: Set<string> = new Set(),
): QualityProposalDraft[] {
  const drafts: QualityProposalDraft[] = [];
  for (const pattern of patterns) {
    if (pattern.platformAggregate) continue;
    if (pattern.occurrenceCount < 1) continue;
    const draft = draftForPattern(pattern);
    if (!draft) continue;
    if (blockedFingerprints.has(draft.fingerprint)) continue;
    drafts.push(draft);
  }
  return drafts;
}

export function isHighRiskProposal(input: { kind: ProposalKind; title: string; summary: string; path?: string }): boolean {
  if (input.kind === "engineering_change") return true;
  const hay = `${input.title} ${input.summary} ${input.path ?? ""}`.toLowerCase();
  return HIGH_RISK_PROPOSAL_KEYS.some((key) => hay.includes(key));
}

export function classifyProposalRisk(kind: ProposalKind, title: string, summary: string): ProposalRisk {
  if (isHighRiskProposal({ kind, title, summary })) return "high";
  if (kind === "planner_config" || kind === "threshold") return "medium";
  return "low";
}

function draftForPattern(pattern: QualityPattern): QualityProposalDraft | null {
  if (pattern.category === "permission_denial_correct") return null;
  const mapping = mappingFor(pattern);
  if (!mapping) return null;
  const risk = classifyProposalRisk(mapping.kind, mapping.title, mapping.summary);
  const high = risk === "high" || mapping.kind === "engineering_change";
  return {
    companyId: pattern.companyId,
    patternFingerprint: pattern.fingerprint,
    title: mapping.title,
    summary: mapping.summary,
    kind: mapping.kind,
    risk,
    autoApplyable: !high && AUTO_APPLY_KINDS.includes(mapping.kind),
    engineeringRequired: mapping.kind === "engineering_change",
    patch: { patches: mapping.patches },
    evidence: {
      pattern: pattern.fingerprint,
      occurrenceCount: pattern.occurrenceCount,
      examples: pattern.evidence,
      rootCause: pattern.rootCause,
    },
    fingerprint: `prop:${pattern.fingerprint}:${mapping.kind}:${mapping.patches.map((p) => p.path).join(",")}`,
  };
}

function mappingFor(pattern: QualityPattern): {
  title: string;
  summary: string;
  kind: ProposalKind;
  patches: Array<{ path: string; value: unknown }>;
} | null {
  switch (pattern.category) {
    case "raw_dump":
      return {
        title: "Tighten no-raw-dump response rules",
        summary: "Increase compression and always strip JSON/tool payloads from WhatsApp replies.",
        kind: "response_rule",
        patches: [
          { path: "responseRules.stripRawJson", value: true },
          { path: "responseRules.maxChars", value: 600 },
          { path: "prompts.noRawDumpGuidance", value: "Never paste raw JSON, XML, tool payloads, or unformatted document dumps." },
        ],
      };
    case "missing_source_url":
      return {
        title: "Require a source URL when the user asks for a link",
        summary: "Planner and response rules should attach a usable https URL after an explicit source/link ask.",
        kind: "planner_config",
        patches: [
          { path: "planner.requireSourceUrlWhenAsked", value: true },
          { path: "responseRules.requireSourceUrlWhenAsked", value: true },
          { path: "suggestedActions.preferOpenSource", value: true },
          { path: "prompts.sourceUrlGuidance", value: "If the user asks for a link, URL, source, or download, include a real https URL." },
        ],
      };
    case "context_loss":
      return {
        title: "Prefer entity memory on follow-ups",
        summary: "Reuse the last document or invoice instead of starting a fresh ungrounded search.",
        kind: "planner_config",
        patches: [
          { path: "planner.preferMemoryOnFollowUp", value: true },
          { path: "prompts.contextFollowUpGuidance", value: "On follow-ups, reuse lastDocument / lastInvoice unless the user changes topic." },
        ],
      };
    case "silence":
    case "stuck":
      return {
        title: "Tighten silence / stuck thresholds and ack guidance",
        summary: "Lower silence detection and require a terminal fallback reply sooner.",
        kind: "threshold",
        patches: [
          { path: "thresholds.silenceMs", value: 20_000 },
          { path: "thresholds.stuckMs", value: 45_000 },
          { path: "prompts.systemNote", value: "Always send a short terminal reply. Never leave a recognised user without an answer." },
        ],
      };
    case "excessive_latency":
      return {
        title: "Lower WhatsApp latency warning thresholds",
        summary: "Flag and prefer cheaper paths sooner when turns exceed the UX budget.",
        kind: "threshold",
        patches: [
          { path: "thresholds.ackWarningMs", value: 2_000 },
          { path: "thresholds.slowTotalMs", value: 45_000 },
        ],
      };
    case "rephrase":
      return {
        title: "Strengthen first-answer completeness guidance",
        summary: "Prompt and ranking changes so the first reply answers the ask and offers a follow-up button.",
        kind: "prompt_tweak",
        patches: [
          { path: "prompts.systemNote", value: "Answer the user's ask in the first reply. Offer one follow-up action instead of a vague hedge." },
          { path: "ranking.preferFirstToolCorrect", value: true },
        ],
      };
    case "repeated_acks":
      return {
        title: "Reduce repeated acknowledgement behaviour",
        summary: "Skip extra progress acks when a final is already close.",
        kind: "guidance_behaviour",
        patches: [{ path: "thresholds.ackWarningMs", value: 2_500 }],
      };
    case "wrong_tool":
      return {
        title: "Skip tools on cheap conversational intents",
        summary: "Greetings, thanks, and help should not call company tools.",
        kind: "planner_config",
        patches: [
          { path: "planner.skipToolsOnCheapIntents", value: true },
          { path: "ranking.preferFirstToolCorrect", value: true },
        ],
      };
    case "permission_ux":
      return {
        title: "ENGINEERING CHANGE REQUIRED — permission policy review",
        summary: "Permission denials must stay report-only. Do not auto-weaken auth or grants.",
        kind: "engineering_change",
        patches: [],
      };
    case "voice_failure":
      return {
        title: "ENGINEERING CHANGE REQUIRED — voice transcription path",
        summary: "Voice download/transcription failures need a code or provider fix, not a prompt tweak.",
        kind: "engineering_change",
        patches: [],
      };
    case "connector_error":
      return {
        title: "ENGINEERING CHANGE REQUIRED — connector health",
        summary: "Connector/OAuth errors are not auto-applyable. Report only.",
        kind: "engineering_change",
        patches: [],
      };
    default:
      return null;
  }
}

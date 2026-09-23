import type { QualityRuntimeConfig } from "./types";
import { CADDINGTON_COMPANY_ID } from "./types";

export const DEFAULT_QUALITY_RUNTIME: QualityRuntimeConfig = {
  version: 0,
  prompts: {
    systemNote: "Answer from connected company systems. Stay concise and cite sources when asked.",
    sourceUrlGuidance:
      "When the user asks for a link or source, return a genuine provider https URL from connected systems. Never invent a Drive or SharePoint file URL.",
    noRawDumpGuidance: "Never paste raw JSON, tool payloads, or document dumps into WhatsApp.",
    contextFollowUpGuidance: "Reuse the last document, invoice, or entity unless the user changes topic.",
  },
  planner: {
    skipToolsOnCheapIntents: true,
    preferMemoryOnFollowUp: true,
    requireSourceUrlWhenAsked: true,
    blockWriteIntents: true,
  },
  responseRules: {
    maxChars: 700,
    maxEmojis: 2,
    stripRawJson: true,
    requireSourceUrlWhenAsked: true,
  },
  thresholds: {
    ackWarningMs: 3_000,
    silenceMs: 30_000,
    stuckMs: 60_000,
    slowTotalMs: 60_000,
  },
  ranking: {
    preferFirstToolCorrect: true,
  },
  suggestedActions: {
    preferOpenSource: true,
    maxButtons: 3,
  },
  guidance: {
    mentionGuidanceSource: true,
    searchIncludesGuidance: true,
  },
};

export function cloneRuntime(config: QualityRuntimeConfig = DEFAULT_QUALITY_RUNTIME): QualityRuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as QualityRuntimeConfig;
}

export function applyRuntimePatches(
  base: QualityRuntimeConfig,
  patches: Array<{ path: string; value: unknown }>,
): QualityRuntimeConfig {
  const next = cloneRuntime(base);
  for (const patch of patches) {
    setPath(next as unknown as Record<string, unknown>, patch.path, patch.value);
  }
  return next;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const existing = cursor[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function runtimeFingerprint(config: QualityRuntimeConfig): string {
  return JSON.stringify(config);
}

export function shouldUseCanaryRuntime(input: {
  companyId?: string | null;
  userId?: string | null;
  canaryPercent: number;
  canaryCompanyId?: string | null;
}): boolean {
  if (input.companyId && (input.canaryCompanyId ?? CADDINGTON_COMPANY_ID) === input.companyId) {
    return true;
  }
  const percent = Math.min(100, Math.max(0, Number(input.canaryPercent) || 0));
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const seed = `${input.companyId ?? ""}:${input.userId ?? ""}`;
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 100 < percent;
}

import { hasOpenAiApiKey } from "./openai-responses.js";
import type { BrainMode, IntelligenceEnv } from "./types.js";

export const EL_COMPANY_ID = "co_el";
export const OPENAI_BRAIN_DEFAULT_COMPANIES = [EL_COMPANY_ID] as const;

export type BrainDecision = {
  mode: BrainMode;
  enabled: boolean;
  useOpenAi: boolean;
  shadow: boolean;
  fallbackToCloudflare: boolean;
  companyId: string | null;
  reason: string;
};

export function parseBrainMode(value: unknown): BrainMode {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "openai_shadow" || raw === "openai_canary" || raw === "openai_primary") return raw;
  return "cloudflare";
}

export function openaiBrainAllowlist(env: IntelligenceEnv): string[] {
  const raw = String(env.OPENAI_BRAIN_COMPANY_IDS ?? "").trim();
  if (!raw) return [...OPENAI_BRAIN_DEFAULT_COMPANIES];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function resolveBrainPolicy(input: {
  env?: IntelligenceEnv | null;
  companyId?: string | null;
  channel?: string | null;
  canaryRoll?: number;
}): BrainDecision {
  const env = input.env ?? {};
  const companyId = String(input.companyId ?? "").trim() || null;
  const enabledFlag = /^(1|true|yes)$/i.test(String(env.OPENAI_BRAIN_ENABLED ?? "").trim());
  const configured = hasOpenAiApiKey(env);
  const allow = openaiBrainAllowlist(env);
  const requested = parseBrainMode(env.OPENAI_BRAIN_MODE);
  const elOnly = !companyId || allow.includes(companyId);

  if (!enabledFlag) {
    return deny(companyId, "flag_off");
  }
  if (!configured) {
    return deny(companyId, "missing_key");
  }
  if (!elOnly) {
    return deny(companyId, "tenant_not_allowlisted");
  }
  if (input.channel === "chatgpt" || input.channel === "mcp") {
    return deny(companyId, "chatgpt_stays_direct_tools");
  }
  if (requested === "cloudflare") {
    return deny(companyId, "mode_cloudflare");
  }
  if (requested === "openai_canary") {
    const roll = Number.isFinite(input.canaryRoll) ? Number(input.canaryRoll) : Math.random();
    const percent = Math.min(100, Math.max(0, Number(env.OPENAI_BRAIN_CANARY_PERCENT ?? 10)));
    if (roll * 100 >= percent) {
      return {
        mode: "openai_canary",
        enabled: true,
        useOpenAi: false,
        shadow: true,
        fallbackToCloudflare: true,
        companyId,
        reason: "canary_holdout",
      };
    }
  }
  return {
    mode: requested,
    enabled: true,
    useOpenAi: requested === "openai_primary" || requested === "openai_canary",
    shadow: requested === "openai_shadow" || requested === "openai_canary",
    fallbackToCloudflare: true,
    companyId,
    reason: requested,
  };
}

function deny(companyId: string | null, reason: string): BrainDecision {
  return {
    mode: "cloudflare",
    enabled: false,
    useOpenAi: false,
    shadow: false,
    fallbackToCloudflare: true,
    companyId,
    reason,
  };
}

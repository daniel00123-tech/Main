import { hasOpenAiApiKey } from "./openai-responses.js";
import type {
  BrainChannelRole,
  BrainMode,
  BrainProviderName,
  IntelligenceEnv,
} from "./types.js";

export const EL_COMPANY_ID = "co_el";
export const CADDINGTON_COMPANY_ID = "co_caddington";
export const HT_COMPANY_ID = "co_ht";
/** Empty by default so a new tenant is Cloudflare until explicitly promoted. */
export const OPENAI_BRAIN_DEFAULT_COMPANIES: readonly string[] = [];

export type BrainDecision = {
  mode: BrainMode;
  enabled: boolean;
  useOpenAi: boolean;
  shadow: boolean;
  fallbackToCloudflare: boolean;
  companyId: string | null;
  reason: string;
  role: BrainChannelRole;
  designatedBrain: BrainProviderName;
  userVisibleBrain: BrainProviderName;
};

export function classifyBrainChannelRole(channel?: string | null): BrainChannelRole {
  const raw = String(channel ?? "").trim().toLowerCase();
  if (raw === "portal" || raw === "portal_chat") return "pa";
  if (raw === "whatsapp") return "request";
  if (raw === "chatgpt" || raw === "mcp") return "chatbot";
  if (
    raw === "automation" ||
    raw === "email" ||
    raw === "daily_improvement" ||
    raw === "smoke" ||
    raw === "shadow_bench"
  ) {
    return "automation";
  }
  return "internal";
}

export function isPaOrRequestRole(role: BrainChannelRole): boolean {
  return role === "pa" || role === "request";
}

/** Unset defaults on: PA and WhatsApp requests use OpenAI as the user-visible brain. */
export function paRequestPrimaryEnabled(env?: IntelligenceEnv | null): boolean {
  const raw = String(env?.OPENAI_BRAIN_PA_REQUEST_PRIMARY ?? "true").trim();
  return !/^(0|false|no|off)$/i.test(raw);
}

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

/** Per-company mode map, e.g. "co_el=openai_shadow,co_future=cloudflare". */
export function openaiCompanyModeMap(env: IntelligenceEnv): Record<string, BrainMode> {
  const raw = String((env as IntelligenceEnv & { OPENAI_BRAIN_COMPANY_MODES?: string }).OPENAI_BRAIN_COMPANY_MODES ?? "").trim();
  if (!raw) return {};
  const out: Record<string, BrainMode> = {};
  for (const part of raw.split(",")) {
    const [id, mode] = part.split("=").map((item) => item.trim());
    if (id && mode) out[id] = parseBrainMode(mode);
  }
  return out;
}

export function resolveTenantReasoningMode(input: {
  env?: IntelligenceEnv | null;
  companyId?: string | null;
}): BrainMode {
  const env = input.env ?? {};
  const companyId = String(input.companyId ?? "").trim();
  if (!companyId) return "cloudflare";
  const mapped = openaiCompanyModeMap(env)[companyId];
  if (mapped) return mapped;
  const allow = openaiBrainAllowlist(env);
  if (!allow.includes(companyId)) return "cloudflare";
  return parseBrainMode(env.OPENAI_BRAIN_MODE);
}

export function resolveBrainPolicy(input: {
  env?: IntelligenceEnv | null;
  companyId?: string | null;
  channel?: string | null;
  canaryRoll?: number;
}): BrainDecision {
  const env = input.env ?? {};
  const companyId = String(input.companyId ?? "").trim() || null;
  const role = classifyBrainChannelRole(input.channel);
  const enabledFlag = /^(1|true|yes)$/i.test(String(env.OPENAI_BRAIN_ENABLED ?? "").trim());
  const configured = hasOpenAiApiKey(env);
  const requested = resolveTenantReasoningMode({ env, companyId });
  const allow = openaiBrainAllowlist(env);
  const promoted = Boolean(companyId && (allow.includes(companyId) || openaiCompanyModeMap(env)[companyId]));

  if (!enabledFlag) {
    return deny(companyId, "flag_off", role);
  }
  if (!configured) {
    return deny(companyId, "missing_key", role);
  }
  if (!promoted) {
    return deny(companyId, companyId ? "tenant_not_allowlisted" : "missing_company", role);
  }
  if (role === "chatbot") {
    return deny(companyId, "chatgpt_stays_direct_tools", role);
  }
  if (requested === "cloudflare") {
    return deny(companyId, "mode_cloudflare", role);
  }
  if (isPaOrRequestRole(role) && (requested === "openai_primary" || paRequestPrimaryEnabled(env))) {
    return {
      mode: requested,
      enabled: true,
      useOpenAi: true,
      shadow: false,
      fallbackToCloudflare: true,
      companyId,
      reason: requested === "openai_primary" ? "openai_primary" : "pa_request_openai_brain",
      role,
      designatedBrain: "openai",
      userVisibleBrain: "openai",
    };
  }
  if (role === "automation" || role === "internal") {
    return {
      mode: requested,
      enabled: true,
      useOpenAi: false,
      shadow: requested === "openai_shadow" || requested === "openai_canary" || requested === "openai_primary",
      fallbackToCloudflare: true,
      companyId,
      reason: role === "automation" ? "automation_stays_cloudflare" : "unscoped_stays_cloudflare",
      role,
      designatedBrain: "openai",
      userVisibleBrain: "cloudflare",
    };
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
        role,
        designatedBrain: "openai",
        userVisibleBrain: "cloudflare",
      };
    }
  }
  const useOpenAi = requested === "openai_primary" || requested === "openai_canary";
  return {
    mode: requested,
    enabled: true,
    useOpenAi,
    shadow: requested === "openai_shadow" || requested === "openai_canary",
    fallbackToCloudflare: true,
    companyId,
    reason: requested,
    role,
    designatedBrain: "openai",
    userVisibleBrain: useOpenAi ? "openai" : "cloudflare",
  };
}

function deny(companyId: string | null, reason: string, role: BrainChannelRole): BrainDecision {
  return {
    mode: "cloudflare",
    enabled: false,
    useOpenAi: false,
    shadow: false,
    fallbackToCloudflare: true,
    companyId,
    reason,
    role,
    designatedBrain: "cloudflare",
    userVisibleBrain: "cloudflare",
  };
}

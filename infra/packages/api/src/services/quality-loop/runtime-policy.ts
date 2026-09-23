import type { QualityRuntimeConfig } from "./types";

export const GENUINE_SOURCE_URL_GUIDANCE =
  "If the user asks for a link, URL, source, or download, include a genuine provider https URL from connected systems. Never invent a Google Drive or SharePoint file URL, including drive.google.com/file/d/{id}/view.";

export const COMPLETENESS_SYSTEM_NOTE =
  "Answer the user's ask in the first reply. Offer one follow-up action instead of a vague hedge.";

/** Quality warning thresholds only — never used to shorten the 60s customer progress/watchdog budget. */
export const QUALITY_WARNING_ACK_MS = 2_000;
export const QUALITY_WARNING_SLOW_TOTAL_MS = 45_000;
export const CUSTOMER_PROGRESS_BUDGET_MS = 60_000;

export function qualitySystemGuidance(runtime: QualityRuntimeConfig): string {
  return [
    runtime.prompts.systemNote,
    runtime.prompts.sourceUrlGuidance,
    runtime.prompts.noRawDumpGuidance,
    runtime.prompts.contextFollowUpGuidance,
  ]
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

export function isGenuineProviderHttpsUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const raw = url.trim();
  if (/drive\.google\.com\/file\/d\/(\{id\}|no-url-file)(?:\/|$)/i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "app.infrastack.app" || host === "localhost" || host === "127.0.0.1") return false;
    const path = decodeURIComponent(parsed.pathname);
    if (/\/file\/d\/\{id\}(?:\/|$)/i.test(path)) return false;
    if (/\/file\/d\/no-url-file(?:\/|$)/i.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

export function sanitiseSourceUrlForReply(url: string | null | undefined): string | null {
  return isGenuineProviderHttpsUrl(url) ? String(url).trim() : null;
}

export function applyPolicyToPatches(
  patches: Array<{ path: string; value: unknown }>,
): Array<{ path: string; value: unknown }> {
  return patches.map((patch) => {
    if (patch.path === "prompts.sourceUrlGuidance") {
      return { ...patch, value: GENUINE_SOURCE_URL_GUIDANCE };
    }
    if (patch.path === "thresholds.stuckMs" || patch.path === "thresholds.silenceMs") {
      // Customer progress/watchdog stays at the 60s budget. Quality warnings use other keys.
      return { ...patch, value: CUSTOMER_PROGRESS_BUDGET_MS };
    }
    return patch;
  });
}

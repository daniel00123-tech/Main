import { recordAuditEvent } from "./control-plane";
import {
  inspectTranscriptionProvider,
  isAllowedWhatsAppAudioMime,
  transcribeWhatsAppAudio,
  type TranscriptionResult,
} from "./whatsapp-transcribe";
import type { Env } from "../env";

export const PORTAL_VOICE_MAX_BYTES = 8 * 1024 * 1024;
export const PORTAL_VOICE_MAX_SECONDS = 180;
export const PORTAL_VOICE_PERMISSION_DENIED = "Microphone permission is needed for voice input.";

export function inspectPortalTranscriptionProvider(env: Env) {
  return inspectTranscriptionProvider(env);
}

export async function transcribePortalVoice(
  env: Env,
  input: {
    companyId: string;
    actor: string;
    bytes: Uint8Array;
    mimeType: string;
    filename?: string;
    durationSeconds?: number | null;
  },
): Promise<TranscriptionResult> {
  const result = await transcribeWhatsAppAudio(env, {
    bytes: input.bytes,
    mimeType: input.mimeType,
    filename: input.filename ?? "portal-voice.webm",
    durationSeconds: input.durationSeconds,
  });
  await recordAuditEvent(env.DB, {
    companyId: input.companyId,
    eventType: "portal.voice_transcribe",
    actor: input.actor,
    resourceType: "portal_chat",
    resourceId: input.companyId,
    detail: {
      ok: result.ok,
      provider: result.provider,
      model: result.ok ? result.model : result.model,
      inputBytes: result.inputBytes,
      durationSeconds: result.durationSeconds,
      customerChargeCents: 0,
    },
  }).catch(() => undefined);
  return result;
}

export function isAllowedPortalAudioMime(mime: string | null | undefined): boolean {
  return isAllowedWhatsAppAudioMime(mime);
}

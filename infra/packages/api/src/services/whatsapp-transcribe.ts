import type { Env } from "../env";

export const WHATSAPP_AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const WHATSAPP_AUDIO_MAX_SECONDS = 180;

const ALLOWED_AUDIO_MIME = /^(audio\/(ogg|opus|mpeg|mp4|aac|amr|mp3|wav|webm|x-wav|x-m4a)|application\/ogg)(;.*)?$/i;

export type TranscriptionSuccess = {
  ok: true;
  provider: string;
  model: string;
  durationSeconds: number | null;
  inputBytes: number;
  text: string;
  confidence: number | null;
  costBasis: "unknown" | "estimated";
  costCents: number | null;
};

export type TranscriptionFailure = {
  ok: false;
  provider: string | null;
  model: string | null;
  reason: "not_configured" | "unsupported" | "too_large" | "empty" | "low_confidence" | "provider_error";
  message: string;
  inputBytes: number;
  durationSeconds: number | null;
};

export type TranscriptionResult = TranscriptionSuccess | TranscriptionFailure;

export function isAllowedWhatsAppAudioMime(mime: string | null | undefined): boolean {
  return ALLOWED_AUDIO_MIME.test(String(mime ?? "").trim());
}

export function inspectTranscriptionProvider(env: Env): {
  provider: "workers-ai" | "openai" | null;
  model: string | null;
  configured: boolean;
} {
  if (env.AI) {
    return { provider: "workers-ai", model: "@cf/openai/whisper-tiny-en", configured: true };
  }
  if (String(env.OPENAI_API_KEY ?? "").trim().length >= 20) {
    return { provider: "openai", model: "whisper-1", configured: true };
  }
  return { provider: null, model: null, configured: false };
}

export async function transcribeWhatsAppAudio(
  env: Env,
  input: { bytes: Uint8Array; mimeType: string; filename?: string; durationSeconds?: number | null },
): Promise<TranscriptionResult> {
  const bytes = input.bytes;
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      provider: null,
      model: null,
      reason: "empty",
      message: "empty_audio",
      inputBytes: 0,
      durationSeconds: input.durationSeconds ?? null,
    };
  }
  if (bytes.byteLength > WHATSAPP_AUDIO_MAX_BYTES) {
    return {
      ok: false,
      provider: null,
      model: null,
      reason: "too_large",
      message: "audio_too_large",
      inputBytes: bytes.byteLength,
      durationSeconds: input.durationSeconds ?? null,
    };
  }
  if (input.durationSeconds != null && input.durationSeconds > WHATSAPP_AUDIO_MAX_SECONDS) {
    return {
      ok: false,
      provider: null,
      model: null,
      reason: "too_large",
      message: "audio_too_long",
      inputBytes: bytes.byteLength,
      durationSeconds: input.durationSeconds,
    };
  }
  if (!isAllowedWhatsAppAudioMime(input.mimeType)) {
    return {
      ok: false,
      provider: null,
      model: null,
      reason: "unsupported",
      message: "unsupported_mime",
      inputBytes: bytes.byteLength,
      durationSeconds: input.durationSeconds ?? null,
    };
  }

  const available = inspectTranscriptionProvider(env);
  if (!available.configured || !available.provider) {
    return {
      ok: false,
      provider: null,
      model: null,
      reason: "not_configured",
      message: "no_transcription_provider",
      inputBytes: bytes.byteLength,
      durationSeconds: input.durationSeconds ?? null,
    };
  }

  if (available.provider === "workers-ai") {
    return transcribeWithWorkersAi(env, bytes, input.mimeType, input.durationSeconds ?? null);
  }
  return transcribeWithOpenAi(env, bytes, input.mimeType, input.filename ?? "voice.ogg", input.durationSeconds ?? null);
}

async function transcribeWithWorkersAi(
  env: Env,
  bytes: Uint8Array,
  _mimeType: string,
  durationSeconds: number | null,
): Promise<TranscriptionResult> {
  const model = "@cf/openai/whisper-tiny-en";
  try {
    const ai = env.AI as {
      run(model: string, input: { audio: number[] }): Promise<{ text?: string; vtt?: string }>;
    };
    const result = await ai.run(model, { audio: Array.from(bytes) });
    const text = String(result?.text ?? "").trim();
    if (!text) {
      return {
        ok: false,
        provider: "workers-ai",
        model,
        reason: "empty",
        message: "empty_transcript",
        inputBytes: bytes.byteLength,
        durationSeconds,
      };
    }
    return {
      ok: true,
      provider: "workers-ai",
      model,
      durationSeconds,
      inputBytes: bytes.byteLength,
      text: text.slice(0, 4000),
      confidence: null,
      costBasis: "unknown",
      costCents: null,
    };
  } catch {
    return {
      ok: false,
      provider: "workers-ai",
      model,
      reason: "provider_error",
      message: "workers_ai_failed",
      inputBytes: bytes.byteLength,
      durationSeconds,
    };
  }
}

async function transcribeWithOpenAi(
  env: Env,
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  durationSeconds: number | null,
): Promise<TranscriptionResult> {
  const model = "whisper-1";
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  try {
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");
    form.set("file", new Blob([bytes], { type: mimeType.split(";")[0] }), filename);
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const raw = await response.text();
    let parsed: { text?: string } = {};
    try {
      parsed = JSON.parse(raw) as { text?: string };
    } catch {
      parsed = {};
    }
    const text = String(parsed.text ?? "").trim();
    if (!response.ok || !text) {
      return {
        ok: false,
        provider: "openai",
        model,
        reason: response.ok ? "empty" : "provider_error",
        message: "openai_whisper_failed",
        inputBytes: bytes.byteLength,
        durationSeconds,
      };
    }
    return {
      ok: true,
      provider: "openai",
      model,
      durationSeconds,
      inputBytes: bytes.byteLength,
      text: text.slice(0, 4000),
      confidence: null,
      costBasis: "unknown",
      costCents: null,
    };
  } catch {
    return {
      ok: false,
      provider: "openai",
      model,
      reason: "provider_error",
      message: "openai_whisper_failed",
      inputBytes: bytes.byteLength,
      durationSeconds,
    };
  }
}

import type { Env } from "../env";
import { whatsappAccessToken } from "./whatsapp-assets";
import { isAllowedWhatsAppAudioMime, WHATSAPP_AUDIO_MAX_BYTES } from "./whatsapp-transcribe";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export type WhatsAppMediaDownload =
  | { ok: true; bytes: Uint8Array; mimeType: string; bytesLength: number }
  | { ok: false; reason: "missing_id" | "meta_error" | "too_large" | "unsupported" | "empty" };

/**
 * Download WhatsApp media only via authenticated Meta Graph endpoints.
 * Never fetch user-supplied URLs.
 */
export async function downloadWhatsAppMedia(
  env: Env,
  mediaId: string | null | undefined,
): Promise<WhatsAppMediaDownload> {
  const id = String(mediaId ?? "").trim();
  if (!id || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) {
    return { ok: false, reason: "missing_id" };
  }
  const token = whatsappAccessToken(env);
  if (!token) return { ok: false, reason: "meta_error" };

  try {
    const meta = await fetch(`${GRAPH_BASE}/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = (await meta.json().catch(() => ({}))) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (!meta.ok || !info.url || !/^https:\/\//i.test(info.url)) {
      return { ok: false, reason: "meta_error" };
    }
    const mime = String(info.mime_type ?? "audio/ogg");
    if (!isAllowedWhatsAppAudioMime(mime)) return { ok: false, reason: "unsupported" };
    if (Number(info.file_size ?? 0) > WHATSAPP_AUDIO_MAX_BYTES) return { ok: false, reason: "too_large" };

    const file = await fetch(info.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!file.ok) return { ok: false, reason: "meta_error" };
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer.byteLength === 0) return { ok: false, reason: "empty" };
    if (buffer.byteLength > WHATSAPP_AUDIO_MAX_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, bytes: buffer, mimeType: mime, bytesLength: buffer.byteLength };
  } catch {
    return { ok: false, reason: "meta_error" };
  }
}

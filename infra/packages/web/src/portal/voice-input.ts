export type VoiceComposerState =
  | "idle"
  | "listening"
  | "processing"
  | "completed"
  | "permission_denied"
  | "unsupported"
  | "error";

export const VOICE_PERMISSION_DENIED = "Microphone permission is needed for voice input.";
export const VOICE_UNSUPPORTED = "Voice input is not supported in this browser.";
export const VOICE_TRANSCRIBE_FAILED = "Voice transcription failed. You can still type your message.";

export function voiceStatusMessage(state: VoiceComposerState): string | null {
  switch (state) {
    case "listening":
      return "Listening… tap to stop";
    case "processing":
      return "Transcribing…";
    case "completed":
      return "Transcript ready to edit";
    case "permission_denied":
      return VOICE_PERMISSION_DENIED;
    case "unsupported":
      return VOICE_UNSUPPORTED;
    case "error":
      return VOICE_TRANSCRIBE_FAILED;
    default:
      return null;
  }
}

export function shouldAutoSendAfterTranscript(): false {
  return false;
}

export function mergeTranscript(existing: string, transcript: string): string {
  const current = existing.replace(/\s+$/g, "");
  const next = String(transcript ?? "").trim();
  if (!next) return existing;
  if (!current) return next;
  return `${current} ${next}`;
}

export function composerVoiceBusy(state: VoiceComposerState): boolean {
  return state === "listening" || state === "processing";
}

export function canStartVoice(state: VoiceComposerState): boolean {
  return state === "idle" || state === "completed" || state === "error" || state === "permission_denied";
}

export function voiceButtonLabel(state: VoiceComposerState): string {
  if (state === "listening") return "Stop recording";
  if (state === "processing") return "Transcribing";
  return "Start voice input";
}

export function browserVoiceSupported(input?: {
  mediaDevices?: boolean;
  mediaRecorder?: boolean;
}): boolean {
  return Boolean(input?.mediaDevices && input?.mediaRecorder);
}

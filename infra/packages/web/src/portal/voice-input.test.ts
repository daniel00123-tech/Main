import { describe, expect, it } from "vitest";
import {
  VOICE_PERMISSION_DENIED,
  browserVoiceSupported,
  canStartVoice,
  composerVoiceBusy,
  mergeTranscript,
  shouldAutoSendAfterTranscript,
  voiceButtonLabel,
  voiceStatusMessage,
} from "./voice-input";

describe("portal voice input", () => {
  it("never auto-sends after transcription and keeps text editable", () => {
    expect(shouldAutoSendAfterTranscript()).toBe(false);
    expect(mergeTranscript("", "What are sales this month?")).toBe("What are sales this month?");
    expect(mergeTranscript("Please check", "sales this month")).toBe("Please check sales this month");
  });

  it("exposes listening, processing, cancel-ready, and permission-denied states", () => {
    expect(voiceStatusMessage("listening")).toMatch(/Listening/);
    expect(voiceStatusMessage("processing")).toMatch(/Transcribing/);
    expect(voiceStatusMessage("permission_denied")).toBe(VOICE_PERMISSION_DENIED);
    expect(canStartVoice("idle")).toBe(true);
    expect(canStartVoice("listening")).toBe(false);
    expect(composerVoiceBusy("listening")).toBe(true);
    expect(composerVoiceBusy("idle")).toBe(false);
    expect(voiceButtonLabel("listening")).toMatch(/Stop/);
  });

  it("requires both getUserMedia and MediaRecorder", () => {
    expect(browserVoiceSupported({ mediaDevices: true, mediaRecorder: true })).toBe(true);
    expect(browserVoiceSupported({ mediaDevices: true, mediaRecorder: false })).toBe(false);
  });
});

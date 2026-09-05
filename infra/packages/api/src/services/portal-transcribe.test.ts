import { describe, expect, it } from "vitest";
import { isAllowedPortalAudioMime, PORTAL_VOICE_PERMISSION_DENIED } from "./portal-transcribe";

describe("portal voice transcription", () => {
  it("accepts short browser recordings and keeps the typed-chat permission copy", () => {
    expect(isAllowedPortalAudioMime("audio/webm")).toBe(true);
    expect(isAllowedPortalAudioMime("audio/ogg; codecs=opus")).toBe(true);
    expect(isAllowedPortalAudioMime("video/mp4")).toBe(false);
    expect(PORTAL_VOICE_PERMISSION_DENIED).toBe("Microphone permission is needed for voice input.");
  });
});

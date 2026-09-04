/** Customer-facing WhatsApp tone. Not sent proactively. */

export const VOICE_ACK = "Got your voice note — I’m just listening to it.";
export const VOICE_HEARD_LABEL = "This is what I heard you say:";
export const WHATSAPP_TEXT_CHAR_LIMIT = 4000;
export const VOICE_UNCLEAR =
  "I couldn’t clearly understand that voice note. Could you send it again, or type the request?";
export const VOICE_EMPTY =
  "I listened to your voice note, but I couldn’t hear any words. Could you send it again, or type the request?";
export const VOICE_UPSTREAM =
  "I received your voice note, but I couldn’t listen to it just now. Could you send it again, or type the request?";
export const VOICE_NOT_CONFIGURED =
  "I received your voice note, but I can’t transcribe audio on this environment yet. Please type the request for now.";
export const UNSUPPORTED_BUTTON =
  "I didn’t recognise that option. Try typing what you need and I’ll look it up.";

export function voiceFailureReply(reason: string | null | undefined): string {
  switch (reason) {
    case "not_configured":
      return VOICE_NOT_CONFIGURED;
    case "empty":
    case "low_confidence":
      return VOICE_EMPTY;
    case "too_large":
      return "That voice note was a bit too long for me to listen to. Could you send a shorter one, or type the request?";
    case "unsupported":
      return "I received your voice note, but I couldn’t listen to that audio format. Could you send it again, or type the request?";
    default:
      return VOICE_UPSTREAM;
  }
}

/** Customer-visible transcript echo. Uses only the real STT words — never invents text. */
export function voiceTranscriptEcho(transcript: string): {
  body: string;
  truncated: boolean;
  heardText: string;
} {
  const heardText = String(transcript ?? "").trim();
  const prefix = `${VOICE_HEARD_LABEL}\n\n`;
  const note = "\n\n(truncated)";
  const maxHeard = WHATSAPP_TEXT_CHAR_LIMIT - prefix.length;
  if (heardText.length <= maxHeard) {
    return { body: `${prefix}${heardText}`, truncated: false, heardText };
  }
  const keep = Math.max(0, maxHeard - note.length);
  const clipped = heardText.slice(0, keep);
  return { body: `${prefix}${clipped}${note}`, truncated: true, heardText: clipped };
}

export const ACK_VARIANTS_V4 = [
  "Got it 👍 I’m checking now.",
  "No problem — I’m looking into that.",
  "Thanks — I’ll check that for you.",
  "Understood. Let me look into it.",
] as const;

export function welcomeFoundationReply(firstName?: string | null): string {
  const name = firstName?.trim() ? ` ${firstName.trim()}` : "";
  return [
    `Hi${name} 👋 I’m Infra, your business AI assistant.`,
    "You can message me normally or send me a voice note.",
    "I can search the business systems you have access to and help you find information quickly.",
  ].join("\n");
}

export function countEmojis(text: string): number {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches?.length ?? 0;
}

export function clampEmojis(text: string, max = 2): string {
  if (countEmojis(text) <= max) return text;
  let kept = 0;
  return text.replace(/\p{Extended_Pictographic}/gu, (emoji) => {
    kept += 1;
    return kept <= max ? emoji : "";
  }).replace(/[ \t]{2,}/g, " ");
}

export function applyCustomerTone(
  text: string,
  options?: { restrained?: boolean; maxEmojis?: number },
): string {
  const max = options?.restrained ? 0 : options?.maxEmojis ?? 2;
  let next = String(text ?? "").trim();
  next = next.replace(/\b(REQUEST ACCEPTED|Executing MCP|Database lookup initiated|wamid|jsessionid)\b/gi, "");
  next = next.replace(/\n{3,}/g, "\n\n");
  return clampEmojis(next, max).trim();
}

export function documentResultCopy(input: {
  title: string;
  relates: string;
  amount?: string | null;
  reference?: string | null;
  askSummarise?: boolean;
}): string {
  const facts: string[] = [];
  if (input.amount) facts.push(`• Amount: ${input.amount}`);
  if (input.reference) facts.push(`• Reference: ${input.reference}`);
  return [
    `I found ${input.title} 📄`,
    input.relates,
    facts.length ? facts.join("\n") : null,
    input.askSummarise === false ? null : "Would you like me to summarise it?",
  ]
    .filter(Boolean)
    .join("\n");
}

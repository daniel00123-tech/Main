import type { WhatsAppIntent } from "./whatsapp-intent";

/** Future engagement campaigns stay off. Do not send unsolicited WhatsApp. */
export const WHATSAPP_ENGAGEMENT_DISABLED = true;

const GREETING_REPLIES = [
  "Hi — I’m Infra. What can I help you with today?",
  "Hello — I’m Infra. What do you need?",
  "Hi. What can I help you with?",
];

const THANKS_REPLIES = [
  "You’re welcome. Anything else I can look up?",
  "No problem. What else can I help with?",
];

const CASUAL_REPLIES = [
  "I’m good, thanks. What can I help you with today?",
  "Doing well — what would you like me to look into?",
];

export function pickVariant(seed: string, options: string[]): string {
  let hash = 0;
  for (const char of seed) hash = (hash + char.charCodeAt(0)) % 2147483647;
  return options[Math.abs(hash) % options.length]!;
}

export function conversationalReply(
  intent: WhatsAppIntent,
  input: { text: string; capabilities?: string | null },
): string | null {
  if (intent === "greeting") return pickVariant(input.text || "hi", GREETING_REPLIES);
  if (intent === "thanks") return pickVariant(input.text || "thanks", THANKS_REPLIES);
  if (intent === "casual") return pickVariant(input.text || "how", CASUAL_REPLIES);
  if (intent === "unsupported" && /\b(i don'?t understand|what did you mean|explain)\b/i.test(input.text)) {
    return "Happy to explain. Which part should I make simpler — the last answer, or a specific document?";
  }
  if (intent === "help" || intent === "capabilities") {
    if (/\b(price|pricing|quote|rates?)\b/i.test(input.text) && input.capabilities) {
      return input.capabilities;
    }
    return (
      input.capabilities ??
      "I can search the business systems you’re authorised to use, including connected emails, documents, finance and operational systems. I can help find information, summarise documents, check business data, and assist with supported tasks. Tell me what you want to know and I’ll work out where to look."
    );
  }
  return null;
}

export const ACK_VARIANTS = [
  "Got it — I’m checking that now.",
  "Thanks — I’m looking into that for you.",
  "Understood — I’m checking your connected systems now.",
];

export const PROGRESS_VARIANTS = [
  "I’ve found the right area — I’m still pulling the details together.",
];

export const DELAY_NOTICE_MESSAGE =
  "This is taking longer than usual, but I’m still working on it.";

export const STILL_WORKING_MESSAGE = DELAY_NOTICE_MESSAGE;

export function acknowledgementMessage(seed: string): string {
  return pickVariant(seed, ACK_VARIANTS);
}

export function progressMessage(seed: string): string {
  return pickVariant(seed, PROGRESS_VARIANTS);
}

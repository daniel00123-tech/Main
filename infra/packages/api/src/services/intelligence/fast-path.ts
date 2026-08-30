/**
 * Ultra-fast local replies only. Greetings, thanks, and simple channel help.
 * Anything else goes to the LLM orchestrator — do not add business phrase rules here.
 */
const GREETING = /^(hi|hello|hey|yo|hiya|morning|afternoon|evening|good morning|good afternoon|good evening)\b[.!? ]*$/i;
const THANKS = /^(thanks|thank you|cheers|ta|thx|ty)\b[.! ]*$/i;
const HELP = /^(help|what can you do|what can i ask)\b[.!? ]*$/i;

export function matchFastPath(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (GREETING.test(trimmed)) {
    return "Hi — what do you need?";
  }
  if (THANKS.test(trimmed)) {
    return "You're welcome.";
  }
  if (HELP.test(trimmed)) {
    return "Ask about a company document, invoice, or policy in your own words. I will look it up and answer from the evidence.";
  }
  return null;
}

export function isFastPathTurn(text: string): boolean {
  return matchFastPath(text) !== null;
}

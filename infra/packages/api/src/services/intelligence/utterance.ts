/**
 * Lightweight preprocessing only. Intent still comes from the classifier.
 */
const LIGHT_TYPOS: Array<[RegExp, string]> = [
  [/\bwhats\b/gi, "what's"],
  [/\bemials\b/gi, "emails"],
  [/\bemaills\b/gi, "emails"],
  [/\bmnth\b/gi, "month"],
  [/\bwats\b/gi, "what's"],
];

export function normaliseUserUtterance(text: string): string {
  let next = text.replace(/\s+/g, " ").trim();
  for (const [pattern, replacement] of LIGHT_TYPOS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

export function isArithmeticAsk(text: string): boolean {
  return /^\s*(?:what(?:'s| is)\s+)?(-?\d+)\s*([+\-*/x×])\s*(-?\d+)\s*[?.!]?\s*$/i.test(text);
}

export function answerArithmetic(text: string): string | null {
  const match = text.match(/(-?\d+)\s*([+\-*/x×])\s*(-?\d+)/);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const op = match[2];
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  let value: number;
  if (op === "+") value = left + right;
  else if (op === "-") value = left - right;
  else if (op === "*" || op === "x" || op === "×") value = left * right;
  else if (op === "/") value = right === 0 ? Number.NaN : left / right;
  else return null;
  if (!Number.isFinite(value)) return "I can’t divide by zero.";
  return String(value);
}

export function isWritingOrBrainstormAsk(text: string): boolean {
  return /\b(help me (write|draft|word|rephrase)|brainstorm|rewrite this|make this (sound|more))\b/i.test(text);
}

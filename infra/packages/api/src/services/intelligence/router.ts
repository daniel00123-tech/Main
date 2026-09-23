import { matchFastPath, matchOpenSourceFastPath } from "./fast-path.js";
import type { IntelligenceConversationState, IntelligenceRoute } from "./types.js";

const WRITE_INTENT =
  /\b(create (an? )?(invoice|bill|credit)|approve |send(?: this| the)? invoice|delete |void |allocate |raise an invoice|write to|update (the )?(invoice|bill|contact)|credit note)\b/i;

export function routeIntelligenceTurn(input: {
  text: string;
  state: IntelligenceConversationState;
  buttonHint?: string | null;
}): { route: IntelligenceRoute; localText?: string } {
  if (input.buttonHint === "open_source" || matchOpenSourceFastPath(input.text)) {
    const url = input.state.currentDocument?.url;
    if (url && /^https?:\/\//i.test(url)) {
      return { route: "FAST_LOCAL", localText: url };
    }
  }
  const fast = matchFastPath(input.text);
  if (fast && !input.buttonHint) {
    return { route: "FAST_LOCAL", localText: fast };
  }
  if (WRITE_INTENT.test(input.text)) {
    return { route: "CONTROLLED_ACTION" };
  }
  return { route: "INTELLIGENT" };
}

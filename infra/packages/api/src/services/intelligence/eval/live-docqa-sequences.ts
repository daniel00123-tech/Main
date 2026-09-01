/**
 * Conversational document Q&A sequences.
 * Same 9-turn shape on every tenant. Only {primary}/{alt} are adapted.
 * No invented expected facts — score structure (id persist, not NO_RESULTS, switch, return).
 */
import type { TenantSubjectAdapter } from "./adversarial-scenarios.js";

export type LiveDocQaTurnKind =
  | "search"
  | "direct_qa"
  | "short_followup"
  | "more_detail"
  | "source"
  | "unrelated"
  | "search_other"
  | "switch"
  | "return_previous";

export type LiveDocQaSequence = {
  id: string;
  search: string;
  directQa: string;
  shortFollowUp: string;
  moreDetail: string;
  source: string;
  unrelated: string;
  searchOther: string;
  switchTo: string;
  returnPrevious: string;
};

const SEQUENCES: Array<Omit<LiveDocQaSequence, "id">> = [
  {
    search: "Find the {primary}",
    directQa: "What are the main points?",
    shortFollowUp: "What exactly?",
    moreDetail: "More detail",
    source: "What's the source URL?",
    unrelated: "How many documents are indexed?",
    searchOther: "Search other documents",
    switchTo: "Open the {alt}",
    returnPrevious: "Go back to the previous document",
  },
  {
    search: "Look up the {primary}",
    directQa: "Summarise it",
    shortFollowUp: "When?",
    moreDetail: "Tell me more",
    source: "Send me the link",
    unrelated: "What can you do?",
    searchOther: "Search other docs",
    switchTo: "Switch to the {alt}",
    returnPrevious: "Return to the last file",
  },
  {
    search: "Pull up {primary}",
    directQa: "What does it say?",
    shortFollowUp: "More?",
    moreDetail: "More details",
    source: "Where did you get that from?",
    unrelated: "Thanks",
    searchOther: "Look in other documents",
    switchTo: "Find the {alt}",
    returnPrevious: "The previous one please",
  },
  {
    search: "Have we got the {primary}",
    directQa: "What does it cover?",
    shortFollowUp: "When was that?",
    moreDetail: "Go on",
    source: "Open the source",
    unrelated: "Who are you?",
    searchOther: "Search everywhere else",
    switchTo: "Show me the {alt}",
    returnPrevious: "Back to the {primary}",
  },
  {
    search: "Search for {primary}",
    directQa: "Give me the key points",
    shortFollowUp: "Who?",
    moreDetail: "More",
    source: "What's the URL?",
    unrelated: "Hi",
    searchOther: "Search other files",
    switchTo: "Open {alt}",
    returnPrevious: "Go back to that first file",
  },
  {
    search: "Can you find {primary}",
    directQa: "What's in this document?",
    shortFollowUp: "What about that?",
    moreDetail: "More detail please",
    source: "Source link",
    unrelated: "What systems are connected?",
    searchOther: "Try other documents",
    switchTo: "Look up the {alt}",
    returnPrevious: "Return to the previous document",
  },
  {
    search: "Find {primary} please",
    directQa: "What are the main rules?",
    shortFollowUp: "What exactly?",
    moreDetail: "Tell me more",
    source: "Send the source URL",
    unrelated: "Remind me what we were talking about",
    searchOther: "Search other documents",
    switchTo: "Switch to {alt}",
    returnPrevious: "The last document again",
  },
  {
    search: "Look for the {primary}",
    directQa: "Summarise the file",
    shortFollowUp: "When?",
    moreDetail: "More detail",
    source: "Where did that come from?",
    unrelated: "That's useful",
    searchOther: "Search other docs",
    switchTo: "Find {alt} instead",
    returnPrevious: "Go back to the previous one",
  },
  {
    search: "Open the {primary} if we have it",
    directQa: "What does it mention?",
    shortFollowUp: "More?",
    moreDetail: "And more detail",
    source: "The link please",
    unrelated: "How many files are indexed?",
    searchOther: "Look across other documents",
    switchTo: "Open the {alt} now",
    returnPrevious: "Return to {primary}",
  },
  {
    search: "Search the library for {primary}",
    directQa: "What's the gist?",
    shortFollowUp: "What exactly?",
    moreDetail: "More details",
    source: "Source URL",
    unrelated: "What can I ask?",
    searchOther: "Search other documents",
    switchTo: "Pull up the {alt}",
    returnPrevious: "Previous document",
  },
  {
    search: "Find me the {primary}",
    directQa: "What should I know from it?",
    shortFollowUp: "When was that?",
    moreDetail: "Tell me more",
    source: "Open the source link",
    unrelated: "Cheers",
    searchOther: "Search other files",
    switchTo: "Go to the {alt}",
    returnPrevious: "Back to the last file",
  },
  {
    search: "Could you find {primary}",
    directQa: "Main points please",
    shortFollowUp: "Who was that?",
    moreDetail: "More",
    source: "What's the source?",
    unrelated: "Hello",
    searchOther: "Search other documents",
    switchTo: "Find the {alt} document",
    returnPrevious: "Go back to the previous document",
  },
  {
    search: "Where is the {primary}",
    directQa: "What does this file say?",
    shortFollowUp: "What about it?",
    moreDetail: "More detail",
    source: "Send me the URL",
    unrelated: "What information can you access?",
    searchOther: "Search other docs",
    switchTo: "Open {alt} please",
    returnPrevious: "Return to the first one",
  },
  {
    search: "Pull up the {primary} file",
    directQa: "Summarise this",
    shortFollowUp: "Exactly?",
    moreDetail: "More details please",
    source: "Where did you get that?",
    unrelated: "How are you?",
    searchOther: "Look in other documents",
    switchTo: "Switch to the {alt} file",
    returnPrevious: "The previous document again",
  },
  {
    search: "Search {primary}",
    directQa: "What are the important bits?",
    shortFollowUp: "When?",
    moreDetail: "Go on",
    source: "The source URL",
    unrelated: "How many documents do we have?",
    searchOther: "Search other documents",
    switchTo: "Show the {alt}",
    returnPrevious: "Go back",
  },
  {
    search: "Have you got {primary}",
    directQa: "Tell me what it says",
    shortFollowUp: "More?",
    moreDetail: "More detail",
    source: "Link please",
    unrelated: "Thanks for that",
    searchOther: "Search other docs",
    switchTo: "Find the {alt} instead",
    returnPrevious: "Return to previous",
  },
  {
    search: "Look up {primary} for me",
    directQa: "What's covered?",
    shortFollowUp: "What exactly?",
    moreDetail: "Tell me more",
    source: "Open source",
    unrelated: "What systems are linked?",
    searchOther: "Try other documents",
    switchTo: "Open the {alt}",
    returnPrevious: "Back to {primary}",
  },
  {
    search: "Find that {primary}",
    directQa: "Key takeaways?",
    shortFollowUp: "When was that?",
    moreDetail: "More",
    source: "What's the link?",
    unrelated: "Remind me",
    searchOther: "Search other documents",
    switchTo: "Look for the {alt}",
    returnPrevious: "Previous file please",
  },
  {
    search: "Can you pull up {primary}",
    directQa: "What does it include?",
    shortFollowUp: "Who?",
    moreDetail: "More detail",
    source: "Send the URL",
    unrelated: "Hi there",
    searchOther: "Search other files",
    switchTo: "Switch to {alt}",
    returnPrevious: "Go back to the previous document",
  },
  {
    search: "Get the {primary}",
    directQa: "Walk me through it",
    shortFollowUp: "What exactly?",
    moreDetail: "More details",
    source: "Source please",
    unrelated: "What can you help with?",
    searchOther: "Search other documents",
    switchTo: "Open the {alt} instead",
    returnPrevious: "Return to the last document",
  },
];

export function instantiateLiveDocQaSequences(adapter: TenantSubjectAdapter): LiveDocQaSequence[] {
  return SEQUENCES.map((row, index) => ({
    id: `docqa-${adapter.tenant}-${String(index + 1).padStart(2, "0")}`,
    search: apply(row.search, adapter),
    directQa: apply(row.directQa, adapter),
    shortFollowUp: apply(row.shortFollowUp, adapter),
    moreDetail: apply(row.moreDetail, adapter),
    source: apply(row.source, adapter),
    unrelated: apply(row.unrelated, adapter),
    searchOther: apply(row.searchOther, adapter),
    switchTo: apply(row.switchTo, adapter),
    returnPrevious: apply(row.returnPrevious, adapter),
  }));
}

export function sequenceTurns(sequence: LiveDocQaSequence): Array<{ kind: LiveDocQaTurnKind; text: string }> {
  return [
    { kind: "search", text: sequence.search },
    { kind: "direct_qa", text: sequence.directQa },
    { kind: "short_followup", text: sequence.shortFollowUp },
    { kind: "more_detail", text: sequence.moreDetail },
    { kind: "source", text: sequence.source },
    { kind: "unrelated", text: sequence.unrelated },
    { kind: "search_other", text: sequence.searchOther },
    { kind: "switch", text: sequence.switchTo },
    { kind: "return_previous", text: sequence.returnPrevious },
  ];
}

function apply(template: string, adapter: TenantSubjectAdapter): string {
  return template.replaceAll("{primary}", adapter.primary).replaceAll("{alt}", adapter.alt);
}

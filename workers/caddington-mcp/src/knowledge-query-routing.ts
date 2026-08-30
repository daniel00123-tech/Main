import type { ParsedQuery } from "./knowledge-query";

export interface QueryRouting {
  topics: string[];
  intents: string[];
  boostTerms: string[];
  likelyCategories: string[];
  asksHistorical: boolean;
}

const INTENT_PATTERNS: Array<{
  pattern: RegExp;
  intent: string;
  topics: string[];
  boost: string[];
  categories: string[];
}> = [
  {
    pattern: /\b(holiday|holidays|annual leave|time off|vacation|sick leave)\b/i,
    intent: "employment_contract",
    topics: ["employment", "hr"],
    boost: ["employment", "contract", "annual leave", "holiday", "leave"],
    categories: ["hr", "employment", "policy"],
  },
  {
    pattern: /\b(price|pricing|quote|quotation|cost|margin|gp|gross profit|rate)\b/i,
    intent: "pricing",
    topics: ["pricing", "finance"],
    boost: ["pricing", "price", "quotation", "quote", "margin", "cost"],
    categories: ["pricing", "finance", "quotation"],
  },
  {
    pattern: /\b(boiler|heating|plumb|installation)\b/i,
    intent: "installation_procedure",
    topics: ["heating", "boiler"],
    boost: ["boiler", "installation", "heating", "plumbing", "quote"],
    categories: ["technical", "pricing", "procedure"],
  },
  {
    pattern: /\b(policy|policies|procedure|approval|approve)\b/i,
    intent: "policy",
    topics: ["policy"],
    boost: ["policy", "approval", "procedure", "guidance"],
    categories: ["policy", "finance", "operations"],
  },
  {
    pattern: /\b(survey|roof|property|building|inspection)\b/i,
    intent: "property_survey",
    topics: ["property", "survey"],
    boost: ["survey", "property", "roof", "building", "inspection"],
    categories: ["survey", "property"],
  },
  {
    pattern: /\b(invoice|supplier|subcontractor|contractor|payment)\b/i,
    intent: "supplier_finance",
    topics: ["finance", "suppliers"],
    boost: ["invoice", "supplier", "payment", "approval", "subcontractor"],
    categories: ["finance", "accounts"],
  },
  {
    pattern: /\b(bonus|bonuses|staff|employee|employment)\b/i,
    intent: "hr_compensation",
    topics: ["employment", "hr"],
    boost: ["bonus", "staff", "employee", "compensation", "agreement"],
    categories: ["hr", "employment"],
  },
];

export function routeSearchQuery(parsed: ParsedQuery): QueryRouting {
  const lower = parsed.normalized.toLowerCase();
  const topics = new Set<string>();
  const intents = new Set<string>();
  const boostTerms = new Set<string>(parsed.terms);
  const likelyCategories = new Set<string>();

  for (const entry of INTENT_PATTERNS) {
    if (entry.pattern.test(lower)) {
      intents.add(entry.intent);
      for (const t of entry.topics) topics.add(t);
      for (const b of entry.boost) boostTerms.add(b);
      for (const c of entry.categories) likelyCategories.add(c);
    }
  }

  for (const phrase of parsed.phrases) {
    for (const word of phrase.split(/\s+/)) {
      if (word.length >= 4) boostTerms.add(word.toLowerCase());
    }
  }

  const asksHistorical =
    /\b(previous|previously|historical|old version|past|was agreed|used to)\b/i.test(
      lower
    ) || parsed.dates.length > 0;

  return {
    topics: [...topics],
    intents: [...intents],
    boostTerms: [...boostTerms],
    likelyCategories: [...likelyCategories],
    asksHistorical,
  };
}

import type { IntelligenceToolCall, IntelligenceToolResult } from "./types.js";

const PRIVATE_SYSTEM =
  /\b(xero|outlook|sharepoint|onedrive|our (sales|customers|staff|invoices|inbox)|holiday entitlement|purchase order process|vehicle (use )?policy|staff profile|company knowledge)\b/i;
const PUBLIC_WEB =
  /\b(weather|forecast|temperature in|news (today|headline)|who is the (prime minister|president)|what time is it in|public holiday in|exchange rate|wikipedia)\b/i;

export function isPrivateBusinessWebQuery(query: string): boolean {
  return PRIVATE_SYSTEM.test(String(query ?? ""));
}

export function looksLikePublicWebAsk(text: string): boolean {
  const raw = String(text ?? "");
  if (isPrivateBusinessWebQuery(raw)) return false;
  if (PUBLIC_WEB.test(raw)) return true;
  return /\bhttps?:\/\//i.test(raw) && /\b(what('s| is) on|summarise|summarize)\b/i.test(raw);
}

export function sanitisePublicWebQuery(text: string): string {
  return String(text ?? "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/\bINV-\d+\b/gi, "")
    .replace(/["“”][^"“”]{80,}["“”]/g, "")
    .replace(/\b(confidential|internal only|do not circulate)\b/gi, "")
    .replace(/\b(xero|outlook|sharepoint|onedrive|company knowledge|holiday entitlement)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function webSearchQuery(text: string): string {
  return sanitisePublicWebQuery(text);
}

export function verbaliseWebSearch(data: unknown, question: string): string {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const heading = typeof record.heading === "string" ? record.heading.trim() : "";
  const abstract = typeof record.abstract === "string" ? record.abstract.trim() : "";
  const results = Array.isArray(record.results) ? record.results : [];
  const first = results.find((row) => row && typeof row === "object") as { title?: string; snippet?: string } | undefined;
  if (abstract) {
    return heading ? `${heading}: ${abstract}` : abstract;
  }
  if (first?.snippet) {
    return first.title ? `${first.title}: ${first.snippet}` : first.snippet;
  }
  if (/\bweather\b/i.test(question)) {
    return "I can look up public weather, but I didn’t get a usable public forecast just now.";
  }
  return "I checked public web sources and didn’t find a clear answer. I won’t use company systems for this.";
}

export async function executePublicWebSearch(call: IntelligenceToolCall): Promise<IntelligenceToolResult> {
  const started = Date.now();
  const query = webSearchQuery(String(call.arguments.query ?? call.arguments.q ?? ""));
  if (!query) {
    return { name: "web_search", ok: false, latencyMs: Date.now() - started, data: null, error: "query_required" };
  }
  if (isPrivateBusinessWebQuery(query)) {
    return {
      name: "web_search",
      ok: false,
      latencyMs: Date.now() - started,
      data: { error: "private_systems_outrank_public_web" },
      error: "private_systems_outrank_public_web",
    };
  }
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return {
        name: "web_search",
        ok: false,
        latencyMs: Date.now() - started,
        data: { status: response.status },
        error: response.status >= 500 ? "timeout" : "tool_failed",
      };
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const related = Array.isArray(raw.RelatedTopics) ? raw.RelatedTopics : [];
    const results = related
      .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : null))
      .filter((row): row is Record<string, unknown> => Boolean(row && (row.Text || row.FirstURL)))
      .slice(0, 5)
      .map((row) => ({
        title: String(row.Text ?? "").split(" - ")[0] ?? "",
        snippet: String(row.Text ?? "").slice(0, 240),
        url: typeof row.FirstURL === "string" ? row.FirstURL : null,
      }));
    let heading = typeof raw.Heading === "string" ? raw.Heading : "";
    let abstract = typeof raw.AbstractText === "string" ? raw.AbstractText : "";
    const citations = results.map((row) => row.url).filter(Boolean);
    if (/\b(weather|forecast|temperature)\b/i.test(query) && !abstract) {
      const weather = await fetchPublicWeather(query);
      if (weather) {
        heading = heading || weather.heading;
        abstract = weather.abstract;
        if (weather.url) citations.unshift(weather.url);
      }
    }
    return {
      name: "web_search",
      ok: true,
      latencyMs: Date.now() - started,
      data: {
        source: "public_web",
        external: true,
        query,
        heading,
        abstract,
        results,
        citations: [...new Set(citations)],
      },
    };
  } catch {
    return {
      name: "web_search",
      ok: false,
      latencyMs: Date.now() - started,
      data: null,
      error: "timeout",
    };
  }
}

async function fetchPublicWeather(query: string): Promise<{ heading: string; abstract: string; url: string } | null> {
  const place = query.replace(/\b(weather|forecast|temperature|tomorrow|today|like)\b/gi, " ").replace(/\s+/g, " ").trim() || "United Kingdom";
  const url = `https://wttr.in/${encodeURIComponent(place)}?format=j1`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "INFRA-public-weather/1.0" } });
    if (!response.ok) return null;
    const raw = (await response.json()) as {
      nearest_area?: Array<{ areaName?: Array<{ value?: string }> }>;
      weather?: Array<{ date?: string; hourly?: Array<{ tempC?: string; weatherDesc?: Array<{ value?: string }> }> }>;
      current_condition?: Array<{ temp_C?: string; weatherDesc?: Array<{ value?: string }> }>;
    };
    const area = raw.nearest_area?.[0]?.areaName?.[0]?.value || place;
    const tomorrow = raw.weather?.[1] ?? raw.weather?.[0];
    const hour = tomorrow?.hourly?.[4] ?? tomorrow?.hourly?.[0];
    const desc = hour?.weatherDesc?.[0]?.value || raw.current_condition?.[0]?.weatherDesc?.[0]?.value;
    const temp = hour?.tempC || raw.current_condition?.[0]?.temp_C;
    if (!desc && !temp) return null;
    return {
      heading: `${area} public weather`,
      abstract: [desc, temp ? `${temp}°C` : "", tomorrow?.date ? `for ${tomorrow.date}` : ""].filter(Boolean).join(", "),
      url: `https://wttr.in/${encodeURIComponent(place)}`,
    };
  } catch {
    return null;
  }
}

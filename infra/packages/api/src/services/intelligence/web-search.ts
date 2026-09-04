/**
 * Read-only public web / live-information lookup.
 * Never used for Xero, Outlook, or company files. Never send private EL data.
 */

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_SEARCH_UNAVAILABLE =
  "Live web access is unavailable just now, so I can’t check current public information.";

const PRIVATE_LEAK =
  /\b(elvexpropertyservices\.com|info@|finance@|INV-\d{2,}|william@|sharon@|ella@|lauren@|michael@)\b/i;
const BUSINESS_OVERRIDE =
  /\b(xero|invoice|sales|outlook|mailbox|inbox|emials?|e-?mails?|sharepoint|onedrive|company files?|po process|purchase order)\b/i;

const LIVE_PUBLIC =
  /\b(weather|forecast|temperature|who won|latest news|breaking news|current (time|score|price|standings)|what(?:'s| is) the (latest|current|score)|find (the )?website|look up (the )?(public|website)|stock price|news about)\b/i;

export function isLivePublicInformationAsk(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || BUSINESS_OVERRIDE.test(trimmed)) return false;
  return LIVE_PUBLIC.test(trimmed);
}

export function looksLikePrivateBusinessQuery(text: string): boolean {
  return PRIVATE_LEAK.test(text) || BUSINESS_OVERRIDE.test(text);
}

export function sanitizeWebSearchQuery(
  text: string,
  privateHints: string[] = [],
): { ok: true; query: string } | { ok: false; reason: string } {
  let query = text.replace(/\s+/g, " ").trim();
  if (!query) return { ok: false, reason: "empty" };
  if (PRIVATE_LEAK.test(query)) {
    return { ok: false, reason: "private_data" };
  }
  for (const hint of privateHints) {
    const token = hint.replace(/\s+/g, " ").trim();
    if (token.length >= 4) {
      query = query.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ").trim();
    }
  }
  query = query.replace(/\s+/g, " ").trim();
  if (PRIVATE_LEAK.test(query) || /INV-\d{2,}/i.test(query)) {
    return { ok: false, reason: "private_data" };
  }
  return { ok: true, query: query.slice(0, 180) };
}

export type WebSearchResult = {
  ok: boolean;
  provider: "open-meteo" | "duckduckgo" | "none";
  query: string;
  summary: string;
  sourceUrl?: string | null;
  error?: string;
};

function weatherPlace(text: string): string {
  const match =
    text.match(/\bweather (?:in|for|at) ([A-Za-z][A-Za-z\s-]{1,40})/i) ??
    text.match(/\bin ([A-Za-z][A-Za-z\s-]{1,40}) (?:now|today|currently)\b/i);
  return (match?.[1] ?? "London").replace(/[?.!]+$/g, "").trim() || "London";
}

async function searchWeather(place: string): Promise<WebSearchResult> {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`,
  );
  if (!geoRes.ok) return { ok: false, provider: "open-meteo", query: place, summary: WEB_SEARCH_UNAVAILABLE, error: "geo_http" };
  const geo = (await geoRes.json()) as { results?: Array<{ name?: string; country?: string; latitude?: number; longitude?: number }> };
  const hit = geo.results?.[0];
  if (!hit?.latitude || !hit.longitude) {
    return { ok: false, provider: "open-meteo", query: place, summary: `I couldn’t find a public weather location for ${place}.`, error: "geo_miss" };
  }
  const wxRes = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
  );
  if (!wxRes.ok) return { ok: false, provider: "open-meteo", query: place, summary: WEB_SEARCH_UNAVAILABLE, error: "wx_http" };
  const wx = (await wxRes.json()) as {
    current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
  };
  const temp = wx.current?.temperature_2m;
  if (typeof temp !== "number") {
    return { ok: false, provider: "open-meteo", query: place, summary: WEB_SEARCH_UNAVAILABLE, error: "wx_empty" };
  }
  const label = [hit.name, hit.country].filter(Boolean).join(", ");
  const wind = typeof wx.current?.wind_speed_10m === "number" ? `, wind ${wx.current.wind_speed_10m} km/h` : "";
  return {
    ok: true,
    provider: "open-meteo",
    query: place,
    summary: `${label} is currently ${temp}°C${wind}.`,
    sourceUrl: "https://open-meteo.com/",
  };
}

async function searchDuckDuckGo(query: string): Promise<WebSearchResult> {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
  );
  if (!res.ok) return { ok: false, provider: "duckduckgo", query, summary: WEB_SEARCH_UNAVAILABLE, error: "ddg_http" };
  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Answer?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };
  const abstract = (data.AbstractText || data.Answer || "").replace(/\s+/g, " ").trim();
  if (abstract) {
    return {
      ok: true,
      provider: "duckduckgo",
      query,
      summary: abstract.slice(0, 480),
      sourceUrl: data.AbstractURL || null,
    };
  }
  const related = data.RelatedTopics?.find((row) => row.Text)?.Text?.replace(/\s+/g, " ").trim();
  if (related) {
    return {
      ok: true,
      provider: "duckduckgo",
      query,
      summary: related.slice(0, 480),
      sourceUrl: data.RelatedTopics?.find((row) => row.FirstURL)?.FirstURL ?? null,
    };
  }
  return { ok: false, provider: "duckduckgo", query, summary: `I couldn’t find a reliable public-web result for that.`, error: "ddg_empty" };
}

export async function executeWebSearch(text: string, privateHints: string[] = []): Promise<WebSearchResult> {
  const sanitized = sanitizeWebSearchQuery(text, privateHints);
  if (!sanitized.ok) {
    return {
      ok: false,
      provider: "none",
      query: "",
      summary:
        sanitized.reason === "private_data"
          ? "I won’t send company or private details to a public web search. Ask about the connected system instead."
          : WEB_SEARCH_UNAVAILABLE,
      error: sanitized.reason,
    };
  }
  try {
    if (/\bweather|forecast|temperature\b/i.test(sanitized.query)) {
      return await searchWeather(weatherPlace(sanitized.query));
    }
    return await searchDuckDuckGo(sanitized.query);
  } catch {
    return { ok: false, provider: "none", query: sanitized.query, summary: WEB_SEARCH_UNAVAILABLE, error: "network" };
  }
}

export function verbaliseWebSearch(result: WebSearchResult): string {
  if (result.summary.trim()) return result.summary.trim();
  return WEB_SEARCH_UNAVAILABLE;
}

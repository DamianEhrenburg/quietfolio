import { APP_USER_AGENT } from "../../src/shared/appMeta";
import type { InternalSettings } from "./settingsService";
import { fetchJson } from "./networkClient";

interface SparqlBinding {
  workLabel?: { value: string };
}

interface SparqlResponse {
  results?: {
    bindings?: SparqlBinding[];
  };
}

function hasCyrillic(value: string) {
  return /[\u0400-\u04FF]/.test(value);
}

function unique(values: string[], limit = 30) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase("ru");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

export async function fetchAuthorWorkTitlesSparql(
  authorId: string,
  query: string,
  settings: InternalSettings
): Promise<string[]> {
  const cleanId = authorId.replace(/^wd:/, "").trim();
  if (!/^Q\d+$/i.test(cleanId)) return [];
  const languages = hasCyrillic(query) ? "ru,en,de" : "en,ru,de";
  const sparql = `
SELECT DISTINCT ?workLabel WHERE {
  ?work wdt:P31/wdt:P279* wd:Q571.
  ?work wdt:P50 wd:${cleanId}.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${languages}". }
}
LIMIT 30`;
  const url = new URL("https://query.wikidata.org/sparql");
  url.searchParams.set("format", "json");
  url.searchParams.set("query", sparql);
  const data = await fetchJson<SparqlResponse>(url.toString(), {
    timeoutMs: Math.min(8_000, settings.requestTimeoutMs),
    retries: 0,
    headers: {
      Accept: "application/sparql-results+json",
      "User-Agent": APP_USER_AGENT
    }
  });
  return unique(
    (data.results?.bindings || [])
      .map((binding) => binding.workLabel?.value || "")
      .filter(Boolean),
    28
  );
}

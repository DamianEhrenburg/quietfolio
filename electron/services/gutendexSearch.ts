import { createHash } from "node:crypto";
import type { BookProvider, OnlineBookCandidate, ProviderReference } from "../../src/shared/types";
import { APP_USER_AGENT } from "../../src/shared/appMeta";
import { MISSING_AUTHOR } from "../../src/shared/authorSentinel";
import { fetchJson } from "./networkClient";
import type { InternalSettings } from "./settingsService";
import type { ResolvedSearchPlan } from "./queryResolver";

const GUTENDEX_API = "https://gutendex.com";

interface GutendexPerson {
  name?: string;
}

interface GutendexBook {
  id: number;
  title?: string;
  authors?: GutendexPerson[];
  subjects?: string[];
  bookshelves?: string[];
  languages?: string[];
  summaries?: string[];
  download_count?: number;
  formats?: Record<string, string>;
}

interface GutendexResponse {
  results?: GutendexBook[];
}

export interface GutendexProviderResult {
  provider: BookProvider;
  results: OnlineBookCandidate[];
  durationMs: number;
}

type ScoreCandidate = (
  candidate: OnlineBookCandidate,
  plan: ResolvedSearchPlan,
  settings: InternalSettings
) => OnlineBookCandidate;

function candidateId(references: ProviderReference[], title: string, author: string) {
  return createHash("sha1")
    .update(`${references.map((item) => `${item.provider}:${item.kind}:${item.externalId}`).join("|")}|${title}|${author}`)
    .digest("hex")
    .slice(0, 20);
}

function buildSearchQuery(plan: ResolvedSearchPlan) {
  if (plan.resolvedMode === "author") {
    return plan.authorName || plan.canonicalQuery || plan.originalQuery;
  }
  if (plan.resolvedMode === "title") {
    return plan.canonicalQuery || plan.originalQuery;
  }
  return plan.originalQuery || plan.canonicalQuery;
}

function mapGutendexBook(book: GutendexBook): OnlineBookCandidate | null {
  const title = book.title?.trim();
  if (!title || !book.id) return null;
  const author = (book.authors || []).map((item) => item.name).filter(Boolean).join(", ") || MISSING_AUTHOR;
  const reference: ProviderReference = {
    provider: "gutendex",
    externalId: String(book.id),
    kind: "work"
  };
  const coverUrl = book.formats?.["image/jpeg"] || book.formats?.["image/png"];
  const subjects = [...(book.subjects || []), ...(book.bookshelves || [])];
  const languages = (book.languages || []).map((code) => code.toLowerCase());
  const description = book.summaries?.[0]?.trim();
  const candidate: OnlineBookCandidate = {
    id: candidateId([reference], title, author),
    title,
    displayTitle: title,
    author,
    languages: languages.length ? languages : ["en"],
    subjects,
    genres: subjects.slice(0, 6),
    providers: ["gutendex"],
    references: [reference],
    coverUrl,
    coverRemoteUrl: coverUrl,
    sourceUrl: `https://www.gutenberg.org/ebooks/${book.id}`,
    description,
    firstPublishedYear: null,
    editionCount: 1,
    popularity: Math.min(99, Math.round(Math.log10((book.download_count || 1) + 1) * 18)),
    completeness: 0,
    score: 0,
    matchConfidence: "medium",
    matchReasons: ["known_work"]
  };
  candidate.completeness = Math.round(
    ([title, author, coverUrl, description, languages[0]] as unknown[]).filter(Boolean).length / 5 * 100
  );
  return candidate;
}

export async function searchGutendex(
  plan: ResolvedSearchPlan,
  settings: InternalSettings,
  scoreCandidate: ScoreCandidate
): Promise<GutendexProviderResult> {
  const started = Date.now();
  const query = buildSearchQuery(plan).trim();
  if (!query) return { provider: "gutendex", results: [], durationMs: 0 };

  const url = new URL(`${GUTENDEX_API}/books`);
  url.searchParams.set("search", query);
  url.searchParams.set("languages", settings.preferRussian ? "en,ru,de,fr" : "en,ru,de,fr");

  const data = await fetchJson<GutendexResponse>(url.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 1,
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT
    }
  });

  const limit = Math.max(8, settings.searchLimit);
  const results = (data.results || [])
    .slice(0, limit)
    .map((book) => mapGutendexBook(book))
    .filter((item): item is OnlineBookCandidate => Boolean(item))
    .map((candidate) => scoreCandidate(candidate, plan, settings));

  return { provider: "gutendex", results, durationMs: Date.now() - started };
}

export async function diagnoseGutendex(settings: InternalSettings) {
  const url = `${GUTENDEX_API}/books?search=dickens&languages=en`;
  await fetchJson(url, {
    timeoutMs: settings.requestTimeoutMs,
    retries: 0,
    headers: { Accept: "application/json", "User-Agent": APP_USER_AGENT }
  });
  return { ok: true, message: "Соединение установлено" };
}

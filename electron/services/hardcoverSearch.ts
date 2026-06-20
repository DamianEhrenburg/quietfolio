import { net } from "electron";
import { createHash } from "node:crypto";
import type { BookProvider, OnlineBookCandidate, ProviderReference } from "../../src/shared/types";
import { APP_USER_AGENT } from "../../src/shared/appMeta";
import { MISSING_AUTHOR } from "../../src/shared/authorSentinel";
import type { InternalSettings } from "./settingsService";
import type { ResolvedSearchPlan } from "./queryResolver";
import { describeNetworkError } from "./networkClient";

const HARDCOVER_API = "https://api.hardcover.app/v1/graphql";

const SEARCH_QUERY = `
query SearchBooks($query: String!, $perPage: Int!) {
  search(query: $query, query_type: "Book", per_page: $perPage, page: 1) {
    results {
      hits {
        document {
          title
          slug
          author_names
          release_year
          pages
          isbns
          image { url }
        }
      }
    }
  }
}`;

interface HardcoverSearchHit {
  document?: {
    title?: string;
    slug?: string;
    author_names?: string[];
    release_year?: number;
    pages?: number;
    isbns?: string[];
    image?: { url?: string };
  };
}

interface HardcoverSearchResponse {
  data?: {
    search?: {
      results?: {
        hits?: HardcoverSearchHit[];
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

export interface HardcoverProviderResult {
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
  if (plan.resolvedMode === "title" && plan.authorName) {
    return `${plan.canonicalQuery || plan.originalQuery} ${plan.authorName}`.trim();
  }
  return plan.canonicalQuery || plan.originalQuery;
}

async function hardcoverGraphql<T>(query: string, variables: Record<string, unknown>, settings: InternalSettings): Promise<T> {
  const token = settings.hardcoverApiToken?.trim();
  if (!token) throw new Error("Hardcover API token не задан");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
  try {
    const response = await net.fetch(HARDCOVER_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": APP_USER_AGENT
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const payload = await response.json() as T & { errors?: Array<{ message?: string }> };
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message).filter(Boolean).join("; ") || "Hardcover GraphQL error");
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function mapHardcoverHit(hit: HardcoverSearchHit): OnlineBookCandidate | null {
  const doc = hit.document;
  if (!doc) return null;
  const title = doc.title?.trim();
  const slug = doc.slug?.trim();
  if (!title || !slug) return null;
  const author = (doc.author_names || []).filter(Boolean).join(", ") || MISSING_AUTHOR;
  const reference: ProviderReference = {
    provider: "hardcover",
    externalId: slug,
    kind: "work"
  };
  const coverUrl = doc.image?.url;
  const candidate: OnlineBookCandidate = {
    id: candidateId([reference], title, author),
    title,
    displayTitle: title,
    author,
    languages: ["en"],
    subjects: [],
    genres: [],
    providers: ["hardcover"],
    references: [reference],
    coverUrl,
    coverRemoteUrl: coverUrl,
    sourceUrl: `https://hardcover.app/books/${slug}`,
    firstPublishedYear: doc.release_year ?? null,
    editionCount: 1,
    popularity: 42,
    completeness: 0,
    score: 0,
    matchConfidence: "medium"
  };
  candidate.completeness = Math.round(
    ([title, author, coverUrl, doc.release_year, doc.pages] as unknown[]).filter(Boolean).length / 5 * 100
  );
  return candidate;
}

export async function searchHardcover(
  plan: ResolvedSearchPlan,
  settings: InternalSettings,
  scoreCandidate: ScoreCandidate
): Promise<HardcoverProviderResult> {
  const started = Date.now();
  const query = buildSearchQuery(plan).trim();
  if (!query || !settings.hardcoverApiToken?.trim()) {
    return { provider: "hardcover", results: [], durationMs: 0 };
  }

  const data = await hardcoverGraphql<HardcoverSearchResponse>(
    SEARCH_QUERY,
    { query, perPage: Math.max(8, settings.searchLimit) },
    settings
  );

  const hits = data.data?.search?.results?.hits || [];
  const results = hits
    .map((hit) => mapHardcoverHit(hit))
    .filter((item): item is OnlineBookCandidate => Boolean(item))
    .map((candidate) => scoreCandidate(candidate, plan, settings));

  return { provider: "hardcover", results, durationMs: Date.now() - started };
}

export async function diagnoseHardcover(settings: InternalSettings) {
  if (!settings.hardcoverApiToken?.trim()) {
    return { ok: false, message: "Не задан API token" };
  }
  try {
    await hardcoverGraphql(
      SEARCH_QUERY,
      { query: "1984", perPage: 1 },
      settings
    );
    return { ok: true, message: "Соединение установлено" };
  } catch (error) {
    return { ok: false, message: describeNetworkError(error) };
  }
}

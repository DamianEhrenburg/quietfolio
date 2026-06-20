import { createHash } from "node:crypto";
import type { OnlineBookCandidate, ProviderReference } from "../../src/shared/types";
import { normalizeGenreList } from "../../src/shared/genreCodes";
import { parseSeriesFromQuery, queryMentionsSeries } from "../../src/shared/searchQueryHints";
import type { InternalSettings } from "./settingsService";
import type { ResolvedSearchPlan } from "./queryResolver";
import {
  ensureInpxIndex,
  inpxReferenceKey,
  searchInpxByAuthor,
  searchInpxWorks,
  type InpxWorkHit
} from "./inpxLocalIndex";
import { searchInpxWebBooks } from "./inpxWebClient";

export function isInpxReference(reference: ProviderReference) {
  return reference.externalId.startsWith("inpx:");
}

function inpxWorkReference(hit: InpxWorkHit): ProviderReference {
  return {
    provider: "open-library",
    externalId: `inpx:${inpxReferenceKey(hit)}`,
    kind: "work"
  };
}

function uniqueStrings(values: string[], limit: number) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function candidateId(references: ProviderReference[], title: string, author: string) {
  return createHash("sha1")
    .update(`${references.map((ref) => `${ref.provider}:${ref.externalId}`).join("|")}|${title}|${author}`)
    .digest("hex")
    .slice(0, 20);
}

export function mapInpxHitToCandidate(hit: InpxWorkHit, plan?: Pick<ResolvedSearchPlan, "seriesNum" | "originalQuery" | "canonicalQuery">): OnlineBookCandidate {
  const reference = inpxWorkReference(hit);
  const genres = hit.genre
    ? normalizeGenreList(hit.genre.split(/[:;,]/).map((part) => part.trim()).filter(Boolean))
    : [];
  const languages = uniqueStrings([hit.language || "ru", "ru"], 4);
  const matchReasons = ["local_index"];
  const queryText = plan?.canonicalQuery || plan?.originalQuery || "";
  if (hit.series && queryText && queryMentionsSeries(queryText, hit.series)) {
    matchReasons.push("series_match");
  }
  if (plan?.seriesNum && hit.seriesNum === plan.seriesNum) {
    matchReasons.push("series_match");
  }
  let score = hit.score;
  if (plan?.seriesNum && hit.seriesNum === plan.seriesNum) score += 120;
  return {
    id: candidateId([reference], hit.title, hit.author),
    providers: ["open-library"],
    references: [reference],
    title: hit.title,
    alternateTitles: uniqueStrings([hit.title, hit.series || ""].filter(Boolean), 6),
    author: hit.author,
    firstPublishedYear: hit.year ?? null,
    editionCount: 0,
    languages,
    genres,
    subjects: genres,
    catalogSeries: hit.series || undefined,
    catalogSeriesNum: hit.seriesNum ?? null,
    score,
    completeness: 58,
    popularity: 40,
    matchConfidence: hit.score >= 140 ? "high" : hit.score >= 100 ? "medium" : "low",
    matchReasons
  };
}

function inpxSearchQuery(plan: ResolvedSearchPlan) {
  const { cleanQuery } = parseSeriesFromQuery(plan.originalQuery);
  if (plan.resolvedMode === "author") {
    return plan.authorName || plan.canonicalQuery || cleanQuery;
  }
  if (plan.source === "combined") {
    return plan.canonicalQuery || cleanQuery;
  }
  return plan.canonicalQuery || cleanQuery;
}

function inpxAuthorHint(plan: ResolvedSearchPlan) {
  if (plan.resolvedMode === "author") return "";
  return plan.authorName || "";
}

export async function collectInpxWorkHits(
  plan: ResolvedSearchPlan,
  settings: InternalSettings,
  limit: number
): Promise<InpxWorkHit[]> {
  const query = inpxSearchQuery(plan);
  if (!query.trim()) return [];

  if (settings.inpxWebUrl?.trim()) {
    try {
      const remote = await searchInpxWebBooks(settings.inpxWebUrl.trim(), plan, limit, settings.requestTimeoutMs);
      if (remote.length) return remote;
    } catch {
      // inpx-web unavailable — try local index
    }
  }

  if (!settings.inpxEnabled || !settings.inpxIndexPath?.trim()) return [];
  if (!ensureInpxIndex(settings)) return [];
  if (plan.resolvedMode === "author") {
    return searchInpxByAuthor(query, limit);
  }
  return searchInpxWorks(query, limit, inpxAuthorHint(plan));
}

export function buildInpxWorkCandidates(
  plan: ResolvedSearchPlan,
  hits: InpxWorkHit[],
  scoreCandidate: (candidate: OnlineBookCandidate) => OnlineBookCandidate
): OnlineBookCandidate[] {
  const seen = new Set<string>();
  const candidates: OnlineBookCandidate[] = [];
  for (const hit of hits) {
    const key = `${inpxReferenceKey(hit)}|${hit.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = mapInpxHitToCandidate(hit, plan);
    const scored = scoreCandidate({
      ...mapped,
      score: mapped.score + 95,
      matchReasons: uniqueStrings([...(mapped.matchReasons || []), "local_index"], 8)
    });
    candidates.push(scored);
  }
  return candidates;
}

export function inpxDuplicatesLiveCatalog(candidate: OnlineBookCandidate, live: OnlineBookCandidate[]) {
  const title = candidate.title.trim().toLowerCase();
  const authorTokens = candidate.author.toLowerCase().split(/\s+/).filter(Boolean);
  return live.some((item) => {
    if (item.title.trim().toLowerCase() !== title) return false;
    const liveAuthor = item.author.toLowerCase();
    return authorTokens.every((token) => liveAuthor.includes(token));
  });
}

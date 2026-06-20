import type {
  DisambiguationOption,
  OnlineQueryResolution,
  OnlineSearchMode,
  QueryResolutionSource,
  ResolvedSearchMode
} from "../../src/shared/types";
import { APP_USER_AGENT } from "../../src/shared/appMeta";
import { fetchJson } from "./networkClient";
import type { InternalSettings } from "./settingsService";
import { getCachedResolution, setCachedResolution } from "./entityResolutionCache";
import { searchCanonicalWorks } from "./canonicalWorksIndex";
import { curatedAuthorResolution, findCuratedWork, getCuratedNotableWorks } from "./russianWorksIndex";
import { fetchAuthorWorkTitlesSparql } from "./wikidataSparql";
import { editionPreferRussian } from "../../src/shared/searchEditionLanguage";
import { parseSeriesFromQuery } from "../../src/shared/searchQueryHints";
import { ensureInpxIndex, searchInpxAuthors } from "./inpxLocalIndex";

interface OpenLibraryAuthorDoc {
  key?: string;
  name?: string;
  alternate_names?: string[];
  top_work?: string;
  work_count?: number;
}

interface OpenLibraryAuthorSearchResponse {
  docs?: OpenLibraryAuthorDoc[];
}

interface WikidataSearchResult {
  id?: string;
  label?: string;
  description?: string;
  aliases?: string[];
  match?: {
    type?: string;
    language?: string;
    text?: string;
  };
}

interface WikidataSearchResponse {
  search?: WikidataSearchResult[];
}

interface WikidataTerm {
  language?: string;
  value?: string;
}

interface WikidataSnak {
  datavalue?: {
    value?: {
      id?: string;
    };
  };
}

interface WikidataClaim {
  mainsnak?: WikidataSnak;
}

interface WikidataEntity {
  id?: string;
  labels?: Record<string, WikidataTerm>;
  aliases?: Record<string, WikidataTerm[]>;
  descriptions?: Record<string, WikidataTerm>;
  claims?: Record<string, WikidataClaim[]>;
}

interface WikidataEntitiesResponse {
  entities?: Record<string, WikidataEntity>;
}

export interface ResolvedSearchPlan extends OnlineQueryResolution {
  titleVariants: string[];
  authorVariants: string[];
  authorWorkCount?: number;
  notableWorkTitles?: string[];
  seriesNum?: number;
}

interface AuthorResolution {
  key?: string;
  name: string;
  aliases: string[];
  confidence: number;
  source: QueryResolutionSource;
  workCount?: number;
  wikidataId?: string;
}

interface WorkResolution {
  label: string;
  aliases: string[];
  authorNames: string[];
  confidence: number;
  wikidataId?: string;
}

const PERSON_DESCRIPTION = /(?:писател|поэт|драматург|философ|эссеист|историк|уч[её]н|журналист|политик|акт[её]р|режисс[её]р|композитор|художник|математик|физик|биолог|врач|writer|author|poet|novelist|playwright|philosopher|essayist|historian|scholar|journalist|politician|actor|director|composer|artist|scientist|mathematician|physicist|physician|schriftsteller|dichter|philosoph|écrivain|auteur|poète|filósofo|escritor|scrittore)/i;
const WORK_DESCRIPTION = /(?:роман|повесть|рассказ|книга|произведен|трактат|эссе|пьеса|поэма|стихотвор|literary work|written work|novel|book|treatise|essay|play|poem|short story|philosophical work|roman|ouvrage|livre|œuvre|libro|obra|opera letteraria)/i;
const LANGUAGES = [
  "ru", "en", "de", "fr", "it", "es", "pt", "pl", "uk", "be", "bg", "sr",
  "ja", "zh", "ko", "ar", "he", "fa", "hi", "tr", "cs", "nl", "sv", "el", "hy", "ka"
];
const authorSearchMemo = new Map<string, Promise<OpenLibraryAuthorDoc[]>>();
const wikidataMemo = new Map<string, { expiresAt: number; value: Promise<WikidataEntity[]> }>();

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string) {
  return normalize(value).split(" ").filter((token) => token.length > 1);
}

function unique(values: Array<string | undefined | null>, limit = 30) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

function queryLanguages(value: string) {
  const cyrillic = hasCyrillic(value);
  if (cyrillic) return unique(["ru", "uk", "en"], 5);
  if (/[A-Za-zÀ-ž]/u.test(value)) return unique(["en", "de", "fr", "es"], 5);
  return unique(["en", "ru"], 5);
}

function normalizeIsbn(value: string) {
  const isbn = value.replace(/[^0-9X]/gi, "").toUpperCase();
  return isbn.length === 10 || isbn.length === 13 ? isbn : undefined;
}

function textCoverage(needle: string, haystack: string) {
  const wanted = tokens(needle);
  if (!wanted.length) return 0;
  const normalizedHaystack = normalize(haystack);
  const matched = wanted.filter((token) => normalizedHaystack.includes(token)).length;
  return matched / wanted.length;
}

function preferredTerm(query: string, values: string[]) {
  const normalizedQuery = normalize(query);
  return values.find((value) => normalize(value) === normalizedQuery)
    || [...values].sort((left, right) => textCoverage(query, right) - textCoverage(query, left))[0]
    || query;
}

function exactOrAliasScore(query: string, values: string[]) {
  const normalizedQuery = normalize(query);
  let best = 0;
  for (const value of values) {
    const normalizedValue = normalize(value);
    if (!normalizedValue) continue;
    if (normalizedValue === normalizedQuery) best = Math.max(best, 100);
    else if (normalizedValue.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedValue)) {
      best = Math.max(best, 86);
    } else {
      const coverage = textCoverage(query, value);
      best = Math.max(best, Math.round(coverage * 72));
    }
  }
  return best;
}

function surnameOnlyPenalty(query: string, authorName: string) {
  const queryTokens = normalize(query).split(" ").filter((token) => token.length > 1);
  if (queryTokens.length !== 1) return 0;
  const token = queryTokens[0];
  const nameTokens = normalize(authorName).split(" ").filter((token) => token.length > 1);
  if (nameTokens.length <= 1) return 0;
  const lastName = nameTokens[nameTokens.length - 1];
  if (lastName === token) return -28;
  if (lastName.includes(token) || token.includes(lastName)) return -18;
  return 0;
}

function claimEntityIds(entity: WikidataEntity, property: string) {
  return unique(
    (entity.claims?.[property] || []).map((claim) => claim.mainsnak?.datavalue?.value?.id),
    20
  );
}

function hasCyrillic(value: string) {
  return /[\u0400-\u04FF]/.test(value);
}

function entityTerms(entity: WikidataEntity, query?: string) {
  const preferRu = query ? hasCyrillic(query) : false;
  const labels = LANGUAGES.map((language) => entity.labels?.[language]?.value);
  const aliases = LANGUAGES.flatMap((language) => (entity.aliases?.[language] || []).map((item) => item.value));
  const terms = unique([...labels, ...aliases], 40);
  if (!preferRu) return terms;
  const russian = terms.filter((term) => hasCyrillic(term));
  const other = terms.filter((term) => !hasCyrillic(term));
  return unique([...russian, ...other], 40);
}

function entityDescriptions(entity: WikidataEntity) {
  return unique(LANGUAGES.map((language) => entity.descriptions?.[language]?.value), 12);
}

async function openLibraryAuthorSearch(query: string, settings: InternalSettings) {
  const memoKey = normalize(query);
  const existing = authorSearchMemo.get(memoKey);
  if (existing) return existing;
  const request = (async () => {
    const url = new URL("https://openlibrary.org/search/authors.json");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "12");
    const data = await fetchJson<OpenLibraryAuthorSearchResponse>(url.toString(), {
      timeoutMs: settings.requestTimeoutMs,
      retries: 2,
      headers: {
        Accept: "application/json",
        "User-Agent": APP_USER_AGENT
      }
    });
    return data.docs || [];
  })();
  authorSearchMemo.set(memoKey, request);
  try {
    return await request;
  } catch (error) {
    authorSearchMemo.delete(memoKey);
    throw error;
  }
}

async function wikidataSearch(query: string, language: string, settings: InternalSettings) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("search", query);
  url.searchParams.set("language", language);
  url.searchParams.set("uselang", language);
  url.searchParams.set("type", "item");
  url.searchParams.set("limit", "8");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  const data = await fetchJson<WikidataSearchResponse>(url.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 1,
    preferNodeTransport: true,
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT
    }
  });
  return data.search || [];
}

async function wikidataEntities(ids: string[], settings: InternalSettings) {
  const cleanIds = unique(ids, 12);
  if (!cleanIds.length) return [];
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", cleanIds.join("|"));
  url.searchParams.set("props", "labels|aliases|descriptions|claims");
  url.searchParams.set("languages", LANGUAGES.join("|"));
  url.searchParams.set("languagefallback", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  const data = await fetchJson<WikidataEntitiesResponse>(url.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 1,
    preferNodeTransport: true,
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT
    }
  });
  return Object.values(data.entities || {}).filter((entity) => entity.id);
}

async function wikidataEntityWithClaims(id: string, settings: InternalSettings) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", id);
  url.searchParams.set("props", "claims");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  const data = await fetchJson<WikidataEntitiesResponse>(url.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 1,
    preferNodeTransport: true,
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT
    }
  });
  return data.entities?.[id];
}

function scoreAuthorDoc(query: string, doc: OpenLibraryAuthorDoc, canonicalNames: string[] = []) {
  const names = unique([doc.name, ...(doc.alternate_names || [])], 40);
  let score = exactOrAliasScore(query, names) + surnameOnlyPenalty(query, doc.name || "");
  const queryTokens = normalize(query).split(" ").filter((token) => token.length > 1);
  const docTokens = normalize(doc.name || "").split(" ").filter((token) => token.length > 1);

  if (queryTokens.length === 1 && docTokens.length >= 2 && docTokens[0] === queryTokens[0]) {
    score += 8;
  }

  if (queryTokens.length === 1 && normalize(doc.name || "") === queryTokens[0]) {
    const workCount = doc.work_count || 0;
    if (workCount < 8) score -= 42;
    if (workCount <= 2) score -= 28;
    if (/^@|calendar|twitter|instagram|tiktok/i.test(doc.name || "")) score -= 90;
  }

  if (canonicalNames.length) {
    const canonicalScore = exactOrAliasScore(doc.name || "", canonicalNames);
    if (canonicalScore >= 78) score += 22;
    else if (canonicalScore >= 62) score += 10;
  }

  if (doc.work_count) score += Math.min(12, Math.log2(doc.work_count + 1) * 2);
  return Math.min(100, Math.round(score));
}

async function bestOpenLibraryAuthor(
  query: string,
  settings: InternalSettings,
  canonicalNames: string[] = []
) {
  try {
    const docs = await openLibraryAuthorSearch(query, settings);
    return docs
      .map((doc) => ({ doc, score: scoreAuthorDoc(query, doc, canonicalNames) }))
      .filter((item) => item.doc.name)
      .sort((left, right) => right.score - left.score || (right.doc.work_count || 0) - (left.doc.work_count || 0))[0];
  } catch {
    return undefined;
  }
}

function isAuthorEntity(entity: WikidataEntity) {
  const instanceOf = claimEntityIds(entity, "P31");
  // Q5 = human. A concept such as “Machiavellianism” may be described with the
  // word “philosophy”, but it must never be treated as an author.
  if (instanceOf.length > 0) return instanceOf.includes("Q5");
  return PERSON_DESCRIPTION.test(entityDescriptions(entity).join(" "));
}

function isWorkEntity(entity: WikidataEntity) {
  return WORK_DESCRIPTION.test(entityDescriptions(entity).join(" "));
}

async function findWikidataEntities(query: string, settings: InternalSettings) {
  const memoKey = normalize(query);
  const cached = wikidataMemo.get(memoKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = (async () => {
    const searches = await Promise.allSettled(
      queryLanguages(query).map((language) => wikidataSearch(query, language, settings))
    );
    const ids = unique(searches.flatMap((result) => result.status === "fulfilled"
      ? result.value.map((item) => item.id)
      : []), 6);
    return wikidataEntities(ids, settings);
  })();
  wikidataMemo.set(memoKey, { expiresAt: Date.now() + 5 * 60_000, value });
  try {
    return await value;
  } catch (error) {
    wikidataMemo.delete(memoKey);
    throw error;
  }
}

async function resolveAuthor(query: string, settings: InternalSettings): Promise<AuthorResolution | null> {
  const entitiesPromise = findWikidataEntities(query, settings).catch(() => [] as WikidataEntity[]);
  const entities = await entitiesPromise;

  const authorEntities = entities
    .filter(isAuthorEntity)
    .map((entity) => {
      const names = entityTerms(entity, query);
      return {
        entity,
        names,
        score: exactOrAliasScore(query, names)
      };
    })
    .sort((left, right) => right.score - left.score);

  const bestEntity = authorEntities[0];
  const canonicalNames = bestEntity?.names || [];

  const [originalCandidate, ...wikidataCandidates] = await Promise.all([
    bestOpenLibraryAuthor(query, settings, canonicalNames),
    ...canonicalNames.slice(0, 3).map((name) => bestOpenLibraryAuthor(name, settings, canonicalNames))
  ]);
  const candidateMap = new Map<string, NonNullable<typeof originalCandidate>>();
  for (const item of [originalCandidate, ...wikidataCandidates]) {
    if (!item) continue;
    const key = item.doc.key || normalize(item.doc.name || "");
    const existing = candidateMap.get(key);
    if (!existing || item.score > existing.score) candidateMap.set(key, item);
  }
  const candidates = [...candidateMap.values()]
    .sort((left, right) => right.score - left.score || (right.doc.work_count || 0) - (left.doc.work_count || 0));
  const best = candidates[0];

  if (best && best.score >= 62) {
    const aliases = unique([
      best.doc.name,
      ...(best.doc.alternate_names || []),
      ...canonicalNames,
      query
    ], 30);
    const entityScore = bestEntity?.score || 0;
    const name = preferredTerm(query, aliases);
    return {
      key: best.doc.key,
      name,
      aliases,
      confidence: Math.min(100, Math.max(best.score, entityScore) + (best.doc.key ? 4 : 0)),
      source: bestEntity ? "wikidata" : "open-library-author",
      workCount: best.doc.work_count,
      wikidataId: bestEntity?.entity.id
    };
  }

  if (bestEntity && bestEntity.score >= 72) {
    return {
      name: preferredTerm(query, bestEntity.names),
      aliases: unique([preferredTerm(query, bestEntity.names), ...bestEntity.names], 30),
      confidence: Math.min(92, bestEntity.score),
      source: "wikidata",
      wikidataId: bestEntity.entity.id
    };
  }

  return null;
}

async function authorLabelsFromIds(ids: string[], settings: InternalSettings, query?: string) {
  const entities = await wikidataEntities(ids, settings).catch(() => [] as WikidataEntity[]);
  return unique(entities.flatMap((entity) => entityTerms(entity, query)), 20);
}

function russianEntityTerms(entity: WikidataEntity) {
  const labels = [entity.labels?.ru?.value, entity.labels?.uk?.value];
  const aliases = [...(entity.aliases?.ru || []), ...(entity.aliases?.uk || [])].map((item) => item.value);
  return unique([...labels, ...aliases], 12);
}

async function fetchAuthorNotableWorkTitles(authorId: string, query: string, settings: InternalSettings) {
  const [sparqlTitles, claimTitles] = await Promise.all([
    Promise.race([
      fetchAuthorWorkTitlesSparql(authorId, query, settings),
      new Promise<string[]>((resolve) => {
        setTimeout(() => resolve([]), 4_000);
      })
    ]).catch(() => [] as string[]),
    fetchAuthorNotableWorkTitlesFromClaims(authorId, query, settings)
  ]);
  return unique([...sparqlTitles, ...claimTitles], 28);
}

async function fetchAuthorNotableWorkTitlesFromClaims(authorId: string, query: string, settings: InternalSettings) {
  const entity = await wikidataEntityWithClaims(authorId, settings).catch(() => undefined);
  if (!entity) return [];
  const workIds = claimEntityIds(entity, "P800");
  if (!workIds.length) return [];
  const works = await wikidataEntities(workIds.slice(0, 8), settings).catch(() => [] as WikidataEntity[]);
  if (hasCyrillic(query)) {
    const russianTitles = unique(works.flatMap(russianEntityTerms), 24);
    if (russianTitles.length > 0) return russianTitles;
    return unique(
      works.flatMap((work) => entityTerms(work, query)).filter((term) => hasCyrillic(term)),
      24
    );
  }
  return unique(
    works.flatMap((work) => entityTerms(work, query)),
    24
  );
}

async function enrichAuthorResolution(author: AuthorResolution, query: string, settings: InternalSettings) {
  const useRussianCurated = editionPreferRussian(query, settings.preferRussian, settings.uiLocale);
  const curatedTitles = useRussianCurated
    ? getCuratedNotableWorks(query, author.name, ...author.aliases)
    : [];
  if (author.source === "curated" || !author.wikidataId || (!useRussianCurated && author.key)) {
    return { notableWorkTitles: curatedTitles };
  }
  const wikidataTitles = await Promise.race([
    fetchAuthorNotableWorkTitles(author.wikidataId, query, settings),
    new Promise<string[]>((resolve) => {
      setTimeout(() => resolve([]), 3_000);
    })
  ]).catch(() => [] as string[]);
  return { notableWorkTitles: unique([...curatedTitles, ...wikidataTitles], 24) };
}

async function resolveWork(query: string, settings: InternalSettings): Promise<WorkResolution | null> {
  const entities = await findWikidataEntities(query, settings).catch(() => [] as WikidataEntity[]);
  const candidates = entities
    .filter(isWorkEntity)
    .map((entity) => {
      const terms = entityTerms(entity, query);
      return { entity, terms, score: exactOrAliasScore(query, terms) };
    })
    .sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || best.score < 58) return null;
  const entityWithClaims = best.entity.id
    ? await wikidataEntityWithClaims(best.entity.id, settings).catch(() => undefined)
    : undefined;
  const authorIds = entityWithClaims ? claimEntityIds(entityWithClaims, "P50") : [];
  const authorNames = await authorLabelsFromIds(authorIds, settings, query);
  const label = preferredTerm(query, best.terms);
  return {
    label,
    aliases: unique([label, ...best.terms], 30),
    authorNames,
    confidence: Math.min(96, best.score + (authorIds.length ? 5 : 0)),
    wikidataId: best.entity.id
  };
}

function splitCandidates(query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const result: Array<{ authorPart: string; titlePart: string }> = [];
  for (const size of [1, 2, 3]) {
    if (words.length <= size) continue;
    result.push({ authorPart: words.slice(-size).join(" "), titlePart: words.slice(0, -size).join(" ") });
    result.push({ authorPart: words.slice(0, size).join(" "), titlePart: words.slice(size).join(" ") });
  }
  const seen = new Set<string>();
  return result.filter((item) => {
    const key = `${normalize(item.authorPart)}|${normalize(item.titlePart)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.authorPart.length >= 2 && item.titlePart.length >= 2;
  }).slice(0, 6);
}

async function authorDisambiguationOptions(
  query: string,
  settings: InternalSettings,
  current?: AuthorResolution | null
) {
  const entities = await findWikidataEntities(query, settings).catch(() => [] as WikidataEntity[]);
  const seen = new Set<string>();
  const options: DisambiguationOption[] = [];
  for (const entity of entities.filter(isAuthorEntity)) {
    const terms = entityTerms(entity, query);
    const label = preferredTerm(query, terms);
    const key = normalize(label);
    if (!key || seen.has(key)) continue;
    if (current && normalize(current.name) === key) continue;
    seen.add(key);
    const descriptions = entityDescriptions(entity);
    options.push({
      label,
      query: label,
      confidence: exactOrAliasScore(query, terms),
      hint: descriptions.find((item) => hasCyrillic(item)) || descriptions[0]
    });
  }
  return options
    .filter((item) => item.confidence >= 58)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3);
}

async function authorSearchPlan(
  query: string,
  requestedMode: OnlineSearchMode,
  author: AuthorResolution | null,
  settings: InternalSettings,
  explanation: string
) {
  const enrichment = author
    ? await enrichAuthorResolution(author, query, settings)
    : { notableWorkTitles: [] as string[] };
  const displayName = author
    ? preferredTerm(query, unique([author.name, ...author.aliases, query], 30))
    : query;
  const disambiguationOptions = author && author.confidence < 78
    ? await authorDisambiguationOptions(query, settings, author)
    : [];
  const { seriesNum } = parseSeriesFromQuery(query);
  return makePlan({
    query,
    requestedMode,
    resolvedMode: "author",
    canonicalQuery: displayName,
    displayLabel: displayName,
    aliases: author?.aliases,
    confidence: author?.confidence || 42,
    source: author?.source || "literal",
    explanation,
    author: author || undefined,
    notableWorkTitles: enrichment.notableWorkTitles,
    disambiguationOptions,
    seriesNum: seriesNum || undefined
  });
}

async function resolveCombined(query: string, settings: InternalSettings) {
  const splits = splitCandidates(query);
  if (!splits.length) return null;

  const cyrillicQuery = hasCyrillic(query);
  const minConfidence = cyrillicQuery ? 62 : 72;

  for (const split of splits.slice(0, 4)) {
    const curated = findCuratedWork(split.titlePart, split.authorPart);
    if (curated) {
      return {
        split,
        author: {
          name: curated.author.displayName,
          aliases: curated.author.aliases,
          confidence: 88,
          source: "curated" as const,
          wikidataId: curated.author.wikidataId
        }
      };
    }
    const hits = searchCanonicalWorks(`${split.titlePart} ${split.authorPart}`, split.authorPart, 3);
    const hit = hits[0];
    if (hit && hit.score >= 78) {
      return {
        split,
        author: {
          name: hit.author,
          aliases: [hit.author],
          confidence: Math.min(90, hit.score),
          source: "curated" as const,
          wikidataId: hit.wikidataId
        }
      };
    }
  }

  for (const split of splits.slice(0, 4)) {
    const author = await resolveAuthor(split.authorPart, settings);
    if (author && author.confidence >= minConfidence) return { split, author };
  }

  if (cyrillicQuery) return null;

  const quick = await Promise.allSettled(splits.map(async (split) => ({
    split,
    candidate: await bestOpenLibraryAuthor(split.authorPart, settings)
  })));
  const bestQuick = quick
    .filter((item): item is PromiseFulfilledResult<{ split: { authorPart: string; titlePart: string }; candidate: Awaited<ReturnType<typeof bestOpenLibraryAuthor>> }> => item.status === "fulfilled")
    .map((item) => item.value)
    .filter((item) => item.candidate && item.candidate.score >= 68)
    .sort((left, right) =>
      (right.candidate?.score || 0) - (left.candidate?.score || 0)
      || tokens(right.split.authorPart).length - tokens(left.split.authorPart).length
    )[0];

  if (bestQuick) {
    const author = await resolveAuthor(bestQuick.split.authorPart, settings);
    if (author && author.confidence >= 70) return { split: bestQuick.split, author };
  }

  return null;
}

function makePlan(options: {
  query: string;
  requestedMode: OnlineSearchMode;
  resolvedMode: ResolvedSearchMode;
  canonicalQuery: string;
  displayLabel: string;
  aliases?: string[];
  confidence: number;
  source: QueryResolutionSource;
  explanation: string;
  author?: AuthorResolution | null;
  titleAliases?: string[];
  wikidataId?: string;
  notableWorkTitles?: string[];
  disambiguationOptions?: DisambiguationOption[];
  seriesNum?: number;
}): ResolvedSearchPlan {
  const author = options.author || undefined;
  const aliases = unique([
    options.canonicalQuery,
    ...(options.aliases || []),
    ...(options.titleAliases || []),
    ...(options.notableWorkTitles || []),
    ...(author?.aliases || [])
  ], 40);
  return {
    originalQuery: options.query,
    requestedMode: options.requestedMode,
    resolvedMode: options.resolvedMode,
    canonicalQuery: options.canonicalQuery,
    displayLabel: options.displayLabel,
    aliases,
    confidence: Math.max(0, Math.min(100, Math.round(options.confidence))),
    source: options.source,
    explanation: options.explanation,
    authorKey: author?.key,
    authorName: author?.name,
    authorAliases: author?.aliases || [],
    titleAliases: unique([...(options.titleAliases || []), ...(options.notableWorkTitles || [])], 24),
    wikidataId: options.wikidataId || author?.wikidataId,
    titleVariants: unique([
      options.canonicalQuery,
      ...(options.titleAliases || []),
      ...(options.notableWorkTitles || []),
      options.query
    ], 16),
    authorVariants: unique([author?.name, options.query, ...(author?.aliases || [])], 20),
    authorWorkCount: author?.workCount,
    notableWorkTitles: unique(options.notableWorkTitles || [], 24),
    disambiguationOptions: options.disambiguationOptions,
    seriesNum: options.seriesNum
  };
}

function hasExactCatalogTerm(query: string, terms: Array<string | undefined>) {
  const normalizedQuery = normalize(query);
  return terms.some((term) => term && normalize(term) === normalizedQuery);
}

function looksLikePersonalName(query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length !== 2) return false;
  const titleStopwords = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for"]);
  if (words.some((word) => titleStopwords.has(word.toLowerCase()))) return false;
  return words.every((word) => /^[\p{L}'’.-]+$/u.test(word));
}

function authorNameMatchesQuery(authorName: string, query: string) {
  const normalizedQuery = normalize(query);
  const normalizedAuthor = normalize(authorName);
  if (normalizedAuthor === normalizedQuery) return true;
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return false;
  const authorTokens = new Set(tokens(authorName));
  const matched = queryTokens.filter((token) =>
    authorTokens.has(token) || normalizedAuthor.includes(token)
  ).length;
  return matched / queryTokens.length >= 0.85;
}

function isBookAboutQuerySubject(work: WorkResolution, query: string) {
  if (!hasExactCatalogTerm(query, [work.label, ...work.aliases])) return false;
  if (!work.authorNames.length) return false;
  return !work.authorNames.some((name) => authorNameMatchesQuery(name, query));
}

function inpxAuthorResolution(query: string, settings: InternalSettings): AuthorResolution | null {
  if (!settings.inpxEnabled || !settings.inpxIndexPath?.trim()) return null;
  if (!ensureInpxIndex(settings)) return null;
  const hits = searchInpxAuthors(query, 2);
  const best = hits[0];
  if (!best || best.score < 100) return null;
  return {
    name: best.author,
    aliases: [best.author],
    confidence: Math.min(84, 68 + Math.round(best.score / 8)),
    source: "literal"
  };
}

async function resolveSearchQueryUncached(
  query: string,
  requestedMode: OnlineSearchMode,
  settings: InternalSettings
): Promise<ResolvedSearchPlan> {
  const rawQuery = query.trim().slice(0, 300);
  const { cleanQuery: seriesStrippedQuery, seriesNum } = parseSeriesFromQuery(rawQuery);
  const cleanQuery = seriesStrippedQuery;
  const seriesOptions = seriesNum ? { seriesNum } : {};
  const isbn = normalizeIsbn(cleanQuery);
  if (isbn || requestedMode === "isbn") {
    return makePlan({
      query: rawQuery,
      requestedMode,
      resolvedMode: "isbn",
      canonicalQuery: isbn || cleanQuery,
      displayLabel: isbn ? `ISBN ${isbn}` : cleanQuery,
      confidence: isbn ? 100 : 45,
      source: "isbn",
      explanation: isbn
        ? "resolver.isbn_recognized"
        : "resolver.isbn_invalid_mode",
      ...seriesOptions
    });
  }

  const useRussianCuratedEarly = editionPreferRussian(cleanQuery, settings.preferRussian, settings.uiLocale);
  if (requestedMode === "auto" && useRussianCuratedEarly) {
    const curatedEarly = curatedAuthorResolution(cleanQuery);
    if (curatedEarly) {
      return authorSearchPlan(
        rawQuery,
        requestedMode,
        {
          name: curatedEarly.name,
          aliases: curatedEarly.aliases,
          confidence: curatedEarly.confidence,
          source: "curated",
          wikidataId: curatedEarly.wikidataId
        },
        settings,
        tokens(cleanQuery).length === 1
          ? "resolver.author_curated_early"
          : "resolver.author_curated"
      );
    }
    if (tokens(cleanQuery).length >= 2) {
      const inpxAuthor = inpxAuthorResolution(cleanQuery, settings);
      if (inpxAuthor) {
        return authorSearchPlan(
          rawQuery,
          requestedMode,
          inpxAuthor,
          settings,
          "resolver.author_local_index"
        );
      }
    }
  }

  if (requestedMode === "auto" && looksLikePersonalName(cleanQuery) && !useRussianCuratedEarly) {
    const author = await resolveAuthor(cleanQuery, settings);
    if (author && author.confidence >= 70) {
      return authorSearchPlan(
        cleanQuery,
        requestedMode,
        author,
        settings,
        "resolver.author_name_fast"
      );
    }
  }

  if (requestedMode === "author") {
    const useRussianCurated = editionPreferRussian(cleanQuery, settings.preferRussian, settings.uiLocale);
    const curatedFirst = useRussianCurated ? curatedAuthorResolution(cleanQuery) : null;
    if (curatedFirst) {
      return authorSearchPlan(
        cleanQuery,
        requestedMode,
        {
          name: curatedFirst.name,
          aliases: curatedFirst.aliases,
          confidence: curatedFirst.confidence,
          source: "curated",
          wikidataId: curatedFirst.wikidataId
        },
        settings,
        "resolver.author_curated"
      );
    }
    const author = await resolveAuthor(cleanQuery, settings);
    const curated = useRussianCurated && (!author || author.confidence < 72)
      ? curatedAuthorResolution(cleanQuery)
      : null;
    const resolvedAuthor = author && (!curated || author.confidence >= curated.confidence + 6)
      ? author
      : curated
        ? {
            name: curated.name,
            aliases: curated.aliases,
            confidence: curated.confidence,
            source: "curated" as const,
            wikidataId: curated.wikidataId
          }
        : author;
    return authorSearchPlan(
      cleanQuery,
      requestedMode,
      resolvedAuthor,
      settings,
      resolvedAuthor?.source === "curated"
        ? "resolver.author_curated"
        : resolvedAuthor?.key
          ? "resolver.author_open_library"
          : "resolver.author_fallback"
    );
  }

  if (requestedMode === "auto" && tokens(cleanQuery).length >= 2 && tokens(cleanQuery).length <= 6 && !looksLikePersonalName(cleanQuery)) {
    const combined = await resolveCombined(cleanQuery, settings);
    if (combined?.author) {
      const { titlePart } = combined.split;
      const curatedWork = titlePart ? findCuratedWork(titlePart, combined.author.name) : null;
      const work: WorkResolution | null = curatedWork
        ? {
            label: curatedWork.work.en || curatedWork.work.ru,
            aliases: unique([curatedWork.work.ru, curatedWork.work.en, curatedWork.work.de].filter(Boolean) as string[], 8),
            authorNames: [combined.author.name],
            confidence: 92,
            wikidataId: combined.author.wikidataId
          }
        : titlePart
          ? await resolveWork(titlePart, settings)
          : null;
      const titleResolved = Boolean(work && work.confidence >= 64);
      const authorMatchesQuery = unique([
        combined.author.name,
        ...(combined.author.aliases || []),
        cleanQuery
      ], 12).some((name) => authorNameMatchesQuery(name, cleanQuery));

      if (titleResolved && !authorMatchesQuery) {
        return makePlan({
          query: cleanQuery,
          requestedMode,
          resolvedMode: "title",
          canonicalQuery: work!.label,
          displayLabel: `${work!.label} — ${combined.author.name}`,
          aliases: work!.aliases,
          confidence: Math.min(98, Math.round(((work!.confidence) + combined.author.confidence) / 2)),
          source: "combined",
          explanation: "resolver.combined_title_author",
          author: combined.author,
          titleAliases: work!.aliases || [titlePart],
          wikidataId: work!.wikidataId
        });
      }
      if (authorMatchesQuery) {
        const author = authorNameMatchesQuery(combined.author.name, cleanQuery)
          ? combined.author
          : (await resolveAuthor(cleanQuery, settings)) || combined.author;
        return authorSearchPlan(
          cleanQuery,
          requestedMode,
          author,
          settings,
          "resolver.author_name"
        );
      }
    }
  }

  if (requestedMode === "title") {
    const work = await resolveWork(cleanQuery, settings);
    let author: AuthorResolution | null = null;
    if (work?.authorNames[0]) author = await resolveAuthor(work.authorNames[0], settings);
    return makePlan({
      query: cleanQuery,
      requestedMode,
      resolvedMode: "title",
      canonicalQuery: work?.label || cleanQuery,
      displayLabel: work?.label || cleanQuery,
      aliases: work?.aliases,
      confidence: work?.confidence || 50,
      source: work ? "wikidata" : "literal",
      explanation: work
        ? "resolver.title_wikidata"
        : "resolver.title_literal",
      author,
      titleAliases: work?.aliases,
      wikidataId: work?.wikidataId
    });
  }

  const [fullAuthor, fullWork] = await Promise.all([
    resolveAuthor(cleanQuery, settings),
    resolveWork(cleanQuery, settings)
  ]);

  const queryWordCount = tokens(cleanQuery).length;
  const personalNameQuery = looksLikePersonalName(cleanQuery);
  const workExactMatch = Boolean(
    fullWork && hasExactCatalogTerm(cleanQuery, [fullWork.label, ...fullWork.aliases])
  );
  const biographyAboutSubject = Boolean(fullWork && isBookAboutQuerySubject(fullWork, cleanQuery));

  if (fullAuthor && fullAuthor.confidence >= 68) {
    const preferAuthor = biographyAboutSubject
      || (
        personalNameQuery
        && queryWordCount <= 4
        && (!fullWork || fullAuthor.confidence >= fullWork.confidence - 12)
      );
    if (preferAuthor) {
      return authorSearchPlan(
        cleanQuery,
        requestedMode,
        fullAuthor,
        settings,
        biographyAboutSubject ? "resolver.author_over_biography" : "resolver.author_name"
      );
    }
  }

  const workClearlyWins = Boolean(
    fullWork &&
    !biographyAboutSubject &&
    !(personalNameQuery && fullAuthor && fullAuthor.confidence >= fullWork.confidence - 8) &&
    fullWork.confidence >= 68 &&
    (
      !fullAuthor ||
      fullWork.confidence >= fullAuthor.confidence + 4 ||
      (workExactMatch && fullWork.confidence >= fullAuthor.confidence - 6) ||
      (queryWordCount >= 3 && fullWork.confidence >= 82 && fullWork.confidence >= fullAuthor.confidence - 2)
    )
  );

  if (workClearlyWins && fullWork) {
    let author: AuthorResolution | null = null;
    if (fullWork.authorNames[0]) author = await resolveAuthor(fullWork.authorNames[0], settings);
    return makePlan({
      query: cleanQuery,
      requestedMode,
      resolvedMode: "title",
      canonicalQuery: fullWork.label,
      displayLabel: fullWork.label,
      aliases: fullWork.aliases,
      confidence: fullWork.confidence,
      source: "wikidata",
      explanation: "resolver.title_over_author",
      author,
      titleAliases: fullWork.aliases,
      wikidataId: fullWork.wikidataId
    });
  }

  const useRussianCurated = editionPreferRussian(cleanQuery, settings.preferRussian, settings.uiLocale);
  const curated = useRussianCurated ? curatedAuthorResolution(cleanQuery) : null;
  if (curated && (!fullAuthor || fullAuthor.confidence < 72)) {
    return authorSearchPlan(
      cleanQuery,
      requestedMode,
      {
        name: curated.name,
        aliases: curated.aliases,
        confidence: curated.confidence,
        source: "curated",
        wikidataId: curated.wikidataId
      },
      settings,
      "resolver.author_curated_priority"
    );
  }

  if (fullAuthor && fullAuthor.confidence >= (personalNameQuery && queryWordCount <= 3 ? 72 : queryWordCount >= 3 ? 84 : workExactMatch ? 92 : 76)) {
    if (!(workExactMatch && fullWork && fullWork.confidence >= fullAuthor.confidence - 6)) {
      return authorSearchPlan(
        cleanQuery,
        requestedMode,
        fullAuthor,
        settings,
        "resolver.author_name"
      );
    }
  }

  if (fullWork && fullWork.confidence >= 64) {
    let author: AuthorResolution | null = null;
    if (fullWork.authorNames[0]) author = await resolveAuthor(fullWork.authorNames[0], settings);
    return makePlan({
      query: cleanQuery,
      requestedMode,
      resolvedMode: "title",
      canonicalQuery: fullWork.label,
      displayLabel: fullWork.label,
      aliases: fullWork.aliases,
      confidence: fullWork.confidence,
      source: "wikidata",
      explanation: "resolver.title_translations",
      author,
      titleAliases: fullWork.aliases,
      wikidataId: fullWork.wikidataId
    });
  }

  return makePlan({
    query: cleanQuery,
    requestedMode,
    resolvedMode: "general",
    canonicalQuery: cleanQuery,
    displayLabel: cleanQuery,
    confidence: 40,
    source: "literal",
    explanation: "resolver.general_literal"
  });
}

export async function resolveSearchQuery(
  query: string,
  requestedMode: OnlineSearchMode,
  settings: InternalSettings
): Promise<ResolvedSearchPlan> {
  const cached = getCachedResolution(query, requestedMode);
  if (cached) return cached;
  const resolved = await resolveSearchQueryUncached(query, requestedMode, settings);
  setCachedResolution(query, requestedMode, resolved);
  return resolved;
}

const workWikidataMemo = new Map<string, { expiresAt: number; value: Promise<string | undefined> }>();

function normalizeWorkTitle(value: string) {
  return normalize(value).replace(/^(the|a|an)\s+/, "");
}

/** Resolve a literary work Q-id for cross-catalog dedupe (EN search). */
export async function lookupWorkWikidataId(
  title: string,
  author: string,
  settings: InternalSettings
): Promise<string | undefined> {
  const memoKey = `${normalizeWorkTitle(title)}|${tokens(author).slice(-2).join(" ")}`;
  const cached = workWikidataMemo.get(memoKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = (async () => {
    const query = `${title} ${author}`.trim();
    if (!query) return undefined;
    const entities = await findWikidataEntities(query, settings).catch(() => [] as WikidataEntity[]);
    const wanted = normalizeWorkTitle(title);
    let best: { id: string; score: number } | undefined;
    for (const entity of entities) {
      if (!isWorkEntity(entity)) continue;
      for (const label of entityTerms(entity, title)) {
        const normalizedLabel = normalizeWorkTitle(label);
        const score = normalizedLabel === wanted
          ? 100
          : normalizedLabel.includes(wanted) || wanted.includes(normalizedLabel)
            ? 78
            : Math.round(textCoverage(title, label) * 70);
        if (!best || score > best.score) best = { id: entity.id!, score };
      }
    }
    return best && best.score >= 65 ? best.id : undefined;
  })();

  workWikidataMemo.set(memoKey, { expiresAt: Date.now() + 12 * 60 * 60_000, value });
  return value;
}

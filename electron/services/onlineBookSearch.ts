import { createHash } from "node:crypto";
import type {
  BookInput,
  BookProvider,
  CoverOption,
  OnlineBookCandidate,
  OnlineBookEdition,
  OnlineBookPreview,
  OnlineEditionSelection,
  OnlineSearchRequest,
  OnlineSearchResponse,
  ProviderDiagnostic,
  ProviderReference
} from "../../src/shared/types";
import { cleanBookDescription, normalizeBookSubtitle } from "../../src/shared/textCleanup";
import { MISSING_AUTHOR } from "../../src/shared/authorSentinel";
import { normalizeGenreList } from "../../src/shared/genreCodes";
import { isQuickAddCandidate, isCatalogJunkCandidate, hasCatalogCover } from "../../src/shared/searchCodes";
import { pickDefaultEdition, preferredEditionLanguages, preferredCoverRemoteUrls, editionCoverRemoteUrls, editionMatchesCover, coverCatalogKey } from "../../src/shared/editionSelection";
import { isLocalCoverUrl } from "../../src/shared/coverScheme";
import { APP_USER_AGENT } from "../../src/shared/appMeta";
import { cacheRemoteCover, verifyRemoteCoverUrl, isTrustedCoverHostUrl } from "./coverCache";
import { describeNetworkError, fetchJson, fetchResponse } from "./networkClient";
import { getCachedSearch, setCachedSearch } from "./searchCache";
import { getInternalSettings, type InternalSettings } from "./settingsService";
import { resolveSearchQuery, type ResolvedSearchPlan } from "./queryResolver";
import { diagnoseFantLab, enrichFantLabEditions, lookupFantLabWorkByTitleAuthor, resolveFantLabWork, searchFantLab, fetchFantLabWorkCatalogMeta } from "./fantlabSearch";
import { diagnoseGutendex, searchGutendex } from "./gutendexSearch";
import { diagnoseHardcover, searchHardcover } from "./hardcoverSearch";
import { buildCuratedWorkCandidates, isCuratedReference, listCuratedCatalogRows } from "./russianWorksIndex";
import {
  buildInpxWorkCandidates,
  collectInpxWorkHits,
  inpxDuplicatesLiveCatalog,
  isInpxReference
} from "./inpxCatalog";
import { editionPreferRussian, queryUsesLatin, queryUsesCyrillic, catalogMatchesPreference } from "../../src/shared/searchEditionLanguage";
import { latinSearchVariants } from "./searchLatin";
import { normalizedEditionLanguage } from "../../src/shared/editionSelection";
import {
  searchOpenLibraryLocalIndex,
  upsertOpenLibraryIndexDocs,
  getOpenLibraryIndexInfo,
  type OpenLibraryIndexDoc
} from "./openLibraryLocalIndex";

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  author_key?: string[];
  first_publish_year?: number;
  edition_count?: number;
  language?: string[];
  subject?: string[];
  cover_i?: number;
  ratings_average?: number;
  ratings_count?: number;
  want_to_read_count?: number;
  currently_reading_count?: number;
  already_read_count?: number;
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibraryDoc[];
}

interface OpenLibraryTextValue {
  value?: string;
}

interface OpenLibraryWork {
  key?: string;
  title?: string;
  description?: string | OpenLibraryTextValue;
  subjects?: string[];
  covers?: number[];
  first_publish_date?: string;
  original_languages?: Array<{ key?: string }>;
}

interface OpenLibraryEdition {
  key?: string;
  title?: string;
  subtitle?: string;
  publish_date?: string;
  publishers?: string[];
  number_of_pages?: number;
  languages?: Array<{ key?: string }>;
  isbn_10?: string[];
  isbn_13?: string[];
  covers?: number[];
  description?: string | OpenLibraryTextValue;
  authors?: Array<{ key?: string }>;
  works?: Array<{ key?: string }>;
}

interface OpenLibraryEditionsResponse {
  entries?: OpenLibraryEdition[];
}

interface OpenLibraryAuthorWorksResponse {
  entries?: OpenLibraryWork[];
}

interface GoogleVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  description?: string;
  industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
  pageCount?: number;
  mainCategory?: string;
  categories?: string[];
  imageLinks?: {
    smallThumbnail?: string;
    thumbnail?: string;
    small?: string;
    medium?: string;
    large?: string;
    extraLarge?: string;
  };
  language?: string;
  infoLink?: string;
  canonicalVolumeLink?: string;
}

interface GoogleVolume {
  id?: string;
  volumeInfo?: GoogleVolumeInfo;
}

interface GoogleBooksResponse {
  items?: GoogleVolume[];
}

interface ProviderResult {
  provider: BookProvider;
  results: OnlineBookCandidate[];
  durationMs: number;
}

interface ResolvedProviderWork {
  work: Partial<OnlineBookCandidate>;
  editions: OnlineBookEdition[];
  hasMoreEditions?: boolean;
}

export type ResolveOnlineWorkMode = "preview" | "quick";

export interface ResolveOnlineWorkOptions {
  mode?: ResolveOnlineWorkMode;
  editionOffset?: number;
}

const PREVIEW_EDITION_LIMIT = 15;
const QUICK_EDITION_LIMIT = 3;
const RESOLVE_PREVIEW_CACHE_MS = 12 * 60_000;

const resolvePreviewCache = new Map<string, { expiresAt: number; value: OnlineBookPreview }>();

function readResolvePreviewCache(key: string) {
  const cached = resolvePreviewCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    resolvePreviewCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function writeResolvePreviewCache(key: string, value: OnlineBookPreview) {
  resolvePreviewCache.set(key, { expiresAt: Date.now() + RESOLVE_PREVIEW_CACHE_MS, value });
}

const OPEN_LIBRARY_FIELDS = [
  "key",
  "title",
  "author_name",
  "author_key",
  "first_publish_year",
  "edition_count",
  "language",
  "subject",
  "cover_i",
  "ratings_average",
  "ratings_count",
  "want_to_read_count",
  "currently_reading_count",
  "already_read_count"
].join(",");

const STOP_WORDS = new Set([
  "и", "в", "на", "с", "к", "о", "об", "для", "из", "по", "а", "но",
  "the", "a", "an", "of", "and", "der", "die", "das", "und", "von"
]);

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
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function uniqueStrings(values: Array<string | undefined | null>, limit = 30) {
  const seen = new Set<string>();
  const result: string[] = [];
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

function normalizeIsbn(value?: string) {
  const normalized = value?.replace(/[^0-9X]/gi, "").toUpperCase();
  return normalized && (normalized.length === 10 || normalized.length === 13)
    ? normalized
    : undefined;
}

function detectIsbn(query: string) {
  return normalizeIsbn(query);
}

function catalogJsonFetch<T>(url: string, settings: InternalSettings, retries = 1) {
  return fetchJson<T>(url, {
    timeoutMs: settings.requestTimeoutMs,
    retries,
    preferNodeTransport: true,
    headers: {
      Accept: "application/json",
      "User-Agent": APP_USER_AGENT
    }
  });
}

function shouldUseOpenLibrarySearch(
  settings: InternalSettings,
  mode: OnlineSearchRequest["mode"],
  plan?: ResolvedSearchPlan
) {
  if (mode === "isbn") return true;
  if (plan?.source === "combined") return true;
  return !settings.preferRussian;
}

function parseYear(value?: string | number | null) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (!value) return null;
  const match = String(value).match(/(?:1[0-9]{3}|20[0-9]{2}|2100)/);
  return match ? Number(match[0]) : null;
}

function normalizedHttps(value?: string) {
  if (!value) return undefined;
  return value.replace(/^http:\/\//i, "https://");
}

function textValue(value?: string | OpenLibraryTextValue) {
  const raw = typeof value === "string" ? value : value?.value;
  return raw ? repairTextEncoding(raw) : undefined;
}

function pickCleanDescription(...candidates: (string | undefined)[]) {
  const cleaned = candidates
    .filter((value): value is string => Boolean(value))
    .map((value) => cleanBookDescription(value))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return cleaned[0];
}

function repairTextEncoding(value: string) {
  if (!value || !/Р[А-Яа-яЁё]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (/[\u0400-\u04FF]/.test(repaired) && !/Р[А-Яа-яЁё]{2,}/.test(repaired)) {
      return repaired;
    }
  } catch {
    // Оставляем исходную строку.
  }
  return value;
}

function coverage(queryTokens: string[], haystack: string) {
  if (queryTokens.length === 0) return 0;
  const haystackTokens = new Set(tokens(haystack));
  const normalizedHaystack = normalize(haystack);
  const matched = queryTokens.filter((token) =>
    haystackTokens.has(token) || normalizedHaystack.includes(token)
  ).length;
  return matched / queryTokens.length;
}

function authorTokenCoverage(queryTokens: string[], haystack: string) {
  if (queryTokens.length === 0) return 0;
  const haystackTokens = new Set(tokens(haystack));
  const matched = queryTokens.filter((token) => haystackTokens.has(token)).length;
  return matched / queryTokens.length;
}

function languageCode(value?: string) {
  const normalized = normalize(value || "");
  if (["ru", "rus", "russian"].includes(normalized)) return "ru";
  if (["en", "eng", "english"].includes(normalized)) return "en";
  if (["de", "deu", "ger", "german"].includes(normalized)) return "de";
  if (["fr", "fra", "fre", "french"].includes(normalized)) return "fr";
  if (["es", "spa", "spanish"].includes(normalized)) return "es";
  if (["it", "ita", "italian"].includes(normalized)) return "it";
  return value?.trim().toLowerCase();
}

function openLibraryLanguage(edition: OpenLibraryEdition) {
  const key = edition.languages?.[0]?.key || "";
  return languageCode(key.split("/").pop());
}

function hasCyrillic(value: string) {
  return /\p{Script=Cyrillic}/u.test(value);
}

function hasLatin(value: string) {
  return /[A-Za-z]/.test(value);
}

function scriptConsistency(title: string, language?: string) {
  if (language === "ru" && hasLatin(title) && !hasCyrillic(title)) return -35;
  if (["de", "en", "fr", "es", "it"].includes(language || "") && hasCyrillic(title) && !hasLatin(title)) {
    return -20;
  }
  return 0;
}

const GENRE_RULES: Array<[RegExp, string]> = [
  [/science fiction|научн\w* фантаст/i, "science_fiction"],
  [/fantasy|фэнтези/i, "fantasy"],
  [/philosoph|философ/i, "philosophy"],
  [/ethic|этик/i, "ethics"],
  [/politic|полит/i, "politics"],
  [/classic|классичес/i, "classics"],
  [/fiction|novel|роман|художествен/i, "fiction"],
  [/histor|истор/i, "history"],
  [/psycholog|психолог/i, "psychology"],
  [/relig|christian|buddh|ислам|религ/i, "religion"],
  [/detective|crime|mystery|детектив/i, "detective"],
  [/biograph|memoir|биограф|мемуар/i, "biography"],
  [/poetry|poems|поэз|стих/i, "poetry"],
  [/drama|plays|драматург/i, "drama"],
  [/children|juvenile|детск/i, "children"],
  [/self help|self-help|саморазвит/i, "self_help"],
  [/econom|эконом/i, "economics"],
  [/sociolog|социолог/i, "sociology"],
  [/law|legal|право|юрид/i, "law"],
  [/computer|programming|technology|технолог|программ/i, "technology"],
  [/art|искусств/i, "art"],
  [/science|наук/i, "science"]
];

function normalizeGenres(subjects: string[], limit = 8) {
  const mapped: string[] = [];
  for (const subject of subjects.map(repairTextEncoding)) {
    for (const [pattern, label] of GENRE_RULES) {
      if (pattern.test(subject)) mapped.push(label);
    }
    if (/german literature|немецк\w* литератур/i.test(subject)) mapped.push("german_literature");
    if (/russian literature|русск\w* литератур/i.test(subject)) mapped.push("russian_literature");
  }

  const normalized = uniqueStrings(mapped, limit);
  if (normalized.length > 0) return normalized;

  return uniqueStrings(
    subjects
      .filter((subject) => subject.length <= 48)
      .filter((subject) => !/--|\d{3,}|\([^)]{10,}\)/.test(subject))
      .map((subject) => subject.replace(/\.$/, "").trim()),
    Math.min(4, limit)
  );
}

function candidateId(references: ProviderReference[], title: string, author: string) {
  return createHash("sha1")
    .update(`${references.map((item) => `${item.provider}:${item.kind}:${item.externalId}`).join("|")}|${title}|${author}`)
    .digest("hex")
    .slice(0, 20);
}

function editionId(reference: ProviderReference, isbn?: string) {
  return createHash("sha1")
    .update(`${reference.provider}:${reference.kind}:${reference.externalId}:${isbn || ""}`)
    .digest("hex")
    .slice(0, 20);
}

function scoreWorkCandidate(
  query: string,
  candidate: Pick<OnlineBookCandidate, "title" | "author" | "languages" | "coverUrl" | "editionCount">,
  mode: "general" | "title" | "author" | "isbn",
  preferRussian: boolean
) {
  const normalizedQuery = normalize(query);
  const queryTokens = tokens(query);
  const normalizedTitle = normalize(candidate.title);
  const normalizedAuthor = normalize(candidate.author);
  const titleCoverage = coverage(queryTokens, candidate.title);
  const authorCoverage = coverage(queryTokens, candidate.author);
  const combinedCoverage = coverage(queryTokens, `${candidate.title} ${candidate.author}`);

  let score = mode === "isbn" ? 1200 : 0;
  if (isCatalogJunkCandidate(candidate)) score -= 2500;
  if (normalizedTitle === normalizedQuery) score += 1000;
  if (normalizedAuthor === normalizedQuery) score += 900;
  if (normalizedTitle.startsWith(normalizedQuery)) score += 520;
  if (normalizedAuthor.startsWith(normalizedQuery)) score += 450;
  if (normalizedQuery.length > 2 && normalizedTitle.includes(normalizedQuery)) score += 360;
  if (normalizedQuery.length > 2 && normalizedAuthor.includes(normalizedQuery)) score += 400;
  score += titleCoverage * 360;
  score += authorCoverage * 320;
  score += combinedCoverage * 170;

  if (mode === "title") score += titleCoverage * 180;
  if (mode === "author") score += authorCoverage * 220;
  if (queryTokens.length > 1 && combinedCoverage < 0.5) score -= 240;
  if (titleCoverage === 0 && authorCoverage === 0) score -= 600;
  if (/автор не указан/i.test(candidate.author)) score -= 120;
  if (preferRussian && candidate.languages.some((item) => languageCode(item) === "ru")) score += 28;
  if (!preferRussian && candidate.languages.some((item) => languageCode(item) === "en")) score += 28;
  if (!preferRussian && queryUsesCyrillic(query) === false && queryUsesCyrillic(candidate.title)
    && !candidate.languages.some((item) => languageCode(item) === "en")) {
    score -= 320;
  }
  if (candidate.coverUrl) score += 4;
  score += Math.min(20, Math.log2(Math.max(1, candidate.editionCount)) * 3);

  return Math.round(score * 100) / 100;
}

function workCompleteness(candidate: Partial<OnlineBookCandidate>) {
  const fields = [
    candidate.firstPublishedYear,
    candidate.editionCount,
    candidate.languages?.length,
    candidate.description,
    candidate.coverUrl,
    candidate.genres?.length
  ];
  return fields.reduce<number>((sum, value) => sum + (value ? 1 : 0), 0);
}

function editionCompleteness(edition: Partial<OnlineBookEdition>) {
  const fields = [
    edition.subtitle,
    edition.publisher,
    edition.pageCount,
    edition.language,
    edition.isbn13 || edition.isbn10,
    edition.coverOptions?.length,
    edition.year
  ];
  return Math.round((fields.reduce<number>((sum, value) => sum + (value ? 1 : 0), 0) / fields.length) * 100);
}

function openLibraryCoverById(coverId?: number) {
  return coverId && coverId > 0
    ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`
    : undefined;
}

function openLibraryCoverByOlid(olid?: string) {
  const normalized = olid?.replace(/^\/books\//, "");
  return normalized
    ? `https://covers.openlibrary.org/b/olid/${encodeURIComponent(normalized)}-L.jpg?default=false`
    : undefined;
}

function openLibraryCoverByIsbn(isbn?: string, size: "L" | "M" | "S" = "L") {
  return isbn
    ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-${size}.jpg?default=false`
    : undefined;
}

function openLibraryWorkUrl(key?: string) {
  return key ? `https://openlibrary.org${key}` : undefined;
}

function mapOpenLibraryDoc(
  doc: OpenLibraryDoc,
  query: string,
  settings: InternalSettings,
  mode: "general" | "title" | "author" | "isbn"
): OnlineBookCandidate | null {
  if (!doc.key || !doc.title) return null;
  const reference: ProviderReference = {
    provider: "open-library",
    externalId: doc.key,
    kind: "work"
  };
  const subjects = uniqueStrings(doc.subject || [], 40);
  const remoteCover = openLibraryCoverById(doc.cover_i);
  const candidate: OnlineBookCandidate = {
    id: candidateId([reference], doc.title, doc.author_name?.join(", ") || ""),
    providers: ["open-library"],
    references: [reference],
    title: doc.title,
    originalTitle: doc.title,
    alternateTitles: [doc.title],
    author: doc.author_name?.slice(0, 4).join(", ") || MISSING_AUTHOR,
    firstPublishedYear: doc.first_publish_year ?? null,
    editionCount: Math.max(0, doc.edition_count || 0),
    listedEditionCount: null,
    languages: uniqueStrings((doc.language || []).map((item) => languageCode(item)), 12),
    genres: normalizeGenres(subjects),
    subjects,
    coverUrl: remoteCover,
    coverRemoteUrl: remoteCover,
    coverKey: doc.cover_i && doc.cover_i > 0 ? `id:${doc.cover_i}` : undefined,
    sourceUrl: openLibraryWorkUrl(doc.key),
    score: 0,
    completeness: 0,
    authorKeys: uniqueStrings(doc.author_key || [], 8),
    popularity: Math.round(
      Math.log2(1 + Math.max(0, doc.edition_count || 0)) * 20
      + Math.log2(1 + Math.max(0, doc.ratings_count || 0)) * 14
      + Math.log2(1 + Math.max(0, doc.want_to_read_count || 0)) * 8
      + Math.log2(1 + Math.max(0, doc.already_read_count || 0)) * 6
      + Math.log2(1 + Math.max(0, doc.currently_reading_count || 0)) * 4
    )
  };
  candidate.score = scoreWorkCandidate(query, candidate, mode, settings.preferRussian);
  candidate.completeness = workCompleteness(candidate);
  return candidate;
}

async function openLibraryRequest(
  parameters: Record<string, string>,
  limit: number,
  settings: InternalSettings
) {
  const url = new URL("https://openlibrary.org/search.json");
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", OPEN_LIBRARY_FIELDS);
  if (settings.preferRussian) url.searchParams.set("lang", "ru");
  else url.searchParams.set("lang", "en");

  const data = await catalogJsonFetch<OpenLibrarySearchResponse>(url.toString(), settings, 2);
  return data.docs || [];
}


async function openLibraryAuthorWorks(
  authorKey: string,
  authorName: string,
  settings: InternalSettings,
  limit: number
) {
  const normalizedKey = authorKey.replace(/^\/authors\//, "");
  const url = new URL(`https://openlibrary.org/authors/${encodeURIComponent(normalizedKey)}/works.json`);
  url.searchParams.set("limit", String(Math.min(200, limit)));
  const data = await catalogJsonFetch<OpenLibraryAuthorWorksResponse>(url.toString(), settings, 2);
  return (data.entries || [])
    .filter((work) => work.key && work.title)
    .map((work): OpenLibraryDoc => ({
      key: work.key,
      title: work.title,
      author_name: [authorName],
      author_key: [normalizedKey],
      first_publish_year: parseYear(work.first_publish_date) ?? undefined,
      edition_count: 1,
      subject: work.subjects,
      cover_i: work.covers?.find((coverId) => coverId > 0)
    }));
}

function providerPriority(candidate: OnlineBookCandidate, preferRussian: boolean) {
  if (preferRussian) {
    if (candidate.providers.includes("fantlab")) return 5;
    if (candidate.providers.includes("open-library")) return 4;
    if (candidate.providers.includes("google-books")) return 3;
    if (candidate.providers.includes("hardcover")) return 2;
    if (candidate.providers.includes("gutendex")) return 1;
    return 0;
  }
  if (candidate.providers.includes("hardcover")) return 5;
  if (candidate.providers.includes("google-books")) return 4;
  if (candidate.providers.includes("open-library")) return 3;
  if (candidate.providers.includes("gutendex")) return 2;
  if (candidate.providers.includes("fantlab")) return 1;
  return 0;
}

function mergeProviderBonus(candidate: OnlineBookCandidate, preferRussian: boolean) {
  if (preferRussian) {
    if (candidate.providers.includes("fantlab")) return 24;
    if (candidate.providers.includes("open-library")) return 16;
    if (candidate.providers.includes("google-books")) return 12;
    if (candidate.providers.includes("hardcover")) return 8;
    if (candidate.providers.includes("gutendex")) return 6;
    return 4;
  }
  if (candidate.providers.includes("hardcover")) return 24;
  if (candidate.providers.includes("google-books")) return 20;
  if (candidate.providers.includes("open-library")) return 16;
  if (candidate.providers.includes("gutendex")) return 12;
  if (candidate.providers.includes("fantlab")) return 8;
  return 4;
}

function pickListedEditionCount(left?: number | null, right?: number | null) {
  const values = [left, right].filter((value): value is number => typeof value === "number" && value > 0);
  return values.length ? Math.max(...values) : null;
}

function mergeWorkCandidates(left: OnlineBookCandidate, right: OnlineBookCandidate, preferRussian: boolean) {
  if (preferRussian) {
    const leftFantLab = left.providers.includes("fantlab");
    const rightFantLab = right.providers.includes("fantlab");
    if (leftFantLab && !rightFantLab) return left;
    if (rightFantLab && !leftFantLab) return right;
  } else {
    const leftOl = left.providers.includes("open-library");
    const rightOl = right.providers.includes("open-library");
    if (leftOl && !rightOl) return left;
    if (rightOl && !leftOl) return right;
  }

  const references = [...left.references];
  for (const reference of right.references) {
    if (!references.some((item) =>
      item.provider === reference.provider &&
      item.kind === reference.kind &&
      item.externalId === reference.externalId
    )) references.push(reference);
  }
  const leftPriority = providerPriority(left, preferRussian);
  const rightPriority = providerPriority(right, preferRussian);
  const stronger = right.score > left.score || (right.score === left.score && rightPriority > leftPriority) ? right : left;
  const weaker = stronger === left ? right : left;
  const merged: OnlineBookCandidate = {
    ...stronger,
    id: candidateId(references, stronger.title, stronger.author),
    providers: uniqueStrings([...left.providers, ...right.providers]) as BookProvider[],
    references,
    alternateTitles: uniqueStrings([...(left.alternateTitles || []), ...(right.alternateTitles || []), left.title, right.title], 30),
    firstPublishedYear:
      left.firstPublishedYear && right.firstPublishedYear
        ? Math.min(left.firstPublishedYear, right.firstPublishedYear)
        : left.firstPublishedYear ?? right.firstPublishedYear,
    editionCount: Math.max(left.editionCount, right.editionCount),
    listedEditionCount: pickListedEditionCount(left.listedEditionCount, right.listedEditionCount),
    wikidataId: left.wikidataId || right.wikidataId,
    languages: uniqueStrings([...left.languages, ...right.languages], 16),
    subjects: uniqueStrings([...left.subjects, ...right.subjects], 50),
    genres: normalizeGenres([...left.subjects, ...right.subjects]),
    description:
      (right.description?.length || 0) > (left.description?.length || 0)
        ? right.description
        : left.description,
    coverUrl: stronger.coverUrl || weaker.coverUrl,
    coverRemoteUrl: stronger.coverRemoteUrl || weaker.coverRemoteUrl,
    coverKey: stronger.coverKey || weaker.coverKey,
    sourceUrl: stronger.sourceUrl || weaker.sourceUrl,
    score: Math.max(left.score, right.score) + mergeProviderBonus(stronger, preferRussian),
    completeness: 0,
    authorKeys: uniqueStrings([...(left.authorKeys || []), ...(right.authorKeys || [])], 12),
    popularity: Math.max(left.popularity || 0, right.popularity || 0),
    matchConfidence: stronger.matchConfidence || left.matchConfidence || right.matchConfidence,
    matchReasons: uniqueStrings([...(left.matchReasons || []), ...(right.matchReasons || [])], 8)
  };
  merged.completeness = workCompleteness(merged);
  return merged;
}

function normalizeAuthorKey(value?: string) {
  return value?.replace(/^\/authors\//, "").trim();
}

function isPoetryCatalogCandidate(candidate: OnlineBookCandidate) {
  const tags = uniqueStrings([...candidate.genres, ...candidate.subjects], 12).join(" ").toLowerCase();
  return /стихотвор|поэз|poem|poetry|verse|стих\b/.test(tags);
}

function planCandidateScore(candidate: OnlineBookCandidate, plan: ResolvedSearchPlan, settings: InternalSettings) {
  const authorKey = normalizeAuthorKey(plan.authorKey);
  const candidateAuthorKeys = (candidate.authorKeys || []).map(normalizeAuthorKey).filter(Boolean);
  const exactAuthorKey = Boolean(authorKey && candidateAuthorKeys.includes(authorKey));
  const authorVariants = uniqueStrings([plan.authorName, ...(plan.authorVariants || [])], 20);
  const authorMatch = Math.max(0, ...authorVariants.map((value) => authorTokenCoverage(tokens(value), candidate.author)));
  const titleVariants = uniqueStrings([plan.canonicalQuery, ...(plan.titleVariants || []), plan.originalQuery], 16);
  const titleScores = titleVariants.map((value) => {
    const normalizedVariant = normalize(value);
    const normalizedTitle = normalize(candidate.title);
    if (normalizedVariant && normalizedTitle === normalizedVariant) return 1000;
    if (normalizedVariant && normalizedTitle.startsWith(normalizedVariant)) return 720;
    if (normalizedVariant && normalizedTitle.includes(normalizedVariant)) return 520;
    return coverage(tokens(value), candidate.title) * 460;
  });
  const alternateScores = (candidate.alternateTitles || []).map((value) => {
    const normalizedVariant = normalize(value);
    const normalizedQuery = normalize(plan.originalQuery);
    if (normalizedVariant && normalizedQuery === normalizedVariant) return 980;
    if (normalizedVariant && normalizedQuery.includes(normalizedVariant)) return 640;
    return coverage(tokens(plan.originalQuery), value) * 420;
  });
  const titleMatch = Math.max(0, ...titleScores, ...alternateScores);
  const popularity = candidate.popularity || 0;
  let score = candidate.score;
  const reasons: string[] = [];

  if (plan.resolvedMode === "author") {
    score = 0;
    if (isCatalogJunkCandidate(candidate)) {
      score -= 2500;
    } else if (exactAuthorKey) {
      score += 1400;
      reasons.push("exact_author");
    } else if (authorMatch >= 0.98) {
      score += 900;
      reasons.push("author_match");
    } else if (authorMatch >= 0.7) {
      score += 420;
      reasons.push("author_partial");
    } else {
      score -= 1200;
    }
    score += popularity * 2.2;
    score += Math.log2(Math.max(1, candidate.editionCount)) * 46;
    if (candidate.providers.includes("fantlab")) score += 220;
    if (candidate.providers.includes("hardcover")) score += settings.preferRussian ? 40 : 160;
    if (candidate.providers.includes("gutendex")) score += settings.preferRussian ? 24 : 120;
    if (candidate.coverUrl) score += 18;
    if (settings.preferRussian && candidate.languages.some((language) => languageCode(language) === "ru")) score += 28;
    if (!settings.preferRussian && candidate.languages.some((language) => languageCode(language) === "en")) score += 28;
    if (settings.preferRussian && hasCyrillic(plan.originalQuery)) {
      if (hasCyrillic(candidate.title)) {
        score += 140;
        reasons.push("russian_title");
      } else if (!candidate.languages.some((language) => languageCode(language) === "ru")) {
        const hasRussianAlt = (candidate.alternateTitles || []).some((title) => hasCyrillic(title));
        if (!hasRussianAlt) score -= 280;
      }
      const russianHints = uniqueStrings([
        ...(plan.notableWorkTitles || []),
        ...plan.titleVariants,
        ...plan.aliases
      ], 24).filter((value) => hasCyrillic(value));
      const hintMatch = Math.max(0, ...russianHints.map((hint) => {
        const normalizedHint = normalize(hint);
        const normalizedTitle = normalize(candidate.title);
        if (normalizedHint && normalizedTitle === normalizedHint) return 1;
        if (normalizedHint && normalizedTitle.includes(normalizedHint)) return 0.82;
        return coverage(tokens(hint), candidate.title);
      }));
      if (hintMatch >= 0.82) {
        score += 220;
        reasons.push("known_work");
      }
    }
    const normalizedQuery = normalize(plan.originalQuery);
    const normalizedTitle = normalize(candidate.title);
    if (normalizedTitle === normalizedQuery && authorMatch < 0.7) {
      score -= 1600;
    }
    const notableHints = uniqueStrings(plan.notableWorkTitles || [], 16);
    if (notableHints.length > 0) {
      const notableMatch = Math.max(0, ...notableHints.map((hint) => {
        const normalizedHint = normalize(hint);
        const normalizedTitle = normalize(candidate.title);
        if (normalizedHint && normalizedTitle === normalizedHint) return 1;
        if (normalizedHint && normalizedTitle.includes(normalizedHint)) return 0.86;
        return coverage(tokens(hint), candidate.title);
      }));
      if (notableMatch >= 0.86) {
        score += 280;
        reasons.push("known_work");
      } else if (notableMatch >= 0.65) {
        score += 120;
      }
    }
    if (!candidate.coverUrl) score -= 45;
    if (candidate.editionCount === 1 && (candidate.popularity || 0) < 12) score -= 80;
  } else if (plan.resolvedMode === "title") {
    score = titleMatch;
    if (titleMatch >= 950) reasons.push("exact_title");
    else if (titleMatch >= 600) reasons.push("close_title");
    else if (titleMatch >= 300) reasons.push("partial_title");

    if (authorKey) {
      if (exactAuthorKey) {
        score += 720;
        reasons.push("exact_author");
      } else if (candidateAuthorKeys.length > 0) {
        score -= 950;
      } else if (authorMatch >= 0.98) {
        score += 500;
        reasons.push("author_match");
      } else if (authorMatch >= 0.65) {
        score += 150;
      } else {
        score -= 320;
      }
    } else if (plan.authorName) {
      if (plan.source === "combined") {
        if (authorMatch >= 0.98) {
          score += 680;
          reasons.push("author_match");
        } else if (authorMatch >= 0.55) {
          score += 120;
        } else {
          score -= 1400;
        }
      } else if (authorMatch >= 0.98) {
        score += 520;
        reasons.push("author_match");
      } else if (authorMatch >= 0.65) {
        score += 180;
      } else {
        score -= 320;
      }
    }
    score += popularity * 0.7;
    score += Math.log2(Math.max(1, candidate.editionCount)) * 18;
    if (candidate.providers.includes("fantlab")) score += 180;
    if (candidate.coverUrl) score += 8;
    if (settings.preferRussian && hasCyrillic(plan.originalQuery) && hasCyrillic(candidate.title)) score += 48;
    if (!settings.preferRussian && queryUsesLatin(plan.originalQuery) && hasLatin(candidate.title) && !hasCyrillic(candidate.title)) score += 48;
    if (!settings.preferRussian && queryUsesLatin(plan.originalQuery) && hasCyrillic(candidate.title)
      && !candidate.languages.some((language) => languageCode(language) === "en")) {
      score -= 72;
    }
    const queryNorm = normalize(plan.canonicalQuery || plan.originalQuery);
    if (candidate.matchReasons?.includes("curated_catalog") || candidate.matchReasons?.includes("known_work_curated")) {
      score += 260;
    }
    if (isPoetryCatalogCandidate(candidate) && !/стих|poem|поэз|verse/i.test(plan.originalQuery)) {
      score -= 480;
    }
    const echoedTitle = candidate.displayTitle || candidate.title;
    if (
      queryNorm
      && normalize(candidate.title) === queryNorm
      && normalize(echoedTitle) !== queryNorm
      && echoedTitle.length > queryNorm.length * 1.25
    ) {
      score -= 360;
    }
    if (!candidate.coverUrl) score -= 95;
    else score += 24;
  } else if (plan.resolvedMode === "isbn") {
    score += 1400;
    reasons.push("exact_isbn");
  } else {
    score = Math.max(
      scoreWorkCandidate(plan.originalQuery, candidate, "general", settings.preferRussian),
      scoreWorkCandidate(plan.canonicalQuery, candidate, "general", settings.preferRussian)
    );
    score += popularity * 0.5;
    if (settings.preferRussian && hasCyrillic(plan.originalQuery) && hasCyrillic(candidate.title)) score += 48;
    if (!settings.preferRussian && queryUsesLatin(plan.originalQuery) && hasLatin(candidate.title) && !hasCyrillic(candidate.title)) score += 48;
    if (!settings.preferRussian && queryUsesLatin(plan.originalQuery) && hasCyrillic(candidate.title)
      && !candidate.languages.some((language) => languageCode(language) === "en")) {
      score -= 72;
    }
    if (score > 450) reasons.push("title_or_author");
  }

  candidate.score = Math.round(score * 100) / 100;
  candidate.alternateTitles = uniqueStrings(candidate.alternateTitles || [], 30);
  candidate.matchReasons = uniqueStrings(reasons, 6);
  candidate.matchConfidence = score >= 1050 ? "high" : score >= 520 ? "medium" : "low";
  return candidate;
}

function searchEditionSettings(settings: InternalSettings, plan: ResolvedSearchPlan): InternalSettings {
  return {
    ...settings,
    preferRussian: editionPreferRussian(plan.originalQuery, settings.preferRussian, settings.uiLocale)
  };
}

function searchOpenLibraryLocalCandidates(
  plan: ResolvedSearchPlan,
  settings: InternalSettings,
  limit: number
) {
  const localQuery = plan.canonicalQuery || plan.originalQuery;
  return searchOpenLibraryLocalIndex(localQuery, limit)
    .map((doc) => mapOpenLibraryDoc(doc as OpenLibraryDoc, plan.originalQuery, settings, "general"))
    .filter((item): item is OnlineBookCandidate => Boolean(item))
    .filter((item) => !isCatalogJunkCandidate(item))
    .map((candidate) => {
      const scored = planCandidateScore(candidate, plan, settings);
      return {
        ...scored,
        score: scored.score + 85,
        matchReasons: uniqueStrings([...(scored.matchReasons || []), "local_index"], 8)
      };
    });
}

async function searchOpenLibrary(plan: ResolvedSearchPlan, settings: InternalSettings): Promise<ProviderResult> {
  const started = Date.now();
  const limit = Math.max(10, settings.searchLimit);
  const localMapped = searchOpenLibraryLocalCandidates(plan, settings, limit);

  const localReady = localMapped.length >= Math.max(8, Math.floor(limit * 0.55));
  const requests: Array<Promise<{ mode: "general" | "title" | "author" | "isbn"; docs: OpenLibraryDoc[] }>> = [];
  const seen = new Set<string>();
  const addRequest = (
    mode: "general" | "title" | "author" | "isbn",
    parameters: Record<string, string>,
    requestLimit = limit
  ) => {
    const key = JSON.stringify({ mode, parameters });
    if (seen.has(key)) return;
    seen.add(key);
    requests.push(openLibraryRequest(parameters, requestLimit, settings).then((docs) => ({ mode, docs })));
  };

  if (plan.resolvedMode === "isbn") {
    addRequest("isbn", { isbn: plan.canonicalQuery }, limit);
  } else if (localReady) {
    addRequest("general", { q: plan.canonicalQuery || plan.originalQuery }, limit);
  } else if (plan.resolvedMode === "author") {
    const authorKey = normalizeAuthorKey(plan.authorKey);
    if (authorKey) {
      addRequest("author", { q: `author_key:${authorKey}`, sort: "editions" }, limit * 2);
      if (settings.preferRussian) {
        addRequest("author", { q: `author_key:${authorKey} language:rus`, sort: "editions" }, limit * 2);
      }
      if (!settings.preferRussian) {
        requests.push(
          openLibraryAuthorWorks(authorKey, plan.authorName || plan.canonicalQuery, settings, Math.min(36, limit * 2))
            .then((docs) => ({ mode: "author" as const, docs }))
        );
      }
    } else {
      for (const author of latinSearchVariants(plan.authorName, plan.originalQuery, ...plan.authorVariants).slice(0, 2)) {
        addRequest("author", { author, sort: "editions" }, limit);
        if (settings.preferRussian) {
          addRequest("general", { q: `${author} language:rus`, sort: "editions" }, limit);
        }
      }
    }
    if (!authorKey) {
      for (const title of uniqueStrings(plan.notableWorkTitles || [], 4)) {
        addRequest("title", { title, author: plan.authorName || plan.canonicalQuery }, limit);
        if (hasCyrillic(title)) {
          addRequest("general", { q: `${title} language:rus`, sort: "editions" }, limit);
        }
      }
      if (plan.authorName && normalize(plan.authorName) === normalize(plan.originalQuery)) {
        addRequest("general", { q: plan.originalQuery, sort: "editions" }, limit);
      }
    }
  } else if (plan.resolvedMode === "title") {
    const titleVariants = uniqueStrings([plan.canonicalQuery, ...plan.titleVariants, plan.originalQuery], 4);
    const authorVariants = uniqueStrings([plan.authorName, ...plan.authorVariants], 3);
    titleVariants.forEach((title, index) => {
      addRequest("title", { title }, limit * 2);
      if (index < 2 && authorVariants[0]) {
        addRequest("title", { title, author: authorVariants[0] }, limit * 2);
      }
    });
    addRequest("general", { q: plan.originalQuery }, limit * 2);
  } else {
    addRequest("general", { q: plan.originalQuery }, limit * 2);
    addRequest("title", { title: plan.originalQuery }, limit);
    addRequest("author", { author: plan.originalQuery }, limit);
  }

  const settled = await Promise.allSettled(requests);
  const fetchedDocs = settled
    .filter((item): item is PromiseFulfilledResult<{ mode: "general" | "title" | "author" | "isbn"; docs: OpenLibraryDoc[] }> => item.status === "fulfilled")
    .flatMap((item) => item.value.docs);
  if (fetchedDocs.length) {
    upsertOpenLibraryIndexDocs(fetchedDocs as OpenLibraryIndexDoc[]);
  }
  const mapped = settled
    .filter((item): item is PromiseFulfilledResult<{ mode: "general" | "title" | "author" | "isbn"; docs: OpenLibraryDoc[] }> => item.status === "fulfilled")
    .flatMap((item) => item.value.docs.map((doc) => mapOpenLibraryDoc(doc, plan.originalQuery, settings, item.value.mode)))
    .filter((item): item is OnlineBookCandidate => Boolean(item))
    .filter((item) => !isCatalogJunkCandidate(item))
    .map((candidate) => planCandidateScore(candidate, plan, settings));

  if (mapped.length === 0 && localMapped.length === 0 && settled.length > 0 && settled.every((item) => item.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }

  const byWork = new Map<string, OnlineBookCandidate>();
  for (const candidate of [...localMapped, ...mapped]) {
    const workReference = candidate.references[0];
    const current = byWork.get(workReference.externalId);
    byWork.set(workReference.externalId, current ? mergeWorkCandidates(current, candidate, settings.preferRussian) : candidate);
  }

  const minimumScore = plan.resolvedMode === "author" ? 500 : plan.resolvedMode === "title" ? 300 : 0;
  const results = [...byWork.values()]
    .filter((candidate) => candidate.score > minimumScore)
    .sort((left, right) => right.score - left.score || (right.popularity || 0) - (left.popularity || 0) || right.completeness - left.completeness)
    .slice(0, limit);

  return { provider: "open-library", results, durationMs: Date.now() - started };
}

function googleIsbns(info: GoogleVolumeInfo) {
  const identifiers = info.industryIdentifiers || [];
  return {
    isbn13: normalizeIsbn(identifiers.find((item) => item.type === "ISBN_13")?.identifier),
    isbn10: normalizeIsbn(identifiers.find((item) => item.type === "ISBN_10")?.identifier)
  };
}

function googleCover(info: GoogleVolumeInfo) {
  const links = info.imageLinks;
  return normalizedHttps(
    links?.extraLarge || links?.large || links?.medium || links?.small || links?.thumbnail || links?.smallThumbnail
  );
}

function mapGoogleCandidate(volume: GoogleVolume, query: string, settings: InternalSettings) {
  const info = volume.volumeInfo || {};
  if (!volume.id || !info.title) return null;
  const reference: ProviderReference = {
    provider: "google-books",
    externalId: volume.id,
    kind: "volume"
  };
  const subjects = uniqueStrings([info.mainCategory, ...(info.categories || [])], 30);
  const remoteCover = googleCover(info);
  const candidate: OnlineBookCandidate = {
    id: candidateId([reference], info.title, info.authors?.join(", ") || ""),
    providers: ["google-books"],
    references: [reference],
    title: info.title,
    originalTitle: info.title,
    alternateTitles: [info.title],
    author: info.authors?.join(", ") || MISSING_AUTHOR,
    firstPublishedYear: parseYear(info.publishedDate),
    editionCount: 1,
    languages: uniqueStrings([languageCode(info.language)], 4),
    genres: normalizeGenres(subjects),
    subjects,
    description: info.description,
    coverUrl: remoteCover,
    coverRemoteUrl: remoteCover,
    coverKey: coverCatalogKey(remoteCover) || undefined,
    sourceUrl: info.canonicalVolumeLink || info.infoLink,
    score: 0,
    completeness: 0
  };
  candidate.score = scoreWorkCandidate(query, candidate, detectIsbn(query) ? "isbn" : "general", settings.preferRussian)
    + (settings.preferRussian ? 70 : 45);
  candidate.completeness = workCompleteness(candidate);
  return candidate;
}

async function googleBooksRequest(query: string, settings: InternalSettings, limit: number) {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(Math.min(40, limit)));
  url.searchParams.set("orderBy", "relevance");
  url.searchParams.set("printType", "books");
  url.searchParams.set("projection", "full");
  if (settings.googleBooksApiKey.trim()) {
    url.searchParams.set("key", settings.googleBooksApiKey.trim());
  }
  if (settings.preferRussian) url.searchParams.set("langRestrict", "ru");

  let data = await fetchJson<GoogleBooksResponse>(url.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 2,
    headers: { Accept: "application/json" }
  });
  if (settings.preferRussian && !(data.items || []).length) {
    url.searchParams.delete("langRestrict");
    data = await fetchJson<GoogleBooksResponse>(url.toString(), {
      timeoutMs: settings.requestTimeoutMs,
      retries: 2,
      headers: { Accept: "application/json" }
    });
  }
  return data.items || [];
}

function quoteGoogleTerm(value: string) {
  return `"${value.replace(/["\\]/g, " ").trim()}"`;
}

async function searchGoogleBooks(plan: ResolvedSearchPlan, settings: InternalSettings): Promise<ProviderResult> {
  const started = Date.now();
  const queries = new Set<string>();
  const addQuery = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) queries.add(trimmed);
  };

  if (plan.resolvedMode === "isbn") {
    addQuery(`isbn:${plan.canonicalQuery}`);
  } else if (plan.resolvedMode === "author") {
    const primary = plan.authorName || plan.canonicalQuery || plan.originalQuery;
    if (primary) addQuery(`inauthor:${quoteGoogleTerm(primary)}`);
    if (plan.authorName && normalize(plan.authorName) !== normalize(plan.originalQuery)) {
      addQuery(`inauthor:${quoteGoogleTerm(plan.originalQuery)}`);
    }
  } else if (plan.resolvedMode === "title") {
    addQuery(`intitle:${quoteGoogleTerm(plan.canonicalQuery)}`);
    if (plan.authorName) addQuery(`intitle:${quoteGoogleTerm(plan.canonicalQuery)} inauthor:${quoteGoogleTerm(plan.authorName)}`);
    if (hasCyrillic(plan.originalQuery)) addQuery(`intitle:${quoteGoogleTerm(plan.originalQuery)}`);
  } else {
    addQuery(plan.originalQuery);
    if (hasCyrillic(plan.originalQuery) && plan.canonicalQuery !== plan.originalQuery) {
      addQuery(plan.canonicalQuery);
    }
  }

  const items = (
    await Promise.allSettled([...queries].map((query) => googleBooksRequest(query, settings, settings.searchLimit * 2)))
  )
    .filter((item): item is PromiseFulfilledResult<GoogleVolume[]> => item.status === "fulfilled")
    .flatMap((item) => item.value);
  const seen = new Set<string>();
  const uniqueItems = items.filter((volume) => {
    if (!volume.id || seen.has(volume.id)) return false;
    seen.add(volume.id);
    return true;
  });
  const results = uniqueItems
    .map((item) => mapGoogleCandidate(item, plan.originalQuery, settings))
    .filter((item): item is OnlineBookCandidate => Boolean(item))
    .filter((item) => !isCatalogJunkCandidate(item))
    .map((candidate) => planCandidateScore(candidate, plan, settings))
    .filter((candidate) => candidate.score > (plan.resolvedMode === "author" ? 500 : plan.resolvedMode === "title" ? 300 : 0))
    .sort((left, right) => right.score - left.score)
    .slice(0, settings.searchLimit);
  return { provider: "google-books", results, durationMs: Date.now() - started };
}

function normalizeWorkTitle(value: string) {
  return normalize(value).replace(/^(the|a|an)\s+/, "");
}

function allWorkTitles(candidate: OnlineBookCandidate) {
  return uniqueStrings([candidate.title, candidate.originalTitle, ...(candidate.alternateTitles || [])], 20);
}

function authorDedupeKey(author: string) {
  return tokens(author).slice(-2).join(" ") || normalize(author);
}

function worksSameBook(left: OnlineBookCandidate, right: OnlineBookCandidate) {
  if (left.wikidataId && right.wikidataId && left.wikidataId === right.wikidataId) return true;
  if (authorDedupeKey(left.author) !== authorDedupeKey(right.author)) return false;
  const leftTitles = allWorkTitles(left).map(normalizeWorkTitle);
  const rightTitles = allWorkTitles(right).map(normalizeWorkTitle);
  return leftTitles.some((leftTitle) => rightTitles.some((rightTitle) => {
    if (!leftTitle || !rightTitle) return false;
    if (leftTitle === rightTitle) return true;
    if (leftTitle.length < 4 || rightTitle.length < 4) return false;
    return leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle);
  }));
}

function aggregateWorks(
  results: OnlineBookCandidate[],
  limit: number,
  settings: InternalSettings
) {
  const preferRussian = settings.preferRussian;
  const grouped: OnlineBookCandidate[] = [];
  for (const candidate of results) {
    if (isCatalogJunkCandidate(candidate)) continue;
    const index = grouped.findIndex((item) => worksSameBook(item, candidate));
    if (index >= 0) {
      grouped[index] = mergeWorkCandidates(grouped[index], candidate, preferRussian);
    } else {
      grouped.push(candidate);
    }
  }
  return grouped
    .sort((left, right) => right.score - left.score || right.completeness - left.completeness)
    .slice(0, limit);
}


function preferredDisplayTitle(
  candidate: OnlineBookCandidate,
  plan: ResolvedSearchPlan,
  position: number
) {
  if (plan.resolvedMode !== "title" || position > 0 || plan.confidence < 55) {
    return candidate.title;
  }

  const queryUsesCyrillic = hasCyrillic(plan.originalQuery);
  const choices = uniqueStrings([
    ...(plan.source === "combined" ? [plan.canonicalQuery] : [plan.displayLabel]),
    ...plan.titleVariants,
    plan.originalQuery,
    ...plan.aliases
  ], 20).filter((value) => hasCyrillic(value) === queryUsesCyrillic);

  return choices[0] || candidate.title;
}

function decorateDisplayTitles(results: OnlineBookCandidate[], plan: ResolvedSearchPlan) {
  return results.map((candidate, index) => ({
    ...candidate,
    displayTitle: preferredDisplayTitle(candidate, plan, index)
  }));
}

function searchResultLimit(plan: ResolvedSearchPlan, settings: InternalSettings) {
  const base = settings.searchLimit;
  if (plan.resolvedMode === "author") return Math.min(60, Math.max(base, 36));
  if (plan.resolvedMode === "title") return Math.min(48, Math.max(base, 28));
  return Math.min(48, Math.max(base, 24));
}

function rankResultsWithCoverPreference(
  results: OnlineBookCandidate[],
  limit: number,
  preferRussian: boolean,
  plan: ResolvedSearchPlan
) {
  const titleHints = uniqueStrings([
    plan.canonicalQuery,
    ...(plan.titleVariants || []),
    ...(plan.source === "combined" ? [plan.displayLabel.split(/[—–-]/)[0]?.trim() || ""] : []),
    plan.originalQuery
  ], 12).map(normalize).filter(Boolean);

  const titleRelevance = (candidate: OnlineBookCandidate) => Math.max(
    0,
    ...allWorkTitles(candidate).map((title) => {
      const normalizedTitle = normalize(title);
      return Math.max(...titleHints.map((hint) => {
        if (!hint || !normalizedTitle) return 0;
        if (normalizedTitle === hint) return 100;
        if (normalizedTitle.includes(hint) || hint.includes(normalizedTitle)) return 72;
        return coverage(tokens(hint), title) * 60;
      }));
    })
  );

  return [...results]
    .sort((left, right) => {
      if (plan.resolvedMode === "author") {
        const coverDelta = Number(hasCatalogCover(right)) - Number(hasCatalogCover(left));
        if (coverDelta !== 0) return coverDelta;
        const poetryDelta = Number(isPoetryCatalogCandidate(left)) - Number(isPoetryCatalogCandidate(right));
        if (poetryDelta !== 0) return poetryDelta;
        const curatedDelta =
          Number(right.matchReasons?.includes("curated_catalog")) - Number(left.matchReasons?.includes("curated_catalog"));
        if (curatedDelta !== 0) return curatedDelta;
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) return scoreDelta;
      }
      if (plan.resolvedMode === "title" || plan.resolvedMode === "general") {
        const exactDelta =
          Number(right.matchReasons?.includes("exact_title") || right.matchReasons?.includes("known_work_curated"))
          - Number(left.matchReasons?.includes("exact_title") || left.matchReasons?.includes("known_work_curated"));
        if (exactDelta !== 0) return exactDelta;
        const curatedDelta =
          Number(right.matchReasons?.includes("curated_catalog")) - Number(left.matchReasons?.includes("curated_catalog"));
        if (curatedDelta !== 0) return curatedDelta;
      }
      if (preferRussian) {
        const inpxDelta =
          Number(right.matchReasons?.includes("local_index")) - Number(left.matchReasons?.includes("local_index"));
        if (inpxDelta !== 0) return inpxDelta;
        const fantLabDelta = Number(right.providers.includes("fantlab")) - Number(left.providers.includes("fantlab"));
        if (fantLabDelta !== 0) return fantLabDelta;
        const russianDelta =
          Number(hasRussianLanguage(right.languages)) - Number(hasRussianLanguage(left.languages));
        if (russianDelta !== 0) return russianDelta;
      } else {
        const localDelta =
          Number(right.matchReasons?.includes("local_index")) - Number(left.matchReasons?.includes("local_index"));
        if (localDelta !== 0) return localDelta;
        const olDelta = Number(right.providers.includes("open-library")) - Number(left.providers.includes("open-library"));
        if (olDelta !== 0) return olDelta;
      }
      const titleDelta = titleRelevance(right) - titleRelevance(left);
      if (titleDelta !== 0) return titleDelta;
      const seriesDelta =
        Number(right.matchReasons?.includes("series_match")) - Number(left.matchReasons?.includes("series_match"));
      if (seriesDelta !== 0) return seriesDelta;
      if (plan.seriesNum) {
        const seriesNumDelta = Number(right.catalogSeriesNum === plan.seriesNum) - Number(left.catalogSeriesNum === plan.seriesNum);
        if (seriesNumDelta !== 0) return seriesNumDelta;
      }
      const coverDelta = Number(hasCatalogCover(right)) - Number(hasCatalogCover(left));
      if (coverDelta !== 0) return coverDelta;
      return right.score - left.score || right.completeness - left.completeness;
    })
    .slice(0, limit);
}

function hasRussianLanguage(languages?: string[]) {
  return (languages || []).some((language) => languageCode(language) === "ru");
}

function surfaceEnglishSearchMetadata(candidate: OnlineBookCandidate) {
  const english = candidate.languages.filter((lang) => languageCode(lang) === "en");
  if (english.length) return { ...candidate, languages: english.slice(0, 3) };
  return candidate;
}

function surfaceSearchMetadata(candidate: OnlineBookCandidate, preferRussian: boolean) {
  if (candidate.providers.includes("fantlab")) {
    return {
      ...candidate,
      languages: uniqueStrings(["ru", ...candidate.languages.filter((lang) => languageCode(lang) === "ru")], 4)
    };
  }
  if (preferRussian) {
    const russian = candidate.languages.filter((lang) => languageCode(lang) === "ru");
    if (russian.length) return { ...candidate, languages: russian };
  }
  return candidate;
}

function curatedDuplicatesLiveCatalog(
  curated: OnlineBookCandidate,
  live: OnlineBookCandidate[]
) {
  const title = normalize(curated.title);
  const author = normalize(curated.author);
  return live.some((item) => {
    if (normalize(item.author) !== author) return false;
    const titles = uniqueStrings([item.title, ...(item.alternateTitles || [])], 12).map(normalize);
    return titles.includes(title) || titles.some((value) => value.includes(title) || title.includes(value));
  });
}

async function enrichSearchResultCoversBackground(
  results: OnlineBookCandidate[],
  settings: InternalSettings,
  query = "",
  options: { maxTargets?: number; deadlineMs?: number } = {}
): Promise<OnlineBookCandidate[]> {
  const preferRussian = editionPreferRussian(query, settings.preferRussian, settings.uiLocale);
  const enrichSettings = { ...settings, preferRussian };
  const enriched = results.map((item) => ({ ...item }));
  const deadlineMs = options.deadlineMs ?? 6_000;
  const deadline = Date.now() + deadlineMs;
  const maxTargets = options.maxTargets ?? 8;
  const targets = enriched
    .filter((item) =>
      item.providers.includes("fantlab")
      || item.references.some(isCuratedReference)
      || item.references.some(isInpxReference)
      || (!preferRussian && item.providers.includes("open-library")))
    .slice(0, maxTargets);

  await Promise.allSettled(targets.map(async (candidate) => {
    if (Date.now() > deadline) return;
    const curatedOnly = candidate.references.some(isCuratedReference)
      && !candidate.references.some((ref) => ref.provider === "fantlab" && ref.kind === "work");
    if (curatedOnly && settings.fantlabEnabled) {
      const fantLabHit = await lookupFantLabWorkByTitleAuthor(candidate.author, candidate.title, enrichSettings).catch(() => null);
      if (fantLabHit) {
        const fantLabRef = fantLabHit.references.find((ref) => ref.provider === "fantlab" && ref.kind === "work");
        if (fantLabRef && !candidate.references.some((ref) => ref.externalId === fantLabRef.externalId)) {
          candidate.references.push(fantLabRef);
        }
        if (!candidate.providers.includes("fantlab")) {
          candidate.providers = [...candidate.providers, "fantlab"] as typeof candidate.providers;
        }
        if (fantLabHit.coverUrl) {
          candidate.coverUrl = fantLabHit.coverUrl;
          candidate.coverRemoteUrl = fantLabHit.coverRemoteUrl || fantLabHit.coverUrl;
          candidate.coverKey = fantLabHit.coverKey;
          candidate.previewEditionId = fantLabHit.previewEditionId;
        }
        if (fantLabHit.listedEditionCount) candidate.listedEditionCount = fantLabHit.listedEditionCount;
      }
    }
    const inpxOnly = candidate.references.some(isInpxReference)
      && !candidate.references.some((ref) => ref.provider === "fantlab" && ref.kind === "work");
    if (inpxOnly && !hasCatalogCover(candidate) && settings.fantlabEnabled) {
      const fantLabHit = await lookupFantLabWorkByTitleAuthor(candidate.author, candidate.title, enrichSettings).catch(() => null);
      if (fantLabHit) {
        const fantLabRef = fantLabHit.references.find((ref) => ref.provider === "fantlab" && ref.kind === "work");
        if (fantLabRef && !candidate.references.some((ref) => ref.externalId === fantLabRef.externalId)) {
          candidate.references.push(fantLabRef);
        }
        if (!candidate.providers.includes("fantlab")) {
          candidate.providers = [...candidate.providers, "fantlab"] as typeof candidate.providers;
        }
        if (fantLabHit.coverUrl) {
          candidate.coverUrl = fantLabHit.coverUrl;
          candidate.coverRemoteUrl = fantLabHit.coverRemoteUrl || fantLabHit.coverUrl;
          candidate.coverKey = fantLabHit.coverKey;
          candidate.previewEditionId = fantLabHit.previewEditionId;
        }
        if (fantLabHit.firstPublishedYear && !candidate.firstPublishedYear) {
          candidate.firstPublishedYear = fantLabHit.firstPublishedYear;
        }
      }
    }
    const fantLabRef = candidate.references.find(
      (ref) => ref.provider === "fantlab" && ref.kind === "work"
    );
    if (fantLabRef) {
      const keepSearchCover = Boolean(candidate.coverKey?.startsWith("fl-edition:"));
      const meta = await fetchFantLabWorkCatalogMeta(fantLabRef.externalId, enrichSettings, keepSearchCover).catch(() => null);
      if (!meta) return;
      if (meta.listedEditionCount) candidate.listedEditionCount = meta.listedEditionCount;
      if (meta.previewEditionId) {
        candidate.previewEditionId = meta.previewEditionId;
        if (!candidate.coverKey) candidate.coverKey = `fl-edition:${meta.previewEditionId}`;
      }
      if (meta.coverUrl && !keepSearchCover) {
        candidate.coverUrl = meta.coverUrl;
        candidate.coverRemoteUrl = meta.coverUrl;
        void verifyRemoteCoverUrl(meta.coverUrl, 3_500);
      }
      return;
    }

    if (preferRussian || !candidate.providers.includes("open-library")) return;
    const workKey = candidate.references.find(
      (ref) => ref.provider === "open-library" && ref.kind === "work" && !ref.externalId.startsWith("curated:")
    )?.externalId;
    if (!workKey || hasCatalogCover(candidate)) return;

    const olKey = workKey.startsWith("/") ? workKey : `/works/${workKey}`;
    const work = await catalogJsonFetch<{ covers?: number[] }>(`https://openlibrary.org${olKey}.json`, enrichSettings).catch(() => null);
    const coverId = work?.covers?.find((id) => id > 0);
    if (!coverId) return;
    const url = openLibraryCoverById(coverId);
    if (!url) return;
    candidate.coverUrl = url;
    candidate.coverRemoteUrl = url;
    candidate.coverKey = `id:${coverId}`;
    void verifyRemoteCoverUrl(url, 3_500);
  }));

  return enriched;
}

export { enrichSearchResultCoversBackground };

export function clearResolvePreviewCache() {
  resolvePreviewCache.clear();
}

function decorateSearchResultCovers(results: OnlineBookCandidate[]) {
  return results.map((item) => {
    const remoteCover = item.coverRemoteUrl
      || (item.coverUrl && /^https?:\/\//i.test(item.coverUrl) ? item.coverUrl : undefined);
    return {
      ...item,
      coverRemoteUrl: remoteCover,
      coverUrl: remoteCover || item.coverUrl
    };
  });
}

async function finalizeSearchResults(
  merged: OnlineBookCandidate[],
  resultLimit: number,
  settings: InternalSettings,
  plan: ResolvedSearchPlan,
  query: string,
  enrichCovers: boolean
) {
  const aggregated = aggregateWorks(
    merged,
    resultLimit * 2,
    settings
  );
  let results = rankResultsWithCoverPreference(
    aggregated,
    resultLimit,
    settings.preferRussian,
    plan
  );
  if (!settings.preferRussian) {
    const filtered = results.filter((item) => catalogMatchesPreference(item, false));
    if (filtered.length) results = filtered;
    results = results.map((item) => surfaceEnglishSearchMetadata(item));
  } else {
    const filtered = results.filter((item) => catalogMatchesPreference(item, true));
    if (filtered.length) results = filtered;
    results = results.map((item) => surfaceSearchMetadata(item, true));
  }
  results = decorateDisplayTitles(results, plan);
  results = decorateSearchResultCovers(results).map((item) => ({
    ...item,
    autoSelectable:
      settings.autoSelectHighConfidence
      && plan.resolvedMode !== "author"
      && isQuickAddCandidate(item.matchReasons, item.matchConfidence)
  }));
  return enrichCovers
    ? enrichSearchResultCoversBackground(results, settings, query, {
      maxTargets: plan.resolvedMode === "author" ? 3 : 2,
      deadlineMs: 900
    })
    : results;
}

function buildLocalFirstCandidates(
  plan: ResolvedSearchPlan,
  settings: InternalSettings,
  resultLimit: number
) {
  const curatedCandidates = buildCuratedWorkCandidates(plan, settings);
  const openLibraryCandidates = settings.openLibraryEnabled && !settings.preferRussian
    ? searchOpenLibraryLocalCandidates(plan, settings, resultLimit)
    : [];
  return [...curatedCandidates, ...openLibraryCandidates];
}

function localFirstReady(candidates: OnlineBookCandidate[], plan: ResolvedSearchPlan) {
  if (candidates.length === 0) return false;
  if (plan.resolvedMode === "author") return candidates.length >= 3;
  return candidates.some((item) =>
    item.matchConfidence === "high"
    || item.matchReasons?.includes("exact_title")
    || item.matchReasons?.includes("known_work_curated")
    || item.matchReasons?.includes("local_index")
  );
}

function warmOnlineProviders(tasks: Array<Promise<ProviderResult>>) {
  void Promise.allSettled(tasks);
}

function cacheKey(request: OnlineSearchRequest, settings: InternalSettings) {
  return createHash("sha1")
    .update(JSON.stringify({
      version: 43,
      q: normalize(request.query),
      mode: request.mode,
      auto: settings.autoSelectHighConfidence,
      fl: settings.fantlabEnabled,
      ol: settings.openLibraryEnabled,
      gb: settings.googleBooksEnabled,
      gtx: settings.gutendexEnabled,
      hc: settings.hardcoverEnabled && Boolean(settings.hardcoverApiToken),
      inpx: settings.inpxEnabled,
      inpxWeb: Boolean(settings.inpxWebUrl?.trim()),
      ru: editionPreferRussian(request.query, settings.preferRussian, settings.uiLocale),
      limit: settings.searchLimit
    }))
    .digest("hex");
}

function literalResolution(request: OnlineSearchRequest): ResolvedSearchPlan {
  return {
    originalQuery: request.query,
    requestedMode: request.mode,
    resolvedMode: request.mode === "auto" ? "general" : request.mode,
    canonicalQuery: request.query,
    displayLabel: request.query,
    aliases: [request.query],
    confidence: 35,
    source: "literal",
    explanation: "resolver.fallback_resolver",
    titleVariants: [request.query],
    authorVariants: []
  };
}

function localTitleAliases(query: string) {
  const normalized = normalize(query);
  const aliases: Record<string, string> = {
    "master i margarita": "The Master and Margarita",
    "voina i mir": "War and Peace"
  };
  return uniqueStrings([aliases[normalized]], 4);
}

function localAutoTitleParts(query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 6) return [];
  const titles: string[] = [];
  for (const size of [1, 2, 3]) {
    if (words.length <= size) continue;
    titles.push(words.slice(size).join(" "));
    titles.push(words.slice(0, -size).join(" "));
  }
  return uniqueStrings(titles.filter((item) => item.length >= 2), 8);
}

function quickLocalPlans(request: OnlineSearchRequest) {
  const plans: ResolvedSearchPlan[] = [];
  if (request.mode === "title" || request.mode === "author") {
    plans.push(literalResolution(request));
  }
  if (request.mode === "auto") {
    for (const title of uniqueStrings([...localTitleAliases(request.query), ...localAutoTitleParts(request.query)], 12)) {
      plans.push(literalResolution({ query: title, mode: "title" }));
    }
  }
  return plans;
}

export async function searchOnlineBooks(input: OnlineSearchRequest | string): Promise<OnlineSearchResponse> {
  const request: OnlineSearchRequest = typeof input === "string"
    ? { query: input, mode: "auto" }
    : { query: input.query, mode: input.mode || "auto" };
  const cleanQuery = request.query.trim().slice(0, 300);
  const cleanRequest: OnlineSearchRequest = { query: cleanQuery, mode: request.mode };
  const settings = getInternalSettings();

  if (!cleanQuery) {
    return {
      query: "",
      resolution: literalResolution(cleanRequest),
      results: [],
      providerStatuses: [],
      fromCache: false
    };
  }

  const key = cacheKey(cleanRequest, settings);
  const cached = getCachedSearch(key);
  if (cached) return cached;

  for (const quickPlan of quickLocalPlans(cleanRequest)) {
    const quickSettings = searchEditionSettings(settings, quickPlan);
    const quickLimit = searchResultLimit(quickPlan, settings);
    const quickCandidates = buildLocalFirstCandidates(quickPlan, quickSettings, quickLimit);
    if (localFirstReady(quickCandidates, quickPlan)) {
      return {
        query: cleanQuery,
        resolution: quickPlan,
        results: await finalizeSearchResults(quickCandidates, quickLimit, quickSettings, quickPlan, cleanQuery, false),
        providerStatuses: [],
        fromCache: false
      };
    }
  }

  let plan: ResolvedSearchPlan;
  try {
    plan = await resolveSearchQuery(cleanQuery, cleanRequest.mode, settings);
  } catch {
    plan = literalResolution(cleanRequest);
  }

  const searchSettings = searchEditionSettings(settings, plan);
  const resultLimit = searchResultLimit(plan, settings);

  const tasks: Array<Promise<ProviderResult>> = [];
  const providers: BookProvider[] = [];
  if (searchSettings.fantlabEnabled && searchSettings.preferRussian) {
    tasks.push(searchFantLab(plan, searchSettings, planCandidateScore));
    providers.push("fantlab");
  }
  if (searchSettings.googleBooksEnabled) {
    tasks.push(searchGoogleBooks(plan, searchSettings));
    providers.push("google-books");
  }
  if (searchSettings.openLibraryEnabled && shouldUseOpenLibrarySearch(searchSettings, cleanRequest.mode, plan)) {
    tasks.push(searchOpenLibrary(plan, searchSettings));
    providers.push("open-library");
  }
  if (searchSettings.gutendexEnabled && cleanRequest.mode !== "isbn") {
    tasks.push(searchGutendex(plan, searchSettings, planCandidateScore));
    providers.push("gutendex");
  }
  if (searchSettings.hardcoverEnabled && searchSettings.hardcoverApiToken && cleanRequest.mode !== "isbn") {
    tasks.push(searchHardcover(plan, searchSettings, planCandidateScore));
    providers.push("hardcover");
  }
  if (tasks.length === 0) {
    throw new Error(settings.uiLocale === "en"
      ? "Enable at least one online search source in Settings."
      : "Включите хотя бы один источник онлайн-поиска в настройках.");
  }

  const localCandidates = buildLocalFirstCandidates(plan, searchSettings, resultLimit);
  if (localFirstReady(localCandidates, plan)) {
    warmOnlineProviders(tasks);
    return {
      query: cleanQuery,
      resolution: plan,
      results: await finalizeSearchResults(localCandidates, resultLimit, searchSettings, plan, cleanQuery, false),
      providerStatuses: [],
      fromCache: false
    };
  }

  const settled = await Promise.allSettled(tasks);
  const providerStatuses = settled.map((result, index) => {
    const provider = providers[index];
    if (result.status === "fulfilled") {
      return { provider, enabled: true, ok: true, resultCount: result.value.results.length, durationMs: result.value.durationMs };
    }
    return { provider, enabled: true, ok: false, resultCount: 0, durationMs: 0, message: describeNetworkError(result.reason) };
  });

  const successful = [
    ...settled
      .filter((result): result is PromiseFulfilledResult<ProviderResult> => result.status === "fulfilled")
      .flatMap((result) => result.value.results)
  ];
  if (successful.length === 0 && providerStatuses.length > 0 && providerStatuses.every((status) => !status.ok)) {
    throw new Error(providerStatuses.map((status) => `${status.provider}: ${status.message}`).join("; "));
  }

  const curatedCandidates = localCandidates
    .filter((item) => item.references.some(isCuratedReference))
    .filter((item) => !curatedDuplicatesLiveCatalog(item, successful));
  const localNonCuratedCandidates = localCandidates
    .filter((item) => !item.references.some(isCuratedReference));
  const inpxHits = searchSettings.preferRussian && (searchSettings.inpxEnabled || searchSettings.inpxWebUrl?.trim())
    ? await collectInpxWorkHits(plan, searchSettings, plan.resolvedMode === "author" ? 36 : 14)
    : [];
  const inpxCandidates = inpxHits.length
    ? buildInpxWorkCandidates(plan, inpxHits, (candidate) => planCandidateScore(candidate, plan, searchSettings))
      .filter((item) => !inpxDuplicatesLiveCatalog(item, successful))
    : [];
  let merged = [...successful, ...localNonCuratedCandidates, ...inpxCandidates, ...curatedCandidates];
  if (plan.resolvedMode === "author" && plan.source === "curated" && plan.authorName) {
    const authorTokens = tokens(plan.authorName);
    if (authorTokens.length) {
      merged = merged.filter((item) => {
        if (!item.providers.includes("fantlab")) return true;
        return authorTokens.every((token) => tokens(item.author).includes(token));
      });
    }
  }
  const results = await finalizeSearchResults(merged, resultLimit, searchSettings, plan, cleanQuery, true);
  const response: OnlineSearchResponse = {
    query: cleanQuery,
    resolution: plan,
    results,
    providerStatuses,
    fromCache: false
  };
  setCachedSearch(key, response, settings.cacheMinutes);
  return response;
}

function pickEditionDisplayCover(options: CoverOption[]) {
  const verifiedExact = options.find((option) => option.verified && option.exactEdition);
  if (verifiedExact) return verifiedExact.url;
  const verified = options.find((option) => option.verified);
  if (verified) return verified.url;
  return options[0]?.url;
}

function coverOptionsForOpenLibraryEdition(edition: OpenLibraryEdition): CoverOption[] {
  const options: CoverOption[] = [];
  for (const coverId of edition.covers || []) {
    const url = openLibraryCoverById(coverId);
    if (url) options.push({ url, source: "edition", exactEdition: true, verified: true });
  }
  const olidUrl = openLibraryCoverByOlid(edition.key);
  if (olidUrl) options.push({ url: olidUrl, source: "edition", exactEdition: true, verified: false });
  const isbn13 = normalizeIsbn(edition.isbn_13?.[0]);
  const isbn10 = normalizeIsbn(edition.isbn_10?.[0]);
  const isbn13Url = openLibraryCoverByIsbn(isbn13);
  const isbn10Url = openLibraryCoverByIsbn(isbn10);
  if (isbn13Url) options.push({ url: isbn13Url, source: "isbn", exactEdition: true, verified: false });
  if (isbn10Url) options.push({ url: isbn10Url, source: "isbn", exactEdition: true, verified: false });
  return uniqueCoverOptions(options);
}

function uniqueCoverOptions(options: CoverOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.url)) return false;
    seen.add(option.url);
    return true;
  });
}

function openLibraryEditionScore(
  edition: OpenLibraryEdition,
  work: OnlineBookCandidate,
  settings: InternalSettings
) {
  const language = openLibraryLanguage(edition);
  const preferredLanguages = preferredEditionLanguages(settings.preferRussian, settings.uiLocale);
  const title = edition.title || work.title;
  const titleVariants = uniqueStrings([
    work.title,
    work.originalTitle,
    ...(work.alternateTitles || [])
  ], 30);
  const normalizedTitle = normalize(title);
  const titleSimilarity = Math.max(0, ...titleVariants.map((variant) => {
    const normalizedVariant = normalize(variant);
    if (normalizedVariant === normalizedTitle) return 1;
    if (normalizedVariant && (normalizedTitle.includes(normalizedVariant) || normalizedVariant.includes(normalizedTitle))) return 0.82;
    return coverage(tokens(variant), title);
  }));
  let score = 0;
  if (preferredLanguages.length > 0) {
    if (preferredLanguages.includes(language || "")) score += 220;
    else if (language) score -= 160;
    else score -= 40;
  } else if (settings.preferRussian && language === "ru") {
    score += 220;
  }
  if (titleSimilarity >= 0.98) score += 180;
  else if (titleSimilarity >= 0.65) score += 100;
  else if (titleSimilarity >= 0.3) score += 35;
  else score -= 90;
  if (edition.isbn_13?.length || edition.isbn_10?.length) score += 45;
  if (edition.publishers?.length) score += 22;
  if (edition.number_of_pages) score += 22;
  if (edition.covers?.some((id) => id > 0)) score += 36;
  score += scriptConsistency(title, language);

  const editionYear = parseYear(edition.publish_date);
  if (editionYear && editionYear >= 2015) score += 48;
  else if (editionYear && editionYear >= 2000) score += 24;

  const publisher = edition.publishers?.[0] || "";
  if (/(?:\bаст\b|\bэксмо\b|азбука|corpus|rospen|мартин|neoclassic|питер\b|palgrave|penguin|vintage)/i.test(publisher)) {
    score += 42;
  }

  const omnibus = /(?:\d{4}\.|\.{3}| и .+ и )/i.test(title) && title.length > 42;
  if (omnibus && titleSimilarity < 0.92) score -= 120;

  const suspiciousTitle = /(?:desk\s+calendar|calendar\s+series|wall\s+calendar|planner|blank\s+(?:book|journal)|notebook|календар|ежедневник|планер)/i.test(title);
  if (suspiciousTitle && titleSimilarity < 0.3) score -= 700;

  if (edition.number_of_pages && edition.number_of_pages < 100 && work.firstPublishedYear && work.firstPublishedYear < 1970) {
    score -= 120;
  }
  if (/(?:saddleback|educational|abridged|study guide|cliffsnotes|sparknotes)/i.test(`${title} ${edition.publishers?.[0] || ""}`)) {
    score -= 220;
  }

  const workKey = work.references.find((item) => item.kind === "work")?.externalId;
  const linkedWorks = (edition.works || []).map((item) => item.key).filter(Boolean);
  if (workKey && linkedWorks.length > 0 && !linkedWorks.includes(workKey)) score -= 500;

  const firstPublishedYear = work.firstPublishedYear;
  if (
    firstPublishedYear
    && editionYear
    && editionYear > firstPublishedYear + 8
    && preferredLanguages.length > 0
    && !preferredLanguages.includes(language || "")
  ) {
    score -= 180;
  }

  return score;
}

function mapOpenLibraryEdition(
  edition: OpenLibraryEdition,
  work: OnlineBookCandidate,
  settings: InternalSettings
): OnlineBookEdition | null {
  if (!edition.key) return null;
  const reference: ProviderReference = {
    provider: "open-library",
    externalId: edition.key,
    kind: "edition"
  };
  const isbn13 = normalizeIsbn(edition.isbn_13?.[0]);
  const isbn10 = normalizeIsbn(edition.isbn_10?.[0]);
  const coverOptions = coverOptionsForOpenLibraryEdition(edition);
  const result: OnlineBookEdition = {
    id: editionId(reference, isbn13 || isbn10),
    provider: "open-library",
    references: [reference],
    workId: work.references.find((item) => item.provider === "open-library" && item.kind === "work")?.externalId,
    editionId: edition.key,
    title: edition.title || work.title,
    subtitle: edition.subtitle,
    author: work.author,
    year: parseYear(edition.publish_date),
    publisher: edition.publishers?.[0],
    pageCount: edition.number_of_pages ?? null,
    language: openLibraryLanguage(edition),
    isbn10,
    isbn13,
    coverUrl: pickEditionDisplayCover(coverOptions),
    coverOptions,
    coverStatus: coverOptions.some((option) => option.verified)
      ? "available"
      : coverOptions.length > 0 ? "candidate" : "missing",
    sourceUrl: `https://openlibrary.org${edition.key}`,
    score: openLibraryEditionScore(edition, work, settings),
    metadataQuality: 0
  };
  result.metadataQuality = editionCompleteness(result);
  return result;
}

function applyOpenLibraryCoverFallbacks(
  editions: OnlineBookEdition[],
  workCoverIds: number[] | undefined
) {
  const workOptions = uniqueCoverOptions((workCoverIds || [])
    .map((coverId) => openLibraryCoverById(coverId))
    .filter((url): url is string => Boolean(url))
    .map((url) => ({
      url,
      source: "work" as const,
      exactEdition: false,
      verified: true,
      note: "Обложка произведения может отличаться от выбранного издания"
    })));

  for (const edition of editions) {
    const hasVerifiedExact = edition.coverOptions.some((option) => option.exactEdition && option.verified);
    const sameLanguage = editions.find((candidate) =>
      candidate.id !== edition.id &&
      candidate.language &&
      candidate.language === edition.language &&
      candidate.coverOptions.some((option) => option.exactEdition && option.verified)
    );
    if (!hasVerifiedExact && sameLanguage) {
      const option = sameLanguage.coverOptions.find((item) => item.exactEdition && item.verified);
      if (option) {
        edition.coverOptions.push({
          ...option,
          source: "same-language-edition",
          exactEdition: false,
          note: "Обложка взята у другого издания на том же языке"
        });
      }
    }
    edition.coverOptions.push(...workOptions);
    edition.coverOptions = uniqueCoverOptions(edition.coverOptions);
    edition.coverUrl = pickEditionDisplayCover(edition.coverOptions);
    const picked = edition.coverOptions.find((option) => option.url === edition.coverUrl) || edition.coverOptions[0];
    if (!picked) {
      edition.coverStatus = "missing";
      edition.coverNote = undefined;
    } else if (!picked.exactEdition) {
      edition.coverStatus = "fallback";
      edition.coverNote = picked.note;
    } else if (picked.verified) {
      edition.coverStatus = "available";
      edition.coverNote = undefined;
    } else {
      edition.coverStatus = "candidate";
      edition.coverNote = "Наличие обложки будет проверено перед сохранением";
    }
  }
}

async function fetchOpenLibraryEditionEntries(
  workKey: string,
  settings: InternalSettings,
  maxEditions = 250,
  offset = 0
) {
  const entries: OpenLibraryEdition[] = [];
  const pageStart = Math.floor(offset / 100) * 100;
  let skip = offset - pageStart;
  for (let pageOffset = pageStart; entries.length < maxEditions; pageOffset += 100) {
    const data = await catalogJsonFetch<OpenLibraryEditionsResponse>(
      `https://openlibrary.org${workKey}/editions.json?limit=100&offset=${pageOffset}`,
      settings
    );
    const batch = data.entries || [];
    for (const edition of batch) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      entries.push(edition);
      if (entries.length >= maxEditions) break;
    }
    if (batch.length < 100) break;
  }
  return entries;
}

async function fetchRussianEditionKeysForWork(workKey: string, settings: InternalSettings, limit = 60) {
  const normalizedKey = workKey.replace(/^\/works\//, "");
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", `type:edition work_key:${normalizedKey} language:rus`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", "key,edition_key");
  const data = await catalogJsonFetch<{ docs?: Array<{ key?: string; edition_key?: string[] }> }>(url.toString(), settings, 2);
  return uniqueStrings(
    (data.docs || []).flatMap((doc) => [doc.key, ...(doc.edition_key || [])]),
    limit
  ).map((value) => (value?.startsWith("/") ? value : `/books/${value}`));
}

async function fetchOpenLibraryEditionByKey(editionKey: string, settings: InternalSettings) {
  try {
    return await catalogJsonFetch<OpenLibraryEdition>(`https://openlibrary.org${editionKey}.json`, settings);
  } catch {
    return null;
  }
}

function mergeOpenLibraryEditionEntries(...lists: OpenLibraryEdition[][]) {
  const map = new Map<string, OpenLibraryEdition>();
  for (const list of lists) {
    for (const edition of list) {
      if (!edition.key) continue;
      map.set(edition.key, edition);
    }
  }
  return [...map.values()];
}

function curatedOpenLibraryDocMatches(
  doc: OpenLibraryDoc,
  candidate: OnlineBookCandidate
) {
  const docTitle = doc.title || "";
  const titleVariants = uniqueStrings([
    candidate.title,
    ...(candidate.alternateTitles || [])
  ], 12);
  const titleScore = Math.max(
    0,
    ...titleVariants.map((variant) => coverage(tokens(variant), docTitle))
  );
  if (titleScore < 0.55) return false;

  const authorNames = doc.author_name || [];
  if (authorNames.length === 0 || candidate.author === MISSING_AUTHOR) {
    return titleScore >= 0.72;
  }
  const authorScore = Math.max(
    0,
    ...authorNames.map((name) => coverage(tokens(candidate.author), name))
  );
  return authorScore >= 0.4;
}

async function resolveCuratedTitleWork(
  candidate: OnlineBookCandidate,
  settings: InternalSettings
): Promise<ResolvedProviderWork> {
  const author = candidate.author;
  const titles = uniqueStrings([candidate.title, ...(candidate.alternateTitles || [])], 8);
  const editionMap = new Map<string, OnlineBookEdition>();

  const addEdition = (edition: OnlineBookEdition | null) => {
    if (!edition) return;
    const key = editionDedupeKey(edition);
    const existing = editionMap.get(key);
    editionMap.set(key, existing ? mergeSameEdition(existing, edition) : edition);
  };

  const seenWorks = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    const settled = await Promise.allSettled([
      openLibraryRequest({ title, author }, 12, settings),
      openLibraryRequest({ q: `${title} language:rus`, author }, 8, settings)
    ]);
    const docs = settled
      .filter((item): item is PromiseFulfilledResult<OpenLibraryDoc[]> => item.status === "fulfilled")
      .flatMap((item) => item.value);

    for (const doc of docs.slice(0, 4)) {
      if (!doc.key || seenWorks.has(doc.key)) continue;
      if (!curatedOpenLibraryDocMatches(doc, candidate)) continue;
      seenWorks.add(doc.key);
      const externalId = doc.key.replace(/^\/works\//, "");
      const reference: ProviderReference = {
        provider: "open-library",
        externalId,
        kind: "work"
      };
      try {
        const resolved = await resolveOpenLibraryWork(reference, candidate, settings);
        for (const edition of resolved.editions) addEdition(edition);
      } catch {
        // Пропускаем произведения, для которых не удалось получить издания.
      }
    }
  }

  if (settings.googleBooksEnabled) {
    for (const title of titles.slice(0, 3)) {
      try {
        const volumes = await googleBooksRequest(`intitle:${title} inauthor:${author}`, settings, 12);
        for (const volume of volumes) addEdition(mapGoogleEdition(volume, candidate, settings));
      } catch {
        // Google Books — резервный источник изданий.
      }
    }
  }

  const editions = [...editionMap.values()]
    .sort((left, right) => right.score - left.score || right.metadataQuality - left.metadataQuality)
    .slice(0, 36);

  return {
    work: {
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      firstPublishedYear: candidate.firstPublishedYear,
      genres: candidate.genres,
      subjects: candidate.subjects,
      description: candidate.description,
      coverUrl: candidate.coverUrl
    },
    editions
  };
}

async function resolveOpenLibraryWork(
  reference: ProviderReference,
  candidate: OnlineBookCandidate,
  settings: InternalSettings,
  options: { editionLimit?: number; editionOffset?: number } = {}
) {
  if (isCuratedReference(reference)) {
    return resolveCuratedTitleWork(candidate, settings);
  }
  if (isInpxReference(reference)) {
    if (settings.fantlabEnabled) {
      const fantLabHit = await lookupFantLabWorkByTitleAuthor(candidate.author, candidate.title, settings).catch(() => null);
      const fantLabRef = fantLabHit?.references.find((item) => item.provider === "fantlab" && item.kind === "work");
      if (fantLabRef) {
        return resolveFantLabWork(
          fantLabRef,
          { ...candidate, ...fantLabHit },
          settings,
          { editionLimit: options.editionLimit, editionOffset: options.editionOffset, enrichEditionCards: true }
        );
      }
    }
    return {
      work: {
        title: candidate.title,
        languages: candidate.languages,
        genres: candidate.genres,
        description: candidate.description
      },
      editions: []
    };
  }
  const editionLimit = options.editionLimit ?? (settings.preferRussian ? 60 : 40);
  const editionOffset = options.editionOffset ?? 0;
  const key = reference.externalId.startsWith("/")
    ? reference.externalId
    : `/works/${reference.externalId}`;
  const work = await catalogJsonFetch<OpenLibraryWork>(`https://openlibrary.org${key}.json`, settings, 2);

  let rawEditions: OpenLibraryEdition[];
  try {
    rawEditions = await fetchOpenLibraryEditionEntries(
      key,
      settings,
      editionLimit,
      editionOffset
    );
  } catch {
    const fallback = await catalogJsonFetch<OpenLibraryEditionsResponse>(
      `https://openlibrary.org${key}/editions.json?limit=100`,
      settings
    ).catch(() => ({ entries: [] }));
    rawEditions = fallback.entries || [];
  }

  if (settings.preferRussian) {
    const russianKeys = await fetchRussianEditionKeysForWork(key, settings).catch(() => []);
    const existing = new Set(rawEditions.map((edition) => edition.key).filter(Boolean));
    const missing = russianKeys.filter((editionKey) => !existing.has(editionKey)).slice(0, 8);
    const extras = await Promise.all(missing.map((editionKey) => fetchOpenLibraryEditionByKey(editionKey, settings)));
    rawEditions = mergeOpenLibraryEditionEntries(rawEditions, extras.filter((edition): edition is OpenLibraryEdition => Boolean(edition?.key)));
  }

  const subjects = uniqueStrings([...(candidate.subjects || []), ...(work?.subjects || [])], 60);
  const enrichedWork: Partial<OnlineBookCandidate> = {
    title: work?.title || candidate.title,
    originalTitle: work?.title || candidate.originalTitle || candidate.title,
    firstPublishedYear: parseYear(work?.first_publish_date) ?? candidate.firstPublishedYear,
    originalLanguage: languageCode(work?.original_languages?.[0]?.key?.replace("/languages/", "")) || candidate.originalLanguage,
    description: textValue(work?.description) || candidate.description,
    subjects,
    genres: normalizeGenres(subjects),
    coverUrl: openLibraryCoverById(work?.covers?.find((id) => id > 0)) || candidate.coverUrl,
    sourceUrl: openLibraryWorkUrl(key)
  };

  const editions = rawEditions
    .map((edition) => mapOpenLibraryEdition(edition, { ...candidate, ...enrichedWork }, settings))
    .filter((edition): edition is OnlineBookEdition => Boolean(edition))
    .filter((edition) => edition.score > -180);
  applyOpenLibraryCoverFallbacks(editions, work?.covers);

  return {
    work: enrichedWork,
    editions: editions
      .sort((left, right) => right.score - left.score || right.metadataQuality - left.metadataQuality)
      .slice(0, editionLimit),
    hasMoreEditions: rawEditions.length >= editionLimit
  };
}

function googleCoverOptions(info: GoogleVolumeInfo): CoverOption[] {
  const cover = googleCover(info);
  return cover ? [{ url: cover, source: "google-books", exactEdition: true, verified: true }] : [];
}

function mapGoogleEdition(
  volume: GoogleVolume,
  work: OnlineBookCandidate,
  settings: InternalSettings
): OnlineBookEdition | null {
  const info = volume.volumeInfo || {};
  if (!volume.id || !info.title) return null;
  const reference: ProviderReference = {
    provider: "google-books",
    externalId: volume.id,
    kind: "volume"
  };
  const isbns = googleIsbns(info);
  const coverOptions = googleCoverOptions(info);
  const edition: OnlineBookEdition = {
    id: editionId(reference, isbns.isbn13 || isbns.isbn10),
    provider: "google-books",
    references: [reference],
    editionId: volume.id,
    title: info.title,
    subtitle: info.subtitle,
    author: info.authors?.join(", ") || work.author,
    year: parseYear(info.publishedDate),
    publisher: info.publisher,
    pageCount: info.pageCount ?? null,
    language: languageCode(info.language),
    isbn10: isbns.isbn10,
    isbn13: isbns.isbn13,
    coverUrl: pickEditionDisplayCover(coverOptions),
    coverOptions,
    coverStatus: coverOptions.length ? "available" : "missing",
    sourceUrl: info.canonicalVolumeLink || info.infoLink,
    score: 120 + (() => {
      const lang = languageCode(info.language);
      const preferred = preferredEditionLanguages(settings.preferRussian, settings.uiLocale);
      if (preferred.length > 0) {
        if (preferred.includes(lang || "")) return 100;
        if (lang) return -80;
        return -20;
      }
      return lang === "ru" ? 100 : 0;
    })(),
    metadataQuality: 0
  };
  edition.score += scriptConsistency(edition.title, edition.language);
  edition.metadataQuality = editionCompleteness(edition);
  return edition;
}

async function resolveGoogleVolume(
  reference: ProviderReference,
  candidate: OnlineBookCandidate,
  settings: InternalSettings
): Promise<ResolvedProviderWork> {
  const url = new URL(`https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(reference.externalId)}`);
  url.searchParams.set("projection", "full");
  if (settings.googleBooksApiKey.trim()) {
    url.searchParams.set("key", settings.googleBooksApiKey.trim());
  }
  const volume = await fetchJson<GoogleVolume>(url.toString(), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 2,
    headers: { Accept: "application/json" }
  });
  const info = volume.volumeInfo || {};
  const subjects = uniqueStrings([...(candidate.subjects || []), info.mainCategory, ...(info.categories || [])], 50);
  const edition = mapGoogleEdition(volume, candidate, settings);
  return {
    work: {
      description: info.description || candidate.description,
      subjects,
      genres: normalizeGenres(subjects),
      firstPublishedYear: candidate.firstPublishedYear ?? parseYear(info.publishedDate),
      coverUrl: googleCover(info) || candidate.coverUrl,
      sourceUrl: info.canonicalVolumeLink || info.infoLink || candidate.sourceUrl
    },
    editions: edition ? [edition] : []
  };
}

function editionDedupeKey(edition: OnlineBookEdition) {
  return edition.isbn13 || edition.isbn10 || [
    normalize(edition.title),
    normalize(edition.publisher || ""),
    edition.year || "",
    edition.language || ""
  ].join("|");
}

function mergeSameEdition(left: OnlineBookEdition, right: OnlineBookEdition) {
  const stronger = right.metadataQuality > left.metadataQuality ? right : left;
  const weaker = stronger === left ? right : left;
  const references = [...stronger.references];
  for (const reference of weaker.references) {
    if (!references.some((item) => item.provider === reference.provider && item.externalId === reference.externalId)) {
      references.push(reference);
    }
  }
  const coverOptions = uniqueCoverOptions([...stronger.coverOptions, ...weaker.coverOptions]);
  const merged: OnlineBookEdition = {
    ...stronger,
    references,
    subtitle: stronger.subtitle || weaker.subtitle,
    publisher: stronger.publisher || weaker.publisher,
    pageCount: stronger.pageCount ?? weaker.pageCount,
    language: stronger.language || weaker.language,
    isbn10: stronger.isbn10 || weaker.isbn10,
    isbn13: stronger.isbn13 || weaker.isbn13,
    coverOptions,
    coverUrl: pickEditionDisplayCover(coverOptions),
    coverStatus: coverOptions.length
      ? (!coverOptions[0].exactEdition
          ? "fallback"
          : coverOptions.some((option) => option.verified) ? "available" : "candidate")
      : "missing",
    coverNote: coverOptions[0]?.note,
    sourceUrl: stronger.sourceUrl || weaker.sourceUrl,
    score: Math.max(left.score, right.score) + 8,
    metadataQuality: 0
  };
  merged.metadataQuality = editionCompleteness(merged);
  return merged;
}

function mergePreviewWork(base: OnlineBookCandidate, updates: Partial<OnlineBookCandidate>[]) {
  const subjects = uniqueStrings([
    ...base.subjects,
    ...updates.flatMap((item) => item.subjects || [])
  ], 60);
  const descriptions = [base.description, ...updates.map((item) => item.description)]
    .filter((value): value is string => Boolean(value));
  const description = pickCleanDescription(...descriptions);
  const result: OnlineBookCandidate = {
    ...base,
    title: updates.find((item) => item.title)?.title || base.title,
    displayTitle: base.displayTitle,
    originalTitle: updates.find((item) => item.originalTitle)?.originalTitle || base.originalTitle || base.title,
    originalLanguage: updates.find((item) => item.originalLanguage)?.originalLanguage || base.originalLanguage,
    firstPublishedYear:
      updates.map((item) => item.firstPublishedYear).find((value) => value !== null && value !== undefined)
      ?? base.firstPublishedYear,
    subjects,
    genres: normalizeGenres(subjects),
    description,
    coverUrl: updates.find((item) => item.coverUrl)?.coverUrl || base.coverUrl,
    coverRemoteUrl: base.coverRemoteUrl || updates.find((item) => item.coverRemoteUrl)?.coverRemoteUrl,
    coverKey: base.coverKey || updates.find((item) => item.coverKey)?.coverKey,
    sourceUrl: updates.find((item) => item.sourceUrl)?.sourceUrl || base.sourceUrl,
    completeness: 0
  };
  result.completeness = workCompleteness(result);
  return result;
}

function syntheticEditionFromCandidate(
  candidate: OnlineBookCandidate,
  work: Partial<OnlineBookCandidate>
): OnlineBookEdition {
  const merged = { ...candidate, ...work };
  const provider = candidate.providers[0] || candidate.references[0]?.provider || "open-library";
  const workRef = candidate.references.find((item) => item.kind === "work");
  const editionRef = candidate.references.find((item) => item.kind === "edition" || item.kind === "volume");
  const reference = editionRef || workRef || candidate.references[0] || {
    provider,
    externalId: candidate.id,
    kind: "work" as const
  };
  const coverUrl = merged.coverRemoteUrl || merged.coverUrl;
  const coverOptions: CoverOption[] = coverUrl
    ? [{
      url: coverUrl,
      source: provider === "google-books" ? "google-books" : "work",
      exactEdition: false,
      verified: false
    }]
    : [];

  const edition: OnlineBookEdition = {
    id: editionId(reference),
    provider,
    references: [reference],
    workId: workRef?.externalId,
    editionId: editionRef?.externalId,
    title: merged.displayTitle || merged.title,
    author: merged.author,
    year: merged.firstPublishedYear ?? null,
    pageCount: null,
    language: merged.languages[0],
    coverUrl,
    coverOptions,
    coverStatus: coverUrl ? "candidate" : "missing",
    sourceUrl: merged.sourceUrl,
    score: 42,
    metadataQuality: 35
  };
  return edition;
}

async function enrichResolvedEditionCovers(
  editions: OnlineBookEdition[],
  settings: InternalSettings,
  maxTargets = 8
) {
  if (maxTargets <= 0) return;
  const targets = editions
    .filter((edition) => {
      if (edition.coverUrl && (isTrustedCoverHostUrl(edition.coverUrl) || edition.coverOptions.some((o) => o.verified))) {
        edition.coverStatus = "available";
        return false;
      }
      return !edition.coverOptions.some((option) => option.verified);
    })
    .slice(0, maxTargets);
  if (!targets.length) return;

  const applyCover = (edition: OnlineBookEdition, url: string, source: CoverOption["source"], verified = false) => {
    edition.coverOptions.unshift({
      url,
      source,
      exactEdition: true,
      verified
    });
    edition.coverOptions = uniqueCoverOptions(edition.coverOptions);
    edition.coverUrl = pickEditionDisplayCover(edition.coverOptions);
    edition.coverStatus = "available";
    edition.coverNote = undefined;
  };

  await Promise.allSettled(targets.map(async (edition) => {
    for (const option of edition.coverOptions) {
      if (option.verified) return;
      if (isTrustedCoverHostUrl(option.url)) {
        option.verified = true;
        edition.coverUrl = pickEditionDisplayCover(edition.coverOptions);
        edition.coverStatus = "available";
        return;
      }
      const verified = await verifyRemoteCoverUrl(option.url, 2_000);
      if (verified) {
        option.verified = true;
        edition.coverUrl = pickEditionDisplayCover(edition.coverOptions);
        edition.coverStatus = "available";
        return;
      }
    }

    const isbn = edition.isbn13 || edition.isbn10;
    if (isbn) {
      for (const size of ["L", "M"] as const) {
        const olUrl = openLibraryCoverByIsbn(isbn, size);
        if (!olUrl) continue;
        try {
          const cached = await cacheRemoteCover(olUrl, 4_000);
          if (cached) {
            applyCover(edition, olUrl, "isbn", true);
            return;
          }
        } catch {
          // OL may not have this ISBN cover; try next size / source.
        }
      }
    }

    if (!settings.googleBooksEnabled || !isbn) return;
    const volume = await findGoogleEditionByIsbn(isbn, settings).catch(() => null);
    const cover = volume?.volumeInfo ? googleCover(volume.volumeInfo) : undefined;
    if (cover) applyCover(edition, cover, "google-books", false);
  }));
}

export async function resolveOnlineWork(
  candidate: OnlineBookCandidate,
  options: ResolveOnlineWorkOptions = {}
): Promise<OnlineBookPreview> {
  const settings = getInternalSettings();
  const mode = options.mode || "preview";
  const editionOffset = options.editionOffset || 0;
  const editionLimit = mode === "quick" ? QUICK_EDITION_LIMIT : PREVIEW_EDITION_LIMIT;
  const cacheKey = `${candidate.id}|${mode}|${editionOffset}`;
  if (editionOffset === 0) {
    const cached = readResolvePreviewCache(cacheKey);
    if (cached) return cached;
  }
  const preferRussian = editionPreferRussian(
    candidate.displayTitle || candidate.title,
    settings.preferRussian,
    settings.uiLocale
  );
  const editionSettings = { ...settings, preferRussian };
  const fantLabOptions = {
    editionLimit,
    editionOffset,
    enrichEditionCards: mode === "preview" && editionOffset === 0
  };

  let references = candidate.references.filter((reference) => {
    if (reference.provider === "fantlab") return settings.fantlabEnabled;
    if (reference.provider === "open-library") return settings.openLibraryEnabled;
    return settings.googleBooksEnabled;
  });
  if (preferRussian && references.some((reference) => reference.provider === "fantlab" && reference.kind === "work")) {
    references = references.filter((reference) => reference.provider === "fantlab");
  }

  const tasks = references.map(async (reference) => {
    if (reference.provider === "fantlab" && (reference.kind === "work" || reference.kind === "edition")) {
      return resolveFantLabWork(reference, candidate, editionSettings, fantLabOptions);
    }
    if (reference.provider === "open-library" && reference.kind === "work") {
      return resolveOpenLibraryWork(reference, candidate, editionSettings, { editionLimit, editionOffset });
    }
    if (reference.provider === "google-books" && reference.kind === "volume") {
      return resolveGoogleVolume(reference, candidate, editionSettings);
    }
    return { work: {}, editions: [] } satisfies ResolvedProviderWork;
  });

  const settled = await Promise.allSettled(tasks);
  const resolved = settled
    .filter((item): item is PromiseFulfilledResult<ResolvedProviderWork> => item.status === "fulfilled")
    .map((item) => item.value);
  if (resolved.length === 0 && settled.some((item) => item.status === "rejected")) {
    throw (settled.find((item) => item.status === "rejected") as PromiseRejectedResult).reason;
  }

  const work = mergePreviewWork(candidate, resolved.map((item) => item.work));
  const editionMap = new Map<string, OnlineBookEdition>();
  for (const edition of resolved.flatMap((item) => item.editions)) {
    const key = editionDedupeKey(edition);
    const existing = editionMap.get(key);
    editionMap.set(key, existing ? mergeSameEdition(existing, edition) : edition);
  }
  let editions = [...editionMap.values()];
  if (candidate.coverKey || candidate.coverRemoteUrl || candidate.coverUrl) {
    editions.sort((left, right) => {
      const leftMatch = editionMatchesCover(left, candidate.coverRemoteUrl || candidate.coverUrl, candidate.coverKey) ? 1 : 0;
      const rightMatch = editionMatchesCover(right, candidate.coverRemoteUrl || candidate.coverUrl, candidate.coverKey) ? 1 : 0;
      if (rightMatch !== leftMatch) return rightMatch - leftMatch;
      return right.score - left.score || right.metadataQuality - left.metadataQuality;
    });
  } else {
    editions.sort((left, right) => right.score - left.score || right.metadataQuality - left.metadataQuality);
  }
  if (preferRussian) {
    const russianEditions = editions.filter((edition) => normalizedEditionLanguage(edition.language) === "ru");
    if (russianEditions.length) editions = russianEditions;
  } else {
    const englishEditions = editions.filter((edition) => {
      const language = normalizedEditionLanguage(edition.language);
      return !language || language === "en";
    });
    if (englishEditions.length) editions = englishEditions;
  }
  editions = editions.slice(0, editionLimit);

  await enrichResolvedEditionCovers(
    editions,
    editionSettings,
    mode === "quick" ? 0 : 3
  );

  if (editions.length > 0) {
    const catalogTotal = pickListedEditionCount(
      candidate.listedEditionCount,
      typeof work.listedEditionCount === "number" ? work.listedEditionCount : null
    );
    if (catalogTotal) {
      work.listedEditionCount = catalogTotal;
    }
  }

  const warnings: string[] = [];
  if (editions.length === 0) {
    editions.push(syntheticEditionFromCandidate(candidate, work));
  } else {
    if (editions.every((edition) => edition.coverStatus === "missing")) {
      warnings.push("preview.no_covers");
    }
  }
  if (settled.some((item) => item.status === "rejected")) {
    warnings.push("preview.partial_catalogs");
  }

  const hasMoreEditions = resolved.some((item) => item.hasMoreEditions);

  const primaryEdition = pickDefaultEdition(editions, {
    preferRussian,
    uiLocale: settings.uiLocale,
    previewCoverUrl: candidate.coverRemoteUrl || candidate.coverUrl,
    previewCoverKey: candidate.coverKey,
    originalLanguage: work.originalLanguage ?? candidate.originalLanguage,
    firstPublishedYear: work.firstPublishedYear ?? candidate.firstPublishedYear
  }) || undefined;

  if (primaryEdition?.coverUrl) {
    work.coverUrl = primaryEdition.coverUrl;
    work.coverRemoteUrl = primaryEdition.coverUrl;
  } else if (candidate.coverRemoteUrl || candidate.coverUrl) {
    work.coverUrl = candidate.coverRemoteUrl || candidate.coverUrl;
    work.coverRemoteUrl = candidate.coverRemoteUrl || candidate.coverUrl;
    work.coverKey = candidate.coverKey;
  }

  const response: OnlineBookPreview = {
    work: primaryEdition ? { ...work, primaryEdition } : work,
    editions,
    primaryEdition,
    warnings,
    hasMoreEditions
  };
  if (editionOffset === 0) writeResolvePreviewCache(cacheKey, response);
  return response;
}

export async function enrichEditionPickerCovers(
  editions: OnlineBookEdition[]
): Promise<OnlineBookEdition[]> {
  const settings = getInternalSettings();
  const fantLabEditions = editions.filter((edition) => edition.provider === "fantlab");
  if (!fantLabEditions.length) return editions;
  return enrichFantLabEditions(editions, settings);
}

export async function loadMoreOnlineEditions(
  candidate: OnlineBookCandidate,
  offset: number
): Promise<{ editions: OnlineBookEdition[]; hasMore: boolean }> {
  const settings = getInternalSettings();
  const preferRussian = editionPreferRussian(
    candidate.displayTitle || candidate.title,
    settings.preferRussian,
    settings.uiLocale
  );
  const editionSettings = { ...settings, preferRussian };

  const fantLabRef = candidate.references.find(
    (item) => item.provider === "fantlab" && item.kind === "work"
  );
  if (fantLabRef) {
    const resolved = await resolveFantLabWork(fantLabRef, candidate, editionSettings, {
      editionLimit: PREVIEW_EDITION_LIMIT,
      editionOffset: offset,
      enrichEditionCards: true
    });
    return {
      editions: resolved.editions,
      hasMore: Boolean(resolved.hasMoreEditions)
    };
  }

  const reference = candidate.references.find(
    (item) => item.provider === "open-library" && item.kind === "work"
  );
  if (!reference) return { editions: [], hasMore: false };

  const resolved = await resolveOpenLibraryWork(reference, candidate, editionSettings, {
    editionLimit: PREVIEW_EDITION_LIMIT,
    editionOffset: offset
  });
  let editions = resolved.editions;
  if (preferRussian) {
    const russianEditions = editions.filter((edition) => normalizedEditionLanguage(edition.language) === "ru");
    if (russianEditions.length) editions = russianEditions;
  } else {
    const englishEditions = editions.filter((edition) => {
      const language = normalizedEditionLanguage(edition.language);
      return !language || language === "en";
    });
    if (englishEditions.length) editions = englishEditions;
  }
  return {
    editions,
    hasMore: Boolean(resolved.hasMoreEditions)
  };
}

async function findGoogleEditionByIsbn(isbn: string, settings: InternalSettings) {
  if (!settings.googleBooksEnabled) return null;
  const items = await googleBooksRequest(`isbn:${isbn}`, settings, 10);
  const exact = items.find((volume) => {
    const identifiers = googleIsbns(volume.volumeInfo || {});
    return identifiers.isbn13 === isbn || identifiers.isbn10 === isbn;
  });
  return exact || null;
}

function metadataQuality(input: Partial<BookInput>) {
  const fields = [
    input.displayTitle,
    input.author,
    input.year,
    input.publisher,
    input.pageCount,
    input.language,
    input.isbn,
    input.coverUrl,
    input.description,
    input.genres?.length
  ];
  return Math.round((fields.reduce<number>((sum, value) => sum + (value ? 1 : 0), 0) / fields.length) * 100);
}

export async function prepareOnlineEdition(selection: OnlineEditionSelection): Promise<BookInput> {
  const settings = getInternalSettings();
  let edition = { ...selection.edition, coverOptions: [...selection.edition.coverOptions] };
  let googleVolume: GoogleVolume | null = null;
  const isbn = edition.isbn13 || edition.isbn10;
  const editionCovers = editionCoverRemoteUrls(edition);
  const preferredCoverKey = selection.preferredCoverKey || selection.work.coverKey;
  const workCovers = preferredCoverRemoteUrls({
    preferredCoverUrl: selection.preferredCoverUrl,
    preferredCoverKey: selection.preferredCoverKey,
    coverRemoteUrl: selection.work.coverRemoteUrl,
    coverKey: selection.work.coverKey,
    coverUrl: selection.work.coverUrl
  }).filter((url) => !editionCovers.includes(url));
  const coverTimeoutMs = Math.min(3_000, settings.requestTimeoutMs);

  if (isbn && settings.googleBooksEnabled) {
    try {
      googleVolume = await findGoogleEditionByIsbn(isbn, settings);
      if (googleVolume) {
        const googleEdition = mapGoogleEdition(googleVolume, selection.work, settings);
        if (googleEdition) edition = mergeSameEdition(edition, googleEdition);
      }
    } catch {
      // Google Books is a fallback source; failures should not block adding a book.
    }
  }

  const coverCandidates = uniqueStrings([
    selection.preferredCoverUrl,
    ...editionCovers.filter((url) => editionMatchesCover(edition, url, preferredCoverKey)),
    ...editionCovers,
    ...edition.coverOptions.map((option) => option.url),
    edition.coverUrl,
    ...workCovers,
    isbn ? openLibraryCoverByIsbn(isbn, "L") : undefined,
    isbn ? openLibraryCoverByIsbn(isbn, "M") : undefined,
    settings.googleBooksEnabled && googleVolume?.volumeInfo ? googleCover(googleVolume.volumeInfo) : undefined
  ], 14).filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));

  let coverUrl = "";
  let coverSource: BookInput["coverSource"] = "none";
  let coverStatus: BookInput["coverStatus"] = edition.coverOptions.length ? "download-failed" : "missing";
  let remoteFallback = editionCovers[0] || coverCandidates[0] || "";

  for (const remoteUrl of coverCandidates) {
    if (isTrustedCoverHostUrl(remoteUrl)) {
      try {
        const cached = await cacheRemoteCover(remoteUrl, coverTimeoutMs);
        coverUrl = cached || remoteUrl;
        coverSource = editionCovers.includes(remoteUrl) ? "edition" : "work";
        coverStatus = cached ? (editionMatchesCover(edition, remoteUrl, preferredCoverKey) ? "local" : "fallback") : "remote";
        break;
      } catch {
        coverUrl = remoteUrl;
        coverSource = "edition";
        coverStatus = "remote";
        break;
      }
    }
    try {
      const cached = await cacheRemoteCover(remoteUrl, coverTimeoutMs);
      if (!cached) continue;
      coverUrl = cached;
      coverSource = edition.coverOptions.some((option) => option.url === remoteUrl)
        ? (edition.coverOptions.find((option) => option.url === remoteUrl)?.source || "edition")
        : "work";
      coverStatus = editionMatchesCover(edition, remoteUrl, preferredCoverKey) ? "local" : "fallback";
      break;
    } catch {
      if (!remoteFallback) remoteFallback = remoteUrl;
    }
  }

  if (!coverUrl && isLocalCoverUrl(selection.work.coverUrl)) {
    coverUrl = selection.work.coverUrl!;
    coverSource = "work";
    coverStatus = "local";
  }

  if (!coverUrl && remoteFallback && /^https?:\/\//i.test(remoteFallback)) {
    coverUrl = remoteFallback;
    coverSource = edition.coverOptions.some((option) => option.url === remoteFallback) ? "edition" : "work";
    coverStatus = "remote";
  }

  const googleInfo = googleVolume?.volumeInfo;
  const subjects = uniqueStrings([
    ...selection.work.subjects,
    googleInfo?.mainCategory,
    ...(googleInfo?.categories || [])
  ], 60);
  const genres = normalizeGenreList(normalizeGenres(subjects));
  const description = pickCleanDescription(selection.work.description, googleInfo?.description) || "";
  const primaryReference = edition.references.find((item) => item.provider === edition.provider)
    || edition.references[0];

  const localizedTitle = selection.displayTitle?.trim() || selection.work.displayTitle || selection.work.title;
  const titlePreference = selection.titlePreference || settings.displayTitlePreference;
  const displayTitle = titlePreference === "edition"
    ? edition.title || selection.work.title
    : localizedTitle;

  const input: BookInput = {
    displayTitle,
    workTitle: selection.work.title,
    originalTitle: selection.work.originalTitle || selection.work.title,
    editionTitle: edition.title || selection.work.title,
    subtitle: normalizeBookSubtitle(edition.subtitle || "", displayTitle),
    author: edition.author || selection.work.author,
    year: edition.year,
    firstPublishedYear: selection.work.firstPublishedYear,
    category: genres[0] || "fiction",
    genres,
    subjects,
    publisher: edition.publisher || googleInfo?.publisher || "",
    pageCount: edition.pageCount ?? googleInfo?.pageCount ?? null,
    language: edition.language || languageCode(googleInfo?.language) || "",
    status: "want",
    rating: null,
    readDate: null,
    review: "",
    reviewerName: "",
    coverUrl,
    coverSource,
    coverStatus,
    isbn: edition.isbn13 || edition.isbn10 || "",
    description,
    source: edition.provider,
    externalId: primaryReference?.externalId,
    workId: edition.workId || selection.work.references.find((item) => item.kind === "work")?.externalId,
    editionId: edition.editionId || primaryReference?.externalId,
    sourceUrl: edition.sourceUrl || selection.work.sourceUrl,
    metadataQuality: null
  };
  input.metadataQuality = metadataQuality(input);
  return input;
}

export async function diagnoseProviders(): Promise<ProviderDiagnostic[]> {
  const settings = getInternalSettings();
  const diagnostics: ProviderDiagnostic[] = [];

  async function diagnose(
    provider: ProviderDiagnostic["provider"],
    service: ProviderDiagnostic["service"],
    enabled: boolean,
    configured: boolean,
    run: () => Promise<unknown>
  ) {
    const started = Date.now();
    if (!enabled) {
      diagnostics.push({ provider, service, enabled, configured, ok: false, durationMs: 0, message: "Источник отключён" });
      return;
    }
    if (!configured) {
      diagnostics.push({ provider, service, enabled, configured, ok: false, durationMs: 0, message: "Не настроен API-ключ" });
      return;
    }
    try {
      await run();
      diagnostics.push({ provider, service, enabled, configured, ok: true, durationMs: Date.now() - started, message: "Соединение установлено" });
    } catch (error) {
      const message = describeNetworkError(error);
      const friendly = /428|429|quota|Quota/i.test(message)
        ? "Лимит Google Books без ключа исчерпан — добавьте свой API-ключ или отключите источник"
        : message;
      diagnostics.push({ provider, service, enabled, configured, ok: false, durationMs: Date.now() - started, message: friendly });
    }
  }

  await Promise.all([
    diagnose("fantlab", "metadata", settings.fantlabEnabled, true, async () => {
      const result = await diagnoseFantLab(settings);
      if (!result.ok) throw new Error(result.message);
    }),
    diagnose("google-books", "metadata", settings.googleBooksEnabled, true, () =>
      googleBooksRequest("isbn:9780140328721", settings, 1)
    ),
    diagnose("open-library", "metadata", settings.openLibraryEnabled, true, () =>
      openLibraryRequest({ isbn: "9780140328721" }, 1, settings)
    ),
    diagnose("gutendex", "metadata", settings.gutendexEnabled, true, async () => {
      const result = await diagnoseGutendex(settings);
      if (!result.ok) throw new Error(result.message);
    }),
    diagnose("hardcover", "metadata", settings.hardcoverEnabled, Boolean(settings.hardcoverApiToken), async () => {
      const result = await diagnoseHardcover(settings);
      if (!result.ok) throw new Error(result.message);
    }),
    diagnose("open-library", "covers", settings.openLibraryEnabled, true, () =>
      fetchResponse("https://covers.openlibrary.org/b/id/12547191-S.jpg?default=false", {
        timeoutMs: settings.requestTimeoutMs,
        retries: 1,
        headers: { Accept: "image/*", "User-Agent": APP_USER_AGENT }
      })
    ),
    diagnose("wikidata", "resolver", true, true, () =>
      fetchJson("https://www.wikidata.org/w/api.php?action=wbsearchentities&search=book&language=en&type=item&limit=1&format=json&origin=*", {
        timeoutMs: settings.requestTimeoutMs,
        retries: 1,
        headers: { Accept: "application/json", "User-Agent": APP_USER_AGENT }
      })
    )
  ]);

  const indexInfo = getOpenLibraryIndexInfo();
  const openLibraryMeta = diagnostics.find((item) => item.provider === "open-library" && item.service === "metadata");
  if (openLibraryMeta?.ok) {
    openLibraryMeta.message = indexInfo.ready
      ? `${openLibraryMeta.message} · локальный кэш: ${indexInfo.works} произведений`
      : `${openLibraryMeta.message} · локальный кэш пуст (растёт при поиске)`;
  }

  return diagnostics;
}

let classicsWarmStarted = false;

function warmDelay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startOpenLibraryClassicsWarm() {
  if (classicsWarmStarted) return;
  classicsWarmStarted = true;
  void warmOpenLibraryClassicsIndex();
}

async function warmOpenLibraryClassicsIndex() {
  const info = getOpenLibraryIndexInfo();
  if (info.works >= 120) return;
  const settings = getInternalSettings();
  if (!settings.openLibraryEnabled) return;

  const queries = uniqueStrings(
    listCuratedCatalogRows().map((row) => row.titleEn || row.titleRu).filter(Boolean),
    28
  );

  for (const query of queries) {
    try {
      const docs = await openLibraryRequest({ q: query }, 5, settings);
      if (docs.length) upsertOpenLibraryIndexDocs(docs as OpenLibraryIndexDoc[]);
    } catch {
      // ignore
    }
    await warmDelay(280);
    if (getOpenLibraryIndexInfo().works >= 120) break;
  }
}

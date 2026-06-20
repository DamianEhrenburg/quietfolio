import { createHash } from "node:crypto";
import { APP_USER_AGENT } from "../../src/shared/appMeta";
import type {
  BookProvider,
  CoverOption,
  OnlineBookCandidate,
  OnlineBookEdition,
  ProviderReference
} from "../../src/shared/types";
import { MISSING_AUTHOR } from "../../src/shared/authorSentinel";
import { describeNetworkError, fetchJson } from "./networkClient";
import type { InternalSettings } from "./settingsService";
import type { ResolvedSearchPlan } from "./queryResolver";
import { latinSearchVariants } from "./searchLatin";

const FANTLAB_API = "https://api.fantlab.ru";
const FANTLAB_SITE = "https://fantlab.ru";
const USER_AGENT = APP_USER_AGENT;

const NON_FICTION_WORK_TYPES = new Set([
  "article",
  "review",
  "essay",
  "monography",
  "sketch",
  "biography",
  "interview"
]);

const SOFT_NON_FICTION_WORK_TYPES = new Set(["essay", "monography", "sketch"]);

interface FantLabWorkMatch {
  work_id: number;
  rusname?: string;
  name?: string;
  altname?: string;
  all_autor_rusname?: string;
  all_autor_name?: string;
  autor1_rusname?: string;
  autor1_id?: number;
  year?: number;
  markcount?: number;
  weight?: number;
  name_eng?: string;
  name_show_im?: string;
  work_type_id?: number;
  level?: number;
  pic_edition_id_auto?: number;
  midmark?: number[];
  rating?: number[];
}

interface FantLabAuthorMatch {
  autor_id: number;
  name?: string;
  rusname?: string;
  weight?: number;
  editioncount?: number;
  markcount?: number;
}

interface FantLabEditionMatch {
  edition_id: number;
  name?: string;
  autors?: string;
  publisher?: string;
  year?: number;
  isbn1?: string;
  isbn2?: string;
  weight?: number;
}

interface FantLabWorkCard {
  work_id: number;
  work_name?: string;
  work_name_orig?: string;
  work_name_alts?: string[];
  work_description?: string;
  work_year?: number;
  work_type?: string;
  lang_code?: string;
  image?: string;
  authors?: Array<{ id?: number; name?: string; name_orig?: string }>;
  rating?: { rating?: string | number; voters?: number };
  val_voters?: number;
}

interface FantLabEditionListItem {
  edition_id: number;
  name?: string;
  year?: number;
  lang?: string;
  lang_code?: string;
  autors?: string;
  correct_level?: number;
}

interface FantLabEditionsBlock {
  list?: FantLabEditionListItem[];
}

interface FantLabWorkExtended extends FantLabWorkCard {
  pic_edition_id_auto?: number;
  editions_blocks?: Record<string, FantLabEditionsBlock> | null;
  editions_info?: { all?: number } | null;
  classificatory?: {
    genre_group?: Array<{
      label?: string;
      genre?: Array<{ label?: string; percent?: number }>;
    }>;
  } | null;
}

interface FantLabEditionCard {
  edition_id: number;
  edition_name?: string;
  year?: number;
  pages?: number;
  lang?: string;
  lang_code?: string;
  image?: string;
  isbns?: Array<string | null>;
  creators?: {
    authors?: Array<{ name?: string }>;
    publishers?: Array<{ name?: string }>;
  };
  series?: Array<{ name?: string } | null> | null;
}

interface FantLabBiblioWork {
  work_id: number;
  work_name?: string;
  work_name_orig?: string;
  work_name_alt?: string;
  work_year?: number;
  work_type?: string;
  work_type_name?: string;
  work_type_id?: number;
  authors?: Array<{ id?: number; name?: string }>;
  rating?: { rating?: number; voters?: number };
  val_voters?: number;
}

interface FantLabBiblioBlock {
  list?: FantLabBiblioWork[];
}

interface FantLabAuthorExtended {
  autor_id?: number;
  name?: string;
  name_orig?: string;
  works_blocks?: Record<string, FantLabBiblioBlock> | null;
  biblio_blocks?: {
    works_blocks?: Record<string, FantLabBiblioBlock> | null;
  } | null;
}

export interface FantLabProviderResult {
  provider: BookProvider;
  results: OnlineBookCandidate[];
  durationMs: number;
}

export interface FantLabResolvedWork {
  work: Partial<OnlineBookCandidate>;
  editions: OnlineBookEdition[];
  hasMoreEditions?: boolean;
}

type ScoreCandidate = (
  candidate: OnlineBookCandidate,
  plan: ResolvedSearchPlan,
  settings: InternalSettings
) => OnlineBookCandidate;

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

function authorTokens(value: string) {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1);
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

function hasCyrillic(value: string) {
  return /[\u0400-\u04FF]/.test(value);
}

function languageCode(value?: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "ru" || normalized.startsWith("рус")) return "ru";
  if (normalized === "en" || normalized.startsWith("англ")) return "en";
  return normalized.slice(0, 2);
}

function fantLabQueryTerms(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => encodeURIComponent(term))
    .join("+");
}

function fantLabUrl(path: string) {
  return `${FANTLAB_API}${path.startsWith("/") ? path : `/${path}`}`;
}

function fantLabAssetUrl(path?: string) {
  if (!path) return undefined;
  if (path.startsWith("http")) return path;
  return `${FANTLAB_SITE}${path}`;
}

function fantLabHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT
  };
}

async function fantLabRequest<T>(path: string, settings: InternalSettings) {
  return fetchJson<T>(fantLabUrl(path), {
    timeoutMs: settings.requestTimeoutMs,
    retries: 3,
    preferNodeTransport: true,
    headers: fantLabHeaders()
  });
}

function candidateId(references: ProviderReference[], title: string, author: string) {
  return createHash("sha1")
    .update(`${references.map((item) => `${item.provider}:${item.kind}:${item.externalId}`).join("|")}|${title}|${author}`)
    .digest("hex")
    .slice(0, 20);
}

function editionHash(reference: ProviderReference, isbn?: string) {
  return createHash("sha1")
    .update(`${reference.provider}:${reference.kind}:${reference.externalId}:${isbn || ""}`)
    .digest("hex")
    .slice(0, 20);
}

function parseAltNames(value?: string) {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripBbTags(value?: string) {
  return value?.replace(/\[\/??[^\]]+\]/g, "").replace(/<[^>]+>/g, "").trim();
}

function isFantLabFictionWork(work: Pick<FantLabWorkMatch, "name_eng" | "work_type_id" | "level">) {
  const typeName = work.name_eng?.toLowerCase() || "";
  if (typeName && NON_FICTION_WORK_TYPES.has(typeName)) return false;
  if (work.work_type_id === 1) return true;
  if ((work.level || 99) <= 12) return true;
  return ["novel", "shortstory", "novelette", "poem", "play", "story"].includes(typeName);
}

function isFantLabSearchableWork(
  work: Pick<FantLabWorkMatch, "name_eng" | "work_type_id" | "level">,
  plan: ResolvedSearchPlan,
  preferRussian: boolean
) {
  if (isFantLabFictionWork(work)) return true;
  if (!preferRussian) return false;
  if (plan.resolvedMode !== "title" && plan.resolvedMode !== "author") return false;
  const typeName = work.name_eng?.toLowerCase() || "";
  if (!typeName || !SOFT_NON_FICTION_WORK_TYPES.has(typeName)) return false;
  return (work.level || 99) <= 18;
}

function fantLabPopularity(work: Pick<FantLabWorkMatch, "markcount" | "weight" | "midmark" | "rating">) {
  const marks = Math.max(0, work.markcount || 0);
  const weight = Math.max(0, work.weight || 0);
  const rating = Math.max(0, ...(work.midmark || []), ...(work.rating || []));
  return Math.round(Math.log2(1 + marks) * 18 + Math.log2(1 + weight) * 6 + rating * 8);
}

function fantLabGenres(work?: FantLabWorkExtended) {
  const labels: string[] = [];
  if (work?.work_type) labels.push(work.work_type);
  for (const group of work?.classificatory?.genre_group || []) {
    for (const genre of group.genre || []) {
      if ((genre.percent || 0) >= 0.2 && genre.label) labels.push(genre.label);
    }
  }
  return uniqueStrings(labels, 8);
}

function normalizeIsbn(value?: string) {
  const normalized = value?.replace(/[^0-9X]/gi, "").toUpperCase();
  if (!normalized) return undefined;
  if (normalized.length === 10 || normalized.length === 13) return normalized;
  return undefined;
}

function parseFantLabIsbns(edition: FantLabEditionCard) {
  const values = uniqueStrings((edition.isbns || []).map((item) => item || ""), 6);
  let isbn13: string | undefined;
  let isbn10: string | undefined;
  for (const raw of values) {
    const normalized = normalizeIsbn(raw);
    if (!normalized) continue;
    if (normalized.length === 13) isbn13 = normalized;
    if (normalized.length === 10) isbn10 = normalized;
  }
  return { isbn13, isbn10 };
}

function mapFantLabWork(
  work: FantLabWorkMatch,
  settings: InternalSettings,
  query: string
): OnlineBookCandidate | null {
  if (!work.work_id) return null;
  const author = stripBbTags(work.all_autor_rusname || work.autor1_rusname || work.all_autor_name) || MISSING_AUTHOR;
  const russianTitle = work.rusname?.trim();
  const originalTitle = work.name?.trim() || russianTitle;
  const displayTitle = settings.preferRussian && russianTitle ? russianTitle : (russianTitle || originalTitle || "");
  if (!displayTitle) return null;

  const alternateTitles = uniqueStrings([
    russianTitle,
    originalTitle,
    ...parseAltNames(work.altname)
  ], 12);
  const reference: ProviderReference = {
    provider: "fantlab",
    externalId: String(work.work_id),
    kind: "work"
  };
  const languages = uniqueStrings([
    russianTitle ? "ru" : "",
    originalTitle && !russianTitle ? "en" : "",
    "ru"
  ], 4);
  const coverUrl = work.pic_edition_id_auto
    ? fantLabEditionCoverUrl(work.pic_edition_id_auto)
    : undefined;

  const candidate: OnlineBookCandidate = {
    id: candidateId([reference], displayTitle, author),
    providers: ["fantlab"],
    references: [reference],
    title: displayTitle,
    originalTitle: originalTitle || displayTitle,
    alternateTitles,
    author,
    firstPublishedYear: work.year ?? null,
    editionCount: 0,
    listedEditionCount: null,
    languages,
    genres: work.name_show_im ? [work.name_show_im] : [],
    subjects: uniqueStrings([work.name_show_im, work.name_eng], 6),
    coverUrl,
    coverRemoteUrl: coverUrl,
    coverKey: work.pic_edition_id_auto ? `fl-edition:${work.pic_edition_id_auto}` : undefined,
    previewEditionId: work.pic_edition_id_auto ? String(work.pic_edition_id_auto) : undefined,
    sourceUrl: `${FANTLAB_SITE}/work${work.work_id}`,
    score: 0,
    completeness: 0,
    authorKeys: work.autor1_id ? [String(work.autor1_id)] : [],
    popularity: fantLabPopularity(work)
  };

  if (settings.preferRussian && hasCyrillic(query)) candidate.score += 90;
  if (hasCyrillic(displayTitle)) candidate.score += 55;
  candidate.completeness = [
    candidate.title,
    candidate.author,
    candidate.firstPublishedYear,
    candidate.coverUrl,
    candidate.languages.length,
    candidate.alternateTitles?.length
  ].filter(Boolean).length * 16;
  return candidate;
}

function mapFantLabBiblioWork(work: FantLabBiblioWork, authorName: string, settings: InternalSettings): OnlineBookCandidate | null {
  if (!work.work_id || !work.work_name) return null;
  const reference: ProviderReference = {
    provider: "fantlab",
    externalId: String(work.work_id),
    kind: "work"
  };
  const alternateTitles = uniqueStrings([
    work.work_name,
    work.work_name_orig,
    ...parseAltNames(work.work_name_alt)
  ], 12);
  const displayTitle = settings.preferRussian ? work.work_name : (work.work_name || work.work_name_orig || "");
  const author = uniqueStrings(
    (work.authors || []).map((item) => item.name),
    4
  ).join(", ") || authorName;

  const candidate: OnlineBookCandidate = {
    id: candidateId([reference], displayTitle, author),
    providers: ["fantlab"],
    references: [reference],
    title: displayTitle,
    originalTitle: work.work_name_orig || work.work_name,
    alternateTitles,
    author,
    firstPublishedYear: work.work_year ?? null,
    editionCount: 0,
    listedEditionCount: null,
    languages: ["ru"],
    genres: work.work_type ? [work.work_type] : [],
    subjects: uniqueStrings([work.work_type, work.work_type_name], 4),
    sourceUrl: `${FANTLAB_SITE}/work${work.work_id}`,
    score: 0,
    completeness: 0,
    authorKeys: (work.authors || []).map((item) => String(item.id || "")).filter(Boolean),
    popularity: Math.round(Math.log2(1 + (work.val_voters || work.rating?.voters || 0)) * 24 + (work.rating?.rating || 0) * 10)
  };
  candidate.completeness = 64;
  return candidate;
}

function fantLabPreviewEditionId(candidate: OnlineBookCandidate) {
  if (candidate.previewEditionId) return Number(candidate.previewEditionId);
  if (candidate.coverKey?.startsWith("fl-edition:")) {
    return Number(candidate.coverKey.slice("fl-edition:".length));
  }
  const match = candidate.coverRemoteUrl?.match(/\/editions\/big\/(\d+)/i)
    || candidate.coverUrl?.match(/\/editions\/big\/(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function fantLabEditionCoverUrl(editionId: number) {
  return fantLabAssetUrl(`/images/editions/big/${editionId}`);
}

function collectFantLabEditionItems(blocks?: Record<string, FantLabEditionsBlock> | null) {
  const result: FantLabEditionListItem[] = [];
  for (const block of Object.values(blocks || {})) {
    for (const item of block.list || []) {
      if (item.edition_id) result.push(item);
    }
  }
  return result;
}

function collectFantLabBiblioWorks(blocks?: Record<string, FantLabBiblioBlock> | null) {
  const result: FantLabBiblioWork[] = [];
  for (const block of Object.values(blocks || {})) {
    for (const item of block.list || []) {
      if (item.work_id && item.work_name) result.push(item);
    }
  }
  return result;
}

function mapFantLabEditionListItem(
  item: FantLabEditionListItem,
  work: OnlineBookCandidate,
  settings: InternalSettings,
  fallbackAuthor: string
): OnlineBookEdition | null {
  if (!item.edition_id) return null;
  const reference: ProviderReference = {
    provider: "fantlab",
    externalId: String(item.edition_id),
    kind: "edition"
  };
  const language = languageCode(item.lang_code || item.lang) || (settings.preferRussian ? "ru" : undefined);
  const author = stripBbTags(item.autors) || fallbackAuthor || work.author;
  const title = stripBbTags(item.name) || work.title;
  let score = 80;
  if (language === "ru") score += settings.preferRussian ? 120 : 40;
  if (item.year) score += 8;

  return {
    id: editionHash(reference),
    provider: "fantlab",
    references: [reference],
    workId: work.references.find((entry) => entry.provider === "fantlab" && entry.kind === "work")?.externalId,
    editionId: String(item.edition_id),
    title,
    author,
    year: item.year ?? null,
    pageCount: null,
    language,
    coverOptions: [],
    coverStatus: "candidate",
    sourceUrl: `${FANTLAB_SITE}/edition${item.edition_id}`,
    score,
    metadataQuality: Math.round(
      ([title, author, item.year, language] as unknown[]).filter(Boolean).length / 4 * 100
    )
  };
}

function mapFantLabEdition(
  edition: FantLabEditionCard,
  work: OnlineBookCandidate,
  settings: InternalSettings,
  fallbackAuthor?: string
): OnlineBookEdition | null {
  if (!edition.edition_id) return null;
  const reference: ProviderReference = {
    provider: "fantlab",
    externalId: String(edition.edition_id),
    kind: "edition"
  };
  const { isbn13, isbn10 } = parseFantLabIsbns(edition);
  const coverUrl = fantLabAssetUrl(edition.image);
  const coverOptions: CoverOption[] = coverUrl
    ? [{ url: coverUrl, source: "edition", exactEdition: true, verified: true }]
    : [];
  const language = languageCode(edition.lang_code || edition.lang) || (settings.preferRussian ? "ru" : undefined);
  const author = stripBbTags(
    edition.creators?.authors?.map((item) => item.name).join(", ")
  ) || fallbackAuthor || work.author;
  const title = edition.edition_name || work.title;
  const publisher = edition.creators?.publishers
    ?.map((item) => stripBbTags(item.name))
    .filter(Boolean)
    .join(", ");
  let score = 100;
  if (language === "ru") score += settings.preferRussian ? 120 : 40;
  if (coverUrl) score += 24;
  if (isbn13 || isbn10) score += 36;
  if (edition.pages) score += 8;

  return {
    id: editionHash(reference, isbn13 || isbn10),
    provider: "fantlab",
    references: [reference],
    workId: work.references.find((item) => item.provider === "fantlab" && item.kind === "work")?.externalId,
    editionId: String(edition.edition_id),
    title,
    author,
    year: edition.year ?? null,
    publisher,
    pageCount: edition.pages ?? null,
    language,
    isbn10,
    isbn13,
    coverUrl,
    coverOptions,
    coverStatus: coverUrl ? "available" : "missing",
    sourceUrl: `${FANTLAB_SITE}/edition${edition.edition_id}`,
    score,
    metadataQuality: Math.round(
      ([title, author, edition.year, publisher, edition.pages, language, isbn13 || isbn10, coverUrl] as unknown[])
        .filter(Boolean).length / 8 * 100
    )
  };
}

async function searchFantLabWorks(
  query: string,
  settings: InternalSettings,
  limit: number,
  plan: ResolvedSearchPlan
) {
  const data = await fantLabRequest<FantLabWorkMatch[]>(
    `/search-works?q=${fantLabQueryTerms(query)}&page=1&onlymatches=1`,
    settings
  );
  return (Array.isArray(data) ? data : [])
    .filter((work) => isFantLabSearchableWork(work, plan, settings.preferRussian))
    .slice(0, limit);
}

async function searchFantLabAuthors(query: string, settings: InternalSettings) {
  const data = await fantLabRequest<FantLabAuthorMatch[]>(
    `/search-autors?q=${fantLabQueryTerms(query)}&page=1&onlymatches=1`,
    settings
  );
  return Array.isArray(data) ? data : [];
}

async function searchFantLabEditions(query: string, settings: InternalSettings, limit: number) {
  const data = await fantLabRequest<FantLabEditionMatch[]>(
    `/search-editions?q=${fantLabQueryTerms(query)}&page=1&onlymatches=1`,
    settings
  );
  return (Array.isArray(data) ? data : []).slice(0, limit);
}

async function fetchFantLabAuthorWorks(authorId: number, authorName: string, settings: InternalSettings, limit: number) {
  const data = await fantLabRequest<FantLabAuthorExtended>(
    `/autor/${authorId}/extended?biblio_blocks=1&sort=rating`,
    settings
  );
  const works = [
    ...collectFantLabBiblioWorks(data.works_blocks),
    ...collectFantLabBiblioWorks(data.biblio_blocks?.works_blocks)
  ];
  const seen = new Set<number>();
  return works
    .filter((work) => {
      const id = Number(work.work_id);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, limit)
    .map((work) => mapFantLabBiblioWork(work, authorName, settings))
    .filter((item): item is OnlineBookCandidate => Boolean(item));
}

function pickFantLabAuthor(authors: FantLabAuthorMatch[], plan: ResolvedSearchPlan) {
  if (authors.length === 0) return null;
  const variants = uniqueStrings([
    plan.authorName,
    plan.canonicalQuery,
    plan.originalQuery,
    ...plan.authorVariants
  ], 10);
  let best = authors[0];
  let bestScore = -1;
  for (const author of authors) {
    const names = uniqueStrings([author.rusname, author.name], 4);
    let score = author.weight || 0;
    for (const variant of variants) {
      const normalizedVariant = normalize(variant);
      const variantTokens = authorTokens(variant);
      for (const name of names) {
        const normalizedName = normalize(name);
        const nameTokens = authorTokens(name);
        if (normalizedVariant && normalizedName === normalizedVariant) score += 5000;
        else if (variantTokens.length > 0 && variantTokens.every((token) => nameTokens.includes(token))) {
          score += 4200;
        }
      }
    }
    if (score > bestScore) {
      best = author;
      bestScore = score;
    }
  }
  return best;
}

function buildFantLabQueries(plan: ResolvedSearchPlan) {
  const queries = new Set<string>();
  const add = (value?: string) => {
    for (const variant of latinSearchVariants(value)) queries.add(variant);
  };

  if (plan.resolvedMode === "isbn") {
    add(plan.canonicalQuery);
  } else if (plan.resolvedMode === "author") {
    add(plan.originalQuery);
    add(plan.authorName);
    for (const variant of plan.authorVariants) add(variant);
    add(plan.canonicalQuery);
    for (const title of plan.notableWorkTitles || []) add(title);
  } else if (plan.resolvedMode === "title") {
    if (plan.source === "combined" && plan.authorName) {
      add(plan.canonicalQuery);
      add(`${plan.canonicalQuery} ${plan.authorName}`);
      for (const variant of plan.authorVariants.slice(0, 2)) {
        if (variant) add(`${plan.canonicalQuery} ${variant}`);
      }
    }
    add(plan.originalQuery);
    add(plan.canonicalQuery);
    for (const variant of plan.titleVariants) add(variant);
    if (plan.authorName) add(`${plan.originalQuery} ${plan.authorName}`);
  } else {
    add(plan.originalQuery);
    add(plan.canonicalQuery);
    if (hasCyrillic(plan.originalQuery)) add(plan.displayLabel);
  }
  return [...queries];
}

export async function searchFantLab(
  plan: ResolvedSearchPlan,
  settings: InternalSettings,
  scoreCandidate: ScoreCandidate
): Promise<FantLabProviderResult> {
  const started = Date.now();
  const limit = Math.max(10, settings.searchLimit);
  const queries = buildFantLabQueries(plan);
  const tasks: Array<Promise<OnlineBookCandidate[]>> = [];

  if (plan.resolvedMode === "isbn") {
    tasks.push(
      searchFantLabEditions(plan.canonicalQuery, settings, limit).then(async (editions) => {
        const results: OnlineBookCandidate[] = [];
        for (const edition of editions.slice(0, 8)) {
          const title = stripBbTags(edition.name) || plan.canonicalQuery;
          const author = stripBbTags(edition.autors) || MISSING_AUTHOR;
          const reference: ProviderReference = {
            provider: "fantlab",
            externalId: String(edition.edition_id),
            kind: "edition"
          };
          const candidate: OnlineBookCandidate = {
            id: candidateId([reference], title, author),
            providers: ["fantlab"],
            references: [reference],
            title,
            author,
            firstPublishedYear: edition.year ?? null,
            editionCount: 0,
            languages: ["ru"],
            genres: [],
            subjects: [],
            sourceUrl: `${FANTLAB_SITE}/edition${edition.edition_id}`,
            score: 1200,
            completeness: 48,
            popularity: edition.weight || 0
          };
          results.push(scoreCandidate(candidate, plan, settings));
        }
        return results;
      })
    );
  } else if (plan.resolvedMode === "author") {
    const primaryQuery = plan.authorName || plan.canonicalQuery || plan.originalQuery;
    tasks.push(
      searchFantLabAuthors(primaryQuery, settings).then(async (authors) => {
        const author = pickFantLabAuthor(authors, plan);
        if (!author?.autor_id) return [];
        return fetchFantLabAuthorWorks(
          author.autor_id,
          author.rusname || author.name || plan.authorName || plan.originalQuery,
          settings,
          limit * 2
        );
      })
    );
    const workQuery = plan.notableWorkTitles?.[0] || plan.originalQuery;
    if (normalize(workQuery) !== normalize(primaryQuery)) {
      tasks.push(
        searchFantLabWorks(workQuery, settings, limit, plan).then((works) =>
          works
            .map((work) => mapFantLabWork(work, settings, plan.originalQuery))
            .filter((item): item is OnlineBookCandidate => Boolean(item))
            .map((candidate) => scoreCandidate(candidate, plan, settings))
        )
      );
    }
  } else {
    for (const query of queries.slice(0, 5)) {
      tasks.push(
        searchFantLabWorks(query, settings, limit * 2, plan).then((works) =>
          works
            .map((work) => mapFantLabWork(work, settings, plan.originalQuery))
            .filter((item): item is OnlineBookCandidate => Boolean(item))
            .map((candidate) => scoreCandidate(candidate, plan, settings))
        )
      );
    }
  }

  const settled = await Promise.allSettled(tasks);
  const seen = new Set<string>();
  const results = settled
    .filter((item): item is PromiseFulfilledResult<OnlineBookCandidate[]> => item.status === "fulfilled")
    .flatMap((item) => item.value)
    .filter((candidate) => {
      const key = `${normalize(candidate.title)}|${normalize(candidate.author)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  if (results.length === 0 && settled.length > 0 && settled.every((item) => item.status === "rejected")) {
    throw settled[0].status === "rejected" ? settled[0].reason : new Error("FantLab не ответил");
  }

  return { provider: "fantlab", results, durationMs: Date.now() - started };
}

export async function resolveFantLabWork(
  reference: ProviderReference,
  candidate: OnlineBookCandidate,
  settings: InternalSettings,
  options: { editionLimit?: number; editionOffset?: number; enrichEditionCards?: boolean } = {}
): Promise<FantLabResolvedWork> {
  const editionLimit = options.editionLimit ?? 24;
  const editionOffset = options.editionOffset ?? 0;
  const enrichEditionCards = options.enrichEditionCards ?? editionLimit > 6;
  if (reference.kind === "edition") {
    const edition = await fantLabRequest<FantLabEditionCard>(`/edition/${reference.externalId}`, settings);
    const mapped = mapFantLabEdition(edition, candidate, settings);
    return {
      work: {
        title: edition.edition_name || candidate.title,
        languages: uniqueStrings([languageCode(edition.lang_code || edition.lang), "ru"], 4),
        coverUrl: fantLabAssetUrl(edition.image) || candidate.coverUrl,
        sourceUrl: `${FANTLAB_SITE}/edition${edition.edition_id}`
      },
      editions: mapped ? [mapped] : []
    };
  }

  const work = await fantLabRequest<FantLabWorkExtended>(`/work/${reference.externalId}/extended`, settings);
  const author = uniqueStrings(
    (work.authors || []).map((item) => item.name || item.name_orig),
    4
  ).join(", ") || candidate.author;
  const catalogTotal = work.editions_info?.all || 0;
  const allEditionItems = collectFantLabEditionItems(work.editions_blocks)
    .filter((item) => !settings.preferRussian || languageCode(item.lang_code || item.lang) === "ru")
    .sort((left, right) => (right.year || 0) - (left.year || 0));

  const previewEditionId = fantLabPreviewEditionId(candidate);
  if (previewEditionId) {
    const previewIndex = allEditionItems.findIndex((item) => item.edition_id === previewEditionId);
    if (previewIndex > 0) {
      const [previewItem] = allEditionItems.splice(previewIndex, 1);
      allEditionItems.unshift(previewItem);
    } else if (previewIndex < 0) {
      allEditionItems.unshift({
        edition_id: previewEditionId,
        name: candidate.title,
        year: candidate.firstPublishedYear ?? undefined,
        lang_code: settings.preferRussian ? "ru" : undefined
      });
    }
  }

  const editionItems = allEditionItems.slice(editionOffset, editionOffset + editionLimit);
  const previewCover = previewEditionId
    ? fantLabEditionCoverUrl(previewEditionId)
    : undefined;
  const enrichedWork: Partial<OnlineBookCandidate> = {
    title: work.work_name || candidate.title,
    originalTitle: work.work_name_orig || candidate.originalTitle || candidate.title,
    alternateTitles: uniqueStrings([
      ...(candidate.alternateTitles || []),
      work.work_name,
      work.work_name_orig,
      ...(work.work_name_alts || [])
    ], 20),
    firstPublishedYear: work.work_year ?? candidate.firstPublishedYear,
    originalLanguage: languageCode(work.lang_code) || candidate.originalLanguage,
    description: stripBbTags(work.work_description) || candidate.description,
    genres: fantLabGenres(work),
    subjects: fantLabGenres(work),
    languages: uniqueStrings(["ru", languageCode(work.lang_code)], 4),
    coverUrl: previewCover || fantLabAssetUrl(work.image) || candidate.coverUrl,
    coverRemoteUrl: previewCover || candidate.coverRemoteUrl || candidate.coverUrl,
    coverKey: candidate.coverKey || (previewEditionId ? `fl-edition:${previewEditionId}` : undefined),
    previewEditionId: candidate.previewEditionId || (previewEditionId ? String(previewEditionId) : undefined),
    sourceUrl: `${FANTLAB_SITE}/work${work.work_id}`,
    listedEditionCount: catalogTotal || candidate.listedEditionCount || allEditionItems.length || null,
    popularity: Math.max(
      candidate.popularity || 0,
      Math.round(Math.log2(1 + (work.val_voters || work.rating?.voters || 0)) * 20)
    )
  };

  const enrichCount = enrichEditionCards
    ? (editionOffset > 0 ? editionItems.length : Math.min(4, editionItems.length))
    : 0;
  const enriched = enrichCount > 0
    ? await Promise.all(
      editionItems.slice(0, enrichCount).map(async (item) => {
        try {
          const edition = await fantLabRequest<FantLabEditionCard>(`/edition/${item.edition_id}`, settings);
          return mapFantLabEdition(edition, { ...candidate, ...enrichedWork }, settings, author);
        } catch {
          return mapFantLabEditionListItem(item, { ...candidate, ...enrichedWork }, settings, author);
        }
      })
    )
    : [];
  const editions = [
    ...enriched,
    ...editionItems
      .slice(enrichCount)
      .map((item) => mapFantLabEditionListItem(item, { ...candidate, ...enrichedWork }, settings, author))
  ]
    .filter((edition): edition is OnlineBookEdition => Boolean(edition))
    .sort((left, right) => {
      if (previewEditionId) {
        const leftPreview = left.editionId === String(previewEditionId) ? 1 : 0;
        const rightPreview = right.editionId === String(previewEditionId) ? 1 : 0;
        if (rightPreview !== leftPreview) return rightPreview - leftPreview;
      }
      return right.score - left.score;
    });

  return {
    work: enrichedWork,
    editions,
    hasMoreEditions: editionOffset + editionLimit < allEditionItems.length
  };
}

export async function fetchFantLabWorkCatalogMeta(
  workId: string,
  settings: InternalSettings,
  keepSearchCover = false
): Promise<{ coverUrl?: string; listedEditionCount?: number; previewEditionId?: string }> {
  const work = await fantLabRequest<FantLabWorkExtended>(`/work/${workId}/extended`, settings);
  const previewEditionId = work.pic_edition_id_auto ? String(work.pic_edition_id_auto) : undefined;
  let coverUrl = previewEditionId ? fantLabEditionCoverUrl(Number(previewEditionId)) : undefined;
  if (!coverUrl && !keepSearchCover) {
    coverUrl = fantLabAssetUrl(work.image);
    if (!coverUrl && work.pic_edition_id_auto) {
      coverUrl = fantLabEditionCoverUrl(work.pic_edition_id_auto);
    }
  }

  const editionItems = collectFantLabEditionItems(work.editions_blocks)
    .filter((item) => !settings.preferRussian || languageCode(item.lang_code || item.lang) === "ru");
  const listedEditionCount = work.editions_info?.all || editionItems.length || undefined;

  if (!coverUrl) {
    for (const item of editionItems.slice(0, 3)) {
      if (!item.edition_id) continue;
      const edition = await fantLabRequest<FantLabEditionCard>(`/edition/${item.edition_id}`, settings).catch(() => null);
      coverUrl = edition ? fantLabAssetUrl(edition.image) : undefined;
      if (coverUrl) break;
    }
  }

  return { coverUrl, listedEditionCount, previewEditionId };
}

export async function fetchFantLabWorkCoverImage(
  workId: string,
  settings: InternalSettings
): Promise<string | undefined> {
  return (await fetchFantLabWorkCatalogMeta(workId, settings)).coverUrl;
}

export async function lookupFantLabWorkByTitleAuthor(
  author: string,
  title: string,
  settings: InternalSettings
): Promise<OnlineBookCandidate | null> {
  if (!settings.fantlabEnabled) return null;
  const query = `${author} ${title}`.trim();
  if (!query) return null;
  const plan: ResolvedSearchPlan = {
    originalQuery: query,
    requestedMode: "auto",
    resolvedMode: "title",
    canonicalQuery: title,
    displayLabel: title,
    aliases: [query],
    confidence: 70,
    source: "literal",
    explanation: "resolver.fallback_resolver",
    titleVariants: [title],
    authorVariants: [author],
    authorName: author
  };
  const works = await searchFantLabWorks(query, settings, 8, plan);
  let best: { work: FantLabWorkMatch; score: number } | null = null;
  const titleNorm = normalize(title);
  const authorNorm = normalize(author);
  const queryAuthorTokens = authorTokens(author);
  for (const work of works) {
    const workTitle = normalize(work.rusname || work.name || "");
    const workAuthor = normalize(work.all_autor_rusname || work.autor1_rusname || work.all_autor_name || "");
    let score = work.weight || 0;
    if (workTitle === titleNorm) score += 5000;
    else if (workTitle.includes(titleNorm) || titleNorm.includes(workTitle)) score += 1200;
    if (queryAuthorTokens.length > 0 && queryAuthorTokens.every((token) => authorTokens(workAuthor).includes(token))) {
      score += 2500;
    } else if (authorNorm && workAuthor.includes(authorNorm)) {
      score += 800;
    }
    if (!best || score > best.score) best = { work, score };
  }
  if (!best || best.score < 1500) return null;
  return mapFantLabWork(best.work, settings, query);
}

export async function diagnoseFantLab(settings: InternalSettings) {
  const started = Date.now();
  try {
    await fantLabRequest<FantLabWorkMatch[]>(`/search-works?q=${fantLabQueryTerms("Гиперион")}&page=1&onlymatches=1`, settings);
    return {
      ok: true,
      durationMs: Date.now() - started,
      message: "Соединение установлено"
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message: describeNetworkError(error)
    };
  }
}

export async function enrichFantLabEditions(
  editions: OnlineBookEdition[],
  settings: InternalSettings
): Promise<OnlineBookEdition[]> {
  const targets = editions.filter(
    (edition) =>
      edition.provider === "fantlab"
      && edition.coverOptions.length === 0
      && edition.references.some((reference) => reference.provider === "fantlab" && reference.kind === "edition")
  );
  if (!targets.length) return editions;

  const enrichedById = new Map<string, OnlineBookEdition>();
  await Promise.all(
    targets.map(async (edition) => {
      const reference = edition.references.find((item) => item.provider === "fantlab" && item.kind === "edition");
      if (!reference) return;
      try {
        const card = await fantLabRequest<FantLabEditionCard>(`/edition/${reference.externalId}`, settings);
        const stub: OnlineBookCandidate = {
          id: edition.id,
          providers: ["fantlab"],
          references: edition.references,
          title: edition.title,
          author: edition.author,
          firstPublishedYear: null,
          editionCount: 0,
          languages: edition.language ? [edition.language] : [],
          genres: [],
          subjects: [],
          score: edition.score,
          completeness: edition.metadataQuality
        };
        const mapped = mapFantLabEdition(card, stub, settings, edition.author);
        if (mapped) enrichedById.set(edition.id, mapped);
      } catch {
        // placeholder until next retry
      }
    })
  );

  return editions.map((edition) => enrichedById.get(edition.id) || edition);
}

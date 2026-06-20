export const MATCH_REASON_CODES = [
  "exact_author",
  "author_match",
  "author_partial",
  "russian_title",
  "known_work",
  "exact_title",
  "close_title",
  "partial_title",
  "exact_isbn",
  "title_or_author",
  "curated_catalog",
  "known_work_curated",
  "local_index",
  "series_match"
] as const;

export type MatchReasonCode = (typeof MATCH_REASON_CODES)[number];

export const RESOLUTION_CODES = [
  "resolver.isbn_recognized",
  "resolver.isbn_invalid_mode",
  "resolver.author_curated",
  "resolver.author_open_library",
  "resolver.author_fallback",
  "resolver.author_curated_priority",
  "resolver.author_name",
  "resolver.author_name_fast",
  "resolver.author_curated_early",
  "resolver.author_local_index",
  "resolver.author_over_biography",
  "resolver.title_wikidata",
  "resolver.title_literal",
  "resolver.title_over_author",
  "resolver.combined_title_author",
  "resolver.title_translations",
  "resolver.general_literal",
  "resolver.fallback_resolver"
] as const;

export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const PREVIEW_WARNING_CODES = [
  "preview.no_editions",
  "preview.no_covers",
  "preview.partial_catalogs"
] as const;

export type PreviewWarningCode = (typeof PREVIEW_WARNING_CODES)[number];

const MATCH_REASON_SET = new Set<string>(MATCH_REASON_CODES);
const RESOLUTION_SET = new Set<string>(RESOLUTION_CODES);
const PREVIEW_WARNING_SET = new Set<string>(PREVIEW_WARNING_CODES);

export function isMatchReasonCode(value: string): value is MatchReasonCode {
  return MATCH_REASON_SET.has(value);
}

export function isResolutionCode(value: string): value is ResolutionCode {
  return RESOLUTION_SET.has(value);
}

export function isPreviewWarningCode(value: string): value is PreviewWarningCode {
  return PREVIEW_WARNING_SET.has(value);
}

export function hasExactMatchReason(reasons?: string[]) {
  if (!reasons?.length) return false;
  return reasons.some((reason) =>
    reason === "exact_author" || reason === "exact_title" || reason === "exact_isbn"
  );
}

export function shouldShowExactBadge(
  reasons: string[] | undefined,
  resolvedMode?: "author" | "title" | "isbn" | "general"
) {
  if (!reasons?.length) return false;
  if (reasons.includes("exact_isbn") || reasons.includes("exact_title")) return true;
  if (resolvedMode === "author") return false;
  return reasons.includes("exact_author");
}

export function isQuickAddCandidate(
  reasons: string[] | undefined,
  matchConfidence?: "high" | "medium" | "low"
) {
  if (!reasons?.length) return false;
  if (reasons.includes("exact_isbn")) return true;
  if (matchConfidence !== "high") return false;
  return reasons.includes("exact_title")
    || reasons.includes("known_work_curated")
    || reasons.includes("curated_catalog")
    || (reasons.includes("local_index") && reasons.includes("series_match"));
}

export function shouldOfferQuickAdd(
  candidate: {
    matchReasons?: string[];
    matchConfidence?: "high" | "medium" | "low";
    autoSelectable?: boolean;
  },
  resolvedMode: "author" | "title" | "isbn" | "general" | undefined,
  autoSelectHighConfidence: boolean
) {
  if (!autoSelectHighConfidence) return false;
  if (resolvedMode === "author") return false;
  if (candidate.autoSelectable) return true;
  return isQuickAddCandidate(candidate.matchReasons, candidate.matchConfidence);
}

export function isCatalogJunkCandidate(candidate: {
  title: string;
  author: string;
  editionCount?: number;
}): boolean {
  const title = candidate.title || "";
  const author = candidate.author || "";
  if (/^@|(?:twitter|instagram|tiktok|facebook|youtube)\b/i.test(title)) return true;
  if (
    /(?:desk\s+)?calendar|wall\s+calendar|planner|notebook|journal|photo\s+book|picture\s+book|coloring\s+book|logbook|scrapbook/i.test(title)
  ) {
    return true;
  }
  if (/(?:календар|ежедневник|планер|блокнот|раскраск)/i.test(title)) return true;

  const normalizedTitle = title.trim().toLowerCase();
  const normalizedAuthor = author.trim().toLowerCase();
  if (
    normalizedTitle
    && normalizedTitle === normalizedAuthor
    && (candidate.editionCount || 0) <= 3
  ) {
    return true;
  }
  return false;
}

export function hasCatalogCover(candidate: {
  coverUrl?: string;
  coverRemoteUrl?: string;
  coverKey?: string;
}): boolean {
  return Boolean(candidate.coverRemoteUrl?.trim() || candidate.coverKey?.trim() || candidate.coverUrl?.trim());
}

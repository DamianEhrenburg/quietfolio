import type { OnlineBookEdition } from "./types";

export function normalizedEditionLanguage(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "";
  if (["ru", "rus", "russian"].includes(normalized)) return "ru";
  if (["en", "eng", "english"].includes(normalized)) return "en";
  if (["de", "deu", "ger", "german"].includes(normalized)) return "de";
  if (["fr", "fra", "fre", "french"].includes(normalized)) return "fr";
  if (["it", "ita", "italian"].includes(normalized)) return "it";
  if (["es", "spa", "spanish"].includes(normalized)) return "es";
  return normalized;
}

export function preferredEditionLanguages(
  preferRussian: boolean,
  uiLocale: "ru" | "en" = "en"
): string[] {
  if (preferRussian) return ["ru"];
  if (uiLocale === "en") return ["en"];
  return [];
}

export function coverCatalogKey(url?: string): string {
  if (!url?.trim()) return "";
  const trimmed = url.trim();
  const fantLabMatch = trimmed.match(/\/editions\/big\/(\d+)/i);
  if (fantLabMatch) return `fl-edition:${fantLabMatch[1]}`;
  const idMatch = trimmed.match(/\/b\/id\/(\d+)/i);
  if (idMatch) return `id:${idMatch[1]}`;
  const isbnMatch = trimmed.match(/\/b\/isbn\/([^/?]+)/i);
  if (isbnMatch) return `isbn:${isbnMatch[1].toLowerCase()}`;
  const olidMatch = trimmed.match(/\/b\/olid\/([^/?]+)/i);
  if (olidMatch) return `olid:${olidMatch[1].toLowerCase()}`;
  return trimmed.split("?")[0].toLowerCase();
}

export function openLibraryCoverUrlFromKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (key.startsWith("id:")) {
    return `https://covers.openlibrary.org/b/id/${key.slice(3)}-L.jpg?default=false`;
  }
  if (key.startsWith("isbn:")) {
    return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(key.slice(5))}-L.jpg?default=false`;
  }
  if (key.startsWith("olid:")) {
    return `https://covers.openlibrary.org/b/olid/${encodeURIComponent(key.slice(5))}-L.jpg?default=false`;
  }
  return undefined;
}

function uniqueUrls(urls: Array<string | undefined>) {
  const seen = new Set<string>();
  return urls.filter((url): url is string => {
    const trimmed = url?.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed) || seen.has(trimmed)) return false;
    seen.add(trimmed);
    return true;
  });
}

export function editionCoverRemoteUrls(
  edition: Pick<OnlineBookEdition, "coverUrl" | "coverOptions">
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const push = (url?: string) => {
    const trimmed = url?.trim();
    if (!trimmed || !/^https?:\/\//i.test(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    urls.push(trimmed);
  };
  for (const option of edition.coverOptions) {
    if (option.verified) push(option.url);
  }
  push(edition.coverUrl);
  for (const option of edition.coverOptions) push(option.url);
  return urls;
}

export function preferredCoverRemoteUrls(input: {
  preferredCoverUrl?: string;
  preferredCoverKey?: string;
  coverRemoteUrl?: string;
  coverKey?: string;
  coverUrl?: string;
}): string[] {
  return uniqueUrls([
    input.preferredCoverUrl,
    input.coverRemoteUrl,
    openLibraryCoverUrlFromKey(input.preferredCoverKey),
    openLibraryCoverUrlFromKey(input.coverKey),
    input.coverUrl && /^https?:\/\//i.test(input.coverUrl) ? input.coverUrl : undefined
  ]);
}

export function editionMatchesCover(
  edition: OnlineBookEdition,
  coverUrl?: string,
  coverKey?: string
): boolean {
  const targets = new Set<string>();
  if (coverKey) targets.add(coverKey);
  const fromUrl = coverCatalogKey(coverUrl);
  if (fromUrl) targets.add(fromUrl);

  if (coverKey?.startsWith("fl-edition:")) {
    const wantedId = coverKey.slice("fl-edition:".length);
    if (edition.editionId === wantedId) return true;
    if (edition.references.some((ref) => ref.externalId === wantedId)) return true;
  }

  if (!targets.size) return false;

  const candidates = [
    edition.coverUrl,
    ...edition.coverOptions.map((option) => option.url)
  ].filter(Boolean) as string[];

  return candidates.some((url) => targets.has(coverCatalogKey(url)));
}

function isStudyOrAbridgedEdition(edition: OnlineBookEdition): boolean {
  const haystack = `${edition.title || ""} ${edition.publisher || ""}`.toLowerCase();
  return /(?:saddleback|educational|abridged|study guide|cliffsnotes|sparknotes|exam prep|teacher)/i.test(haystack);
}

function canonicalEditionScore(
  edition: OnlineBookEdition,
  options: Pick<PickDefaultEditionOptions, "preferRussian" | "uiLocale" | "firstPublishedYear" | "originalLanguage">
): number {
  let score = edition.score;

  const preferred = preferredEditionLanguages(options.preferRussian, options.uiLocale);
  const language = normalizedEditionLanguage(edition.language);
  if (preferred.length > 0) {
    if (preferred.includes(language)) score += 80;
    else if (language) score -= 120;
  }

  if (!options.preferRussian && options.originalLanguage) {
    if (language === normalizedEditionLanguage(options.originalLanguage)) score += 40;
  }

  const firstPublishedYear = options.firstPublishedYear;
  if (firstPublishedYear && edition.year) {
    score -= Math.abs(edition.year - firstPublishedYear) * 4;
  }

  if (edition.pageCount) {
    if (edition.pageCount < 100) score -= 140;
    else if (edition.pageCount > 220) score += 50;
  }

  if (edition.coverOptions.some((option) => option.verified)) score += 180;
  else if (edition.coverUrl || edition.coverOptions.length) score += 90;

  if (edition.isbn13 || edition.isbn10) score += 35;

  if (isStudyOrAbridgedEdition(edition)) score -= 260;
  score += edition.metadataQuality * 0.35;
  return score;
}

export interface PickDefaultEditionOptions {
  preferRussian: boolean;
  uiLocale?: "ru" | "en";
  previewCoverUrl?: string;
  previewCoverKey?: string;
  originalLanguage?: string;
  firstPublishedYear?: number | null;
}

export function pickDefaultEdition(
  editions: OnlineBookEdition[],
  options: PickDefaultEditionOptions
): OnlineBookEdition | null {
  if (!editions.length) return null;

  const {
    preferRussian,
    uiLocale = "en",
    previewCoverUrl,
    previewCoverKey,
    originalLanguage,
    firstPublishedYear
  } = options;

  if (previewCoverUrl || previewCoverKey) {
    const coverMatch = editions.find((edition) =>
      editionMatchesCover(edition, previewCoverUrl, previewCoverKey)
    );
    if (coverMatch) return coverMatch;
  }

  const [bestCanonical] = [...editions].sort((left, right) =>
    canonicalEditionScore(right, { preferRussian, uiLocale, firstPublishedYear, originalLanguage })
    - canonicalEditionScore(left, { preferRussian, uiLocale, firstPublishedYear, originalLanguage })
  );
  if (bestCanonical) return bestCanonical;

  return editions[0];
}

import type { Book, BookProvider, ProviderDiagnostic, UiLocale } from "../shared/types";
import type { Messages } from "./types";
import { enMessages } from "./locales/en";
import { ruMessages } from "./locales/ru";
import {
  isMatchReasonCode,
  isPreviewWarningCode,
  isResolutionCode
} from "../shared/searchCodes";
import { formatLanguageName } from "../shared/languageCodes";
import { normalizeGenreList, resolveGenreCode } from "../shared/genreCodes";
import { isMissingAuthor } from "../shared/authorSentinel";

const catalogs: Record<UiLocale, Messages> = {
  ru: ruMessages,
  en: enMessages
};

export function getMessages(locale: UiLocale): Messages {
  return catalogs[locale];
}

export function errorMessage(m: Messages, error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, "");
  }
  return m.common.unknownError;
}

export function ratingLabel(m: Messages, rating: number | null) {
  if (rating === null || !Number.isFinite(rating)) return m.common.noRating;
  const normalized = Math.max(0, Math.min(5, Math.round(rating)));
  return normalized === 0 ? m.common.noRating : "★".repeat(normalized) + "☆".repeat(5 - normalized);
}

export function languageLabel(m: Messages, language?: string) {
  const locale = m.localeTag.startsWith("ru") ? "ru" : "en";
  if (!language?.trim()) return m.languages.unknown;
  return formatLanguageName(language, locale);
}

export function authorLabel(m: Messages, author?: string) {
  if (isMissingAuthor(author)) return m.editor.authorMissing;
  return author || m.editor.authorMissing;
}

export function genreLabel(m: Messages, genre?: string) {
  if (!genre) return m.common.uncategorized;
  const code = resolveGenreCode(genre);
  if (code) return m.genres.labels[code];
  return genre;
}

export function genreEditorText(m: Messages, genres: string[]) {
  return genres.map((genre) => genreLabel(m, genre)).join(", ");
}

export function parseGenreEditorText(text: string) {
  return normalizeGenreList(
    text.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
  );
}

export function categoryEditorText(m: Messages, category?: string) {
  if (!category) return "";
  const code = resolveGenreCode(category);
  return code ? m.genres.labels[code] : category;
}

export function matchReasonLabel(m: Messages, reason: string) {
  if (isMatchReasonCode(reason)) return m.search.matchReasons[reason];
  return reason;
}

export function resolutionExplanationLabel(m: Messages, explanation: string) {
  if (isResolutionCode(explanation)) return m.search.resolution[explanation];
  return explanation;
}

export function searchResolutionStrip(
  m: Messages,
  resolution: {
    resolvedMode: "author" | "title" | "isbn" | "general";
    displayLabel: string;
    explanation?: string;
    confidence?: number;
  }
): { title: string; hint?: string } | null {
  const hint = resolution.explanation
    ? resolutionExplanationLabel(m, resolution.explanation)
    : undefined;
  if (resolution.resolvedMode === "author") {
    return {
      title: m.online.booksByAuthor(resolution.displayLabel),
      hint
    };
  }
  if (resolution.confidence != null && resolution.confidence >= 48 && hint) {
    return { title: resolution.displayLabel, hint };
  }
  return null;
}

export function previewWarningLabel(m: Messages, warning: string) {
  if (isPreviewWarningCode(warning)) return m.search.warnings[warning];
  return warning;
}

export function diagnosticLabel(m: Messages, item: ProviderDiagnostic) {
  const provider =
    item.provider === "wikidata"
      ? m.diagnostic.wikidata
      : item.provider === "google-books"
        ? "Google Books"
        : item.provider === "open-library"
          ? "Open Library"
          : item.provider === "gutendex"
            ? "Gutenberg"
            : item.provider === "hardcover"
              ? "Hardcover"
              : "FantLab";
  const service =
    item.service === "covers"
      ? m.diagnostic.covers
      : item.service === "resolver"
        ? m.diagnostic.resolver
        : m.diagnostic.metadata;
  return `${provider} · ${service}`;
}

export function coverStatusLabel(
  m: Messages,
  book: Pick<Book, "coverStatus" | "coverSource">
) {
  if (book.coverStatus === "download-failed") return m.cover.downloadFailed;
  if (book.coverStatus === "missing" || book.coverSource === "none") return m.cover.missing;
  if (book.coverSource === "manual") return m.cover.manual;
  if (book.coverSource === "inventaire") return m.cover.externalCatalog;
  if (book.coverSource === "google-books") return m.cover.googleBooksIsbn;
  if (book.coverSource === "isbn") return m.cover.openLibraryIsbn;
  if (book.coverSource === "same-language-edition") return m.cover.sameLanguageEdition;
  if (book.coverSource === "work") return m.cover.work;
  if (book.coverStatus === "fallback") return m.cover.fallback;
  if (book.coverSource === "edition") return m.cover.edition;
  return m.cover.local;
}

export function sortBooks(books: Book[], locale: UiLocale) {
  const localeTag = locale === "en" ? "en" : "ru";
  return [...books].sort((left, right) =>
    left.displayTitle.localeCompare(right.displayTitle, localeTag, { sensitivity: "base" })
  );
}

export function providerLabel(m: Messages, provider: BookProvider) {
  if (provider === "google-books") return "Google Books";
  if (provider === "open-library") return "Open Library";
  if (provider === "gutendex") return "Gutenberg";
  if (provider === "hardcover") return "Hardcover";
  return "FantLab";
}

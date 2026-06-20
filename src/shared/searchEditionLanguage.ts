import type { BookProvider, ProviderReference } from "./types";

/** Язык изданий следует алфавиту запроса; настройка — только для неоднозначных случаев (ISBN и т.п.). */
export function queryUsesCyrillic(value: string) {
  return /[\u0400-\u04FF]/.test(value);
}

export function queryUsesLatin(value: string) {
  return /[a-z]/i.test(value) && !queryUsesCyrillic(value);
}

/** Язык каталога: кириллица в запросе → ru, латиница → en, иначе — язык интерфейса. */
export function editionPreferRussian(
  query: string,
  settingPreferRussian = false,
  uiLocale: "ru" | "en" = "ru"
) {
  const trimmed = query.trim();
  if (!trimmed) return settingPreferRussian || uiLocale === "ru";
  if (queryUsesCyrillic(trimmed)) return true;
  if (queryUsesLatin(trimmed)) return false;
  return settingPreferRussian || uiLocale === "ru";
}

function hasRussianLanguage(languages?: string[]) {
  return (languages || []).some((language) => {
    const code = language.trim().toLowerCase();
    return code === "ru" || code === "rus" || code === "russian";
  });
}

function isCuratedCatalogReference(references?: ProviderReference[]) {
  return (references || []).some((reference) => reference.externalId.startsWith("curated:"));
}

export function catalogMatchesPreference(
  candidate: {
    title: string;
    originalTitle?: string;
    alternateTitles?: string[];
    languages?: string[];
    providers?: BookProvider[];
    references?: ProviderReference[];
  },
  preferRussian: boolean
) {
  if (preferRussian) {
    if (candidate.providers?.includes("fantlab")) return true;
    if (isCuratedCatalogReference(candidate.references)) return true;
    if (hasRussianLanguage(candidate.languages)) return true;
    return false;
  }

  const latinTitle = (value?: string) => Boolean(value && /[a-z]/i.test(value) && !queryUsesCyrillic(value));
  if (latinTitle(candidate.title) || latinTitle(candidate.originalTitle)) return true;
  if (candidate.alternateTitles?.some((title) => latinTitle(title))) return true;

  return (candidate.languages || []).some((language) => {
    const code = language.trim().toLowerCase();
    return code === "en" || code === "eng" || code === "english";
  });
}

/** Stable sentinel for missing author in catalog/search payloads. */
export const MISSING_AUTHOR = "catalog.author_missing";

const LEGACY_MISSING_AUTHOR = "Автор не указан";

export function isMissingAuthor(author?: string) {
  return !author || author === MISSING_AUTHOR || author === LEGACY_MISSING_AUTHOR;
}

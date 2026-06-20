export const GENRE_CODES = [
  "science_fiction",
  "fantasy",
  "philosophy",
  "ethics",
  "politics",
  "classics",
  "fiction",
  "history",
  "psychology",
  "religion",
  "detective",
  "biography",
  "poetry",
  "drama",
  "children",
  "self_help",
  "economics",
  "sociology",
  "law",
  "technology",
  "art",
  "science",
  "german_literature",
  "russian_literature"
] as const;

export type GenreCode = (typeof GENRE_CODES)[number];

const GENRE_CODE_SET = new Set<string>(GENRE_CODES);

export function isGenreCode(value: string): value is GenreCode {
  return GENRE_CODE_SET.has(value);
}

/** Legacy Russian labels emitted before genre codes. */
export const LEGACY_RU_GENRE_LABELS: Record<string, GenreCode> = {
  "Научная фантастика": "science_fiction",
  "Фэнтези": "fantasy",
  "Философия": "philosophy",
  "Этика": "ethics",
  "Политика и общество": "politics",
  "Классическая литература": "classics",
  "Художественная литература": "fiction",
  "История": "history",
  "Психология": "psychology",
  "Религия": "religion",
  "Детектив": "detective",
  "Биография и мемуары": "biography",
  "Поэзия": "poetry",
  "Драматургия": "drama",
  "Детская литература": "children",
  "Саморазвитие": "self_help",
  "Экономика": "economics",
  "Социология": "sociology",
  "Право": "law",
  "Технологии": "technology",
  "Искусство": "art",
  "Наука": "science",
  "Немецкая литература": "german_literature",
  "Русская литература": "russian_literature",
  "Драма": "drama"
};

/** Common raw subject tokens from catalogs. */
export const SUBJECT_ALIASES: Record<string, GenreCode> = {
  роман: "fiction",
  novel: "fiction",
  fiction: "fiction",
  "psychological fiction": "fiction",
  "western stories": "fiction",
  dystopian: "fiction",
  classics: "classics",
  philosophy: "philosophy",
  psychology: "psychology",
  science: "science",
  history: "history",
  poetry: "poetry",
  drama: "drama"
};

export function resolveGenreCode(value: string): GenreCode | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isGenreCode(trimmed)) return trimmed;
  if (LEGACY_RU_GENRE_LABELS[trimmed]) return LEGACY_RU_GENRE_LABELS[trimmed];
  const lower = trimmed.toLowerCase();
  if (SUBJECT_ALIASES[lower]) return SUBJECT_ALIASES[lower];
  if (isGenreCode(lower)) return lower as GenreCode;
  return null;
}

export function normalizeGenreList(values: string[], limit = 8): string[] {
  const mapped: string[] = [];
  for (const value of values) {
    const code = resolveGenreCode(value);
    if (code) mapped.push(code);
    else if (value.trim()) mapped.push(value.trim());
  }
  return [...new Set(mapped)].slice(0, limit);
}

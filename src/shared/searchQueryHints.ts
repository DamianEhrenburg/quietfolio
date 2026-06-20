const SERIES_PATTERNS: Array<{ pattern: RegExp; group: number }> = [
  { pattern: /(?:^|\s)(?:том|книга|часть|выпуск|#)\s*(\d{1,3})(?=\s|$|[,.])/iu, group: 1 },
  { pattern: /(?:^|\s)(\d{1,3})\s*(?:й\s+)?(?:том|книга|часть)(?=\s|$|[,.])/iu, group: 1 },
  { pattern: /\bbook\s+(\d{1,3})\b/i, group: 1 }
];

export function parseSeriesFromQuery(query: string) {
  const trimmed = query.trim();
  for (const { pattern, group } of SERIES_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match?.[group]) continue;
    const seriesNum = Number(match[group]);
    if (!Number.isFinite(seriesNum) || seriesNum < 1 || seriesNum > 499) continue;
    const cleanQuery = trimmed.replace(match[0], " ").replace(/\s+/g, " ").trim();
    return { seriesNum, cleanQuery: cleanQuery || trimmed };
  }
  return { cleanQuery: trimmed };
}

export function queryMentionsSeries(query: string, series: string) {
  const normalizedSeries = series
    .normalize("NFKD")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalizedSeries || normalizedSeries.length < 3) return false;
  const normalizedQuery = query
    .normalize("NFKD")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return normalizedQuery.includes(normalizedSeries);
}

const SERIES_PATTERNS = [
  { pattern: /(?:^|\s)(?:том|книга|часть|выпуск|#)\s*(\d{1,3})(?=\s|$|[,.])/iu, group: 1 },
  { pattern: /(?:^|\s)(\d{1,3})\s*(?:й\s+)?(?:том|книга|часть)(?=\s|$|[,.])/iu, group: 1 },
  { pattern: /\bbook\s+(\d{1,3})\b/i, group: 1 }
];

function parseSeriesFromQuery(query) {
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

const cases = [
  { input: "метро 2033 том 2", expectNum: 2, expectClean: "метро 2033" },
  { input: "Harry Potter book 4", expectNum: 4, expectClean: "Harry Potter" },
  { input: "1984", expectNum: undefined, expectClean: "1984" }
];

for (const item of cases) {
  const parsed = parseSeriesFromQuery(item.input);
  if (item.expectNum !== parsed.seriesNum) {
    throw new Error(`series parse failed for "${item.input}": got ${parsed.seriesNum}`);
  }
  if (parsed.cleanQuery !== item.expectClean) {
    throw new Error(`clean query failed for "${item.input}": got "${parsed.cleanQuery}"`);
  }
}

console.log(`Search hint checks passed (${cases.length} cases).`);

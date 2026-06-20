import type {
  OnlineBookCandidate,
  OnlineSearchRequest,
  OnlineSearchResponse
} from "../src/shared/types";

interface SearchBenchCase {
  id: string;
  lang: "ru" | "en";
  query: string;
  mode: OnlineSearchRequest["mode"];
  expect: string[];
}

interface SearchBenchRow {
  id: string;
  lang: "ru" | "en";
  latencyMs: number;
  resultCount: number;
  timeout: boolean;
  top1: boolean;
  top5: boolean;
  cover: boolean;
  quickAdd: boolean;
  first: string;
}

function normalizeBenchText(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .trim();
}

function benchCandidateText(candidate: OnlineBookCandidate) {
  return normalizeBenchText([
    candidate.title,
    candidate.displayTitle,
    candidate.originalTitle,
    candidate.author,
    ...(candidate.alternateTitles || [])
  ].filter(Boolean).join(" "));
}

function benchMatches(candidate: OnlineBookCandidate | undefined, expected: string[]) {
  if (!candidate) return false;
  const text = benchCandidateText(candidate);
  return expected.some((item) => text.includes(normalizeBenchText(item)));
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

async function withBenchTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeBenchLine(value: string) {
  try {
    process.stdout.write(value);
  } catch (error) {
    if (!(error instanceof Error) || !/EPIPE|broken pipe/i.test(error.message)) throw error;
  }
}

export function ignoreBenchmarkPipeErrors() {
  const ignorePipeError = (error: Error) => {
    if (!/EPIPE|broken pipe/i.test(error.message)) throw error;
  };
  process.stdout.on("error", ignorePipeError);
  process.stderr.on("error", ignorePipeError);
}

export async function runSearchBenchmark(
  searchOnlineBooks: (request: OnlineSearchRequest) => Promise<OnlineSearchResponse>
) {
  const rawCases = process.env.QUIETFOLIO_BENCH_CASES;
  const cases = rawCases ? JSON.parse(rawCases) as SearchBenchCase[] : [];
  if (cases.length === 0) throw new Error("No search benchmark cases provided");
  const caseTimeoutMs = Number(process.env.QUIETFOLIO_BENCH_CASE_TIMEOUT_MS) || 5_000;

  const rows: SearchBenchRow[] = [];
  for (const item of cases) {
    const started = performance.now();
    const response = await withBenchTimeout(
      searchOnlineBooks({ query: item.query, mode: item.mode }),
      caseTimeoutMs
    );
    const latencyMs = Math.round(performance.now() - started);
    const timeout = response === "timeout";
    const results = timeout ? [] : response.results;
    const topFive = results.slice(0, 5);
    rows.push({
      id: item.id,
      lang: item.lang,
      latencyMs,
      resultCount: results.length,
      timeout,
      top1: benchMatches(results[0], item.expect),
      top5: topFive.some((candidate) => benchMatches(candidate, item.expect)),
      cover: topFive.some((candidate) => Boolean(candidate.coverRemoteUrl || candidate.coverUrl)),
      quickAdd: Boolean(results[0]?.autoSelectable),
      first: results[0]
        ? `${results[0].title} — ${results[0].author}`
        : "none"
    });
    writeBenchLine(`bench ${rows.length}/${cases.length}: ${item.id} ${latencyMs}ms${timeout ? " timeout" : ""}\n`);
  }

  const latencies = rows.map((row) => row.latencyMs);
  const rate = (count: number) => `${Math.round((count / rows.length) * 1000) / 10}%`;
  const rateFor = (items: typeof rows, field: "top1" | "top5" | "cover") =>
    `${Math.round((items.filter((row) => row[field]).length / Math.max(1, items.length)) * 1000) / 10}%`;
  const metricsFor = (lang: "ru" | "en") => {
    const items = rows.filter((row) => row.lang === lang);
    const langLatencies = items.map((row) => row.latencyMs);
    return `${lang.toUpperCase()}: median ${percentile(langLatencies, 0.5)}ms, p95 ${percentile(langLatencies, 0.95)}ms, top-1 ${rateFor(items, "top1")}, top-5 ${rateFor(items, "top5")}, cover ${rateFor(items, "cover")}, timeouts ${items.filter((row) => row.timeout).length}`;
  };
  const quickAddExample = (lang: "ru" | "en") => {
    const row = rows.find((item) =>
      item.lang === lang
      && item.quickAdd
      && item.cover
      && (lang === "ru" || /[a-z]/i.test(item.first))
    );
    return row ? `${lang.toUpperCase()}: ${row.id} -> ${row.first}` : `${lang.toUpperCase()}: none`;
  };
  const summary = [
    "Quietfolio search benchmark",
    `cases: ${rows.length} (RU ${rows.filter((row) => row.lang === "ru").length}, EN ${rows.filter((row) => row.lang === "en").length})`,
    `median latency: ${percentile(latencies, 0.5)}ms`,
    `p95 latency: ${percentile(latencies, 0.95)}ms`,
    `top-1: ${rate(rows.filter((row) => row.top1).length)}`,
    `top-5: ${rate(rows.filter((row) => row.top5).length)}`,
    `cover hit rate: ${rate(rows.filter((row) => row.cover).length)}`,
    `case timeouts: ${rows.filter((row) => row.timeout).length}`,
    metricsFor("ru"),
    metricsFor("en"),
    `quick-add examples: ${quickAddExample("ru")} | ${quickAddExample("en")}`,
    "",
    "Slowest cases:",
    ...[...rows]
      .sort((a, b) => b.latencyMs - a.latencyMs)
      .slice(0, 5)
      .map((row) => `- ${row.id}: ${row.latencyMs}ms, results ${row.resultCount}, first ${row.first}`)
  ];
  writeBenchLine(`${summary.join("\n")}\n`);
}

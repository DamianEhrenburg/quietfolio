import type { ResolvedSearchPlan } from "./queryResolver";
import type { InpxWorkHit } from "./inpxLocalIndex";

interface InpxWebBookRow {
  author?: string;
  title?: string;
  series?: string;
  sernum?: number | string;
  genre?: string;
  lang?: string;
  date?: string;
  year?: number | string;
  libid?: string | number;
}

interface InpxWebSearchResponse {
  found?: InpxWebBookRow[];
  totalFound?: number;
  error?: string;
}

function toWsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return `http://${trimmed}`.replace(/^http:/, "ws:");
}

function parseYear(value: unknown) {
  const year = Number(value);
  return Number.isFinite(year) && year > 0 ? year : null;
}

function mapWebRow(row: InpxWebBookRow, index: number): InpxWorkHit | null {
  const author = row.author?.trim();
  const title = row.title?.trim();
  if (!author || !title) return null;
  const seriesNum = Number(row.sernum);
  return {
    author,
    title,
    series: row.series?.trim() || undefined,
    seriesNum: Number.isFinite(seriesNum) && seriesNum > 0 ? seriesNum : null,
    genre: row.genre?.trim() || undefined,
    language: row.lang?.trim().toLowerCase() || undefined,
    year: parseYear(row.year ?? row.date),
    libId: row.libid != null ? String(row.libid) : undefined,
    score: 72 + Math.max(0, 12 - index)
  };
}

function buildBookSearchQuery(plan: ResolvedSearchPlan, limit: number) {
  const query: Record<string, string | number> = { limit };
  const text = (plan.canonicalQuery || plan.originalQuery).trim();
  if (plan.resolvedMode === "author") {
    const author = plan.authorName || text;
    query.author = `*${author}*`;
    return query;
  }
  if (plan.authorName) {
    query.author = `*${plan.authorName}*`;
  }
  if (text) {
    query.title = text.includes(" ") ? `*${text}*` : text;
  }
  return query;
}

async function inpxWebRequest<T>(baseUrl: string, payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const wsUrl = toWsUrl(baseUrl);
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error("inpx-web timeout"));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ ...payload, accessToken: "", requestId }));
    });

    ws.addEventListener("message", (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (data._rok) return;
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      if (typeof data.error === "string") {
        reject(new Error(data.error));
        return;
      }
      resolve(data as T);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("inpx-web connection failed"));
    });
  });
}

export async function searchInpxWebBooks(
  baseUrl: string,
  plan: ResolvedSearchPlan,
  limit: number,
  timeoutMs: number
): Promise<InpxWorkHit[]> {
  const response = await inpxWebRequest<InpxWebSearchResponse>(
    baseUrl,
    { action: "bookSearch", query: buildBookSearchQuery(plan, limit) },
    Math.min(timeoutMs, 12_000)
  );
  const rows = Array.isArray(response.found) ? response.found : [];
  return rows
    .map((row, index) => mapWebRow(row, index))
    .filter((hit): hit is InpxWorkHit => Boolean(hit))
    .slice(0, limit);
}

export async function probeInpxWeb(baseUrl: string, timeoutMs: number) {
  const started = Date.now();
  try {
    const response = await inpxWebRequest<{ message?: string }>(
      baseUrl,
      { action: "test" },
      Math.min(timeoutMs, 8_000)
    );
    return {
      ok: Boolean(response.message),
      durationMs: Date.now() - started,
      message: response.message || "inpx-web ok"
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      message: error instanceof Error ? error.message : "inpx-web failed"
    };
  }
}

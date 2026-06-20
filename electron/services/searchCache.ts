import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OnlineSearchResponse } from "../../src/shared/types";

interface CacheEntry {
  expiresAt: number;
  response: OnlineSearchResponse;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const MAX_ENTRIES = 80;
let memoryCache: CacheFile | null = null;

function cachePath() {
  return path.join(app.getPath("userData"), "online-search-cache.json");
}

function loadCache(): CacheFile {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CacheFile;
    memoryCache = parsed?.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} };
  } catch {
    memoryCache = { version: 1, entries: {} };
  }
  return memoryCache;
}

function persist(cache: CacheFile) {
  const target = cachePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(cache), "utf8");
  fs.renameSync(temp, target);
}

export function getCachedSearch(key: string): OnlineSearchResponse | null {
  const cache = loadCache();
  const entry = cache.entries[key];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete cache.entries[key];
    persist(cache);
    return null;
  }
  return { ...entry.response, fromCache: true };
}

export function setCachedSearch(key: string, response: OnlineSearchResponse, ttlMinutes: number) {
  const cache = loadCache();
  cache.entries[key] = {
    expiresAt: Date.now() + Math.max(5, ttlMinutes) * 60_000,
    response: { ...response, fromCache: false }
  };

  const sorted = Object.entries(cache.entries).sort(
    (left, right) => right[1].expiresAt - left[1].expiresAt
  );
  cache.entries = Object.fromEntries(sorted.slice(0, MAX_ENTRIES));
  persist(cache);
}

export function clearSearchCache() {
  memoryCache = { version: 1, entries: {} };
  try {
    fs.rmSync(cachePath(), { force: true });
  } catch {
    // Кэш не является критичным для работы приложения.
  }
}

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OnlineSearchMode } from "../../src/shared/types";
import type { ResolvedSearchPlan } from "./queryResolver";

interface CacheEntry {
  expiresAt: number;
  value: ResolvedSearchPlan;
}

interface CacheFile {
  version: 4;
  entries: Record<string, CacheEntry>;
}

const MAX_ENTRIES = 300;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
let memoryCache: CacheFile | null = null;

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cachePath() {
  return path.join(app.getPath("userData"), "entity-resolution-cache.json");
}

function key(query: string, mode: OnlineSearchMode) {
  return `${mode}:${normalize(query)}`;
}

function loadCache(): CacheFile {
  if (memoryCache) return memoryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as CacheFile;
    memoryCache = parsed?.version === 4 && parsed.entries ? parsed : { version: 4, entries: {} };
  } catch {
    memoryCache = { version: 4, entries: {} };
  }
  return memoryCache;
}

function persist(cache: CacheFile) {
  const target = cachePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache), "utf8");
  fs.renameSync(temporary, target);
}

export function getCachedResolution(query: string, mode: OnlineSearchMode) {
  const cache = loadCache();
  const entryKey = key(query, mode);
  const entry = cache.entries[entryKey];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete cache.entries[entryKey];
    persist(cache);
    return null;
  }
  return entry.value;
}

export function setCachedResolution(query: string, mode: OnlineSearchMode, value: ResolvedSearchPlan) {
  const cache = loadCache();
  cache.entries[key(query, mode)] = { expiresAt: Date.now() + TTL_MS, value };
  const sorted = Object.entries(cache.entries).sort((left, right) => right[1].expiresAt - left[1].expiresAt);
  cache.entries = Object.fromEntries(sorted.slice(0, MAX_ENTRIES));
  persist(cache);
}

export function clearEntityResolutionCache() {
  memoryCache = { version: 4, entries: {} };
  try {
    fs.rmSync(cachePath(), { force: true });
  } catch {
    // Кэш распознавания не является критичным.
  }
}

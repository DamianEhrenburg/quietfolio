import { createHash } from "node:crypto";
import { app } from "electron";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { ensureDatabaseDirectory } from "./databasePaths";
import type { InternalSettings } from "./settingsService";

export interface InpxWorkHit {
  title: string;
  author: string;
  series?: string;
  seriesNum?: number | null;
  genre?: string;
  language?: string;
  year?: number | null;
  libId?: string;
  score: number;
}

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inpx_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inpx_works (
    rowid INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    series TEXT NOT NULL DEFAULT '',
    series_num INTEGER,
    genre TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    year INTEGER,
    lib_id TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT ''
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS inpx_works_fts USING fts5(
    title,
    author,
    series,
    genre,
    content='inpx_works',
    content_rowid='rowid',
    tokenize='unicode61'
  );
`;

let database: Database.Database | null = null;
let indexedSourceKey: string | null = null;

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function getDatabasePath() {
  return path.join(app.getPath("userData"), "inpx-index.sqlite");
}

function parseGenreList(raw: string) {
  return raw
    .split(/[:;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(", ");
}

function parseInpLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("\x04");
  if (parts.length < 12) return null;
  const author = parts[0]?.trim();
  const title = parts[1]?.trim();
  if (!author || !title) return null;
  if (parts[8]?.trim() === "1") return null;
  const series = parts[2]?.trim() || "";
  const seriesNum = Number(parts[3]);
  const genre = parseGenreList(parts[4]?.trim() || "");
  const libId = parts[7]?.trim() || "";
  const language = parts[11]?.trim().toLowerCase() || "";
  const yearRaw = parts.length > 14 ? parts[14] : parts[13];
  const year = Number(yearRaw);
  return {
    author,
    title,
    series,
    seriesNum: Number.isFinite(seriesNum) && seriesNum > 0 ? seriesNum : null,
    genre,
    libId,
    language,
    year: Number.isFinite(year) && year > 0 ? year : null
  };
}

function listInpFiles(sourcePath: string): string[] {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    return fs.readdirSync(sourcePath)
      .filter((name) => name.toLowerCase().endsWith(".inp"))
      .map((name) => path.join(sourcePath, name));
  }
  return [];
}

function readInpxArchive(archivePath: string): Array<{ name: string; buffer: Buffer }> {
  const buffer = fs.readFileSync(archivePath);
  const entries: Array<{ name: string; buffer: Buffer }> = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.toString("utf8", nameStart, nameStart + fileNameLength);
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (!name.toLowerCase().endsWith(".inp")) {
      offset = dataEnd;
      continue;
    }
    const payload = buffer.subarray(dataStart, dataEnd);
    const decoded = compression === 0
      ? payload
      : compression === 8
        ? inflateRawSync(payload)
        : null;
    if (decoded) entries.push({ name, buffer: decoded });
    offset = dataEnd;
  }
  return entries;
}

function openDatabase() {
  if (database) return database;
  const databasePath = getDatabasePath();
  ensureDatabaseDirectory(databasePath);
  database = new Database(databasePath);
  database.exec(SCHEMA_SQL);
  return database;
}

function sourceFingerprint(sourcePath: string) {
  const stat = fs.statSync(sourcePath);
  return `${sourcePath}|${stat.mtimeMs}|${stat.size}`;
}

function needsSchemaRebuild(db: Database.Database) {
  const version = db.prepare("SELECT value FROM inpx_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  return version?.value !== String(SCHEMA_VERSION);
}

function rebuildIndex(sourcePath: string) {
  const db = openDatabase();
  const fingerprint = sourceFingerprint(sourcePath);
  const current = db.prepare("SELECT value FROM inpx_meta WHERE key = 'source'").get() as { value?: string } | undefined;
  const total = (db.prepare("SELECT COUNT(*) AS total FROM inpx_works").get() as { total: number }).total;
  if (
    current?.value === fingerprint
    && total > 0
    && !needsSchemaRebuild(db)
  ) {
    indexedSourceKey = fingerprint;
    return;
  }

  db.exec(`
    DELETE FROM inpx_works;
    DELETE FROM inpx_works_fts;
  `);

  const insert = db.prepare(`
    INSERT INTO inpx_works (title, author, series, series_num, genre, language, year, lib_id, source_file)
    VALUES (@title, @author, @series, @seriesNum, @genre, @language, @year, @libId, @sourceFile)
  `);
  const seenLibIds = new Set<string>();
  const ingest = db.transaction((rows: Array<{
    title: string;
    author: string;
    series: string;
    seriesNum: number | null;
    genre: string;
    language: string;
    year: number | null;
    libId: string;
    sourceFile: string;
  }>) => {
    for (const row of rows) {
      if (row.libId) {
        if (seenLibIds.has(row.libId)) continue;
        seenLibIds.add(row.libId);
      }
      insert.run(row);
    }
  });

  const pushLines = (lines: string[], sourceFile: string) => {
    const batch: Array<{
      title: string;
      author: string;
      series: string;
      seriesNum: number | null;
      genre: string;
      language: string;
      year: number | null;
      libId: string;
      sourceFile: string;
    }> = [];
    for (const line of lines) {
      const parsed = parseInpLine(line);
      if (!parsed) continue;
      batch.push({
        title: parsed.title,
        author: parsed.author,
        series: parsed.series,
        seriesNum: parsed.seriesNum,
        genre: parsed.genre,
        language: parsed.language || "",
        year: parsed.year,
        libId: parsed.libId,
        sourceFile
      });
      if (batch.length >= 500) {
        ingest(batch);
        batch.length = 0;
      }
    }
    if (batch.length) ingest(batch);
  };

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    for (const filePath of listInpFiles(sourcePath)) {
      pushLines(fs.readFileSync(filePath, "utf8").split(/\r?\n/), path.basename(filePath));
    }
  } else if (sourcePath.toLowerCase().endsWith(".inpx")) {
    for (const entry of readInpxArchive(sourcePath)) {
      pushLines(entry.buffer.toString("utf8").split(/\r?\n/), entry.name);
    }
  }

  db.exec(`
    INSERT INTO inpx_works_fts(rowid, title, author, series, genre)
    SELECT rowid, title, author, series, genre FROM inpx_works
  `);
  db.prepare("INSERT OR REPLACE INTO inpx_meta(key, value) VALUES ('source', ?)").run(fingerprint);
  db.prepare("INSERT OR REPLACE INTO inpx_meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  indexedSourceKey = fingerprint;
}

export function ensureInpxIndex(settings: InternalSettings) {
  if (!settings.inpxEnabled || !settings.inpxIndexPath?.trim()) return false;
  const sourcePath = settings.inpxIndexPath.trim();
  if (!fs.existsSync(sourcePath)) return false;
  try {
    rebuildIndex(sourcePath);
    return true;
  } catch {
    return false;
  }
}

export function getInpxIndexInfo(settings: InternalSettings) {
  if (!settings.inpxEnabled || !settings.inpxIndexPath?.trim()) {
    return { ready: false, works: 0, path: settings.inpxIndexPath || "" };
  }
  if (!ensureInpxIndex(settings)) {
    return { ready: false, works: 0, path: settings.inpxIndexPath };
  }
  const total = openDatabase().prepare("SELECT COUNT(*) AS total FROM inpx_works").get() as { total: number };
  return { ready: true, works: total.total, path: settings.inpxIndexPath, sourceKey: indexedSourceKey };
}

type InpxRow = InpxWorkHit & { rank: number; language: string; year: number | null; series: string; genre: string; lib_id: string; series_num: number | null };

function mapInpxRow(row: InpxRow): InpxWorkHit {
  return {
    title: row.title,
    author: row.author,
    series: row.series || undefined,
    seriesNum: row.series_num,
    genre: row.genre || undefined,
    language: row.language || undefined,
    year: row.year,
    libId: row.lib_id || undefined,
    score: 68 + Math.min(24, Math.round(-row.rank))
  };
}

function ftsTokens(query: string) {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/"/g, "").trim())
    .filter(Boolean);
}

function buildFtsQuery(tokens: string[], mode: "and" | "or") {
  if (!tokens.length) return "";
  const quoted = tokens.map((token) => `"${token}"`);
  return mode === "and" ? quoted.join(" AND ") : quoted.join(" OR ");
}

function queryInpxWorks(ftsQuery: string, limit: number, authorHint?: string) {
  if (!ftsQuery) return [];
  const db = openDatabase();
  if (authorHint?.trim()) {
    const rows = db.prepare(`
      SELECT title, author, series, series_num, genre, language, year, lib_id, bm25(inpx_works_fts) AS rank
      FROM inpx_works_fts
      JOIN inpx_works ON inpx_works.rowid = inpx_works_fts.rowid
      WHERE inpx_works_fts MATCH ?
        AND inpx_works.author LIKE ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, `%${authorHint.trim()}%`, limit) as InpxRow[];
    return rows.map(mapInpxRow);
  }
  const rows = db.prepare(`
    SELECT title, author, series, series_num, genre, language, year, lib_id, bm25(inpx_works_fts) AS rank
    FROM inpx_works_fts
    JOIN inpx_works ON inpx_works.rowid = inpx_works_fts.rowid
    WHERE inpx_works_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as InpxRow[];
  return rows.map(mapInpxRow);
}

function scoreInpxHit(hit: InpxWorkHit, query: string) {
  const queryNorm = normalize(query);
  const titleNorm = normalize(hit.title);
  const authorNorm = normalize(hit.author);
  let bonus = hit.score;
  if (queryNorm && titleNorm === queryNorm) bonus += 180;
  else if (queryNorm && titleNorm.includes(queryNorm)) bonus += 90;
  if (queryNorm && authorNorm === queryNorm) bonus += 120;
  const queryTokens = ftsTokens(query);
  if (queryTokens.length > 1 && queryTokens.every((token) => authorNorm.includes(normalize(token)))) bonus += 60;
  if (hit.language === "ru") bonus += 12;
  if (hit.series) bonus += 4;
  return bonus;
}

export function searchInpxWorks(query: string, limit = 8, authorHint = ""): InpxWorkHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tokens = ftsTokens(trimmed);
  const andQuery = buildFtsQuery(tokens, "and");
  const andHits = queryInpxWorks(andQuery, limit, authorHint);
  if (andHits.length >= Math.min(limit, 4) || tokens.length <= 1) {
    return andHits
      .map((hit) => ({ ...hit, score: scoreInpxHit(hit, trimmed) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
  const seen = new Set(andHits.map((hit) => `${hit.libId || ""}|${normalize(hit.author)}|${normalize(hit.title)}`));
  const merged = [...andHits];
  for (const hit of queryInpxWorks(buildFtsQuery(tokens, "or"), limit, authorHint)) {
    const key = `${hit.libId || ""}|${normalize(hit.author)}|${normalize(hit.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= limit) break;
  }
  return merged
    .map((hit) => ({ ...hit, score: scoreInpxHit(hit, trimmed) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function searchInpxByAuthor(authorQuery: string, limit = 24): InpxWorkHit[] {
  const trimmed = authorQuery.trim();
  if (!trimmed) return [];
  const db = openDatabase();
  const tokens = ftsTokens(trimmed);
  const ftsQuery = buildFtsQuery(tokens, "and") || `"${trimmed.replace(/"/g, "")}"`;
  const rows = db.prepare(`
    SELECT title, author, series, series_num, genre, language, year, lib_id, bm25(inpx_works_fts) AS rank
    FROM inpx_works_fts
    JOIN inpx_works ON inpx_works.rowid = inpx_works_fts.rowid
    WHERE inpx_works_fts MATCH ?
      AND inpx_works_fts.author MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, ftsQuery, limit) as InpxRow[];
  return rows
    .map((row) => ({ ...mapInpxRow(row), score: scoreInpxHit(mapInpxRow(row), trimmed) }))
    .sort((left, right) => right.score - left.score);
}

export function searchInpxAuthors(query: string, limit = 3): Array<{ author: string; score: number }> {
  const hits = searchInpxWorks(query, Math.max(limit * 6, 12));
  const seen = new Map<string, number>();
  for (const hit of hits) {
    const key = normalize(hit.author);
    if (!key) continue;
    seen.set(key, Math.max(seen.get(key) || 0, hit.score));
  }
  return [...seen.entries()]
    .map(([key, score]) => ({ author: hits.find((hit) => normalize(hit.author) === key)?.author || key, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function inpxReferenceKey(hit: Pick<InpxWorkHit, "author" | "title" | "series" | "libId">) {
  if (hit.libId) return hit.libId;
  return createHash("sha1").update(`${hit.author}|${hit.title}|${hit.series || ""}`).digest("hex").slice(0, 20);
}

export function resetInpxIndex() {
  if (database) {
    try { database.close(); } catch { /* noop */ }
    database = null;
  }
  indexedSourceKey = null;
  const databasePath = getDatabasePath();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(databasePath + suffix); } catch { /* noop */ }
  }
}

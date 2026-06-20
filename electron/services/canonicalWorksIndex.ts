import { app } from "electron";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureDatabaseDirectory } from "./databasePaths";
import { CURATED_CATALOG_SEED_VERSION, listCuratedCatalogRows } from "./russianWorksIndex";

export interface CanonicalWorkHit {
  titleRu: string;
  titleEn?: string;
  author: string;
  wikidataId?: string;
  score: number;
}

let database: Database.Database | null = null;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canonical_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS canonical_works (
    rowid INTEGER PRIMARY KEY,
    title_ru TEXT NOT NULL,
    title_en TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL,
    author_aliases TEXT NOT NULL DEFAULT '',
    wikidata_id TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS canonical_works_fts USING fts5(
    title_ru,
    title_en,
    author,
    author_aliases,
    content='canonical_works',
    content_rowid='rowid',
    tokenize='unicode61'
  );
`;

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
  return path.join(app.getPath("userData"), "canonical-works.sqlite");
}

function isCorruptionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /malformed|corrupt|not a database|database disk image/i.test(message);
}

function closeDatabase() {
  if (!database) return;
  try {
    database.close();
  } catch {
    // ignore
  }
  database = null;
}

function removeDatabaseFiles(databasePath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(databasePath + suffix);
    } catch {
      // missing sidecar files are fine
    }
  }
}

export function resetCanonicalWorksIndex() {
  closeDatabase();
  removeDatabaseFiles(getDatabasePath());
}

function openFreshDatabase(databasePath: string) {
  database = new Database(databasePath);
  database.exec(SCHEMA_SQL);
  seedCatalog(database);
  return database;
}

function readSeedVersion(db: Database.Database) {
  const row = db.prepare("SELECT value FROM canonical_meta WHERE key = 'seed_version'").get() as { value?: string } | undefined;
  return Number(row?.value || 0);
}

function writeSeedVersion(db: Database.Database, version: number) {
  db.prepare("INSERT OR REPLACE INTO canonical_meta(key, value) VALUES ('seed_version', ?)").run(String(version));
}

function rebuildFts(db: Database.Database) {
  db.exec(`
    DELETE FROM canonical_works_fts;
    INSERT INTO canonical_works_fts(rowid, title_ru, title_en, author, author_aliases)
    SELECT rowid, title_ru, title_en, author, author_aliases FROM canonical_works
  `);
}

function seedCatalog(db: Database.Database) {
  const rows = listCuratedCatalogRows();
  const insert = db.prepare(`
    INSERT INTO canonical_works (title_ru, title_en, author, author_aliases, wikidata_id)
    VALUES (@titleRu, @titleEn, @author, @authorAliases, @wikidataId)
  `);
  const seed = db.transaction((catalogRows: ReturnType<typeof listCuratedCatalogRows>) => {
    for (const row of catalogRows) {
      insert.run({
        titleRu: row.titleRu,
        titleEn: row.titleEn || "",
        author: row.author,
        authorAliases: row.authorAliases,
        wikidataId: row.wikidataId || null
      });
    }
  });
  seed(rows);
  rebuildFts(db);
  writeSeedVersion(db, CURATED_CATALOG_SEED_VERSION);
}

function mergeCatalog(db: Database.Database) {
  const existing = new Set(
    (db.prepare("SELECT title_ru, author FROM canonical_works").all() as Array<{ title_ru: string; author: string }>)
      .map((row) => `${normalize(row.title_ru)}|${normalize(row.author)}`)
  );
  const insert = db.prepare(`
    INSERT INTO canonical_works (title_ru, title_en, author, author_aliases, wikidata_id)
    VALUES (@titleRu, @titleEn, @author, @authorAliases, @wikidataId)
  `);
  let added = 0;
  for (const row of listCuratedCatalogRows()) {
    const key = `${normalize(row.titleRu)}|${normalize(row.author)}`;
    if (existing.has(key)) continue;
    insert.run({
      titleRu: row.titleRu,
      titleEn: row.titleEn || "",
      author: row.author,
      authorAliases: row.authorAliases,
      wikidataId: row.wikidataId || null
    });
    existing.add(key);
    added += 1;
  }
  if (added > 0) rebuildFts(db);
  writeSeedVersion(db, CURATED_CATALOG_SEED_VERSION);
}

function ensureSeeded(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS total FROM canonical_works").get() as { total: number };
  const version = readSeedVersion(db);
  if (count.total === 0) {
    seedCatalog(db);
    return;
  }
  if (version < CURATED_CATALOG_SEED_VERSION) {
    mergeCatalog(db);
  }
}

function openDatabase() {
  if (database) return database;
  const databasePath = getDatabasePath();
  ensureDatabaseDirectory(databasePath);
  if (!fs.existsSync(databasePath)) {
    return openFreshDatabase(databasePath);
  }
  try {
    database = new Database(databasePath);
    database.exec(SCHEMA_SQL);
    ensureSeeded(database);
    return database;
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    closeDatabase();
    removeDatabaseFiles(databasePath);
    return openFreshDatabase(databasePath);
  }
}

export function searchCanonicalWorks(query: string, authorHint = "", limit = 6, retried = false): CanonicalWorkHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const db = openDatabase();
    const ftsQuery = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, "")}"`)
      .join(" AND ");
    if (!ftsQuery) return [];

    const rows = db.prepare(`
      SELECT w.title_ru AS titleRu, w.title_en AS titleEn, w.author AS author, w.wikidata_id AS wikidataId,
             bm25(canonical_works_fts) AS rank
      FROM canonical_works_fts f
      JOIN canonical_works w ON w.rowid = f.rowid
      WHERE canonical_works_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<CanonicalWorkHit & { rank: number }>;

    const authorNorm = normalize(authorHint);
    return rows
      .map((row) => {
        let score = 70 + Math.min(20, Math.round(-row.rank));
        if (authorNorm) {
          const authorHay = normalize(`${row.author}`);
          const authorTokens = new Set(authorHay.split(" ").filter(Boolean));
          if (authorTokens.has(authorNorm) || authorHay === authorNorm) score += 18;
        }
        return { ...row, score };
      })
      .sort((left, right) => right.score - left.score);
  } catch (error) {
    if (!isCorruptionError(error) || retried) throw error;
    resetCanonicalWorksIndex();
    return searchCanonicalWorks(query, authorHint, limit, true);
  }
}

export function searchCanonicalAuthors(query: string, limit = 3): Array<{ author: string; wikidataId?: string; score: number }> {
  const hits = searchCanonicalWorks(query, "", Math.max(limit * 8, 16));
  const seen = new Map<string, { author: string; wikidataId?: string; score: number }>();
  for (const hit of hits) {
    const key = normalize(hit.author);
    if (!key) continue;
    const current = seen.get(key);
    if (!current || hit.score > current.score) {
      seen.set(key, { author: hit.author, wikidataId: hit.wikidataId, score: hit.score });
    }
  }
  return [...seen.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

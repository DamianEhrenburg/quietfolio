import { app } from "electron";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureDatabaseDirectory } from "./databasePaths";

export interface OpenLibraryIndexDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
  cover_i?: number;
  language?: string[];
  subject?: string[];
}

let database: Database.Database | null = null;
let activeDatabasePath: string | null = null;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ol_works (
    work_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    first_publish_year INTEGER,
    edition_count INTEGER NOT NULL DEFAULT 0,
    cover_id INTEGER,
    languages TEXT NOT NULL DEFAULT '[]',
    subjects TEXT NOT NULL DEFAULT '[]',
    popularity INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ol_works_popularity ON ol_works(popularity DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS ol_works_fts USING fts5(
    title,
    author,
    content='ol_works',
    content_rowid='rowid',
    tokenize='unicode61'
  );
`;

export function getOpenLibraryIndexPath() {
  return path.join(app.getPath("userData"), "ol-index.sqlite");
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
  activeDatabasePath = null;
}

function removeIndexFiles(databasePath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(databasePath + suffix);
    } catch {
      // missing sidecar files are fine
    }
  }
}

export function resetOpenLibraryIndex() {
  closeDatabase();
  removeIndexFiles(getOpenLibraryIndexPath());
}

function assertDatabaseIntegrity(db: Database.Database) {
  const check = db.pragma("integrity_check", { simple: true });
  if (check !== "ok") {
    throw new Error("open-library index corrupt");
  }
}

function openDatabase(databasePath: string) {
  ensureDatabaseDirectory(databasePath);
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  assertDatabaseIntegrity(db);
  db.exec(SCHEMA_SQL);
  rebuildFtsIfEmpty(db);
  return db;
}

function getDatabase() {
  const databasePath = getOpenLibraryIndexPath();
  if (database && activeDatabasePath === databasePath) return database;

  try {
    database = openDatabase(databasePath);
  } catch {
    resetOpenLibraryIndex();
    database = openDatabase(databasePath);
  }
  activeDatabasePath = databasePath;
  return database;
}

function runWithRecovery<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    resetOpenLibraryIndex();
    getDatabase();
    try {
      return fn();
    } catch (retryError) {
      if (isCorruptionError(retryError)) return fallback;
      throw retryError;
    }
  }
}

function rebuildFtsIfEmpty(db: Database.Database) {
  const ftsCount = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM ol_works_fts").get()?.count ?? 0;
  const workCount = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM ol_works").get()?.count ?? 0;
  if (workCount > 0 && ftsCount === 0) {
    db.exec("INSERT INTO ol_works_fts(ol_works_fts) VALUES('rebuild')");
  }
}

export function getOpenLibraryIndexInfo() {
  return runWithRecovery(
    () => {
      const db = getDatabase();
      const count = db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM ol_works").get()?.count ?? 0;
      return {
        path: getOpenLibraryIndexPath(),
        works: count,
        ready: count > 0
      };
    },
    {
      path: getOpenLibraryIndexPath(),
      works: 0,
      ready: false
    }
  );
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function ftsQuery(value: string) {
  const tokens = normalizeQuery(value)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
  if (!tokens.length) return "";
  return tokens.map((token) => `"${token.replace(/"/g, "")}"*`).join(" ");
}

export function searchOpenLibraryLocalIndex(query: string, limit = 20): OpenLibraryIndexDoc[] {
  return runWithRecovery(() => {
    const db = getDatabase();
    const fts = ftsQuery(query);
    if (!fts) return [];

    const rows = db.prepare<[string, number], {
      work_key: string;
      title: string;
      author: string;
      first_publish_year: number | null;
      edition_count: number;
      cover_id: number | null;
      languages: string;
      subjects: string;
    }>(`
      SELECT w.work_key, w.title, w.author, w.first_publish_year, w.edition_count, w.cover_id, w.languages, w.subjects
      FROM ol_works_fts AS f
      JOIN ol_works AS w ON w.rowid = f.rowid
      WHERE ol_works_fts MATCH ?
      ORDER BY w.popularity DESC, w.edition_count DESC
      LIMIT ?
    `).all(fts, limit);

    return rows.map((row) => ({
      key: row.work_key,
      title: row.title,
      author_name: row.author ? row.author.split(" · ") : undefined,
      first_publish_year: row.first_publish_year ?? undefined,
      edition_count: row.edition_count,
      cover_i: row.cover_id ?? undefined,
      language: JSON.parse(row.languages) as string[],
      subject: JSON.parse(row.subjects) as string[]
    }));
  }, []);
}

export function upsertOpenLibraryIndexDocs(docs: OpenLibraryIndexDoc[]) {
  if (!docs.length) return 0;
  return runWithRecovery(() => {
    const db = getDatabase();
    const statement = db.prepare(`
      INSERT INTO ol_works (
        work_key, title, author, first_publish_year, edition_count, cover_id, languages, subjects, popularity, updated_at
      ) VALUES (
        @work_key, @title, @author, @first_publish_year, @edition_count, @cover_id, @languages, @subjects, @popularity, strftime('%s', 'now')
      )
      ON CONFLICT(work_key) DO UPDATE SET
        title = excluded.title,
        author = excluded.author,
        first_publish_year = COALESCE(excluded.first_publish_year, ol_works.first_publish_year),
        edition_count = MAX(ol_works.edition_count, excluded.edition_count),
        cover_id = COALESCE(excluded.cover_id, ol_works.cover_id),
        languages = excluded.languages,
        subjects = excluded.subjects,
        popularity = MAX(ol_works.popularity, excluded.popularity),
        updated_at = excluded.updated_at
    `);

    const ftsDelete = db.prepare<[string]>("DELETE FROM ol_works_fts WHERE rowid = (SELECT rowid FROM ol_works WHERE work_key = ?)");
    const ftsInsert = db.prepare<[string]>("INSERT INTO ol_works_fts(rowid, title, author) SELECT rowid, title, author FROM ol_works WHERE work_key = ?");

    let changed = 0;
    const transaction = db.transaction((items: OpenLibraryIndexDoc[]) => {
      for (const doc of items) {
        if (!doc.key || !doc.title) continue;
        const author = (doc.author_name || []).slice(0, 4).join(" · ");
        const popularity = Math.max(0, doc.edition_count || 0) * 10 + (doc.cover_i && doc.cover_i > 0 ? 5 : 0);
        statement.run({
          work_key: doc.key,
          title: doc.title,
          author,
          first_publish_year: doc.first_publish_year ?? null,
          edition_count: Math.max(0, doc.edition_count || 0),
          cover_id: doc.cover_i && doc.cover_i > 0 ? doc.cover_i : null,
          languages: JSON.stringify(doc.language || []),
          subjects: JSON.stringify((doc.subject || []).slice(0, 12)),
          popularity
        });
        ftsDelete.run(doc.key);
        ftsInsert.run(doc.key);
        changed += 1;
      }
    });
    transaction(docs);
    return changed;
  }, 0);
}

export function isOpenLibraryIndexReady() {
  return getOpenLibraryIndexInfo().ready;
}

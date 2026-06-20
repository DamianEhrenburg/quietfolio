/**
 * Seed Open Library local index with curated classic titles.
 * Usage: npm run seed:ol-classics
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const USER_AGENT = "Quietfolio/0.5.0 (personal desktop library)";
const indexPath = process.env.QUIETFOLIO_OL_INDEX_PATH
  || path.join(os.homedir(), "AppData", "Roaming", "quietfolio-desktop", "ol-index.sqlite");

const CLASSIC_QUERIES = [
  "war and peace tolstoy",
  "crime and punishment dostoevsky",
  "1984 orwell",
  "fahrenheit 451 bradbury",
  "the call of cthulhu lovecraft",
  "pride and prejudice austen",
  "moby dick melville",
  "don quixote cervantes",
  "divine comedy dante",
  "thus spoke zarathustra nietzsche",
  "the trial kafka",
  "brave new world huxley",
  "the hobbit tolkien",
  "treasure island stevenson",
  "frankenstein shelley",
  "the picture of dorian gray wilde",
  "journey to the center of the earth verne",
  "war of the worlds wells",
  "hamlet shakespeare",
  "great expectations dickens"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function ensureSchema(db) {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  db.exec(`
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
    CREATE VIRTUAL TABLE IF NOT EXISTS ol_works_fts USING fts5(
      title,
      author,
      content='ol_works',
      content_rowid='rowid',
      tokenize='unicode61'
    );
  `);
}

function upsertDoc(db, doc) {
  if (!doc.key || !doc.title) return;
  const author = (doc.author_name || []).slice(0, 4).join(" · ");
  const popularity = Math.max(0, doc.edition_count || 0) * 10 + (doc.cover_i > 0 ? 5 : 0);
  db.prepare(`
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
  `).run({
    work_key: doc.key,
    title: doc.title,
    author,
    first_publish_year: doc.first_publish_year ?? null,
    edition_count: Math.max(0, doc.edition_count || 0),
    cover_id: doc.cover_i > 0 ? doc.cover_i : null,
    languages: JSON.stringify(doc.language || []),
    subjects: JSON.stringify((doc.subject || []).slice(0, 12)),
    popularity
  });
  db.prepare("DELETE FROM ol_works_fts WHERE rowid = (SELECT rowid FROM ol_works WHERE work_key = ?)").run(doc.key);
  db.prepare("INSERT INTO ol_works_fts(rowid, title, author) SELECT rowid, title, author FROM ol_works WHERE work_key = ?").run(doc.key);
}

const db = new Database(indexPath);
ensureSchema(db);

for (const query of CLASSIC_QUERIES) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8&fields=key,title,author_name,first_publish_year,edition_count,cover_i,language,subject`;
  try {
    const data = await fetchJson(url);
    for (const doc of data.docs || []) upsertDoc(db, doc);
    console.log(`Seeded ${data.docs?.length || 0} works for "${query}"`);
  } catch (error) {
    console.warn(`Skip "${query}":`, error instanceof Error ? error.message : error);
  }
  await sleep(320);
}

const total = db.prepare("SELECT COUNT(*) AS count FROM ol_works").get().count;
console.log(`Index ready: ${indexPath} (${total} works)`);
db.close();

import Database from "better-sqlite3";
import type {
  Book,
  BookInput,
  BookSource,
  CoverSource,
  CoverStatus,
  LibraryInfo,
  ReadingStatus
} from "../../src/shared/types";
import { MISSING_AUTHOR } from "../../src/shared/authorSentinel";
import { cleanBookDescription } from "../../src/shared/textCleanup";
import { getCoversDirectory } from "./coverCache";
import { ensureDatabaseDirectory, getDatabasePath } from "./databasePaths";

interface ColumnInfoRow { name: string }
interface CountRow { count: number }

interface BookRow {
  id: number;
  title: string | null;
  work_title: string | null;
  original_title: string | null;
  edition_title: string | null;
  subtitle: string | null;
  author: string | null;
  year: number | null;
  first_published_year: number | null;
  category: string | null;
  genres_json: string | null;
  subjects_json: string | null;
  publisher: string | null;
  page_count: number | null;
  language: string | null;
  status: string | null;
  rating: number | null;
  read_date: string | null;
  review: string | null;
  reviewer_name: string | null;
  cover_url: string | null;
  cover_source: string | null;
  cover_status: string | null;
  isbn: string | null;
  description: string | null;
  source: string | null;
  external_id: string | null;
  work_id: string | null;
  edition_id: string | null;
  source_url: string | null;
  metadata_quality: number | null;
  favorite: number | null;
}

const VALID_STATUSES = new Set<ReadingStatus>(["want", "reading", "read", "paused"]);
const VALID_SOURCES = new Set<BookSource>(["local", "google-books", "open-library", "fantlab", "gutendex", "hardcover"]);
const VALID_COVER_SOURCES = new Set<CoverSource>([
  "edition", "isbn", "google-books", "same-language-edition", "work", "manual", "none"
]);
const VALID_COVER_STATUSES = new Set<CoverStatus>([
  "local", "remote", "fallback", "missing", "download-failed"
]);

let database: Database.Database | null = null;
let activeDatabasePath: string | null = null;

function getColumnNames(db: Database.Database, tableName: string) {
  const rows = db.prepare<[], ColumnInfoRow>(`PRAGMA table_info(${JSON.stringify(tableName)})`).all();
  return new Set(rows.map((row) => row.name));
}

function hasTable(db: Database.Database, tableName: string) {
  return Boolean(
    db.prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    ).get(tableName)
  );
}

function addColumnIfMissing(
  db: Database.Database,
  columns: Set<string>,
  name: string,
  definition: string
) {
  if (columns.has(name)) return;
  db.exec(`ALTER TABLE books ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

function initializeSchema(db: Database.Database) {
  if (!hasTable(db, "books")) {
    db.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        work_title TEXT,
        original_title TEXT,
        edition_title TEXT,
        subtitle TEXT,
        author TEXT NOT NULL,
        year INTEGER,
        first_published_year INTEGER,
        category TEXT NOT NULL DEFAULT 'Без категории',
        genres_json TEXT NOT NULL DEFAULT '[]',
        subjects_json TEXT NOT NULL DEFAULT '[]',
        publisher TEXT,
        page_count INTEGER,
        language TEXT,
        status TEXT NOT NULL DEFAULT 'want',
        rating INTEGER,
        read_date TEXT,
        review TEXT,
        reviewer_name TEXT,
        cover_url TEXT,
        cover_source TEXT NOT NULL DEFAULT 'none',
        cover_status TEXT NOT NULL DEFAULT 'missing',
        isbn TEXT,
        description TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        external_id TEXT,
        work_id TEXT,
        edition_id TEXT,
        source_url TEXT,
        metadata_quality INTEGER,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } else {
    const columns = getColumnNames(db, "books");
    if (!columns.has("id") || !columns.has("title") || !columns.has("author")) {
      throw new Error("Таблица books не содержит обязательные поля id, title и author");
    }

    const hadStatus = columns.has("status");
    addColumnIfMissing(db, columns, "work_title", "TEXT");
    addColumnIfMissing(db, columns, "original_title", "TEXT");
    addColumnIfMissing(db, columns, "edition_title", "TEXT");
    addColumnIfMissing(db, columns, "subtitle", "TEXT");
    addColumnIfMissing(db, columns, "year", "INTEGER");
    addColumnIfMissing(db, columns, "first_published_year", "INTEGER");
    addColumnIfMissing(db, columns, "category", "TEXT NOT NULL DEFAULT 'Без категории'");
    addColumnIfMissing(db, columns, "genres_json", "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(db, columns, "subjects_json", "TEXT NOT NULL DEFAULT '[]'");
    addColumnIfMissing(db, columns, "publisher", "TEXT");
    addColumnIfMissing(db, columns, "page_count", "INTEGER");
    addColumnIfMissing(db, columns, "language", "TEXT");
    addColumnIfMissing(db, columns, "status", "TEXT NOT NULL DEFAULT 'want'");
    addColumnIfMissing(db, columns, "rating", "INTEGER");
    addColumnIfMissing(db, columns, "read_date", "TEXT");
    addColumnIfMissing(db, columns, "review", "TEXT");
    addColumnIfMissing(db, columns, "reviewer_name", "TEXT");
    addColumnIfMissing(db, columns, "cover_url", "TEXT");
    addColumnIfMissing(db, columns, "cover_source", "TEXT NOT NULL DEFAULT 'none'");
    addColumnIfMissing(db, columns, "cover_status", "TEXT NOT NULL DEFAULT 'missing'");
    addColumnIfMissing(db, columns, "isbn", "TEXT");
    addColumnIfMissing(db, columns, "description", "TEXT");
    addColumnIfMissing(db, columns, "source", "TEXT NOT NULL DEFAULT 'local'");
    addColumnIfMissing(db, columns, "external_id", "TEXT");
    addColumnIfMissing(db, columns, "work_id", "TEXT");
    addColumnIfMissing(db, columns, "edition_id", "TEXT");
    addColumnIfMissing(db, columns, "source_url", "TEXT");
    addColumnIfMissing(db, columns, "metadata_quality", "INTEGER");
    addColumnIfMissing(db, columns, "favorite", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, columns, "created_at", "TEXT");
    addColumnIfMissing(db, columns, "updated_at", "TEXT");

    if (!hadStatus && columns.has("read")) {
      db.exec("UPDATE books SET status = CASE WHEN read = 1 THEN 'read' ELSE 'want' END");
    }

    if (hasTable(db, "reviews")) {
      const reviewColumns = getColumnNames(db, "reviews");
      if (reviewColumns.has("book_id") && reviewColumns.has("review_text") && reviewColumns.has("reviewer_name")) {
        db.exec(`
          UPDATE books
          SET review = COALESCE(NULLIF(review, ''),
                (SELECT r.review_text FROM reviews r WHERE r.book_id = books.id LIMIT 1)),
              reviewer_name = COALESCE(NULLIF(reviewer_name, ''),
                (SELECT r.reviewer_name FROM reviews r WHERE r.book_id = books.id LIMIT 1));
        `);
      }
    }

    if (hasTable(db, "book_covers")) {
      const coverColumns = getColumnNames(db, "book_covers");
      if (coverColumns.has("book_id") && coverColumns.has("cover_url")) {
        db.exec(`
          UPDATE books
          SET cover_url = COALESCE(NULLIF(cover_url, ''),
            (SELECT c.cover_url FROM book_covers c WHERE c.book_id = books.id LIMIT 1));
        `);
      }
    }

    db.exec(`
      UPDATE books
      SET category = COALESCE(NULLIF(TRIM(category), ''), 'Без категории'),
          genres_json = COALESCE(NULLIF(TRIM(genres_json), ''), '[]'),
          subjects_json = COALESCE(NULLIF(TRIM(subjects_json), ''), '[]'),
          status = CASE WHEN status IN ('want', 'reading', 'read', 'paused') THEN status ELSE 'want' END,
          source = CASE WHEN source IN ('local', 'google-books', 'open-library', 'fantlab', 'gutendex', 'hardcover') THEN source ELSE 'local' END,
          cover_source = CASE WHEN cover_source IN ('edition', 'isbn', 'google-books', 'same-language-edition', 'work', 'manual', 'none') THEN cover_source ELSE 'none' END,
          cover_status = CASE WHEN cover_status IN ('local', 'remote', 'fallback', 'missing', 'download-failed') THEN cover_status ELSE CASE WHEN NULLIF(cover_url, '') IS NULL THEN 'missing' ELSE 'remote' END END,
          created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_books_title ON books(title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
    CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
    CREATE INDEX IF NOT EXISTS idx_books_external_id ON books(source, external_id);
    CREATE INDEX IF NOT EXISTS idx_books_work_id ON books(work_id);
    CREATE INDEX IF NOT EXISTS idx_books_edition_id ON books(edition_id);
    CREATE INDEX IF NOT EXISTS idx_books_favorite ON books(favorite);
  `);
}

function getDatabase() {
  if (database) return database;
  const databasePath = getDatabasePath();
  ensureDatabaseDirectory(databasePath);
  database = new Database(databasePath);
  activeDatabasePath = databasePath;
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  initializeSchema(database);
  return database;
}

function normalizeText(value: unknown, fallback = "", maxLength = 10_000) {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function normalizeOptionalText(value: unknown, maxLength = 10_000) {
  const normalized = normalizeText(value, "", maxLength);
  return normalized || undefined;
}

function normalizeDescription(value: unknown) {
  const raw = normalizeOptionalText(value, 30_000);
  if (!raw) return undefined;
  const cleaned = cleanBookDescription(raw);
  return cleaned || undefined;
}

function normalizeNullableNumber(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return rounded >= min && rounded <= max ? rounded : null;
}

function normalizeStringList(value: unknown, limit: number, maxLength = 180) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const text = normalizeText(item, "", maxLength);
    const key = text.toLocaleLowerCase("ru");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeInput(input: BookInput): BookInput {
  const displayTitle = normalizeText(input.displayTitle, "", 500);
  const author = normalizeText(input.author, "", 500);
  if (!displayTitle) throw new Error("Укажите название книги");
  if (!author) throw new Error("Укажите автора книги");

  const status = VALID_STATUSES.has(input.status) ? input.status : "want";
  const source = input.source && VALID_SOURCES.has(input.source) ? input.source : "local";
  const genres = normalizeStringList(input.genres, 30, 120);
  const subjects = normalizeStringList(input.subjects, 80, 300);
  const category = normalizeText(input.category, genres[0] || "Без категории", 200) || "Без категории";
  const coverSource = input.coverSource && VALID_COVER_SOURCES.has(input.coverSource)
    ? input.coverSource
    : input.coverUrl ? "manual" : "none";
  const coverStatus = input.coverStatus && VALID_COVER_STATUSES.has(input.coverStatus)
    ? input.coverStatus
    : input.coverUrl ? "remote" : "missing";

  return {
    displayTitle,
    workTitle: normalizeOptionalText(input.workTitle, 500),
    originalTitle: normalizeOptionalText(input.originalTitle, 500),
    editionTitle: normalizeOptionalText(input.editionTitle, 500),
    subtitle: normalizeOptionalText(input.subtitle, 500),
    author,
    year: normalizeNullableNumber(input.year, 0, 9999),
    firstPublishedYear: normalizeNullableNumber(input.firstPublishedYear, 0, 9999),
    category,
    genres,
    subjects,
    publisher: normalizeOptionalText(input.publisher, 500),
    pageCount: normalizeNullableNumber(input.pageCount, 1, 100_000),
    language: normalizeOptionalText(input.language, 80),
    status,
    rating: normalizeNullableNumber(input.rating, 1, 5),
    readDate: normalizeOptionalText(input.readDate, 30) ?? null,
    favorite: Boolean(input.favorite),
    review: normalizeOptionalText(input.review, 20_000),
    reviewerName: normalizeOptionalText(input.reviewerName, 300),
    coverUrl: normalizeOptionalText(input.coverUrl, 2_000),
    coverSource,
    coverStatus,
    isbn: normalizeOptionalText(input.isbn, 40)?.replace(/[^0-9Xx-]/g, ""),
    description: normalizeDescription(input.description),
    source,
    externalId: normalizeOptionalText(input.externalId, 500),
    workId: normalizeOptionalText(input.workId, 500),
    editionId: normalizeOptionalText(input.editionId, 500),
    sourceUrl: normalizeOptionalText(input.sourceUrl, 2_000),
    metadataQuality: normalizeNullableNumber(input.metadataQuality, 0, 100)
  };
}

function parseStringList(value: string | null, limit: number, maxLength = 180) {
  try {
    return normalizeStringList(JSON.parse(value || "[]"), limit, maxLength);
  } catch {
    return [];
  }
}

function toStatus(value: string | null): ReadingStatus {
  return value && VALID_STATUSES.has(value as ReadingStatus) ? value as ReadingStatus : "want";
}

function toSource(value: string | null): BookSource {
  return value && VALID_SOURCES.has(value as BookSource) ? value as BookSource : "local";
}

function toCoverSource(value: string | null): CoverSource {
  return value && VALID_COVER_SOURCES.has(value as CoverSource) ? value as CoverSource : "none";
}

function toCoverStatus(value: string | null): CoverStatus {
  return value && VALID_COVER_STATUSES.has(value as CoverStatus) ? value as CoverStatus : "missing";
}

function toBook(row: BookRow): Book {
  const review = normalizeOptionalText(row.review, 20_000);
  const genres = parseStringList(row.genres_json, 30, 120);
  return {
    id: row.id,
    displayTitle: normalizeText(row.title, "Без названия", 500) || "Без названия",
    workTitle: normalizeOptionalText(row.work_title, 500),
    originalTitle: normalizeOptionalText(row.original_title, 500),
    editionTitle: normalizeOptionalText(row.edition_title, 500),
    subtitle: normalizeOptionalText(row.subtitle, 500),
    author: normalizeText(row.author, MISSING_AUTHOR, 500) || MISSING_AUTHOR,
    year: row.year,
    firstPublishedYear: row.first_published_year,
    category: normalizeText(row.category, genres[0] || "Без категории", 200) || "Без категории",
    genres,
    subjects: parseStringList(row.subjects_json, 80, 300),
    publisher: normalizeOptionalText(row.publisher, 500),
    pageCount: row.page_count,
    language: normalizeOptionalText(row.language, 80),
    status: toStatus(row.status),
    rating: row.rating,
    readDate: row.read_date,
    favorite: Boolean(row.favorite),
    hasReview: Boolean(review),
    review,
    reviewerName: normalizeOptionalText(row.reviewer_name, 300),
    coverUrl: normalizeOptionalText(row.cover_url, 2_000) || "",
    coverSource: toCoverSource(row.cover_source),
    coverStatus: toCoverStatus(row.cover_status),
    isbn: normalizeOptionalText(row.isbn, 40),
    description: normalizeDescription(row.description),
    source: toSource(row.source),
    externalId: normalizeOptionalText(row.external_id, 500),
    workId: normalizeOptionalText(row.work_id, 500),
    editionId: normalizeOptionalText(row.edition_id, 500),
    sourceUrl: normalizeOptionalText(row.source_url, 2_000),
    metadataQuality: row.metadata_quality
  };
}

const SELECT_BOOK_FIELDS = `
  SELECT id, title, work_title, original_title, edition_title, subtitle, author, year, first_published_year,
    category, genres_json, subjects_json, publisher, page_count, language, status,
    rating, read_date, favorite, review, reviewer_name, cover_url, cover_source, cover_status,
    isbn, description, source, external_id, work_id, edition_id, source_url, metadata_quality
  FROM books
`;

function getBookByIdFromDb(db: Database.Database, id: number) {
  const row = db.prepare(`${SELECT_BOOK_FIELDS} WHERE id = ? LIMIT 1`).get(id) as BookRow | undefined;
  return row ? toBook(row) : null;
}

export function listBooks(): Book[] {
  const rows = getDatabase()
    .prepare(`${SELECT_BOOK_FIELDS} ORDER BY title COLLATE NOCASE, author COLLATE NOCASE`)
    .all() as BookRow[];
  return rows.map(toBook);
}

function persistenceParameters(input: BookInput) {
  const book = normalizeInput(input);
  return {
    ...book,
    title: book.displayTitle,
    workTitle: book.workTitle ?? null,
    originalTitle: book.originalTitle ?? null,
    editionTitle: book.editionTitle ?? null,
    subtitle: book.subtitle ?? null,
    genresJson: JSON.stringify(book.genres),
    subjectsJson: JSON.stringify(book.subjects),
    publisher: book.publisher ?? null,
    language: book.language ?? null,
    review: book.review ?? null,
    reviewerName: book.reviewerName ?? null,
    coverUrl: book.coverUrl ?? null,
    isbn: book.isbn ?? null,
    description: book.description ?? null,
    externalId: book.externalId ?? null,
    workId: book.workId ?? null,
    editionId: book.editionId ?? null,
    sourceUrl: book.sourceUrl ?? null,
    metadataQuality: book.metadataQuality ?? null,
    favorite: book.favorite ? 1 : 0
  };
}

export function createBook(input: BookInput): Book {
  const db = getDatabase();
  const parameters = persistenceParameters(input);
  const result = db.prepare(`
    INSERT INTO books (
      title, work_title, original_title, edition_title, subtitle, author, year, first_published_year,
      category, genres_json, subjects_json, publisher, page_count, language,
      status, rating, read_date, favorite, review, reviewer_name, cover_url, cover_source,
      cover_status, isbn, description, source, external_id, work_id, edition_id,
      source_url, metadata_quality, created_at, updated_at
    ) VALUES (
      @title, @workTitle, @originalTitle, @editionTitle, @subtitle, @author, @year, @firstPublishedYear,
      @category, @genresJson, @subjectsJson, @publisher, @pageCount, @language,
      @status, @rating, @readDate, @favorite, @review, @reviewerName, @coverUrl, @coverSource,
      @coverStatus, @isbn, @description, @source, @externalId, @workId, @editionId,
      @sourceUrl, @metadataQuality, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run(parameters);
  const created = getBookByIdFromDb(db, Number(result.lastInsertRowid));
  if (!created) throw new Error("Не удалось получить добавленную книгу");
  return created;
}

export function updateBook(id: number, input: BookInput): Book {
  if (!Number.isInteger(id) || id <= 0) throw new Error("Некорректный идентификатор книги");
  const db = getDatabase();
  const parameters = { ...persistenceParameters(input), id };
  const result = db.prepare(`
    UPDATE books SET
      title = @title, work_title = @workTitle, original_title = @originalTitle,
      edition_title = @editionTitle, subtitle = @subtitle,
      author = @author, year = @year, first_published_year = @firstPublishedYear,
      category = @category, genres_json = @genresJson, subjects_json = @subjectsJson,
      publisher = @publisher, page_count = @pageCount, language = @language,
      status = @status, rating = @rating, read_date = @readDate, favorite = @favorite, review = @review,
      reviewer_name = @reviewerName, cover_url = @coverUrl, cover_source = @coverSource,
      cover_status = @coverStatus, isbn = @isbn, description = @description,
      source = @source, external_id = @externalId, work_id = @workId,
      edition_id = @editionId, source_url = @sourceUrl,
      metadata_quality = @metadataQuality, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run(parameters);
  if (result.changes === 0) throw new Error("Книга не найдена");
  const updated = getBookByIdFromDb(db, id);
  if (!updated) throw new Error("Не удалось получить обновлённую книгу");
  return updated;
}

export function deleteBook(id: number) {
  if (!Number.isInteger(id) || id <= 0) throw new Error("Некорректный идентификатор книги");
  return getDatabase().prepare("DELETE FROM books WHERE id = ?").run(id).changes > 0;
}

export function clearAllBooks() {
  getDatabase().prepare("DELETE FROM books").run();
}

export function getLibraryInfo(): LibraryInfo {
  const db = getDatabase();
  const row = db.prepare("SELECT COUNT(*) AS count FROM books").get() as CountRow;
  return {
    databasePath: activeDatabasePath || getDatabasePath(),
    coversPath: getCoversDirectory(),
    bookCount: row.count
  };
}

export function closeDatabase() {
  if (!database) return;
  database.close();
  database = null;
  activeDatabasePath = null;
}

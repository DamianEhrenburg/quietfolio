import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const cases = [
  { id: "ru-title-1984", lang: "ru", query: "1984", mode: "title", expect: ["1984", "оруэлл"] },
  { id: "ru-title-master", lang: "ru", query: "Мастер и Маргарита", mode: "title", expect: ["мастер и маргарита", "булгаков"] },
  { id: "ru-title-crime", lang: "ru", query: "Преступление и наказание", mode: "title", expect: ["преступление и наказание", "достоевский"] },
  { id: "ru-title-war", lang: "ru", query: "Война и мир", mode: "title", expect: ["война и мир", "толстой"] },
  { id: "ru-title-captain", lang: "ru", query: "Капитанская дочка", mode: "title", expect: ["капитанская дочка", "пушкин"] },
  { id: "ru-title-dead-souls", lang: "ru", query: "Мертвые души", mode: "title", expect: ["мертвые души", "гоголь"] },
  { id: "ru-author-dostoevsky", lang: "ru", query: "Достоевский", mode: "author", expect: ["достоевский"] },
  { id: "ru-author-tolstoy", lang: "ru", query: "Лев Толстой", mode: "author", expect: ["толстой"] },
  { id: "ru-author-orwell", lang: "ru", query: "Джордж Оруэлл", mode: "author", expect: ["оруэлл", "orwell"] },
  { id: "ru-author-strugatsky", lang: "ru", query: "Стругацкие", mode: "author", expect: ["стругац"] },
  { id: "ru-author-title-orwell", lang: "ru", query: "Оруэлл скотный двор", mode: "auto", expect: ["скотный двор", "animal farm"] },
  { id: "ru-author-title-kafka", lang: "ru", query: "Кафка процесс", mode: "auto", expect: ["процесс", "kafka", "кафка"] },
  { id: "ru-translit-master", lang: "ru", query: "master i margarita", mode: "auto", expect: ["master and margarita", "мастер и маргарита"] },
  { id: "ru-translit-voina", lang: "ru", query: "voina i mir", mode: "auto", expect: ["война и мир", "war and peace"] },
  { id: "ru-isbn-crime", lang: "ru", query: "9780140449136", mode: "isbn", expect: ["crime and punishment", "преступление"] },
  { id: "ru-isbn-master", lang: "ru", query: "9780141180144", mode: "isbn", expect: ["master and margarita", "мастер"] },
  { id: "ru-classic-idiot", lang: "ru", query: "Идиот Достоевский", mode: "auto", expect: ["идиот", "dostoevsky"] },
  { id: "ru-classic-metro", lang: "ru", query: "Метро 2033", mode: "title", expect: ["метро 2033", "глуховский"] },
  { id: "ru-classic-roadside", lang: "ru", query: "Пикник на обочине", mode: "title", expect: ["пикник на обочине", "roadside picnic"] },
  { id: "ru-classic-solaris", lang: "ru", query: "Солярис Лем", mode: "auto", expect: ["солярис", "solaris"] },
  { id: "en-title-1984", lang: "en", query: "1984", mode: "title", expect: ["1984", "orwell"] },
  { id: "en-title-animal", lang: "en", query: "Animal Farm", mode: "title", expect: ["animal farm", "orwell"] },
  { id: "en-title-brave", lang: "en", query: "Brave New World", mode: "title", expect: ["brave new world", "huxley"] },
  { id: "en-title-fahrenheit", lang: "en", query: "Fahrenheit 451", mode: "title", expect: ["fahrenheit 451", "bradbury"] },
  { id: "en-title-mockingbird", lang: "en", query: "To Kill a Mockingbird", mode: "title", expect: ["to kill a mockingbird", "lee"] },
  { id: "en-title-gatsby", lang: "en", query: "The Great Gatsby", mode: "title", expect: ["great gatsby", "fitzgerald"] },
  { id: "en-author-orwell", lang: "en", query: "George Orwell", mode: "author", expect: ["orwell"] },
  { id: "en-author-austen", lang: "en", query: "Jane Austen", mode: "author", expect: ["austen"] },
  { id: "en-author-hemingway", lang: "en", query: "Ernest Hemingway", mode: "author", expect: ["hemingway"] },
  { id: "en-author-tolkien", lang: "en", query: "J R R Tolkien", mode: "author", expect: ["tolkien"] },
  { id: "en-author-title-dune", lang: "en", query: "Frank Herbert Dune", mode: "auto", expect: ["dune", "herbert"] },
  { id: "en-author-title-hobbit", lang: "en", query: "Tolkien Hobbit", mode: "auto", expect: ["hobbit", "tolkien"] },
  { id: "en-translit-dostoevsky", lang: "en", query: "Dostoevsky Crime and Punishment", mode: "auto", expect: ["crime and punishment", "dostoevsky"] },
  { id: "en-translit-kafka", lang: "en", query: "Kafka Metamorphosis", mode: "auto", expect: ["metamorphosis", "kafka"] },
  { id: "en-isbn-1984", lang: "en", query: "9780451524935", mode: "isbn", expect: ["1984", "orwell"] },
  { id: "en-isbn-hobbit", lang: "en", query: "9780547928227", mode: "isbn", expect: ["hobbit", "tolkien"] },
  { id: "en-classic-pride", lang: "en", query: "Pride and Prejudice", mode: "title", expect: ["pride and prejudice", "austen"] },
  { id: "en-classic-mobydick", lang: "en", query: "Moby Dick", mode: "title", expect: ["moby dick", "melville"] },
  { id: "en-classic-catcher", lang: "en", query: "The Catcher in the Rye", mode: "title", expect: ["catcher in the rye", "salinger"] },
  { id: "en-classic-lotr", lang: "en", query: "Lord of the Rings", mode: "title", expect: ["lord of the rings", "tolkien"] }
];
const pattern = process.env.QUIETFOLIO_BENCH_CASE_PATTERN
  ? new RegExp(process.env.QUIETFOLIO_BENCH_CASE_PATTERN, "i")
  : null;
const filteredCases = pattern ? cases.filter((item) => pattern.test(item.id)) : cases;
const selectedCases = Number(process.env.QUIETFOLIO_BENCH_CASE_LIMIT)
  ? filteredCases.slice(0, Number(process.env.QUIETFOLIO_BENCH_CASE_LIMIT))
  : filteredCases;

const userData = mkdtempSync(path.join(tmpdir(), "quietfolio-search-bench-"));
mkdirSync(userData, { recursive: true });
writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({
    version: 10,
    uiLocale: "ru",
    uiLocaleChosen: true,
    openLibraryEnabled: true,
    googleBooksEnabled: false,
    fantlabEnabled: true,
    gutendexEnabled: true,
    hardcoverEnabled: false,
    preferRussian: true,
    searchLimit: 12,
    requestTimeoutMs: 4_000,
    cacheMinutes: 5,
    displayTitlePreference: "localized",
    autoSelectHighConfidence: true,
    inpxEnabled: false,
    inpxIndexPath: "",
    inpxWebUrl: ""
  }),
  "utf8"
);
const child = spawn(electronPath, [".", "--bench-search"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    QUIETFOLIO_BENCH_CASES: JSON.stringify(selectedCases),
    QUIETFOLIO_BENCH_CASE_TIMEOUT_MS: process.env.QUIETFOLIO_BENCH_CASE_TIMEOUT_MS || "5000",
    QUIETFOLIO_BENCH_USER_DATA: userData
  },
  stdio: "inherit"
});

child.on("error", (error) => {
  rmSync(userData, { recursive: true, force: true });
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  rmSync(userData, { recursive: true, force: true });
  if (signal) {
    process.stderr.write(`Search benchmark terminated by ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

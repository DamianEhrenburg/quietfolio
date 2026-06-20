import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export function getPrimaryDatabasePath() {
  return path.join(app.getPath("userData"), "library.db");
}

/**
 * Выбирает рабочую базу данных. По умолчанию она хранится в userData Electron.
 * QUIETFOLIO_DATABASE_PATH — явный путь к базе.
 */
export function getDatabasePath() {
  const configuredPath = process.env.QUIETFOLIO_DATABASE_PATH?.trim();
  return configuredPath ? path.resolve(configuredPath) : getPrimaryDatabasePath();
}

export function ensureDatabaseDirectory(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

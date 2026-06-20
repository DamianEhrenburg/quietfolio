import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppSettings, AppSettingsUpdate } from "../../src/shared/types";
import { resetInpxIndex } from "./inpxLocalIndex";

interface StoredSettings {
  version: 10;
  uiLocale: "ru" | "en";
  uiLocaleChosen: boolean;
  openLibraryEnabled: boolean;
  googleBooksEnabled: boolean;
  fantlabEnabled: boolean;
  gutendexEnabled: boolean;
  hardcoverEnabled: boolean;
  preferRussian: boolean;
  searchLimit: number;
  requestTimeoutMs: number;
  cacheMinutes: number;
  displayTitlePreference: "localized" | "edition";
  autoSelectHighConfidence: boolean;
  inpxEnabled: boolean;
  inpxIndexPath: string;
  inpxWebUrl: string;
  encryptedGoogleBooksApiKey?: string;
  plainGoogleBooksApiKey?: string;
  encryptedHardcoverApiToken?: string;
  plainHardcoverApiToken?: string;
}

export interface InternalSettings extends Omit<AppSettings, "inpxConfigured" | "googleBooksConfigured" | "hardcoverConfigured"> {
  googleBooksApiKey: string;
  hardcoverApiToken: string;
}

const DEFAULTS: StoredSettings = {
  version: 10,
  uiLocale: "en",
  uiLocaleChosen: false,
  openLibraryEnabled: true,
  googleBooksEnabled: true,
  fantlabEnabled: true,
  gutendexEnabled: true,
  hardcoverEnabled: false,
  preferRussian: false,
  searchLimit: 18,
  requestTimeoutMs: 15_000,
  cacheMinutes: 60,
  displayTitlePreference: "localized",
  autoSelectHighConfidence: true,
  inpxEnabled: false,
  inpxIndexPath: "",
  inpxWebUrl: ""
};

let cached: StoredSettings | null = null;

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function readSettings(): StoredSettings {
  if (cached) return cached;

  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Partial<StoredSettings> & {
      inventaireEnabled?: boolean;
      litresEnabled?: boolean;
    };
    cached = {
      ...DEFAULTS,
      ...parsed,
      version: 10,
      uiLocale: parsed.uiLocale === "en" ? "en" : "ru",
      uiLocaleChosen: parsed.uiLocaleChosen === true,
      openLibraryEnabled: parsed.openLibraryEnabled !== false,
      googleBooksEnabled: parsed.googleBooksEnabled !== false,
      fantlabEnabled: parsed.fantlabEnabled !== false,
      gutendexEnabled: parsed.gutendexEnabled !== false,
      hardcoverEnabled: parsed.hardcoverEnabled === true,
      preferRussian: parsed.preferRussian !== false,
      searchLimit: clampInteger(parsed.searchLimit, 5, 40, DEFAULTS.searchLimit),
      requestTimeoutMs: clampInteger(
        parsed.requestTimeoutMs,
        5_000,
        60_000,
        DEFAULTS.requestTimeoutMs
      ),
      cacheMinutes: clampInteger(parsed.cacheMinutes, 5, 1_440, DEFAULTS.cacheMinutes),
      displayTitlePreference: parsed.displayTitlePreference === "edition" ? "edition" : "localized",
      autoSelectHighConfidence: parsed.autoSelectHighConfidence !== false,
      inpxEnabled: parsed.inpxEnabled === true,
      inpxIndexPath: typeof parsed.inpxIndexPath === "string" ? parsed.inpxIndexPath.trim() : "",
      inpxWebUrl: typeof parsed.inpxWebUrl === "string" ? parsed.inpxWebUrl.trim() : ""
    };
  } catch {
    cached = { ...DEFAULTS };
  }

  return cached;
}

function writeSettings(value: StoredSettings) {
  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, target);
  cached = value;
}

function decryptSecret(encrypted?: string, plain?: string) {
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      return "";
    }
  }
  return plain || "";
}

function storeSecret(
  settings: StoredSettings,
  value: string,
  encryptedField: "encryptedGoogleBooksApiKey" | "encryptedHardcoverApiToken",
  plainField: "plainGoogleBooksApiKey" | "plainHardcoverApiToken"
): StoredSettings {
  const next = { ...settings };
  delete next[encryptedField];
  delete next[plainField];

  const normalized = value.trim();
  if (!normalized) return next;

  if (safeStorage.isEncryptionAvailable()) {
    next[encryptedField] = safeStorage.encryptString(normalized).toString("base64");
  } else {
    next[plainField] = normalized;
  }

  return next;
}

function decryptGoogleBooksApiKey(settings: StoredSettings) {
  return decryptSecret(settings.encryptedGoogleBooksApiKey, settings.plainGoogleBooksApiKey);
}

function decryptHardcoverApiToken(settings: StoredSettings) {
  return decryptSecret(settings.encryptedHardcoverApiToken, settings.plainHardcoverApiToken);
}

export function getInternalSettings(): InternalSettings {
  const stored = readSettings();
  const googleBooksApiKey = decryptGoogleBooksApiKey(stored);
  const hardcoverApiToken = decryptHardcoverApiToken(stored);

  return {
    uiLocale: stored.uiLocale,
    uiLocaleChosen: stored.uiLocaleChosen,
    openLibraryEnabled: stored.openLibraryEnabled,
    googleBooksEnabled: stored.googleBooksEnabled,
    fantlabEnabled: stored.fantlabEnabled,
    gutendexEnabled: stored.gutendexEnabled,
    hardcoverEnabled: stored.hardcoverEnabled,
    preferRussian: stored.preferRussian,
    searchLimit: stored.searchLimit,
    requestTimeoutMs: stored.requestTimeoutMs,
    cacheMinutes: stored.cacheMinutes,
    displayTitlePreference: stored.displayTitlePreference,
    autoSelectHighConfidence: stored.autoSelectHighConfidence,
    inpxEnabled: stored.inpxEnabled,
    inpxIndexPath: stored.inpxIndexPath,
    inpxWebUrl: stored.inpxWebUrl,
    googleBooksApiKey,
    hardcoverApiToken
  };
}

export function getPublicSettings(): AppSettings {
  const internal = getInternalSettings();
  const stored = readSettings();
  return {
    uiLocale: internal.uiLocale,
    uiLocaleChosen: internal.uiLocaleChosen,
    openLibraryEnabled: internal.openLibraryEnabled,
    googleBooksEnabled: internal.googleBooksEnabled,
    fantlabEnabled: internal.fantlabEnabled,
    gutendexEnabled: internal.gutendexEnabled,
    hardcoverEnabled: internal.hardcoverEnabled,
    googleBooksConfigured: Boolean(internal.googleBooksApiKey),
    hardcoverConfigured: Boolean(internal.hardcoverApiToken),
    preferRussian: internal.preferRussian,
    searchLimit: internal.searchLimit,
    requestTimeoutMs: internal.requestTimeoutMs,
    cacheMinutes: internal.cacheMinutes,
    displayTitlePreference: internal.displayTitlePreference,
    autoSelectHighConfidence: internal.autoSelectHighConfidence,
    inpxEnabled: internal.inpxEnabled,
    inpxIndexPath: internal.inpxIndexPath,
    inpxWebUrl: internal.inpxWebUrl,
    inpxConfigured: Boolean(
      (stored.inpxEnabled && stored.inpxIndexPath && fs.existsSync(stored.inpxIndexPath))
      || Boolean(stored.inpxWebUrl?.trim())
    )
  };
}

export function updateSettings(update: AppSettingsUpdate): AppSettings {
  const current = readSettings();

  let next: StoredSettings = {
    ...current,
    uiLocale: update.uiLocale === "en" || update.uiLocale === "ru" ? update.uiLocale : current.uiLocale,
    uiLocaleChosen:
      typeof update.uiLocaleChosen === "boolean" ? update.uiLocaleChosen : current.uiLocaleChosen,
    openLibraryEnabled: update.openLibraryEnabled !== false,
    googleBooksEnabled: update.googleBooksEnabled === true,
    fantlabEnabled: update.fantlabEnabled !== false,
    gutendexEnabled: update.gutendexEnabled !== false,
    hardcoverEnabled: update.hardcoverEnabled === true,
    preferRussian: update.preferRussian !== false,
    searchLimit: clampInteger(update.searchLimit, 5, 40, current.searchLimit),
    requestTimeoutMs: clampInteger(
      update.requestTimeoutMs,
      5_000,
      60_000,
      current.requestTimeoutMs
    ),
    cacheMinutes: clampInteger(update.cacheMinutes, 5, 1_440, current.cacheMinutes),
    displayTitlePreference: update.displayTitlePreference === "edition" ? "edition" : "localized",
    autoSelectHighConfidence: update.autoSelectHighConfidence !== false,
    inpxEnabled: typeof update.inpxEnabled === "boolean" ? update.inpxEnabled : current.inpxEnabled,
    inpxIndexPath: typeof update.inpxIndexPath === "string" ? update.inpxIndexPath.trim() : current.inpxIndexPath,
    inpxWebUrl: typeof update.inpxWebUrl === "string" ? update.inpxWebUrl.trim() : current.inpxWebUrl
  };

  if (update.clearGoogleBooksApiKey) {
    next = storeSecret(next, "", "encryptedGoogleBooksApiKey", "plainGoogleBooksApiKey");
  } else if (typeof update.googleBooksApiKey === "string" && update.googleBooksApiKey.trim()) {
    next = storeSecret(next, update.googleBooksApiKey, "encryptedGoogleBooksApiKey", "plainGoogleBooksApiKey");
    if (update.googleBooksEnabled !== false) {
      next.googleBooksEnabled = true;
    }
  }

  if (update.clearHardcoverApiToken) {
    next = storeSecret(next, "", "encryptedHardcoverApiToken", "plainHardcoverApiToken");
  } else if (typeof update.hardcoverApiToken === "string" && update.hardcoverApiToken.trim()) {
    next = storeSecret(next, update.hardcoverApiToken, "encryptedHardcoverApiToken", "plainHardcoverApiToken");
    if (update.hardcoverEnabled !== false) {
      next.hardcoverEnabled = true;
    }
  }

  if (
    next.inpxIndexPath !== current.inpxIndexPath
    || next.inpxEnabled !== current.inpxEnabled
    || next.inpxWebUrl !== current.inpxWebUrl
  ) {
    resetInpxIndex();
  }

  writeSettings(next);
  return getPublicSettings();
}

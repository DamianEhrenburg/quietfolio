import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppSettingsUpdate,
  BookInput,
  OnlineBookCandidate,
  OnlineEditionSelection,
  OnlineSearchRequest,
  ResolveOnlineWorkRequest
} from "../src/shared/types";
import {
  cacheRemoteCover,
  isLocalCoverUrl,
  registerCoverProtocol,
  registerCoverScheme,
  warmRemoteCovers
} from "./services/coverCache";
import {
  closeDatabase,
  createBook,
  deleteBook,
  getLibraryInfo,
  listBooks,
  updateBook
} from "./services/libraryRepository";
import {
  clearResolvePreviewCache,
  diagnoseProviders,
  enrichSearchResultCoversBackground,
  enrichEditionPickerCovers,
  loadMoreOnlineEditions,
  prepareOnlineEdition,
  resolveOnlineWork,
  searchOnlineBooks,
  startOpenLibraryClassicsWarm
} from "./services/onlineBookSearch";
import { ignoreBenchmarkPipeErrors, runSearchBenchmark } from "./searchBenchmark";
import { getOpenLibraryIndexInfo } from "./services/openLibraryLocalIndex";
import { clearSearchCache } from "./services/searchCache";
import { clearEntityResolutionCache } from "./services/entityResolutionCache";
import {
  getInternalSettings,
  getPublicSettings,
  updateSettings
} from "./services/settingsService";
import { getInpxIndexInfo } from "./services/inpxLocalIndex";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchUserDataPath = process.env.QUIETFOLIO_BENCH_USER_DATA?.trim();
if (benchUserDataPath) {
  app.setPath("userData", benchUserDataPath);
}

const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(process.cwd(), "build", "icon.png");
registerCoverScheme();

function requireBookInput(value: unknown): BookInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Данные книги должны быть объектом");
  }
  return value as BookInput;
}

function requireOnlineCandidate(value: unknown): OnlineBookCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Некорректный результат онлайн-поиска");
  }
  return value as OnlineBookCandidate;
}

function requireEditionSelection(value: unknown): OnlineEditionSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Некорректно выбрано издание");
  }
  const selection = value as Partial<OnlineEditionSelection>;
  if (!selection.work || !selection.edition) {
    throw new TypeError("Не указано произведение или издание");
  }
  return selection as OnlineEditionSelection;
}

function requireBookId(value: unknown) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError("Некорректный идентификатор книги");
  }
  return id;
}

async function prepareBookInput(value: unknown) {
  const input = requireBookInput(value);
  const coverUrl = input.coverUrl?.trim();
  if (!coverUrl || isLocalCoverUrl(coverUrl)) return input;

  try {
    const cached = await cacheRemoteCover(coverUrl, getInternalSettings().requestTimeoutMs);
    if (cached) {
      return { ...input, coverUrl: cached, coverStatus: input.coverStatus === "remote" ? "local" : input.coverStatus };
    }
  } catch {
    // keep remote url for renderer display
  }
  if (/^https?:\/\//i.test(coverUrl) && input.coverStatus === "download-failed") {
    return { ...input, coverUrl, coverStatus: "remote" as const };
  }
  return input;
}

function createWindow() {
  nativeTheme.themeSource = "dark";

  const mainWindow = new BrowserWindow({
    icon: appIconPath,
    width: 1360,
    height: 860,
    minWidth: 1020,
    minHeight: 700,
    title: "Quietfolio",
    backgroundColor: "#090d14",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#090d14", symbolColor: "#dce2ee", height: 46 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isLocalFile = url.startsWith("file://");
    const isDevelopmentPage = Boolean(
      process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    );

    if (!isLocalFile && !isDevelopmentPage) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) {
        void shell.openExternal(url);
      }
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../out/renderer/index.html"));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerCoverProtocol();

  ipcMain.handle("library:listBooks", () => listBooks());
  ipcMain.handle("library:createBook", async (_event, input: unknown) =>
    createBook(await prepareBookInput(input))
  );
  ipcMain.handle("library:updateBook", async (_event, id: unknown, input: unknown) =>
    updateBook(requireBookId(id), await prepareBookInput(input))
  );
  ipcMain.handle("library:deleteBook", (_event, id: unknown) => deleteBook(requireBookId(id)));
  ipcMain.handle("library:getInfo", () => getLibraryInfo());
  ipcMain.handle("library:searchOnline", (_event, value: unknown) => {
    if (typeof value === "string") return searchOnlineBooks(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Некорректный поисковый запрос");
    }
    const request = value as Partial<OnlineSearchRequest>;
    if (typeof request.query !== "string") throw new TypeError("Поисковый запрос должен быть строкой");
    if (!request.mode || !["auto", "author", "title", "isbn"].includes(request.mode)) {
      throw new TypeError("Некорректный режим поиска");
    }
    return searchOnlineBooks(request as OnlineSearchRequest);
  });
  ipcMain.handle("library:resolveOnlineWork", (_event, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "candidate" in value) {
      const request = value as ResolveOnlineWorkRequest;
      return resolveOnlineWork(requireOnlineCandidate(request.candidate), {
        mode: request.mode,
        editionOffset: request.editionOffset
      });
    }
    return resolveOnlineWork(requireOnlineCandidate(value));
  });
  ipcMain.handle("library:loadMoreEditions", (_event, value: unknown, offset: unknown) => {
    if (typeof offset !== "number" || offset < 0) throw new TypeError("Некорректное смещение изданий");
    return loadMoreOnlineEditions(requireOnlineCandidate(value), offset);
  });
  ipcMain.handle("library:prepareOnlineEdition", (_event, selection: unknown) =>
    prepareOnlineEdition(requireEditionSelection(selection))
  );
  ipcMain.handle("library:warmCovers", async (_event, value: unknown) => {
    if (!Array.isArray(value)) throw new TypeError("Некорректный список обложек");
    const urls = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return warmRemoteCovers(urls, getInternalSettings().requestTimeoutMs);
  });
  ipcMain.handle("library:enrichEditionCovers", async (_event, value: unknown) => {
    if (!Array.isArray(value)) throw new TypeError("Некорректный список изданий");
    return enrichEditionPickerCovers(value as import("../src/shared/types").OnlineBookEdition[]);
  });
  ipcMain.handle("library:enrichSearchCovers", async (_event, value: unknown, query?: unknown) => {
    if (!Array.isArray(value)) throw new TypeError("Некорректный список результатов");
    const results = value as OnlineBookCandidate[];
    const searchQuery = typeof query === "string" ? query : "";
    return enrichSearchResultCoversBackground(results, getInternalSettings(), searchQuery);
  });

  ipcMain.handle("settings:get", () => getPublicSettings());
  ipcMain.handle("settings:getInpxIndexInfo", () => getInpxIndexInfo(getInternalSettings()));
  ipcMain.handle("settings:getOlIndexInfo", () => getOpenLibraryIndexInfo());
  ipcMain.handle("settings:update", (_event, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Некорректные настройки");
    }
    const result = updateSettings(value as AppSettingsUpdate);
    clearSearchCache();
    clearResolvePreviewCache();
    clearEntityResolutionCache();
    return result;
  });
  ipcMain.handle("settings:diagnoseProviders", () => diagnoseProviders());
  ipcMain.handle("settings:clearSearchCache", () => {
    clearSearchCache();
    clearResolvePreviewCache();
    clearEntityResolutionCache();
    return true;
  });
  ipcMain.handle("shell:openExternal", async (_event, value: unknown) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
      throw new TypeError("Некорректная внешняя ссылка");
    }
    await shell.openExternal(value);
    return true;
  });

  try {
    getLibraryInfo();
  } catch (error) {
    console.error("Failed to initialize the library database", error);
  }

  if (process.argv.includes("--bench-search")) {
    ignoreBenchmarkPipeErrors();
    runSearchBenchmark(searchOnlineBooks)
      .then(() => app.quit())
      .catch((error: unknown) => {
        try {
          process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
        } catch {
          // benchmark output pipe may already be closed
        }
        app.exit(1);
      });
    return;
  }

  createWindow();
  startOpenLibraryClassicsWarm();

  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(appIconPath);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => closeDatabase());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

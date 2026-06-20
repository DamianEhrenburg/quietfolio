import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  AppSettingsUpdate,
  Book,
  BookInput,
  LibraryInfo,
  OnlineBookCandidate,
  OnlineBookEdition,
  OnlineBookPreview,
  OnlineEditionSelection,
  OnlineSearchRequest,
  OnlineSearchResponse,
  ProviderDiagnostic,
  ResolveOnlineWorkRequest
} from "../src/shared/types";

const api = {
  listBooks: (): Promise<Book[]> => ipcRenderer.invoke("library:listBooks"),
  createBook: (input: BookInput): Promise<Book> => ipcRenderer.invoke("library:createBook", input),
  updateBook: (id: number, input: BookInput): Promise<Book> =>
    ipcRenderer.invoke("library:updateBook", id, input),
  deleteBook: (id: number): Promise<boolean> => ipcRenderer.invoke("library:deleteBook", id),
  getLibraryInfo: (): Promise<LibraryInfo> => ipcRenderer.invoke("library:getInfo"),
  searchOnline: (request: OnlineSearchRequest): Promise<OnlineSearchResponse> =>
    ipcRenderer.invoke("library:searchOnline", request),
  resolveOnlineWork: (request: OnlineBookCandidate | ResolveOnlineWorkRequest): Promise<OnlineBookPreview> =>
    ipcRenderer.invoke("library:resolveOnlineWork", request),
  loadMoreEditions: (candidate: OnlineBookCandidate, offset: number): Promise<{ editions: OnlineBookEdition[]; hasMore: boolean }> =>
    ipcRenderer.invoke("library:loadMoreEditions", candidate, offset),
  prepareOnlineEdition: (selection: OnlineEditionSelection): Promise<BookInput> =>
    ipcRenderer.invoke("library:prepareOnlineEdition", selection),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  getInpxIndexInfo: (): Promise<{ ready: boolean; works: number; path: string }> =>
    ipcRenderer.invoke("settings:getInpxIndexInfo"),
  getOlIndexInfo: (): Promise<{ ready: boolean; works: number; path: string }> =>
    ipcRenderer.invoke("settings:getOlIndexInfo"),
  updateSettings: (settings: AppSettingsUpdate): Promise<AppSettings> =>
    ipcRenderer.invoke("settings:update", settings),
  diagnoseProviders: (): Promise<ProviderDiagnostic[]> =>
    ipcRenderer.invoke("settings:diagnoseProviders"),
  clearSearchCache: (): Promise<boolean> => ipcRenderer.invoke("settings:clearSearchCache"),
  warmCovers: (urls: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke("library:warmCovers", urls),
  enrichSearchCovers: (results: OnlineBookCandidate[], query?: string): Promise<OnlineBookCandidate[]> =>
    ipcRenderer.invoke("library:enrichSearchCovers", results, query),
  enrichEditionCovers: (editions: OnlineBookEdition[]): Promise<OnlineBookEdition[]> =>
    ipcRenderer.invoke("library:enrichEditionCovers", editions),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("shell:openExternal", url)
};

contextBridge.exposeInMainWorld("quietfolio", api);
export type QuietfolioApi = typeof api;

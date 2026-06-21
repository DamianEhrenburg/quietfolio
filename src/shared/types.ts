export type ReadingStatus = "want" | "reading" | "read" | "paused";

export type OnlineSearchMode = "auto" | "author" | "title" | "isbn";
export type ResolvedSearchMode = "author" | "title" | "isbn" | "general";
export type QueryResolutionSource =
  | "isbn"
  | "open-library-author"
  | "wikidata"
  | "combined"
  | "curated"
  | "literal";
export type MatchConfidence = "high" | "medium" | "low";
export type DisplayTitlePreference = "localized" | "edition";

export type BookProvider = "open-library" | "google-books" | "fantlab" | "gutendex" | "hardcover";
export type DiagnosticProvider = BookProvider | "wikidata";
export type BookSource = "local" | BookProvider;
export type ReferenceKind = "work" | "edition" | "volume";
export type CoverSource =
  | "edition"
  | "isbn"
  | "google-books"
  | "same-language-edition"
  | "work"
  | "manual"
  | "none";
export type CoverStatus = "local" | "remote" | "fallback" | "missing" | "download-failed";

export interface ProviderReference {
  provider: BookProvider;
  externalId: string;
  kind: ReferenceKind;
}

export interface Book {
  id: number;
  displayTitle: string;
  workTitle?: string;
  originalTitle?: string;
  editionTitle?: string;
  subtitle?: string;
  author: string;
  year: number | null;
  firstPublishedYear: number | null;
  category: string;
  genres: string[];
  subjects: string[];
  publisher?: string;
  pageCount: number | null;
  language?: string;
  status: ReadingStatus;
  rating: number | null;
  readDate: string | null;
  favorite: boolean;
  hasReview: boolean;
  review?: string;
  reviewerName?: string;
  coverUrl?: string;
  coverSource?: CoverSource;
  coverStatus?: CoverStatus;
  isbn?: string;
  description?: string;
  source: BookSource;
  externalId?: string;
  workId?: string;
  editionId?: string;
  sourceUrl?: string;
  metadataQuality: number | null;
}

export interface BookInput {
  displayTitle: string;
  workTitle?: string;
  originalTitle?: string;
  editionTitle?: string;
  subtitle?: string;
  author: string;
  year: number | null;
  firstPublishedYear: number | null;
  category: string;
  genres: string[];
  subjects: string[];
  publisher?: string;
  pageCount: number | null;
  language?: string;
  status: ReadingStatus;
  rating: number | null;
  readDate: string | null;
  favorite?: boolean;
  review?: string;
  reviewerName?: string;
  coverUrl?: string;
  coverSource?: CoverSource;
  coverStatus?: CoverStatus;
  isbn?: string;
  description?: string;
  source?: BookSource;
  externalId?: string;
  workId?: string;
  editionId?: string;
  sourceUrl?: string;
  metadataQuality?: number | null;
}

export interface LibraryInfo {
  databasePath: string;
  coversPath: string;
  bookCount: number;
}

export interface OnlineSearchRequest {
  query: string;
  mode: OnlineSearchMode;
}

export interface DisambiguationOption {
  label: string;
  query: string;
  confidence: number;
  hint?: string;
}

export interface OnlineQueryResolution {
  originalQuery: string;
  requestedMode: OnlineSearchMode;
  resolvedMode: ResolvedSearchMode;
  canonicalQuery: string;
  displayLabel: string;
  aliases: string[];
  confidence: number;
  source: QueryResolutionSource;
  explanation: string;
  authorKey?: string;
  authorName?: string;
  authorAliases?: string[];
  titleAliases?: string[];
  wikidataId?: string;
  disambiguationOptions?: DisambiguationOption[];
}

export interface OnlineBookCandidate {
  id: string;
  providers: BookProvider[];
  references: ProviderReference[];
  title: string;
  displayTitle?: string;
  originalTitle?: string;
  alternateTitles?: string[];
  originalLanguage?: string;
  author: string;
  firstPublishedYear: number | null;
  editionCount: number;
  /** Catalog-specific edition total for search UI; omit OL global edition_count. */
  listedEditionCount?: number | null;
  languages: string[];
  genres: string[];
  subjects: string[];
  description?: string;
  coverUrl?: string;
  /** Remote catalog cover URL before local cache warming. */
  coverRemoteUrl?: string;
  /** Stable Open Library cover id/isbn key for matching editions. */
  coverKey?: string;
  /** FantLab pic_edition_id_auto for search-result cover alignment. */
  previewEditionId?: string;
  /** INPX / local catalog series label for Discover metadata. */
  catalogSeries?: string;
  catalogSeriesNum?: number | null;
  sourceUrl?: string;
  score: number;
  completeness: number;
  matchConfidence?: MatchConfidence;
  matchReasons?: string[];
  authorKeys?: string[];
  popularity?: number;
  autoSelectable?: boolean;
  providerScore?: number;
  primaryEdition?: OnlineBookEdition;
  /** Wikidata work item id (Q…) for cross-catalog dedupe. */
  wikidataId?: string;
}

export interface CoverOption {
  url: string;
  source: CoverSource;
  exactEdition: boolean;
  note?: string;
  verified?: boolean;
}

export interface OnlineBookEdition {
  id: string;
  provider: BookProvider;
  references: ProviderReference[];
  workId?: string;
  editionId?: string;
  title: string;
  subtitle?: string;
  author: string;
  year: number | null;
  publisher?: string;
  pageCount: number | null;
  language?: string;
  isbn10?: string;
  isbn13?: string;
  coverUrl?: string;
  coverOptions: CoverOption[];
  coverStatus: "available" | "candidate" | "fallback" | "missing";
  coverNote?: string;
  sourceUrl?: string;
  score: number;
  metadataQuality: number;
}

export interface OnlineBookPreview {
  work: OnlineBookCandidate;
  editions: OnlineBookEdition[];
  primaryEdition?: OnlineBookEdition;
  warnings: string[];
  hasMoreEditions?: boolean;
}

export interface ResolveOnlineWorkRequest {
  candidate: OnlineBookCandidate;
  mode?: "preview" | "quick";
  editionOffset?: number;
}

export interface OnlineEditionSelection {
  work: OnlineBookCandidate;
  edition: OnlineBookEdition;
  displayTitle?: string;
  titlePreference?: DisplayTitlePreference;
  preferredCoverUrl?: string;
  preferredCoverKey?: string;
}

export interface ProviderSearchStatus {
  provider: BookProvider;
  enabled: boolean;
  ok: boolean;
  resultCount: number;
  durationMs: number;
  message?: string;
}

export interface OnlineSearchResponse {
  query: string;
  resolution: OnlineQueryResolution;
  results: OnlineBookCandidate[];
  providerStatuses: ProviderSearchStatus[];
  fromCache: boolean;
}

export type UiLocale = "ru" | "en";

export interface AppSettings {
  uiLocale: UiLocale;
  uiLocaleChosen: boolean;
  openLibraryEnabled: boolean;
  googleBooksEnabled: boolean;
  fantlabEnabled: boolean;
  gutendexEnabled: boolean;
  hardcoverEnabled: boolean;
  googleBooksConfigured: boolean;
  hardcoverConfigured: boolean;
  preferRussian: boolean;
  searchLimit: number;
  requestTimeoutMs: number;
  cacheMinutes: number;
  displayTitlePreference: DisplayTitlePreference;
  autoSelectHighConfidence: boolean;
  inpxEnabled: boolean;
  inpxIndexPath: string;
  inpxWebUrl: string;
  inpxConfigured: boolean;
}

export interface AppSettingsUpdate {
  uiLocale?: UiLocale;
  uiLocaleChosen?: boolean;
  openLibraryEnabled: boolean;
  googleBooksEnabled: boolean;
  fantlabEnabled: boolean;
  gutendexEnabled?: boolean;
  hardcoverEnabled?: boolean;
  preferRussian: boolean;
  searchLimit: number;
  requestTimeoutMs: number;
  cacheMinutes: number;
  displayTitlePreference: DisplayTitlePreference;
  autoSelectHighConfidence: boolean;
  inpxEnabled?: boolean;
  inpxIndexPath?: string;
  inpxWebUrl?: string;
  googleBooksApiKey?: string;
  clearGoogleBooksApiKey?: boolean;
  hardcoverApiToken?: string;
  clearHardcoverApiToken?: boolean;
}

export interface ProviderDiagnostic {
  provider: DiagnosticProvider;
  service: "metadata" | "covers" | "resolver";
  enabled: boolean;
  configured: boolean;
  ok: boolean;
  durationMs: number;
  message: string;
}

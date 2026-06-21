import type {
  Book,
  OnlineSearchMode,
  ReadingStatus,
  UiLocale
} from "../shared/types";

export interface Messages {
  locale: UiLocale;
  localeTag: string;
  brand: {
    tagline: string;
    version: (version: string) => string;
  };
  language: {
    welcomeEyebrow: string;
    welcomeTitle: string;
    welcomeSubtitle: string;
    russian: string;
    russianHint: string;
    english: string;
    englishHint: string;
    continue: string;
    interface: string;
    interfaceHint: string;
    welcomePreview: string;
    welcomePickHint: string;
    saving: string;
  };
  status: Record<ReadingStatus, string>;
  sources: Record<Book["source"], string>;
  searchMode: Record<OnlineSearchMode, string>;
  searchPlaceholder: Record<OnlineSearchMode, string>;
  resolvedMode: Record<"author" | "title" | "isbn" | "general", string>;
  languages: {
    unknown: string;
    ru: string;
    en: string;
    de: string;
    fr: string;
    es: string;
    it: string;
    uk: string;
    pt: string;
    pl: string;
    ja: string;
    cs: string;
    nl: string;
  };
  genres: {
    labels: Record<
      | "science_fiction"
      | "fantasy"
      | "philosophy"
      | "ethics"
      | "politics"
      | "classics"
      | "fiction"
      | "history"
      | "psychology"
      | "religion"
      | "detective"
      | "biography"
      | "poetry"
      | "drama"
      | "children"
      | "self_help"
      | "economics"
      | "sociology"
      | "law"
      | "technology"
      | "art"
      | "science"
      | "german_literature"
      | "russian_literature",
      string
    >;
  };
  cover: {
    downloadFailed: string;
    missing: string;
    manual: string;
    externalCatalog: string;
    googleBooksIsbn: string;
    openLibraryIsbn: string;
    sameLanguageEdition: string;
    work: string;
    fallback: string;
    edition: string;
    local: string;
    alt: (title: string) => string;
  };
  diagnostic: {
    covers: string;
    resolver: string;
    metadata: string;
    wikidata: string;
  };
  common: {
    close: string;
    cancel: string;
    save: string;
    saving: string;
    add: string;
    delete: string;
    deleting: string;
    search: string;
    searching: string;
    retry: string;
    edit: string;
    write: string;
    clear: string;
    cancelSearch: string;
    expand: string;
    collapse: string;
    notSpecified: string;
    noRating: string;
    uncategorized: string;
    noYear: string;
    pagesShort: (count: number) => string;
    ratingOf: (value: number) => string;
    ratingOutOf: (star: number) => string;
    removeRating: string;
    booksCount: (filtered: number, total: number) => string;
    editionCount: (count: number) => string;
    editionCountInCatalog: (count: number) => string;
    yearUnknown: string;
    originalFilter: (language: string) => string;
    editionLabel: (title: string) => string;
    metadataFrom: (source: string) => string;
    sqliteBooks: (count: number) => string;
    diagnosticDuration: (ms: number) => string;
    unknownError: string;
    desktopApiUnavailable: string;
    shortcutCommandK: string;
    shortcutEsc: string;
  };
  nav: {
    main: string;
    home: string;
    library: string;
    online: string;
    favorites: string;
    stats: string;
    expandPanel: string;
    collapsePanel: string;
    commandPalette: string;
    settings: string;
    backHome: string;
    overview: string;
    myLibrary: string;
    catalog: string;
    today: string;
    recentlyAdded: string;
    findNewBook: string;
    allBooks: string;
    bookSearch: string;
    catalogsAndNetwork: string;
    import: string;
    export: string;
    comingSoon: string;
  };
  home: {
    welcome: string;
    title: string;
    titleBreak: string;
    subtitle: string;
    findBook: string;
    openLibrary: string;
    addFirstBook: string;
    totalBooks: string;
    currentlyReading: string;
    finished: string;
    favorites: string;
    continue: string;
    currentBook: string;
    startCollection: string;
    open: string;
    openCard: string;
    startSearch: string;
    collection: string;
    recentEmpty: string;
    emptyContinue: string;
    pageSubtitle: string;
    commandPlaceholder: string;
  };
  library: {
    myCollection: string;
    allBooks: string;
    findOnline: string;
    focusView: string;
    exitFocusView: string;
    all: string;
    searchPlaceholder: string;
    add: string;
    welcomeTitle: string;
    welcomeText: string;
    findFirstBook: string;
    nothingFound: string;
    nothingFoundHint: string;
    selectBook: string;
    addBookForDetails: string;
    loadError: string;
    tableTitle: string;
    tableAuthor: string;
    tableYear: string;
    tableStatus: string;
    tableRating: string;
    readingStatus: string;
    rating: string;
    year: string;
    firstPublished: string;
    publisher: string;
    pages: string;
    language: string;
    category: string;
    isbn: string;
    aboutBook: string;
    openSourceRecord: string;
    metadata: string;
    deleteConfirm: string;
    addFavorite: string;
    removeFavorite: string;
    personalReview: string;
    reviewEmpty: string;
    reviewPlaceholder: string;
    pageSubtitle: string;
  };
  online: {
    title: string;
    pageSubtitle: string;
    pageTitle: string;
    subtitle: string;
    mode: string;
    manual: string;
    idleTitle: string;
    idleHint: string;
    resolving: string;
    searchFailed: string;
    resultsCount: (count: number) => string;
    resultsRange: (from: number, to: number, total: number) => string;
    sortBy: string;
    sortRelevance: string;
    sortYearDesc: string;
    sortYearAsc: string;
    sortPopularity: string;
    sortPopularityHint: string;
    sortTitle: string;
    showMore: (remaining: number) => string;
    fromCache: string;
    catalogsPartial: string;
    resolvedAs: (mode: string, confidence: number) => string;
    booksByAuthor: (name: string) => string;
    wrongAuthor: string;
    searchHistory: string;
    repeatSearch: (query: string) => string;
    removeSearchHistory: (query: string) => string;
    clearSearchHistory: string;
    noResults: string;
    noResultsHint: string;
    bestMatch: string;
    exactMatch: string;
    add: string;
    preparing: string;
    editions: string;
    loading: string;
    enterQuery: string;
    failedLoadEditions: (error: string) => string;
    failedPrepareBook: (error: string) => string;
    failedPrepareEdition: (error: string) => string;
  };
  search: {
    matchReasons: Record<
      | "exact_author"
      | "author_match"
      | "author_partial"
      | "russian_title"
      | "known_work"
      | "exact_title"
      | "close_title"
      | "partial_title"
      | "exact_isbn"
      | "title_or_author"
      | "curated_catalog"
      | "known_work_curated"
      | "local_index"
      | "series_match",
      string
    >;
    resolution: Record<
      | "resolver.isbn_recognized"
      | "resolver.isbn_invalid_mode"
      | "resolver.author_curated"
      | "resolver.author_open_library"
      | "resolver.author_fallback"
      | "resolver.author_curated_priority"
      | "resolver.author_name"
      | "resolver.author_name_fast"
      | "resolver.author_curated_early"
      | "resolver.author_local_index"
      | "resolver.author_over_biography"
      | "resolver.title_wikidata"
      | "resolver.title_literal"
      | "resolver.title_over_author"
      | "resolver.combined_title_author"
      | "resolver.title_translations"
      | "resolver.general_literal"
      | "resolver.fallback_resolver",
      string
    >;
    warnings: Record<
      | "preview.no_editions"
      | "preview.no_covers"
      | "preview.partial_catalogs",
      string
    >;
  };
  editor: {
    eyebrow: string;
    createTitle: string;
    editTitle: string;
    newBook: string;
    authorMissing: string;
    inLibrary: string;
    work: string;
    edition: string;
    displayTitle: string;
    displayTitleHint: string;
    author: string;
    editionYear: string;
    publisher: string;
    pageCount: string;
    editionLanguage: string;
    category: string;
    genres: string;
    genresPlaceholder: string;
    status: string;
    rating: string;
    readDate: string;
    readDatePlaceholder: string;
    readDateHint: string;
    personalReview: string;
    personalReviewHint: string;
    advanced: string;
    workTitle: string;
    originalTitle: string;
    editionTitle: string;
    subtitle: string;
    firstPublished: string;
    coverUrl: string;
    description: string;
    titleRequired: string;
    authorRequired: string;
  };
  editionPicker: {
    eyebrow: string;
    filter: string;
    all: string;
    russian: string;
    english: string;
    withCover: string;
    withIsbn: string;
    noMatches: string;
    noMatchesHint: string;
    libraryTitle: string;
    workButton: string;
    editionButton: string;
    verifyAndAdd: string;
    checkingCover: string;
    loadMore: string;
    shownOfCatalog: (shown: number, total: number) => string;
  };
  settings: {
    title: string;
    application: string;
    applicationHint: string;
    onlineSources: string;
    onlineSourcesHint: string;
    fantlabDesc: string;
    googleBooksDesc: string;
    openLibraryDesc: string;
    gutendexDesc: string;
    hardcoverDesc: string;
    hardcoverTokenLabel: string;
    hardcoverTokenPlaceholder: string;
    clearHardcoverToken: string;
    free: string;
    keySaved: string;
    keyOptional: string;
    keyRequired: string;
    apiKeyPlaceholderKeep: string;
    apiKeyPlaceholderPaste: string;
    clearGoogleKey: string;
    sourcesHint: string;
    searchBehavior: string;
    searchBehaviorHint: string;
    autoSelectHighConfidence: string;
    libraryTitles: string;
    libraryTitlesHint: string;
    localizedTitle: string;
    localizedTitleHint: string;
    editionTitle: string;
    editionTitleHint: string;
    preferRussian: string;
    advancedSection: string;
    results: string;
    timeoutSeconds: string;
    cacheMinutes: string;
    diagnostics: string;
    diagnosticsHint: string;
    checkSources: string;
    clearSearchCache: string;
    saveSettings: string;
    googleApiKeyLabel: string;
    localIndex: string;
    localIndexHint: string;
    inpxEnabled: string;
    inpxDesc: string;
    inpxPathLabel: string;
    inpxPathPlaceholder: string;
    inpxWebUrlLabel: string;
    inpxWebUrlPlaceholder: string;
    inpxReady: (works: number) => string;
    olIndexReady: (works: number) => string;
    inpxMissing: string;
  };
  command: {
    title: string;
    placeholder: string;
    quickActions: string;
    findOnline: string;
    findOnlineHint: string;
    addManual: string;
    addManualHint: string;
    openSettings: string;
    openSettingsHint: string;
    inLibrary: string;
  };
  notices: {
    bookAdded: string;
    changesSaved: string;
    reviewSaved: string;
    reviewRemoved: string;
    bookDeleted: string;
    enterQuery: string;
    settingsSaved: string;
    cacheCleared: string;
    statusChanged: (title: string, status: string) => string;
    ratingChanged: (title: string, rating: number) => string;
    ratingCleared: (title: string) => string;
    favoriteAdded: string;
    favoriteRemoved: string;
  };
}

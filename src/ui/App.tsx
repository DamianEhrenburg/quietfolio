import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookCopy,
  BookMarked,
  BookOpen,
  BookPlus,
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  CheckCircle2,
  CircleCheck,
  CircleX,
  Cloud,
  Command,
  Compass,
  House,
  Download,
  ExternalLink,
  Grid2X2,
  KeyRound,
  Layers3,
  LibraryBig,
  List,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Clock3,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Wifi,
  HardDrive,
  X
} from "lucide-react";
import { BrandIcon, brandIcon } from "../shared/brand";
import type {
  AppSettings,
  AppSettingsUpdate,
  Book,
  BookInput,
  DisplayTitlePreference,
  LibraryInfo,
  OnlineBookCandidate,
  OnlineBookEdition,
  OnlineBookPreview,
  OnlineEditionSelection,
  OnlineSearchMode,
  OnlineSearchResponse,
  ProviderDiagnostic,
  ReadingStatus
} from "../shared/types";
import { cleanBookDescription, decodeHtmlEntities, normalizeBookSubtitle } from "../shared/textCleanup";
import { resolveGenreCode } from "../shared/genreCodes";
import { pickDefaultEdition, normalizedEditionLanguage, editionCoverRemoteUrls } from "../shared/editionSelection";
import { isLocalCoverUrl } from "../shared/coverScheme";
import { shouldShowExactBadge, shouldOfferQuickAdd, hasCatalogCover } from "../shared/searchCodes";
import { editionPreferRussian } from "../shared/searchEditionLanguage";
import { APP_VERSION } from "../shared/appMeta";
import { isMissingAuthor } from "../shared/authorSentinel";
import {
  authorLabel,
  coverStatusLabel,
  errorMessage,
  genreLabel,
  genreEditorText,
  parseGenreEditorText,
  categoryEditorText,
  getMessages,
  I18nProvider,
  languageLabel,
  diagnosticLabel,
  previewWarningLabel,
  ratingLabel,
  searchResolutionStrip,
  sortBooks,
  useI18n
} from "../i18n";
import { LanguageWelcome } from "./LanguageWelcome";
import type { UiLocale } from "../shared/types";

const HOME_RECENT_BOOKS_LIMIT = 7;
const ONLINE_RESULTS_PAGE_SIZE = 10;
const ONLINE_SEARCH_DEBOUNCE_MS = 350;
const DISCOVER_SEARCH_HISTORY_KEY = "quietfolio.discoverSearchHistory";
const DISCOVER_SEARCH_HISTORY_LIMIT = 8;

interface PrefetchedOnlineSearch {
  query: string;
  mode: OnlineSearchMode;
  response: OnlineSearchResponse | null;
  error: string | null;
  ready: boolean;
}

interface DiscoverSearchHistoryItem {
  query: string;
  mode: OnlineSearchMode;
  savedAt: number;
}

function onlineSearchMinLength(searchMode: OnlineSearchMode, query: string): number {
  if (searchMode === "isbn") return 10;
  const compact = query.replace(/[\s-]/g, "");
  if (/^\d{10,13}$/.test(compact)) return 10;
  return 2;
}

function readDiscoverSearchHistory(): DiscoverSearchHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DISCOVER_SEARCH_HISTORY_KEY);
    const items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) return [];
    return items
      .filter((item): item is DiscoverSearchHistoryItem =>
        item
        && typeof item.query === "string"
        && ["auto", "author", "title", "isbn"].includes(item.mode)
        && typeof item.savedAt === "number"
      )
      .slice(0, DISCOVER_SEARCH_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeDiscoverSearchHistory(items: DiscoverSearchHistoryItem[]) {
  try {
    window.localStorage.setItem(DISCOVER_SEARCH_HISTORY_KEY, JSON.stringify(items));
  } catch {
    // Best-effort UI memory only.
  }
}

function rememberDiscoverSearch(
  history: DiscoverSearchHistoryItem[],
  query: string,
  mode: OnlineSearchMode
): DiscoverSearchHistoryItem[] {
  const trimmed = query.trim();
  if (!trimmed) return history;
  const key = `${mode}:${trimmed.toLocaleLowerCase()}`;
  const next = [
    { query: trimmed, mode, savedAt: Date.now() },
    ...history.filter((item) => `${item.mode}:${item.query.toLocaleLowerCase()}` !== key)
  ].slice(0, DISCOVER_SEARCH_HISTORY_LIMIT);
  writeDiscoverSearchHistory(next);
  return next;
}

function historyModeFromResponse(response: OnlineSearchResponse, fallback: OnlineSearchMode): OnlineSearchMode {
  const mode = response.resolution.resolvedMode;
  return mode === "author" || mode === "title" || mode === "isbn" ? mode : fallback;
}

function historyQueryFromResponse(response: OnlineSearchResponse): string {
  if (!response.results.length || response.resolution.confidence < 70 || response.resolution.source === "literal") return "";
  if (response.resolution.resolvedMode === "author") {
    return response.resolution.authorName || response.resolution.canonicalQuery || response.resolution.displayLabel;
  }
  if (response.resolution.resolvedMode === "isbn") return response.resolution.canonicalQuery;
  const best = response.results[0];
  return best.displayTitle || best.title || response.resolution.canonicalQuery;
}

type OnlineResultSort = "relevance" | "year_desc" | "year_asc" | "popularity" | "title";

const readingStatusOptions = [
  { value: "want" as const, Icon: Sparkles },
  { value: "reading" as const, Icon: BookMarked },
  { value: "read" as const, Icon: CircleCheck },
  { value: "paused" as const, Icon: Clock3 },
  { value: "abandoned" as const, Icon: CircleX }
];

const emptyBookInput: BookInput = {
  displayTitle: "",
  workTitle: "",
  originalTitle: "",
  editionTitle: "",
  subtitle: "",
  author: "",
  year: null,
  firstPublishedYear: null,
  category: "",
  genres: [],
  subjects: [],
  publisher: "",
  pageCount: null,
  language: "",
  status: "want",
  rating: null,
  readDate: null,
  favorite: false,
  review: "",
  reviewerName: "",
  coverUrl: "",
  coverSource: "none",
  coverStatus: "missing",
  isbn: "",
  description: "",
  source: "local",
  externalId: "",
  workId: "",
  editionId: "",
  sourceUrl: "",
  metadataQuality: null
};

const defaultSettings: AppSettings = {
  uiLocale: "en",
  uiLocaleChosen: false,
  openLibraryEnabled: true,
  googleBooksEnabled: true,
  fantlabEnabled: true,
  gutendexEnabled: true,
  hardcoverEnabled: false,
  googleBooksConfigured: false,
  hardcoverConfigured: false,
  preferRussian: false,
  searchLimit: 18,
  requestTimeoutMs: 15_000,
  cacheMinutes: 60,
  displayTitlePreference: "localized",
  autoSelectHighConfidence: true,
  inpxEnabled: false,
  inpxIndexPath: "",
  inpxWebUrl: "",
  inpxConfigured: false
};

type EditorState =
  | { mode: "create"; initial: BookInput }
  | { mode: "edit"; bookId: number; initial: BookInput };

type WorkspaceMode = "home" | "library" | "online";
type LibraryFilter = "all" | "favorites" | ReadingStatus;

const libraryFilterOptions: LibraryFilter[] = ["all", "favorites", "reading", "want", "read", "paused", "abandoned"];

function getApi() {
  if (!window.quietfolio) throw new Error("Desktop API unavailable");
  return window.quietfolio;
}

function settingsToUpdate(settings: AppSettings): AppSettingsUpdate {
  return {
    openLibraryEnabled: settings.openLibraryEnabled,
    googleBooksEnabled: settings.googleBooksEnabled,
    fantlabEnabled: settings.fantlabEnabled,
    gutendexEnabled: settings.gutendexEnabled,
    hardcoverEnabled: settings.hardcoverEnabled,
    preferRussian: settings.preferRussian,
    searchLimit: settings.searchLimit,
    requestTimeoutMs: settings.requestTimeoutMs,
    cacheMinutes: settings.cacheMinutes,
    displayTitlePreference: settings.displayTitlePreference,
    autoSelectHighConfidence: settings.autoSelectHighConfidence,
    inpxEnabled: settings.inpxEnabled,
    inpxIndexPath: settings.inpxIndexPath,
    inpxWebUrl: settings.inpxWebUrl
  };
}

function formatPublisher(value?: string) {
  if (!value) return "";
  return value
    .replace(/\[[^\]]*\]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/^,\s*/, "")
    .trim();
}

const coverPalettes = [
  ["#2a1f4e", "#6b5cae"],
  ["#1a3348", "#3d7ab8"],
  ["#1f3d32", "#3d9a72"],
  ["#3d2818", "#b87840"],
  ["#3a1830", "#9a4d78"],
  ["#182838", "#4d8ab8"]
] as const;

function coverPalette(seed: string) {
  let hash = 0;
  for (const char of seed) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return coverPalettes[Math.abs(hash) % coverPalettes.length];
}

function getInitials(title: string) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function uniqueDetailGenres(book: Book, m: ReturnType<typeof getMessages>) {
  const categoryDisplay = genreLabel(m, book.category).toLocaleLowerCase(m.locale);
  const seen = new Set<string>([categoryDisplay]);
  return book.genres.filter((genre) => {
    const label = genreLabel(m, genre).toLocaleLowerCase(m.locale);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  }).slice(0, 8);
}

function filterChipClass(active: LibraryFilter, filter: LibraryFilter) {
  const classes = ["filter-chip"];
  if (active === filter) classes.push("selected");
  if (filter === "favorites") classes.push("filter-favorites");
  if (filter !== "all" && filter !== "favorites") classes.push(`filter-${filter}`);
  return classes.join(" ");
}

function bookToInput(book: Book): BookInput {
  return {
    displayTitle: book.displayTitle,
    workTitle: book.workTitle || "",
    originalTitle: book.originalTitle || "",
    editionTitle: book.editionTitle || "",
    subtitle: book.subtitle || "",
    author: book.author,
    year: book.year,
    firstPublishedYear: book.firstPublishedYear,
    category: book.category,
    genres: book.genres,
    subjects: book.subjects,
    publisher: book.publisher || "",
    pageCount: book.pageCount,
    language: book.language || "",
    status: book.status,
    rating: book.rating,
    readDate: book.readDate,
    favorite: book.favorite,
    review: book.review || "",
    reviewerName: book.reviewerName || "",
    coverUrl: book.coverUrl || "",
    coverSource: book.coverSource || "none",
    coverStatus: book.coverStatus || "missing",
    isbn: book.isbn || "",
    description: book.description || "",
    source: book.source,
    externalId: book.externalId || "",
    workId: book.workId || "",
    editionId: book.editionId || "",
    sourceUrl: book.sourceUrl || "",
    metadataQuality: book.metadataQuality
  };
}

function CoverImage(props: {
  src?: string;
  fallbackSrcs?: string[];
  title: string;
  fit?: "contain" | "cover";
  status?: ReadingStatus;
  genre?: string;
}) {
  return <CoverImageInner key={`${props.src ?? ""}|${(props.fallbackSrcs || []).join(",")}|${props.title}`} {...props} />;
}

function initialCoverSrc(src?: string) {
  const trimmed = src?.trim();
  if (!trimmed) return undefined;
  if (isLocalCoverUrl(trimmed) || !/^https?:\/\//i.test(trimmed)) return trimmed;
  return undefined;
}

function CoverImageLoad({
  currentSrc,
  title,
  fit,
  genre,
  onFailed
}: {
  currentSrc?: string;
  title: string;
  fit: "contain" | "cover";
  genre?: string;
  onFailed: () => void;
}) {
  const { m } = useI18n();
  const [failedSrc, setFailedSrc] = useState<string | undefined>();
  const [displaySrc, setDisplaySrc] = useState(() => initialCoverSrc(currentSrc));
  const [imageLoading, setImageLoading] = useState(
    () => Boolean(initialCoverSrc(currentSrc)) || Boolean(currentSrc && /^https?:\/\//i.test(currentSrc))
  );

  useEffect(() => {
    if (!currentSrc || isLocalCoverUrl(currentSrc) || !/^https?:\/\//i.test(currentSrc)) return;
    let cancelled = false;
    void getApi()
      .warmCovers([currentSrc])
      .then((mapped) => {
        if (cancelled) return;
        const local = mapped[currentSrc];
        if (local) {
          setDisplaySrc(local);
          setImageLoading(true);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentSrc]);

  const palette = coverPalette(genre || title || "book");
  const activeSrc = displaySrc;
  if (!activeSrc || failedSrc === activeSrc) {
    return (
      <span
        className="cover-fallback"
        style={{ background: `linear-gradient(145deg, ${palette[0]}, ${palette[1]})` }}
      >
        <span className="cover-fallback-initials">{getInitials(title)}</span>
        <small className="cover-fallback-title">{title}</small>
      </span>
    );
  }

  return (
    <span className={`cover-image-shell cover-image-${fit}${imageLoading ? " is-loading" : ""}`}>
      {fit === "contain" && !imageLoading && (
        <img className="cover-image-backdrop" src={activeSrc} alt="" aria-hidden="true" />
      )}
      <img
        className="cover-image-main"
        src={activeSrc}
        alt={m.cover.alt(title)}
        loading="lazy"
        decoding="async"
        onLoad={() => setImageLoading(false)}
        onError={() => {
          setImageLoading(false);
          setFailedSrc(activeSrc);
          onFailed();
        }}
      />
    </span>
  );
}

function CoverImageInner({
  src,
  fallbackSrcs,
  title,
  fit = "contain",
  status,
  genre
}: {
  src?: string;
  fallbackSrcs?: string[];
  title: string;
  fit?: "contain" | "cover";
  status?: ReadingStatus;
  genre?: string;
}) {
  const { m } = useI18n();
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    return [src, ...(fallbackSrcs || [])]
      .filter((url): url is string => Boolean(url))
      .filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });
  }, [src, fallbackSrcs]);
  const [srcIndex, setSrcIndex] = useState(0);
  const currentSrc = candidates[srcIndex] ?? candidates[0];

  const content = (
    <CoverImageLoad
      key={currentSrc}
      currentSrc={currentSrc}
      title={title}
      fit={fit}
      genre={genre}
      onFailed={() => {
        if (srcIndex + 1 < candidates.length) setSrcIndex((index) => index + 1);
      }}
    />
  );

  if (!status) return content;

  return (
    <span className={`cover-with-status status-${status}`}>
      {content}
      <span className="cover-status-rail" title={m.status[status]} aria-hidden="true">
        <i />
      </span>
    </span>
  );
}

function BookGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="book-grid skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="book-card skeleton-card" key={index}>
          <div className="cover skeleton-block" />
          <div className="book-card-body">
            <span className="skeleton-line short" />
            <span className="skeleton-line" />
            <span className="skeleton-line medium" />
          </div>
        </div>
      ))}
    </div>
  );
}

function OnlineResultsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="work-results skeleton-results" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <article className="work-result-card skeleton-result" key={index}>
          <div className="cover work-cover skeleton-block" />
          <div className="work-result-copy">
            <span className="skeleton-line" />
            <span className="skeleton-line medium" />
            <span className="skeleton-line short" />
          </div>
          <div className="skeleton-block action-skeleton" />
        </article>
      ))}
    </div>
  );
}

function StatusSwitcher({
  value,
  onChange,
  compact = false,
  iconsOnly = false,
  saving = false,
  className
}: {
  value: ReadingStatus;
  onChange: (status: ReadingStatus) => void;
  compact?: boolean;
  iconsOnly?: boolean;
  saving?: boolean;
  className?: string;
}) {
  const { m } = useI18n();
  return (
    <div
      className={`status-switcher${compact ? " compact" : ""}${iconsOnly ? " icons-only" : ""}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={m.library.readingStatus}
    >
      {readingStatusOptions.map(({ value: status, Icon }) => {
        const label = m.status[status];
        return (
        <button
          key={status}
          type="button"
          className={`status-option status-${status}${value === status ? " selected" : ""}`}
          disabled={saving}
          title={label}
          aria-label={label}
          aria-pressed={value === status}
          onClick={() => {
            if (status !== value) onChange(status);
          }}
        >
          {saving && value === status ? <LoaderCircle className="spin-icon" size={compact ? 14 : 15} /> : <Icon size={compact ? 14 : 15} />}
          {!iconsOnly && <span>{label}</span>}
        </button>
      );
      })}
    </div>
  );
}

function RatingPicker({
  value,
  onChange,
  saving = false,
  compact = false,
  inline = false,
  readOnly = false,
  className
}: {
  value: number | null;
  onChange: (rating: number | null) => void;
  saving?: boolean;
  compact?: boolean;
  inline?: boolean;
  readOnly?: boolean;
  className?: string;
}) {
  const { m } = useI18n();
  const normalized =
    value !== null && Number.isFinite(value) ? Math.max(1, Math.min(5, Math.round(value))) : null;
  const mode = inline ? "inline" : compact ? "compact" : "panel";
  const iconSize = inline ? 11 : compact ? 15 : 18;
  const caption = normalized ? m.common.ratingOf(normalized) : m.common.noRating;

  return (
    <div
      className={`rating-picker rating-picker-${mode}${readOnly ? " readonly" : ""}${className ? ` ${className}` : ""}`}
      role={readOnly ? "img" : "group"}
      aria-label={readOnly ? caption : m.library.rating}
    >
      <div className="rating-stars">
        {[1, 2, 3, 4, 5].map((star) => {
          const filled = normalized !== null && star <= normalized;
          return (
            <button
              key={star}
              type="button"
              className={`rating-star${filled ? " filled" : ""}${normalized === star ? " active" : ""}`}
              disabled={saving || readOnly}
              tabIndex={readOnly ? -1 : undefined}
              title={readOnly ? undefined : normalized === star ? m.common.removeRating : m.common.ratingOutOf(star)}
              aria-label={m.common.ratingOutOf(star)}
              aria-pressed={readOnly ? undefined : normalized === star}
              onClick={() => onChange(normalized === star ? null : star)}
            >
              {saving && normalized === star ? (
                <LoaderCircle className="spin-icon" size={iconSize} />
              ) : (
                <Star size={iconSize} fill={filled ? "currentColor" : "none"} />
              )}
            </button>
          );
        })}
      </div>
      {mode === "panel" && <span className="rating-caption">{caption}</span>}
    </div>
  );
}

function DetailReviewSection({
  book,
  onSave
}: {
  book: Book;
  onSave: (book: Book, review: string) => Promise<void>;
}) {
  const { m } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(book.review || "");
  const [saving, setSaving] = useState(false);

  async function submitReview(review: string) {
    setSaving(true);
    try {
      await onSave(book, review);
      setEditing(false);
      setDraft(review);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="review-box">
      <div className="review-box-header">
        <h3>{m.library.personalReview}</h3>
        {!editing && (
          <button type="button" className="text-action" onClick={() => { setDraft(book.review || ""); setEditing(true); }}>
            {book.hasReview ? m.common.edit : m.common.write}
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            className="review-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            maxLength={20_000}
            placeholder={m.library.reviewPlaceholder}
            autoFocus
          />
          <div className="review-box-actions">
            <button type="button" className="primary-action" disabled={saving} onClick={() => void submitReview(draft)}>
              {saving ? <LoaderCircle className="spin-icon" size={16} /> : <Save size={16} />}
              {saving ? m.common.saving : m.common.save}
            </button>
            <button type="button" className="secondary-action" disabled={saving} onClick={() => { setEditing(false); setDraft(book.review || ""); }}>{m.common.cancel}</button>
            {book.hasReview && (
              <button type="button" className="ghost-danger" disabled={saving} onClick={() => void submitReview("")}>{m.common.clear}</button>
            )}
          </div>
        </>
      ) : book.hasReview ? (
        <>
          <p>{decodeHtmlEntities(book.review || "")}</p>
          {book.reviewerName && <span>{book.reviewerName}</span>}
        </>
      ) : (
        <p className="review-empty">{m.library.reviewEmpty}</p>
      )}
    </section>
  );
}

function ExpandableText({
  text,
  className,
  previewChars = 250
}: {
  text: string;
  className?: string;
  previewChars?: number;
}) {
  const { m } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const decoded = cleanBookDescription(text);
  const estimatedLines = Math.ceil(decoded.length / 46);
  const isLong =
    decoded.length > previewChars ||
    decoded.split("\n").length > 3 ||
    estimatedLines > 5;

  if (!decoded) return null;

  return (
    <div
      className={`expandable-text${isLong ? " is-clampable" : ""}${expanded ? " is-expanded" : ""}${className ? ` ${className}` : ""}`}
    >
      <p>{decoded}</p>
      {isLong && (
        <button type="button" className="text-action expandable-toggle" onClick={() => setExpanded((current) => !current)}>
          {expanded ? m.common.collapse : m.common.expand}
        </button>
      )}
    </div>
  );
}

function useModalBehavior(onClose: () => void, locked: boolean) {
  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, [locked, onClose]);
}

interface BookEditorDialogProps {
  state: EditorState;
  saving: boolean;
  onClose: () => void;
  onSave: (input: BookInput) => Promise<void>;
}

function BookEditorDialog({ state, saving, onClose, onSave }: BookEditorDialogProps) {
  const { m } = useI18n();
  const [form, setForm] = useState<BookInput>(state.initial);
  const [genresText, setGenresText] = useState(genreEditorText(m, state.initial.genres));
  const [categoryText, setCategoryText] = useState(categoryEditorText(m, state.initial.category));
  const [formError, setFormError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useModalBehavior(onClose, saving);

  function updateField<Key extends keyof BookInput>(key: Key, value: BookInput[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    if (!form.displayTitle.trim()) return setFormError(m.editor.titleRequired);
    if (!form.author.trim()) return setFormError(m.editor.authorRequired);
    const genres = parseGenreEditorText(genresText);
    const categoryCode = resolveGenreCode(categoryText.trim());
    try {
      await onSave({
        ...form,
        genres,
        category: categoryCode || categoryText.trim() || genres[0] || m.common.uncategorized,
        coverSource: form.coverUrl && form.coverSource === "none" ? "manual" : form.coverSource,
        coverStatus: form.coverUrl && form.coverStatus === "missing" ? "remote" : form.coverStatus
      });
    } catch (error) {
      setFormError(errorMessage(m, error));
    }
  }

  const hasEditionIdentity = Boolean(form.workTitle || form.originalTitle || form.editionTitle);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="book-dialog-title">
        <header className="dialog-header">
          <div>
            <span className="eyebrow">{m.editor.eyebrow}</span>
            <h2 id="book-dialog-title">{state.mode === "create" ? m.editor.createTitle : m.editor.editTitle}</h2>
          </div>
          <button className="icon-button" onClick={onClose} disabled={saving} aria-label={m.common.close}><X size={20} /></button>
        </header>

        <form onSubmit={handleSubmit} className="book-form">
          <div className="dialog-scroll book-form-scroll">
            <div className="form-cover-preview">
              <div className="cover editor-cover"><CoverImage src={form.coverUrl} title={form.displayTitle || m.editor.newBook} /></div>
              <div>
                <strong>{form.displayTitle || m.editor.newBook}</strong>
                <span>{authorLabel(m, form.author)}</span>
                {form.source !== "local" && (form.coverStatus === "missing" || form.coverStatus === "download-failed") && (
                  <small>{coverStatusLabel(m, form as Book)}</small>
                )}
              </div>
            </div>

            {hasEditionIdentity && <section className="title-identity-card">
              <div><span>{m.editor.inLibrary}</span><strong>{form.displayTitle || m.common.notSpecified}</strong></div>
              <div><span>{m.editor.work}</span><strong>{form.workTitle || form.originalTitle || m.common.notSpecified}</strong></div>
              <div><span>{m.editor.edition}</span><strong>{form.editionTitle || m.common.notSpecified}</strong></div>
            </section>}

            <div className="form-grid">
              <label className="field field-wide"><span>{m.editor.displayTitle}</span><input autoFocus value={form.displayTitle} onChange={(event) => updateField("displayTitle", event.target.value)} maxLength={500} /><small>{m.editor.displayTitleHint}</small></label>
              <label className="field field-wide"><span>{m.editor.author}</span><input value={form.author} onChange={(event) => updateField("author", event.target.value)} maxLength={500} /></label>
              <label className="field"><span>{m.editor.editionYear}</span><input type="number" min="0" max="9999" value={form.year ?? ""} onChange={(event) => updateField("year", event.target.value ? Number(event.target.value) : null)} /></label>
              <label className="field"><span>{m.editor.publisher}</span><input value={formatPublisher(form.publisher) || form.publisher || ""} onChange={(event) => updateField("publisher", event.target.value)} maxLength={500} /></label>
              <label className="field"><span>{m.editor.pageCount}</span><input type="number" min="1" max="100000" value={form.pageCount ?? ""} onChange={(event) => updateField("pageCount", event.target.value ? Number(event.target.value) : null)} /></label>
              <label className="field"><span>{m.editor.editionLanguage}</span><input value={form.language ? languageLabel(m, form.language) : ""} onChange={(event) => updateField("language", event.target.value)} maxLength={80} /></label>
              <label className="field"><span>{m.editor.category}</span><input value={categoryText} onChange={(event) => setCategoryText(event.target.value)} maxLength={200} /></label>
              <label className="field field-wide"><span>{m.editor.genres}</span><input value={genresText} onChange={(event) => setGenresText(event.target.value)} placeholder={m.editor.genresPlaceholder} /></label>
              <label className="field"><span>{m.editor.status}</span><select value={form.status} onChange={(event) => updateField("status", event.target.value as ReadingStatus)}>{Object.entries(m.status).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>{m.editor.rating}</span><select value={form.rating ?? ""} onChange={(event) => updateField("rating", event.target.value ? Number(event.target.value) : null)}><option value="">{m.common.noRating}</option>{[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{m.common.ratingOf(rating)}</option>)}</select></label>
              <label className="field"><span>{m.editor.readDate}</span><input type="text" inputMode="numeric" placeholder={m.editor.readDatePlaceholder} value={form.readDate || ""} onChange={(event) => updateField("readDate", event.target.value.trim() || null)} maxLength={10} /><small>{m.editor.readDateHint}</small></label>
              <label className="field"><span>{m.library.isbn}</span><input value={form.isbn || ""} onChange={(event) => updateField("isbn", event.target.value)} maxLength={40} /></label>

              <label className="field field-wide form-review">
                <span>{m.editor.personalReview}</span>
                <textarea value={form.review || ""} onChange={(event) => updateField("review", event.target.value)} rows={4} maxLength={20_000} placeholder={m.library.reviewPlaceholder} />
                <small>{m.editor.personalReviewHint}</small>
              </label>

              <div className="field field-wide form-advanced">
                <button
                  type="button"
                  className={`advanced-toggle ${advancedOpen ? "open" : ""}`}
                  onClick={() => setAdvancedOpen((current) => !current)}
                  aria-expanded={advancedOpen}
                >
                  <span>{m.editor.advanced}</span>
                  <ChevronDown size={18} />
                </button>
                {advancedOpen && <div className="advanced-panel">
                  <label className="field field-wide"><span>{m.editor.workTitle}</span><input value={form.workTitle || ""} onChange={(event) => updateField("workTitle", event.target.value)} maxLength={500} /></label>
                  <label className="field field-wide"><span>{m.editor.originalTitle}</span><input value={form.originalTitle || ""} onChange={(event) => updateField("originalTitle", event.target.value)} maxLength={500} /></label>
                  <label className="field field-wide"><span>{m.editor.editionTitle}</span><input value={form.editionTitle || ""} onChange={(event) => updateField("editionTitle", event.target.value)} maxLength={500} /></label>
                  <label className="field field-wide"><span>{m.editor.subtitle}</span><input value={form.subtitle || ""} onChange={(event) => updateField("subtitle", event.target.value)} maxLength={500} /></label>
                  <label className="field"><span>{m.editor.firstPublished}</span><input type="number" min="0" max="9999" value={form.firstPublishedYear ?? ""} onChange={(event) => updateField("firstPublishedYear", event.target.value ? Number(event.target.value) : null)} /></label>
                  <label className="field field-wide"><span>{m.editor.coverUrl}</span><input value={form.coverUrl || ""} onChange={(event) => updateField("coverUrl", event.target.value)} maxLength={2000} /></label>
                  <label className="field field-wide"><span>{m.editor.description}</span><textarea value={form.description || ""} onChange={(event) => updateField("description", event.target.value)} rows={5} maxLength={30_000} /></label>
                </div>}
              </div>
            </div>

            {formError && <p className="form-error"><AlertTriangle size={17} />{formError}</p>}
          </div>
          <footer className="dialog-footer">
            <button type="button" className="secondary-action" onClick={onClose} disabled={saving}>{m.common.cancel}</button>
            <button type="submit" className="primary-action" disabled={saving}>{saving ? <LoaderCircle className="spin-icon" size={18} /> : <Save size={18} />}{saving ? m.common.saving : m.common.save}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

interface EditionPickerDialogProps {
  preview: OnlineBookPreview;
  preparing: boolean;
  loadingMoreEditions: boolean;
  onLoadMoreEditions: () => Promise<void>;
  onEditionsPatch: (enriched: OnlineBookEdition[]) => void;
  defaultTitlePreference: DisplayTitlePreference;
  preferRussian: boolean;
  onClose: () => void;
  onConfirm: (selection: OnlineEditionSelection) => Promise<void>;
}

type EditionFilter = "all" | "ru" | "en" | "original" | "cover" | "isbn";

function normalizedLanguage(value?: string) {
  const normalized = value?.toLocaleLowerCase("ru");
  if (!normalized) return "";
  if (["ru", "rus", "russian"].includes(normalized)) return "ru";
  if (["en", "eng", "english"].includes(normalized)) return "en";
  if (["de", "deu", "ger", "german"].includes(normalized)) return "de";
  if (["fr", "fra", "fre", "french"].includes(normalized)) return "fr";
  if (["it", "ita", "italian"].includes(normalized)) return "it";
  if (["es", "spa", "spanish"].includes(normalized)) return "es";
  return normalized;
}

function editionCompactMeta(m: import("../i18n/types").Messages, edition: OnlineBookEdition) {
  const parts = [
    languageLabel(m, edition.language),
    edition.year ? String(edition.year) : "",
    formatPublisher(edition.publisher),
    edition.pageCount ? m.common.pagesShort(edition.pageCount) : "",
    edition.isbn13 || edition.isbn10 ? `ISBN ${edition.isbn13 || edition.isbn10}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function editionSelectionCovers(edition: OnlineBookEdition, workCoverUrl?: string, workCoverKey?: string) {
  const editionUrls = editionCoverRemoteUrls(edition);
  const primary = editionUrls[0];
  return {
    preferredCoverUrl: primary || workCoverUrl,
    preferredCoverKey: primary ? undefined : workCoverKey
  };
}

function editionHasCover(edition: OnlineBookEdition) {
  return edition.coverOptions.some((option) => option.verified) || Boolean(edition.coverUrl);
}

function editionCoverCandidates(edition: OnlineBookEdition) {
  return editionCoverRemoteUrls(edition);
}

function EditionPickerDialog({ preview, preparing, loadingMoreEditions, onLoadMoreEditions, onEditionsPatch, defaultTitlePreference, preferRussian, onClose, onConfirm }: EditionPickerDialogProps) {
  const { m, locale } = useI18n();
  const enrichingRef = useRef(new Set<string>());
  const russianCount = preview.editions.filter((item) => normalizedEditionLanguage(item.language) === "ru").length;
  const initialEdition = preview.primaryEdition || pickDefaultEdition(preview.editions, {
    preferRussian,
    uiLocale: locale,
    previewCoverUrl: preview.work.coverRemoteUrl || preview.work.coverUrl,
    previewCoverKey: preview.work.coverKey,
    originalLanguage: preview.work.originalLanguage,
    firstPublishedYear: preview.work.firstPublishedYear
  });
  const [selectedId, setSelectedId] = useState(initialEdition?.id || "");
  const [filter, setFilter] = useState<EditionFilter>(preferRussian && russianCount > 0 ? "ru" : "all");
  const [titlePreference, setTitlePreference] = useState<DisplayTitlePreference>(defaultTitlePreference);
  const localizedTitle = preview.work.displayTitle || preview.work.title;
  const [displayTitle, setDisplayTitle] = useState(
    defaultTitlePreference === "edition" ? initialEdition?.title || localizedTitle : localizedTitle
  );
  useModalBehavior(onClose, preparing);

  useEffect(() => {
    const bare = preview.editions.filter(
      (edition) =>
        edition.provider === "fantlab"
        && !editionHasCover(edition)
        && !enrichingRef.current.has(edition.id)
    );
    if (!bare.length) return;
    bare.forEach((edition) => enrichingRef.current.add(edition.id));
    void getApi()
      .enrichEditionCovers(bare)
      .then((enriched) => {
        onEditionsPatch(enriched);
        const urls = enriched
          .flatMap((edition) => editionCoverRemoteUrls(edition))
          .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
        if (urls.length) void getApi().warmCovers(urls);
      })
      .catch(() => {});
  }, [preview.editions, preview.work.id, onEditionsPatch]);

  const originalLanguage = normalizedLanguage(preview.work.originalLanguage);
  const filters = useMemo(() => {
    const items: Array<{ id: EditionFilter; label: string; count: number }> = [
      { id: "all", label: m.editionPicker.all, count: preview.editions.length },
      { id: "ru", label: m.editionPicker.russian, count: russianCount },
      { id: "en", label: m.editionPicker.english, count: preview.editions.filter((item) => normalizedLanguage(item.language) === "en").length },
      { id: "cover", label: m.editionPicker.withCover, count: preview.editions.filter(editionHasCover).length },
      { id: "isbn", label: m.editionPicker.withIsbn, count: preview.editions.filter((item) => Boolean(item.isbn13 || item.isbn10)).length }
    ];
    if (originalLanguage) {
      items.splice(3, 0, {
        id: "original",
        label: m.common.originalFilter(languageLabel(m, originalLanguage)),
        count: preview.editions.filter((item) => normalizedLanguage(item.language) === originalLanguage).length
      });
    }
    if (preferRussian && russianCount > 0) {
      const slim = items.filter((item) => item.id === "all" || item.id === "ru" || item.id === "cover" || item.id === "isbn");
      const ru = slim.find((item) => item.id === "ru");
      const rest = slim.filter((item) => item.id !== "ru");
      return ru ? [ru, ...rest] : slim;
    }
    return items;
  }, [m, originalLanguage, preferRussian, preview.editions, russianCount]);

  const filteredEditions = useMemo(() => preview.editions.filter((edition) => {
    if (filter === "all") return true;
    if (filter === "ru") return normalizedLanguage(edition.language) === "ru";
    if (filter === "en") return normalizedLanguage(edition.language) === "en";
    if (filter === "original") return Boolean(originalLanguage) && normalizedLanguage(edition.language) === originalLanguage;
    if (filter === "cover") return editionHasCover(edition);
    return Boolean(edition.isbn13 || edition.isbn10);
  }), [filter, originalLanguage, preview.editions]);

  const selected = filteredEditions.find((edition) => edition.id === selectedId) || filteredEditions[0] || null;

  function chooseTitlePreference(preference: DisplayTitlePreference) {
    setTitlePreference(preference);
    setDisplayTitle(preference === "edition" ? selected?.title || localizedTitle : localizedTitle);
  }

  function chooseEdition(edition: OnlineBookEdition) {
    setSelectedId(edition.id);
    if (titlePreference === "edition") setDisplayTitle(edition.title);
  }

  function chooseFilter(nextFilter: EditionFilter) {
    setFilter(nextFilter);
    const nextEditions = preview.editions.filter((edition) => {
      if (nextFilter === "all") return true;
      if (nextFilter === "ru") return normalizedLanguage(edition.language) === "ru";
      if (nextFilter === "en") return normalizedLanguage(edition.language) === "en";
      if (nextFilter === "original") return Boolean(originalLanguage) && normalizedLanguage(edition.language) === originalLanguage;
      if (nextFilter === "cover") return editionHasCover(edition);
      return Boolean(edition.isbn13 || edition.isbn10);
    });
    const nextSelected = nextEditions.find((edition) => edition.id === selectedId) || nextEditions[0];
    if (nextSelected) {
      setSelectedId(nextSelected.id);
      if (titlePreference === "edition") setDisplayTitle(nextSelected.title);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !preparing) onClose();
    }}>
      <section className="dialog-card edition-dialog" role="dialog" aria-modal="true" aria-labelledby="edition-dialog-title">
        <header className="dialog-header">
          <div><span className="eyebrow">{m.editionPicker.eyebrow}</span><h2 id="edition-dialog-title">{localizedTitle}</h2><p>{authorLabel(m, preview.work.author)}{(preview.work.listedEditionCount ?? 0) > preview.editions.length ? ` · ${m.editionPicker.shownOfCatalog(preview.editions.length, preview.work.listedEditionCount!)}` : ""}</p></div>
          <button className="icon-button" onClick={onClose} disabled={preparing} aria-label={m.common.close}><X size={20} /></button>
        </header>

        <div className="dialog-scroll edition-dialog-scroll">
          <div className="edition-filter-bar" role="tablist" aria-label={m.editionPicker.filter}>
            {filters.map((item) => <button type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "active" : ""} disabled={item.count === 0} onClick={() => chooseFilter(item.id)} key={item.id}>{item.label}<span>{item.count}</span></button>)}
          </div>

          <div className="edition-list compact">
            {filteredEditions.length === 0 ? (
              <div className="empty-state compact"><BookCopy size={28} /><h3>{m.editionPicker.noMatches}</h3><p>{m.editionPicker.noMatchesHint}</p></div>
            ) : filteredEditions.map((edition) => {
              const coverCandidates = editionCoverCandidates(edition);
              return (
              <button
                type="button"
                className={selected?.id === edition.id ? "edition-option selected compact" : "edition-option compact"}
                onClick={() => chooseEdition(edition)}
                key={edition.id}
              >
                <div className="cover edition-cover"><CoverImage src={coverCandidates[0]} fallbackSrcs={coverCandidates.slice(1)} title={edition.title} fit="cover" genre={preview.work.genres[0]} /></div>
                <div className="edition-copy">
                  <div className="edition-title-line"><strong>{edition.title}</strong></div>
                  <div className="metadata-line compact">{editionCompactMeta(m, edition)}</div>
                </div>
                <span className="edition-radio" aria-hidden="true" />
              </button>
            );
            })}
          </div>

          {preview.hasMoreEditions && (
            <div className="edition-load-more">
              <button
                type="button"
                className="secondary-action"
                disabled={preparing || loadingMoreEditions}
                onClick={() => void onLoadMoreEditions()}
              >
                {loadingMoreEditions ? <LoaderCircle className="spin-icon" size={17} /> : null}
                {loadingMoreEditions ? m.online.loading : m.editionPicker.loadMore}
              </button>
            </div>
          )}

          {preview.warnings.map((warning) => <p className="preview-warning" key={warning}><AlertTriangle size={16} />{previewWarningLabel(m, warning)}</p>)}

          {selected && <section className="save-title-panel slim">
            <label className="field field-wide"><span>{m.editionPicker.libraryTitle}</span><input value={displayTitle} onChange={(event) => setDisplayTitle(event.target.value)} maxLength={500} /></label>
            <div className="title-choice-inline">
              <button type="button" className={titlePreference === "localized" ? "selected" : ""} onClick={() => chooseTitlePreference("localized")}>{m.editionPicker.workButton}</button>
              <button type="button" className={titlePreference === "edition" ? "selected" : ""} onClick={() => chooseTitlePreference("edition")}>{m.editionPicker.editionButton}</button>
            </div>
          </section>}
        </div>

        <footer className="dialog-footer">
          <button className="secondary-action" onClick={onClose} disabled={preparing}>{m.common.cancel}</button>
          <button className="primary-action" disabled={!selected || !displayTitle.trim() || preparing} onClick={() => {
            if (!selected) return;
            const covers = editionSelectionCovers(selected, preview.work.coverRemoteUrl, preview.work.coverKey);
            void onConfirm({
              work: preview.work,
              edition: selected,
              displayTitle: displayTitle.trim(),
              titlePreference,
              preferredCoverUrl: covers.preferredCoverUrl,
              preferredCoverKey: covers.preferredCoverKey
            });
          }}>
            {preparing ? <LoaderCircle className="spin-icon" size={18} /> : <BookPlus size={18} />}
            {preparing ? m.editionPicker.checkingCover : m.editionPicker.verifyAndAdd}
          </button>
        </footer>
      </section>
    </div>
  );
}


interface SettingsDialogProps {
  settings: AppSettings;
  mode: "application" | "catalogs";
  saving: boolean;
  diagnostics: ProviderDiagnostic[];
  diagnosing: boolean;
  onClose: () => void;
  onSave: (update: AppSettingsUpdate) => Promise<void>;
  onDiagnose: () => Promise<void>;
  onClearCache: () => Promise<void>;
}

function SettingsDialog({ settings, mode, saving, diagnostics, diagnosing, onClose, onSave, onDiagnose, onClearCache }: SettingsDialogProps) {
  const { m } = useI18n();
  const [form, setForm] = useState(settings);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState("");
  const [inpxWorks, setInpxWorks] = useState<number | null>(null);
  const [olWorks, setOlWorks] = useState<number | null>(null);
  const [hardcoverToken, setHardcoverToken] = useState("");
  const [clearHardcoverToken, setClearHardcoverToken] = useState(false);
  useModalBehavior(onClose, saving);

  useEffect(() => {
    let cancelled = false;
    if (!form.inpxEnabled || !form.inpxIndexPath.trim()) return;
    void getApi().getInpxIndexInfo()
      .then((info) => {
        if (!cancelled) setInpxWorks(info.ready ? info.works : null);
      })
      .catch(() => {
        if (!cancelled) setInpxWorks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [form.inpxEnabled, form.inpxIndexPath]);

  useEffect(() => {
    let cancelled = false;
    void getApi().getOlIndexInfo()
      .then((info) => {
        if (!cancelled) setOlWorks(info.ready ? info.works : null);
      })
      .catch(() => {
        if (!cancelled) setOlWorks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [form.openLibraryEnabled]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await onSave({
        uiLocale: form.uiLocale,
        openLibraryEnabled: form.openLibraryEnabled,
        googleBooksEnabled: form.googleBooksEnabled,
        fantlabEnabled: form.fantlabEnabled,
        gutendexEnabled: form.gutendexEnabled,
        hardcoverEnabled: form.hardcoverEnabled,
        preferRussian: form.preferRussian,
        searchLimit: form.searchLimit,
        requestTimeoutMs: form.requestTimeoutMs,
        cacheMinutes: form.cacheMinutes,
        displayTitlePreference: form.displayTitlePreference,
        autoSelectHighConfidence: form.autoSelectHighConfidence,
        inpxEnabled: form.inpxEnabled,
        inpxIndexPath: form.inpxIndexPath,
        inpxWebUrl: form.inpxWebUrl,
        googleBooksApiKey: apiKey || undefined,
        clearGoogleBooksApiKey: clearKey,
        hardcoverApiToken: hardcoverToken || undefined,
        clearHardcoverApiToken: clearHardcoverToken
      });
    } catch (saveError) {
      setError(errorMessage(m, saveError));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="dialog-card settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <header className="dialog-header"><div><span className="eyebrow">{m.brand.version(APP_VERSION)}</span><h2 id="settings-dialog-title">{mode === "catalogs" ? m.nav.catalogsAndNetwork : m.settings.title}</h2></div><button className="icon-button" onClick={onClose} disabled={saving} aria-label={m.common.close}><X size={20} /></button></header>
        <form className="settings-form" onSubmit={submit}>
          <div className="dialog-scroll settings-form-scroll">
            {mode === "application" && <section className="settings-section">
              <div className="settings-section-heading"><div><h3>{m.settings.application}</h3><p>{m.settings.applicationHint}</p></div><Settings size={22} /></div>
              <div className="settings-language-grid">
                <button type="button" className={form.uiLocale === "ru" ? "selected" : ""} onClick={() => setForm((current) => ({ ...current, uiLocale: "ru" }))}><strong>{m.language.russian}</strong><span>{m.language.russianHint}</span></button>
                <button type="button" className={form.uiLocale === "en" ? "selected" : ""} onClick={() => setForm((current) => ({ ...current, uiLocale: "en" }))}><strong>{m.language.english}</strong><span>{m.language.englishHint}</span></button>
              </div>
              <div className="settings-choice-grid">
                <button type="button" className={form.displayTitlePreference === "localized" ? "selected" : ""} onClick={() => setForm((current) => ({ ...current, displayTitlePreference: "localized" }))}><strong>{m.settings.localizedTitle}</strong><span>{m.settings.localizedTitleHint}</span></button>
                <button type="button" className={form.displayTitlePreference === "edition" ? "selected" : ""} onClick={() => setForm((current) => ({ ...current, displayTitlePreference: "edition" }))}><strong>{m.settings.editionTitle}</strong><span>{m.settings.editionTitleHint}</span></button>
              </div>
              <label className="compact-check"><input type="checkbox" checked={form.autoSelectHighConfidence} onChange={(event) => setForm((current) => ({ ...current, autoSelectHighConfidence: event.target.checked }))} />{m.settings.autoSelectHighConfidence}</label>
            </section>}

            {mode === "catalogs" && <section className="settings-section">
              <div className="settings-section-heading"><div><h3>{m.settings.onlineSources}</h3><p>{m.settings.onlineSourcesHint}</p></div><Wifi size={22} /></div>
              <label className="provider-toggle featured"><input type="checkbox" checked={form.fantlabEnabled} onChange={(event) => setForm((current) => ({ ...current, fantlabEnabled: event.target.checked }))} /><div><strong>FantLab</strong><span>{m.settings.fantlabDesc}</span></div><em>{m.settings.free}</em></label>
              <label className="provider-toggle featured"><input type="checkbox" checked={form.googleBooksEnabled} onChange={(event) => setForm((current) => ({ ...current, googleBooksEnabled: event.target.checked }))} /><div><strong>Google Books</strong><span>{m.settings.googleBooksDesc}</span></div><em>{settings.googleBooksConfigured && !clearKey ? m.settings.keySaved : m.settings.keyOptional}</em></label>
              <label className="field field-wide"><span><KeyRound size={15} /> {m.settings.googleApiKeyLabel}</span><input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false); if (event.target.value.trim()) setForm((current) => ({ ...current, googleBooksEnabled: true })); }} placeholder={settings.googleBooksConfigured ? m.settings.apiKeyPlaceholderKeep : m.settings.apiKeyPlaceholderPaste} autoComplete="off" /></label>
              {settings.googleBooksConfigured && <label className="compact-check"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />{m.settings.clearGoogleKey}</label>}
              <p className="settings-hint">{m.settings.sourcesHint}</p>
              <label className="provider-toggle"><input type="checkbox" checked={form.openLibraryEnabled} onChange={(event) => setForm((current) => ({ ...current, openLibraryEnabled: event.target.checked }))} /><div><strong>Open Library</strong><span>{m.settings.openLibraryDesc}</span></div><em>{m.settings.free}</em></label>
              <label className="provider-toggle"><input type="checkbox" checked={form.gutendexEnabled} onChange={(event) => setForm((current) => ({ ...current, gutendexEnabled: event.target.checked }))} /><div><strong>Gutenberg</strong><span>{m.settings.gutendexDesc}</span></div><em>{m.settings.free}</em></label>
              <label className="provider-toggle"><input type="checkbox" checked={form.hardcoverEnabled} onChange={(event) => setForm((current) => ({ ...current, hardcoverEnabled: event.target.checked }))} /><div><strong>Hardcover</strong><span>{m.settings.hardcoverDesc}</span></div><em>{settings.hardcoverConfigured && !clearHardcoverToken ? m.settings.keySaved : m.settings.keyOptional}</em></label>
              <label className="field field-wide"><span><KeyRound size={15} /> {m.settings.hardcoverTokenLabel}</span><input type="password" value={hardcoverToken} onChange={(event) => { setHardcoverToken(event.target.value); setClearHardcoverToken(false); if (event.target.value.trim()) setForm((current) => ({ ...current, hardcoverEnabled: true })); }} placeholder={settings.hardcoverConfigured ? m.settings.apiKeyPlaceholderKeep : m.settings.hardcoverTokenPlaceholder} autoComplete="off" /></label>
              {settings.hardcoverConfigured && <label className="compact-check"><input type="checkbox" checked={clearHardcoverToken} onChange={(event) => setClearHardcoverToken(event.target.checked)} />{m.settings.clearHardcoverToken}</label>}
            </section>}

            {mode === "catalogs" && <section className="settings-section">
              <div className="settings-section-heading"><div><h3>{m.settings.localIndex}</h3><p>{m.settings.localIndexHint}</p></div><HardDrive size={22} /></div>
              {olWorks != null && olWorks > 0 && <p className="settings-hint">{m.settings.olIndexReady(olWorks)}</p>}
              <label className="provider-toggle"><input type="checkbox" checked={form.inpxEnabled} onChange={(event) => setForm((current) => ({ ...current, inpxEnabled: event.target.checked }))} /><div><strong>INPX / INP</strong><span>{m.settings.inpxDesc}</span></div><em>{form.inpxEnabled && (form.inpxIndexPath.trim() || form.inpxWebUrl.trim()) ? (settings.inpxConfigured ? m.settings.free : m.settings.inpxMissing) : m.settings.free}</em></label>
              <label className="field field-wide"><span>{m.settings.inpxPathLabel}</span><input value={form.inpxIndexPath} onChange={(event) => { setInpxWorks(null); setForm((current) => ({ ...current, inpxIndexPath: event.target.value, inpxEnabled: event.target.value.trim() ? true : current.inpxEnabled })); }} placeholder={m.settings.inpxPathPlaceholder} spellCheck={false} /></label>
              <label className="field field-wide"><span>{m.settings.inpxWebUrlLabel}</span><input value={form.inpxWebUrl} onChange={(event) => setForm((current) => ({ ...current, inpxWebUrl: event.target.value, inpxEnabled: event.target.value.trim() ? true : current.inpxEnabled }))} placeholder={m.settings.inpxWebUrlPlaceholder} spellCheck={false} /></label>
              {inpxWorks != null && inpxWorks > 0 && <p className="settings-hint">{m.settings.inpxReady(inpxWorks)}</p>}
            </section>}

            {mode === "catalogs" && <details className="settings-advanced">
              <summary>{m.settings.advancedSection}</summary>
              <section className="settings-section settings-grid">
                <label className="compact-check"><input type="checkbox" checked={form.preferRussian} onChange={(event) => setForm((current) => ({ ...current, preferRussian: event.target.checked }))} />{m.settings.preferRussian}</label>
                <label className="field"><span>{m.settings.results}</span><input type="number" min="5" max="40" value={form.searchLimit} onChange={(event) => setForm((current) => ({ ...current, searchLimit: Number(event.target.value) }))} /></label>
                <label className="field"><span>{m.settings.timeoutSeconds}</span><input type="number" min="5" max="60" value={Math.round(form.requestTimeoutMs / 1000)} onChange={(event) => setForm((current) => ({ ...current, requestTimeoutMs: Number(event.target.value) * 1000 }))} /></label>
                <label className="field"><span>{m.settings.cacheMinutes}</span><input type="number" min="5" max="1440" value={form.cacheMinutes} onChange={(event) => setForm((current) => ({ ...current, cacheMinutes: Number(event.target.value) }))} /></label>
              </section>
              <section className="settings-section">
                <div className="settings-section-heading"><div><h3>{m.settings.diagnostics}</h3><p>{m.settings.diagnosticsHint}</p></div></div>
                <div className="diagnostic-actions"><button type="button" className="secondary-action" onClick={() => void onDiagnose()} disabled={diagnosing}>{diagnosing ? <LoaderCircle className="spin-icon" size={17} /> : <Wifi size={17} />}{m.settings.checkSources}</button><button type="button" className="secondary-action" onClick={() => void onClearCache()}><RotateCcw size={17} />{m.settings.clearSearchCache}</button></div>
                {diagnostics.length > 0 && <div className="diagnostic-list">{diagnostics.map((item) => <div className={item.ok ? "diagnostic-card ok" : "diagnostic-card"} key={`${item.provider}-${item.service}`}>{item.ok ? <CircleCheck size={18} /> : <CircleX size={18} />}<div><strong>{diagnosticLabel(m, item)}</strong><span>{item.message}{item.durationMs ? m.common.diagnosticDuration(item.durationMs) : ""}</span></div></div>)}</div>}
              </section>
            </details>}
            {error && <p className="form-error"><AlertTriangle size={17} />{error}</p>}
          </div>
          <footer className="dialog-footer"><button type="button" className="secondary-action" onClick={onClose}>{m.common.cancel}</button><button className="primary-action" disabled={saving}><Save size={18} />{saving ? m.common.saving : m.settings.saveSettings}</button></footer>
        </form>
      </section>
    </div>
  );
}


interface CommandPaletteProps {
  query: string;
  books: Book[];
  onQueryChange: (value: string) => void;
  onClose: () => void;
  onOpenBook: (book: Book) => void;
  onNavigate: (mode: WorkspaceMode) => void;
  onCreate: () => void;
  onSettings: () => void;
}

function CommandPalette({ query, books, onQueryChange, onClose, onOpenBook, onNavigate, onCreate, onSettings }: CommandPaletteProps) {
  const { m, locale } = useI18n();
  useModalBehavior(onClose, false);
  const normalized = query.trim().toLocaleLowerCase(locale === "en" ? "en" : "ru");
  const matchingBooks = books
    .filter((book) => !normalized || [book.displayTitle, book.author, book.workTitle, book.isbn]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase(locale === "en" ? "en" : "ru").includes(normalized)))
    .slice(0, 6);

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label={m.command.title}>
        <label className="command-input"><Search size={20} /><input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={m.command.placeholder} /><kbd>{m.common.shortcutEsc}</kbd></label>
        <div className="command-scroll">
          <div className="command-group"><span>{m.command.quickActions}</span>
            <button onClick={() => { onNavigate("online"); onClose(); }}><Compass size={18} /><div><strong>{m.command.findOnline}</strong><small>{m.command.findOnlineHint}</small></div></button>
            <button onClick={() => { onCreate(); onClose(); }}><BookPlus size={18} /><div><strong>{m.command.addManual}</strong><small>{m.command.addManualHint}</small></div></button>
            <button onClick={() => { onSettings(); onClose(); }}><Settings size={18} /><div><strong>{m.command.openSettings}</strong><small>{m.command.openSettingsHint}</small></div></button>
          </div>
          {matchingBooks.length > 0 && <div className="command-group"><span>{m.command.inLibrary}</span>{matchingBooks.map((book) => <button key={book.id} onClick={() => { onOpenBook(book); onClose(); }}><div className="command-cover"><CoverImage src={book.coverUrl} title={book.displayTitle} /></div><div><strong>{book.displayTitle}</strong><small>{authorLabel(m, book.author)}</small></div><ArrowRight size={17} /></button>)}</div>}
        </div>
      </section>
    </div>
  );
}


export default function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loadedSettings = await getApi().getSettings();
        if (!cancelled) {
          setSettings(loadedSettings);
          setSettingsLoaded(true);
        }
      } catch {
        if (!cancelled) setSettingsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleChooseLanguage(locale: UiLocale) {
    const saved = await getApi().updateSettings({
      ...settingsToUpdate(settings),
      uiLocale: locale,
      uiLocaleChosen: true
    });
    setSettings(saved);
  }

  if (!settingsLoaded) return <div className="app-boot" aria-hidden="true" />;
  if (!settings.uiLocaleChosen) return <LanguageWelcome onChoose={handleChooseLanguage} />;

  return (
    <I18nProvider locale={settings.uiLocale}>
      <AppShell settings={settings} onSettingsChange={setSettings} />
    </I18nProvider>
  );
}

function AppShell({
  settings,
  onSettingsChange
}: {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}) {
  const { m, locale } = useI18n();
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBookId, setActiveBookId] = useState<number | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("home");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [libraryFocus, setLibraryFocus] = useState(false);
  const navCollapsedBeforeFocus = useRef(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [onlineQuery, setOnlineQuery] = useState("");
  const [onlineSearchMode, setOnlineSearchMode] = useState<OnlineSearchMode>("auto");
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [librarySort, setLibrarySort] = useState<"title" | "recent">("title");
  const [loading, setLoading] = useState(true);
  const [libraryLoadError, setLibraryLoadError] = useState("");
  const [libraryInfo, setLibraryInfo] = useState<LibraryInfo | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [statusSavingId, setStatusSavingId] = useState<number | null>(null);
  const [ratingSavingId, setRatingSavingId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");

  const [onlineState, setOnlineState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [onlineResponse, setOnlineResponse] = useState<OnlineSearchResponse | null>(null);
  const [onlineError, setOnlineError] = useState("");
  const [onlineSearchHistory, setOnlineSearchHistory] = useState<DiscoverSearchHistoryItem[]>(() => readDiscoverSearchHistory());
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [editionPreview, setEditionPreview] = useState<OnlineBookPreview | null>(null);
  const [loadingMoreEditions, setLoadingMoreEditions] = useState(false);
  const [preparingEdition, setPreparingEdition] = useState(false);
  const [quickAddingId, setQuickAddingId] = useState<string | null>(null);
  const [onlineVisibleCount, setOnlineVisibleCount] = useState(ONLINE_RESULTS_PAGE_SIZE);
  const [onlineResultSort, setOnlineResultSort] = useState<OnlineResultSort>("relevance");
  const onlineSearchGenerationRef = useRef(0);
  const onlineSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchGenerationRef = useRef(0);
  const prefetchRef = useRef<PrefetchedOnlineSearch | null>(null);
  const prefetchPromiseRef = useRef<Promise<void> | null>(null);
  const quickAddingIdRef = useRef<string | null>(null);
  const previewLoadingIdRef = useRef<string | null>(null);
  const deferredOnlineResponseRef = useRef<OnlineSearchResponse | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDialogMode, setSettingsDialogMode] = useState<"application" | "catalogs">("application");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [diagnosing, setDiagnosing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let loadedSettings: AppSettings | null = null;
      try {
        const api = getApi();
        const [loadedBooks, info, settingsFromApi] = await Promise.all([
          api.listBooks(), api.getLibraryInfo(), api.getSettings()
        ]);
        loadedSettings = settingsFromApi;
        if (cancelled) return;
        const sorted = sortBooks(loadedBooks, loadedSettings.uiLocale);
        setBooks(sorted);
        setLibraryInfo(info);
        onSettingsChange(loadedSettings);
        setActiveBookId(sorted[0]?.id ?? null);
        void api.warmCovers(
          sorted
            .map((book) => book.coverUrl)
            .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)))
        );
      } catch (error) {
        if (!cancelled) setLibraryLoadError(errorMessage(getMessages(loadedSettings?.uiLocale ?? "en"), error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [onSettingsChange]);

  const sortedBooks = useMemo(() => sortBooks(books, locale), [books, locale]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en") === "k") {
        event.preventDefault();
        setCommandOpen((current) => !current);
        return;
      }
      if (
        event.key === "Escape" &&
        libraryFocus &&
        !commandOpen &&
        !settingsOpen &&
        !editor &&
        !editionPreview
      ) {
        event.preventDefault();
        setLibraryFocus(false);
        setNavCollapsed(navCollapsedBeforeFocus.current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandOpen, editionPreview, editor, libraryFocus, settingsOpen]);

  function exitLibraryFocusIfNeeded(next: WorkspaceMode) {
    if (mode === "library" && next !== "library" && libraryFocus) {
      setLibraryFocus(false);
      setNavCollapsed(navCollapsedBeforeFocus.current);
    }
  }

  function setWorkspaceMode(next: WorkspaceMode) {
    exitLibraryFocusIfNeeded(next);
    if (next === "library") {
      setLibrarySort("title");
      setLibraryFilter("all");
    }
    setMode(next);
  }

  function openLibraryRecent() {
    exitLibraryFocusIfNeeded("library");
    setMode("library");
    setLibrarySort("recent");
    setLibraryFilter("all");
    setLibraryQuery("");
  }

  function openLibraryFavorites() {
    exitLibraryFocusIfNeeded("library");
    setMode("library");
    setLibrarySort("title");
    setLibraryFilter("favorites");
    setLibraryQuery("");
  }

  function toggleLibraryFocus() {
    setLibraryFocus((active) => {
      if (active) {
        setNavCollapsed(navCollapsedBeforeFocus.current);
        return false;
      }
      navCollapsedBeforeFocus.current = navCollapsed;
      setNavCollapsed(true);
      return true;
    });
  }

  const activeBook = books.find((book) => book.id === activeBookId) || null;
  const activeBookDescription = activeBook?.description ? cleanBookDescription(activeBook.description) : "";
  const activeBookExtraGenres = useMemo(
    () => (activeBook ? uniqueDetailGenres(activeBook, m) : []),
    [activeBook, m]
  );

  const libraryDisplayBooks = useMemo(() => {
    if (librarySort === "recent") {
      return [...books].sort((left, right) => right.id - left.id);
    }
    return sortedBooks;
  }, [books, librarySort, sortedBooks]);

  function libraryFilterLabel(filter: LibraryFilter) {
    if (filter === "all") return m.library.all;
    if (filter === "favorites") return m.nav.favorites;
    return m.status[filter];
  }

  const filteredBooks = useMemo(() => {
    const normalized = libraryQuery.trim().toLocaleLowerCase(locale === "en" ? "en" : "ru");
    return libraryDisplayBooks.filter((book) => {
      if (libraryFilter === "favorites" && !book.favorite) return false;
      if (libraryFilter !== "all" && libraryFilter !== "favorites" && book.status !== libraryFilter) return false;
      if (!normalized) return true;
      return [book.displayTitle, book.workTitle, book.originalTitle, book.editionTitle, book.subtitle, book.author, book.category, book.publisher, book.isbn, ...book.genres]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase(locale === "en" ? "en" : "ru").includes(normalized));
    });
  }, [libraryDisplayBooks, libraryQuery, libraryFilter, locale]);

  const stats = useMemo(() => ({
    total: books.length,
    read: books.filter((book) => book.status === "read").length,
    reading: books.filter((book) => book.status === "reading").length,
    want: books.filter((book) => book.status === "want").length,
    paused: books.filter((book) => book.status === "paused").length,
    abandoned: books.filter((book) => book.status === "abandoned").length,
    favorites: books.filter((book) => book.favorite).length,
    reviewed: books.filter((book) => book.hasReview).length
  }), [books]);

  const filteredOnlineResults = useMemo(() => onlineResponse?.results ?? [], [onlineResponse]);

  const sortedOnlineResults = useMemo(() => {
    if (!filteredOnlineResults.length) return [];
    const items = [...filteredOnlineResults];
    const collator = locale === "en" ? "en" : "ru";
    switch (onlineResultSort) {
      case "relevance":
        return items;
      case "year_desc":
        return items.sort((left, right) => (right.firstPublishedYear || 0) - (left.firstPublishedYear || 0));
      case "year_asc":
        return items.sort((left, right) => (left.firstPublishedYear || 0) - (right.firstPublishedYear || 0));
      case "popularity":
        return items.sort((left, right) =>
          (right.popularity || 0) - (left.popularity || 0)
          || (right.listedEditionCount || 0) - (left.listedEditionCount || 0)
          || (right.firstPublishedYear || 0) - (left.firstPublishedYear || 0)
        );
      case "title":
        return items.sort((left, right) =>
          (left.displayTitle || left.title).localeCompare(right.displayTitle || right.title, collator, { sensitivity: "base" })
        );
      default:
        return items;
    }
  }, [filteredOnlineResults, onlineResultSort, locale]);

  const visibleOnlineResults = sortedOnlineResults.slice(0, onlineVisibleCount);
  const onlineResultsFrom = sortedOnlineResults.length ? 1 : 0;
  const onlineResultsTo = Math.min(sortedOnlineResults.length, onlineVisibleCount);
  const hasMoreOnlineResults = visibleOnlineResults.length < sortedOnlineResults.length;
  const showOnlineIdle = onlineState === "idle";
  const showOnlineSkeleton = onlineState === "loading";
  const showOnlineResults = onlineState === "success";

  const currentReading = books.find((book) => book.status === "reading") || books[0] || null;
  const recentBooks = [...books].sort((left, right) => right.id - left.id).slice(0, HOME_RECENT_BOOKS_LIMIT);
  const noBooksYet = !loading && books.length === 0 && !libraryLoadError;

  function openCreateDialog(initial: BookInput = emptyBookInput) {
    const sanitized = {
      ...initial,
      author: isMissingAuthor(initial.author) ? "" : initial.author,
      genres: [...initial.genres],
      subjects: [...initial.subjects]
    };
    setEditor({ mode: "create", initial: sanitized });
  }

  function openEditDialog(book: Book) {
    setEditor({ mode: "edit", bookId: book.id, initial: bookToInput(book) });
  }

  function enterOnlineMode(seed = "") {
    exitLibraryFocusIfNeeded("online");
    setMode("online");
    if (seed) setOnlineQuery(seed);
  }

  async function refreshInfo() {
    try { setLibraryInfo(await getApi().getLibraryInfo()); } catch { /* non-critical */ }
  }

  async function handleSaveBook(input: BookInput) {
    if (!editor) return;
    setSaving(true);
    try {
      if (editor.mode === "create") {
        const created = await getApi().createBook(input);
        setBooks((current) => sortBooks([...current, created], locale));
        setActiveBookId(created.id);
        setNotice(m.notices.bookAdded);
        setWorkspaceMode("library");
      } else {
        const updated = await getApi().updateBook(editor.bookId, input);
        setBooks((current) => sortBooks(current.map((book) => book.id === updated.id ? updated : book), locale));
        setActiveBookId(updated.id);
        setNotice(m.notices.changesSaved);
      }
      setEditor(null);
      await refreshInfo();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveReview(book: Book, review: string) {
    try {
      const updated = await getApi().updateBook(book.id, { ...bookToInput(book), review: review.trim() });
      setBooks((current) => sortBooks(current.map((item) => item.id === updated.id ? updated : item), locale));
      setNotice(updated.review?.trim() ? m.notices.reviewSaved : m.notices.reviewRemoved);
    } catch (error) {
      setNotice(errorMessage(m, error));
      throw error;
    }
  }

  async function handleToggleFavorite(book: Book) {
    try {
      const updated = await getApi().updateBook(book.id, { ...bookToInput(book), favorite: !book.favorite });
      setBooks((current) => sortBooks(current.map((item) => item.id === updated.id ? updated : item), locale));
      setNotice(updated.favorite ? m.notices.favoriteAdded : m.notices.favoriteRemoved);
    } catch (error) {
      setNotice(errorMessage(m, error));
    }
  }

  async function handleUpdateStatus(book: Book, status: ReadingStatus) {
    if (book.status === status) return;
    setStatusSavingId(book.id);
    try {
      const updated = await getApi().updateBook(book.id, { ...bookToInput(book), status });
      setBooks((current) => sortBooks(current.map((item) => item.id === updated.id ? updated : item), locale));
      setNotice(m.notices.statusChanged(updated.displayTitle, m.status[status]));
    } catch (error) {
      setNotice(errorMessage(m, error));
    } finally {
      setStatusSavingId(null);
    }
  }

  async function handleUpdateRating(book: Book, rating: number | null) {
    if (book.rating === rating) return;
    setRatingSavingId(book.id);
    try {
      const updated = await getApi().updateBook(book.id, { ...bookToInput(book), rating });
      setBooks((current) => sortBooks(current.map((item) => item.id === updated.id ? updated : item), locale));
      setNotice(rating ? m.notices.ratingChanged(updated.displayTitle, rating) : m.notices.ratingCleared(updated.displayTitle));
    } catch (error) {
      setNotice(errorMessage(m, error));
    } finally {
      setRatingSavingId(null);
    }
  }

  function selectLibraryBook(bookId: number) {
    setConfirmDeleteId(null);
    setActiveBookId(bookId);
  }

  async function handleDeleteBook(book: Book) {
    setDeleting(true);
    try {
      await getApi().deleteBook(book.id);
      const remaining = books.filter((item) => item.id !== book.id);
      setBooks(remaining);
      setActiveBookId(remaining[0]?.id ?? null);
      setConfirmDeleteId(null);
      setNotice(m.notices.bookDeleted);
      await refreshInfo();
    } catch (error) {
      setNotice(errorMessage(m, error));
    } finally {
      setDeleting(false);
    }
  }

  function handleDisambiguationPick(option: { query: string; label: string }) {
    setOnlineQuery(option.query);
    setOnlineSearchMode("author");
    cancelOnlineSearchDebounce();
    void commitOnlineSearch(option.query, "author");
  }

  function cancelOnlineSearch() {
    onlineSearchGenerationRef.current += 1;
    prefetchGenerationRef.current += 1;
    prefetchRef.current = null;
    prefetchPromiseRef.current = null;
    setOnlineState("idle");
    setOnlineError("");
  }

  function resetOnlinePrefetch() {
    prefetchGenerationRef.current += 1;
    prefetchRef.current = null;
    prefetchPromiseRef.current = null;
  }

  async function prefetchOnlineSearch(query: string, searchMode: OnlineSearchMode) {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < onlineSearchMinLength(searchMode, trimmed)) return;

    const generation = ++prefetchGenerationRef.current;
    prefetchRef.current = {
      query: trimmed,
      mode: searchMode,
      response: null,
      error: null,
      ready: false
    };
    if (mode === "online" && onlineQuery.trim() === trimmed && onlineSearchMode === searchMode) {
      setOnlineError("");
      setOnlineVisibleCount(ONLINE_RESULTS_PAGE_SIZE);
      setOnlineState("loading");
    }

    const work = (async () => {
      try {
        const response = await getApi().searchOnline({ query: trimmed, mode: searchMode });
        if (generation !== prefetchGenerationRef.current) return;
        prefetchRef.current = {
          query: trimmed,
          mode: searchMode,
          response,
          error: null,
          ready: true
        };
        const coverUrls = response.results
          .map((item) => item.coverRemoteUrl || item.coverUrl)
          .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
        if (coverUrls.length) void getApi().warmCovers(coverUrls);
        if (
          mode === "online"
          && onlineQuery.trim() === trimmed
          && onlineSearchMode === searchMode
          && !quickAddingIdRef.current
          && !previewLoadingIdRef.current
        ) {
          const searchGeneration = ++onlineSearchGenerationRef.current;
          setOnlineError("");
          setOnlineVisibleCount(ONLINE_RESULTS_PAGE_SIZE);
          setOnlineSearchHistory((history) =>
            rememberDiscoverSearch(history, historyQueryFromResponse(response), historyModeFromResponse(response, searchMode))
          );
          publishOnlineResponse(response);
          enrichOnlineSearchCovers(response, trimmed, searchGeneration);
        }
      } catch (error) {
        if (generation !== prefetchGenerationRef.current) return;
        const message = errorMessage(m, error);
        prefetchRef.current = {
          query: trimmed,
          mode: searchMode,
          response: null,
          error: message,
          ready: true
        };
        if (mode === "online" && onlineQuery.trim() === trimmed && onlineSearchMode === searchMode) {
          setOnlineError(message);
          setOnlineState("error");
        }
      }
    })();

    prefetchPromiseRef.current = work;
    await work;
  }

  async function commitOnlineSearch(query: string, searchMode: OnlineSearchMode) {
    const trimmed = query.trim();
    if (!trimmed) return;

    const generation = ++onlineSearchGenerationRef.current;
    setOnlineError("");
    setOnlineVisibleCount(ONLINE_RESULTS_PAGE_SIZE);

    const applyResponse = (response: OnlineSearchResponse) => {
      if (generation !== onlineSearchGenerationRef.current) return;
      setOnlineSearchHistory((history) =>
        rememberDiscoverSearch(history, historyQueryFromResponse(response), historyModeFromResponse(response, searchMode))
      );
      publishOnlineResponse(response);
      enrichOnlineSearchCovers(response, trimmed, generation);
    };

    const prefetched = prefetchRef.current;
    if (prefetched?.query === trimmed && prefetched.mode === searchMode) {
      if (!prefetched.ready && prefetchPromiseRef.current) {
        setOnlineState("loading");
        await prefetchPromiseRef.current;
      }
      const latest = prefetchRef.current;
      if (latest?.ready && latest.query === trimmed && latest.mode === searchMode) {
        if (latest.error) {
          if (generation !== onlineSearchGenerationRef.current) return;
          setOnlineError(latest.error);
          setOnlineState("error");
          return;
        }
        if (latest.response) {
          applyResponse(latest.response);
          return;
        }
      }
    }

    setOnlineState("loading");
    try {
      const response = await getApi().searchOnline({ query: trimmed, mode: searchMode });
      applyResponse(response);
    } catch (error) {
      if (generation !== onlineSearchGenerationRef.current) return;
      setOnlineError(errorMessage(m, error));
      setOnlineState("error");
    }
  }

  function cancelOnlineSearchDebounce() {
    if (onlineSearchDebounceRef.current) {
      clearTimeout(onlineSearchDebounceRef.current);
      onlineSearchDebounceRef.current = null;
    }
  }

  function flushDeferredOnlineResponse() {
    const deferred = deferredOnlineResponseRef.current;
    if (!deferred) return;
    deferredOnlineResponseRef.current = null;
    setOnlineResponse(deferred);
    setOnlineState("success");
  }

  function publishOnlineResponse(response: OnlineSearchResponse) {
    if (quickAddingIdRef.current || previewLoadingIdRef.current) {
      deferredOnlineResponseRef.current = response;
      return;
    }
    setOnlineResponse(response);
    setOnlineState("success");
  }

  function enrichOnlineSearchCovers(response: OnlineSearchResponse, query: string, generation: number) {
    const coverUrls = response.results
      .map((item) => item.coverRemoteUrl || item.coverUrl)
      .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
    if (coverUrls.length) void getApi().warmCovers(coverUrls);
    if (response.results.some((item) =>
      item.providers.includes("fantlab")
      || item.references.some((ref) => ref.externalId.startsWith("inpx:"))
      || item.providers.includes("open-library")
    ) && response.results.some((item) =>
      !hasCatalogCover(item) || (item.providers.includes("fantlab") && !item.listedEditionCount)
    )) {
      void getApi()
        .enrichSearchCovers(response.results, query)
        .then((enriched) => {
          if (generation !== onlineSearchGenerationRef.current) return;
          if (quickAddingIdRef.current || previewLoadingIdRef.current) return;
          const byId = new Map(enriched.map((item) => [item.id, item]));
          setOnlineResponse((current) => {
            if (!current || current.query !== response.query) return current;
            return {
              ...current,
              results: current.results.map((item) => byId.get(item.id) || item)
            };
          });
          const enrichedUrls = enriched
            .map((item) => item.coverRemoteUrl || item.coverUrl)
            .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
          if (enrichedUrls.length) void getApi().warmCovers(enrichedUrls);
        })
        .catch(() => {});
    }
  }

  function handleOnlineQueryChange(value: string) {
    setOnlineQuery(value);
    if (!value.trim()) {
      cancelOnlineSearchDebounce();
      onlineSearchGenerationRef.current += 1;
      resetOnlinePrefetch();
      setOnlineState("idle");
      setOnlineResponse(null);
      setOnlineError("");
      return;
    }
    resetOnlinePrefetch();
    if (onlineResponse && onlineResponse.query !== value.trim()) {
      setOnlineResponse(null);
      setOnlineState("idle");
      setOnlineError("");
    }
  }

  useEffect(() => {
    if (mode !== "online") return;
    const query = onlineQuery.trim();
    if (!query || query.length < onlineSearchMinLength(onlineSearchMode, query)) {
      resetOnlinePrefetch();
      return;
    }

    cancelOnlineSearchDebounce();
    onlineSearchDebounceRef.current = setTimeout(() => {
      void prefetchOnlineSearch(query, onlineSearchMode);
    }, ONLINE_SEARCH_DEBOUNCE_MS);

    return () => cancelOnlineSearchDebounce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineQuery, onlineSearchMode, mode]);

  function handleSearchClear() {
    cancelOnlineSearchDebounce();
    if (mode === "online") {
      if (onlineState === "loading") {
        cancelOnlineSearch();
        return;
      }
      setOnlineQuery("");
      resetOnlinePrefetch();
      setOnlineState("idle");
      setOnlineResponse(null);
      setOnlineError("");
      return;
    }
    setLibraryQuery("");
  }

  const searchQueryValue = mode === "library" ? libraryQuery : onlineQuery;
  const showSearchClear = mode === "online"
    ? Boolean(onlineQuery.trim()) || onlineState === "loading"
    : Boolean(libraryQuery.trim());

  async function handleOnlineSearch() {
    const trimmed = onlineQuery.trim();
    if (!trimmed) {
      setNotice(m.notices.enterQuery);
      return;
    }
    cancelOnlineSearchDebounce();
    await commitOnlineSearch(trimmed, onlineSearchMode);
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && mode === "online") {
      cancelOnlineSearchDebounce();
      void handleOnlineSearch();
    }
  }

  function handleOnlineSearchModeChange(searchMode: OnlineSearchMode) {
    setOnlineSearchMode(searchMode);
    setOnlineVisibleCount(ONLINE_RESULTS_PAGE_SIZE);
    cancelOnlineSearchDebounce();
    resetOnlinePrefetch();
    setOnlineResponse(null);
    setOnlineState("idle");
    setOnlineError("");
  }

  async function handleOnlineHistoryPick(item: DiscoverSearchHistoryItem) {
    setOnlineQuery(item.query);
    setOnlineSearchMode(item.mode);
    setOnlineVisibleCount(ONLINE_RESULTS_PAGE_SIZE);
    cancelOnlineSearchDebounce();
    resetOnlinePrefetch();
    await commitOnlineSearch(item.query, item.mode);
  }

  function handleRemoveOnlineHistory(item: DiscoverSearchHistoryItem) {
    setOnlineSearchHistory((history) => {
      const next = history.filter((entry) => entry.query !== item.query || entry.mode !== item.mode);
      writeDiscoverSearchHistory(next);
      return next;
    });
  }

  function handleClearOnlineHistory() {
    writeDiscoverSearchHistory([]);
    setOnlineSearchHistory([]);
  }

  async function handleLoadMoreEditions() {
    if (!editionPreview?.hasMoreEditions || loadingMoreEditions) return;
    setLoadingMoreEditions(true);
    try {
      const result = await getApi().loadMoreEditions(editionPreview.work, editionPreview.editions.length);
      setEditionPreview((current) => {
        if (!current) return current;
        const seen = new Set(current.editions.map((edition) => edition.id));
        return {
          ...current,
          editions: [
            ...current.editions,
            ...result.editions.filter((edition) => !seen.has(edition.id))
          ],
          hasMoreEditions: result.hasMore
        };
      });
      const coverUrls = result.editions
        .flatMap((edition) => editionCoverRemoteUrls(edition))
        .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
      if (coverUrls.length) void getApi().warmCovers(coverUrls);
      const bare = result.editions.filter((edition) => !editionHasCover(edition));
      if (bare.length) {
        void getApi()
          .enrichEditionCovers(bare)
          .then((enriched) => handlePatchEditionCovers(enriched))
          .catch(() => {});
      }
    } catch (error) {
      setNotice(m.online.failedLoadEditions(errorMessage(m, error)));
    } finally {
      setLoadingMoreEditions(false);
    }
  }

  const handlePatchEditionCovers = useCallback((enriched: OnlineBookEdition[]) => {
    const byId = new Map(enriched.map((edition) => [edition.id, edition]));
    setEditionPreview((current) => {
      if (!current) return current;
      return {
        ...current,
        editions: current.editions.map((edition) => byId.get(edition.id) || edition)
      };
    });
    const urls = enriched
      .flatMap((edition) => editionCoverRemoteUrls(edition))
      .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
    if (urls.length) void getApi().warmCovers(urls);
  }, []);

  async function handleOpenCandidate(candidate: OnlineBookCandidate) {
    previewLoadingIdRef.current = candidate.id;
    setPreviewLoadingId(candidate.id);
    try {
      const preview = await getApi().resolveOnlineWork({ candidate, mode: "preview" });
      setEditionPreview(preview);
    } catch (error) {
      setNotice(m.online.failedLoadEditions(errorMessage(m, error)));
    } finally {
      previewLoadingIdRef.current = null;
      setPreviewLoadingId(null);
      flushDeferredOnlineResponse();
    }
  }

  async function handleQuickAddCandidate(candidate: OnlineBookCandidate) {
    const pinned = {
      ...candidate,
      references: candidate.references.map((reference) => ({ ...reference })),
      alternateTitles: candidate.alternateTitles ? [...candidate.alternateTitles] : undefined
    };
    quickAddingIdRef.current = pinned.id;
    setQuickAddingId(pinned.id);
    try {
      const preview = await getApi().resolveOnlineWork({ candidate: pinned, mode: "quick" });
      const edition = preview.primaryEdition || pickDefaultEdition(preview.editions, {
        preferRussian: editionPreferRussian(onlineQuery, settings.preferRussian, settings.uiLocale),
        uiLocale: settings.uiLocale,
        previewCoverUrl: pinned.coverRemoteUrl || pinned.coverUrl,
        previewCoverKey: pinned.coverKey,
        originalLanguage: preview.work.originalLanguage ?? pinned.originalLanguage,
        firstPublishedYear: preview.work.firstPublishedYear ?? pinned.firstPublishedYear
      });
      if (!edition) {
        setEditionPreview(preview);
        return;
      }
      const searchCover = pinned.coverRemoteUrl || pinned.coverUrl;
      const input = await getApi().prepareOnlineEdition({
        work: {
          ...preview.work,
          coverRemoteUrl: searchCover || preview.work.coverRemoteUrl,
          coverKey: pinned.coverKey || preview.work.coverKey
        },
        edition,
        displayTitle: preview.work.displayTitle || preview.work.title,
        titlePreference: settings.displayTitlePreference,
        preferredCoverUrl: searchCover,
        preferredCoverKey: pinned.coverKey
      });
      openCreateDialog(input);
    } catch (error) {
      setNotice(m.online.failedPrepareBook(errorMessage(m, error)));
    } finally {
      quickAddingIdRef.current = null;
      setQuickAddingId(null);
      flushDeferredOnlineResponse();
    }
  }

  async function handlePrepareEdition(selection: OnlineEditionSelection) {
    setPreparingEdition(true);
    try {
      const input = await getApi().prepareOnlineEdition(selection);
      setEditionPreview(null);
      openCreateDialog(input);
    } catch (error) {
      setNotice(m.online.failedPrepareEdition(errorMessage(m, error)));
    } finally {
      setPreparingEdition(false);
    }
  }

  async function handleSaveSettings(update: AppSettingsUpdate) {
    setSettingsSaving(true);
    try {
      const saved = await getApi().updateSettings(update);
      onSettingsChange(saved);
      setSettingsOpen(false);
      setDiagnostics([]);
      setOnlineResponse(null);
      setOnlineState("idle");
      setNotice(m.notices.settingsSaved);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleDiagnose() {
    setDiagnosing(true);
    try { setDiagnostics(await getApi().diagnoseProviders()); }
    finally { setDiagnosing(false); }
  }

  async function handleClearCache() {
    await getApi().clearSearchCache();
    setOnlineResponse(null);
    setOnlineState("idle");
    setNotice(m.notices.cacheCleared);
  }

  function openSettingsDialog(dialogMode: "application" | "catalogs" = "application") {
    setSettingsDialogMode(dialogMode);
    setSettingsOpen(true);
  }

  return (
    <main className={`app-shell ${navCollapsed ? "nav-collapsed" : ""}`}>
      <aside className="app-rail" aria-label={m.nav.main}>
        <button className="rail-brand" onClick={() => setWorkspaceMode("home")} title="Quietfolio"><img className="brand-icon" src={brandIcon} width={44} height={44} alt="" /></button>
        <nav className="rail-nav">
          <button className={mode === "home" ? "rail-button active" : "rail-button"} onClick={() => setWorkspaceMode("home")} title={m.nav.home}><House size={20} /></button>
          <button className={mode === "library" ? "rail-button active" : "rail-button"} onClick={() => setWorkspaceMode("library")} title={m.nav.library}><BookOpen size={20} /></button>
          <button className={mode === "online" ? "rail-button active" : "rail-button"} onClick={() => enterOnlineMode()} title={m.nav.online}><Compass size={20} /></button>
          <button className="rail-button" disabled title={`${m.nav.stats} · ${m.nav.comingSoon}`}><ChartNoAxesColumnIncreasing size={20} /></button>
        </nav>
        <div className="rail-bottom">
          <button
            className={`rail-button ${navCollapsed ? "rail-expand" : "rail-collapse"}`}
            onClick={() => setNavCollapsed((collapsed) => !collapsed)}
            title={navCollapsed ? m.nav.expandPanel : m.nav.collapsePanel}
          >
            {navCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          <button className="rail-button" onClick={() => setCommandOpen(true)} title={m.nav.commandPalette}><Command size={20} /></button>
          {navCollapsed && <button className="rail-button" onClick={() => openSettingsDialog("application")} title={m.nav.settings}><Settings size={20} /></button>}
        </div>
      </aside>

      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><img className="brand-mark-icon" src={brandIcon} width={44} height={44} alt="" /></div><div><h1>Quietfolio</h1><span>{m.brand.tagline}</span></div></div>
        <div className="sidebar-section-title">{mode === "home" ? m.nav.overview : mode === "library" ? m.nav.myLibrary : m.nav.catalog}</div>
        <nav className="nav-stack">
          {mode === "home" && <>
            <button className="nav-item active"><House size={19} /><span className="nav-item-label">{m.nav.today}</span></button>
            <button className="nav-item" onClick={openLibraryRecent}><Clock3 size={19} /><span className="nav-item-label">{m.nav.recentlyAdded}</span></button>
            <button className="nav-item" onClick={() => enterOnlineMode()}><Sparkles size={19} /><span className="nav-item-label">{m.nav.findNewBook}</span></button>
          </>}
          {mode === "library" && <>
            <button className={libraryFilter === "all" ? "nav-item active" : "nav-item"} onClick={() => { setLibrarySort("title"); setLibraryFilter("all"); }}><LibraryBig size={19} /><span className="nav-item-label">{m.nav.allBooks}</span><span className="nav-item-count">{stats.total}</span></button>
            <button className={libraryFilter === "favorites" ? "nav-item active nav-favorites" : "nav-item nav-favorites"} onClick={openLibraryFavorites}><Star size={19} /><span className="nav-item-label">{m.nav.favorites}</span><span className="nav-item-count">{stats.favorites}</span></button>
            <button className={libraryFilter === "reading" ? "nav-item active nav-reading" : "nav-item nav-reading"} onClick={() => { setLibrarySort("title"); setLibraryFilter("reading"); }}><BookMarked size={19} /><span className="nav-item-label">{m.status.reading}</span><span className="nav-item-count">{stats.reading}</span></button>
            <button className={libraryFilter === "want" ? "nav-item active nav-want" : "nav-item nav-want"} onClick={() => { setLibrarySort("title"); setLibraryFilter("want"); }}><Sparkles size={19} /><span className="nav-item-label">{m.status.want}</span><span className="nav-item-count">{stats.want}</span></button>
            <button className={libraryFilter === "read" ? "nav-item active nav-read" : "nav-item nav-read"} onClick={() => { setLibrarySort("title"); setLibraryFilter("read"); }}><CircleCheck size={19} /><span className="nav-item-label">{m.status.read}</span><span className="nav-item-count">{stats.read}</span></button>
            <button className={libraryFilter === "paused" ? "nav-item active nav-paused" : "nav-item nav-paused"} onClick={() => { setLibrarySort("title"); setLibraryFilter("paused"); }}><Clock3 size={19} /><span className="nav-item-label">{m.status.paused}</span><span className="nav-item-count">{stats.paused}</span></button>
            <button className={libraryFilter === "abandoned" ? "nav-item active nav-abandoned" : "nav-item nav-abandoned"} onClick={() => { setLibrarySort("title"); setLibraryFilter("abandoned"); }}><CircleX size={19} /><span className="nav-item-label">{m.status.abandoned}</span><span className="nav-item-count">{stats.abandoned}</span></button>
          </>}
          {mode === "online" && <>
            <button className="nav-item active"><Compass size={19} /><span className="nav-item-label">{m.nav.bookSearch}</span></button>
            <button className="nav-item" onClick={() => openSettingsDialog("catalogs")}><SlidersHorizontal size={19} /><span className="nav-item-label">{m.nav.catalogsAndNetwork}</span></button>
          </>}
        </nav>
        <div className="sidebar-footer">
          {libraryInfo && <span className="database-state"><i />{m.common.sqliteBooks(libraryInfo.bookCount)}</span>}
          <button className="icon-line" disabled title={m.nav.comingSoon}><Upload size={18} />{m.nav.import}</button>
          <button className="icon-line" disabled title={m.nav.comingSoon}><Download size={18} />{m.nav.export}</button>
          <button className="icon-line" onClick={() => openSettingsDialog("application")}><Settings size={18} />{m.nav.settings}</button>
        </div>
      </aside>

      <section className={`workspace${libraryFocus && mode === "library" ? " library-focus" : ""}`}>
        <header className="topbar">
          <div className="topbar-drag">
            {mode !== "home" && <button className="icon-button back-button" onClick={() => setWorkspaceMode("home")} title={m.nav.backHome}><ArrowLeft size={19} /></button>}
            <div className="page-identity"><strong>{mode === "home" ? m.nav.home : mode === "library" ? m.nav.library : m.online.pageTitle}</strong><span>{mode === "online" ? m.online.pageSubtitle : mode === "library" ? m.library.pageSubtitle : m.home.pageSubtitle}</span></div>
          </div>
          {mode === "home" ? <button className="command-trigger" onClick={() => setCommandOpen(true)}><Search size={18} /><span>{m.home.commandPlaceholder}</span><kbd>{m.common.shortcutCommandK}</kbd></button>
          : <label className="search-box"><Search size={20} /><input value={searchQueryValue} onChange={(event) => mode === "library" ? setLibraryQuery(event.target.value) : handleOnlineQueryChange(event.target.value)} onKeyDown={handleSearchKeyDown} placeholder={mode === "library" ? m.library.searchPlaceholder : m.searchPlaceholder[onlineSearchMode]} />{showSearchClear ? <button type="button" className="search-box-clear" onClick={handleSearchClear} title={mode === "online" && onlineState === "loading" ? m.common.cancelSearch : m.common.clear} aria-label={mode === "online" && onlineState === "loading" ? m.common.cancelSearch : m.common.clear}><X size={18} /></button> : null}</label>}
          <div className={`topbar-actions${mode === "online" ? " online-actions" : ""}`}>
            {mode === "library" && <>
              <button
                type="button"
                className={libraryFocus ? "secondary-action selected" : "secondary-action"}
                onClick={toggleLibraryFocus}
                title={libraryFocus ? m.library.exitFocusView : m.library.focusView}
                aria-pressed={libraryFocus}
              >
                {libraryFocus ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                <span>{libraryFocus ? m.library.exitFocusView : m.library.focusView}</span>
              </button>
              <div className="segmented"><button className={viewMode === "grid" ? "selected" : ""} onClick={() => setViewMode("grid")}><Grid2X2 size={18} /></button><button className={viewMode === "table" ? "selected" : ""} onClick={() => setViewMode("table")}><List size={18} /></button></div>
              <button className="primary-action" onClick={() => openCreateDialog()}><Plus size={18} />{m.library.add}</button>
            </>}
            {mode === "online" && <>
              <button className="secondary-action online-toolbar-btn" onClick={() => void handleOnlineSearch()} disabled={onlineState === "loading"}>{onlineState === "loading" ? <LoaderCircle className="spin-icon" size={18} /> : <Search size={18} />}{onlineState === "loading" ? m.common.searching : m.common.search}</button>
              <button className="primary-action online-toolbar-btn" onClick={() => openCreateDialog()}><Plus size={18} />{m.online.manual}</button>
            </>}
          </div>
        </header>

        {libraryLoadError && <p className="warning-banner"><AlertTriangle size={18} />{m.library.loadError} {libraryLoadError}</p>}

        {mode === "home" && <section className="home-workspace">
          <section className="home-hero">
            <div className="hero-glow" />
            <div className="hero-copy"><span className="eyebrow">{m.home.welcome}</span><h1>{m.home.title}<br /><span className="hero-title-accent">{m.home.titleBreak}</span></h1><p>{m.home.subtitle}</p><div className="hero-actions"><button className="primary-action large" onClick={() => enterOnlineMode()}><Compass size={19} />{m.home.findBook}</button><button className="secondary-action large" onClick={() => setWorkspaceMode("library")}><LibraryBig size={19} />{m.home.openLibrary}</button></div></div>
            <div className="hero-book-stack">
              {recentBooks.slice(0, 3).map((book, index) => <button key={book.id} className={`hero-book hero-book-${index + 1}`} onClick={() => { setActiveBookId(book.id); setWorkspaceMode("library"); }}><CoverImage src={book.coverUrl} title={book.displayTitle} fit="cover" /></button>)}
              {!recentBooks.length && <div className="hero-placeholder"><BookOpen size={38} /><span>{m.home.addFirstBook}</span></div>}
            </div>
          </section>

          <section className="home-stat-grid">
            <article><div className="stat-icon violet"><LibraryBig size={20} /></div><div><strong>{stats.total}</strong><span>{m.home.totalBooks}</span></div></article>
            <article><div className="stat-icon blue"><BookMarked size={20} /></div><div><strong>{stats.reading}</strong><span>{m.home.currentlyReading}</span></div></article>
            <article><div className="stat-icon green"><CircleCheck size={20} /></div><div><strong>{stats.read}</strong><span>{m.home.finished}</span></div></article>
            <article><div className="stat-icon rose"><Star size={20} /></div><div><strong>{stats.favorites}</strong><span>{m.home.favorites}</span></div></article>
          </section>

          <div className="home-columns">
            <section className="home-panel continue-panel">
              <div className="section-heading">
                <div><span className="eyebrow">{m.home.continue}</span><h2>{currentReading ? m.home.currentBook : m.home.startCollection}</h2></div>
                {currentReading && <button className="text-action" onClick={() => { setActiveBookId(currentReading.id); setWorkspaceMode("library"); }}>{m.home.open} <ArrowRight size={16} /></button>}
              </div>
              {currentReading ? (
                <div className="continue-card featured-continue">
                  <div className="continue-cover"><CoverImage src={currentReading.coverUrl} title={currentReading.displayTitle} fit="cover" genre={currentReading.genres[0]} /></div>
                  <div className="continue-copy">
                    <span className={`status-pill status-${currentReading.status}`}>{m.status[currentReading.status]}</span>
                    <h3>{currentReading.displayTitle}</h3>
                    <p className="continue-author">{authorLabel(m, currentReading.author)}</p>
                    <div className="continue-meta"><span>{formatPublisher(currentReading.publisher) || genreLabel(m, currentReading.category)}</span><span>{ratingLabel(m, currentReading.rating)}</span></div>
                    <div className="continue-actions"><button className="secondary-action" onClick={() => { setActiveBookId(currentReading.id); setWorkspaceMode("library"); }}><BookOpen size={17} />{m.home.openCard}</button></div>
                  </div>
                </div>
              ) : (
                <div className="home-empty"><BookPlus size={28} /><p>{m.home.emptyContinue}</p><button className="primary-action" onClick={() => enterOnlineMode()}>{m.home.startSearch}</button></div>
              )}
            </section>

            <section className={`home-panel recent-panel ${recentBooks.length === 0 ? "is-empty" : ""}`}>
              <div className="section-heading"><div><span className="eyebrow">{m.home.collection}</span><h2>{m.nav.recentlyAdded}</h2></div>{recentBooks.length > 0 && <button className="text-action" onClick={() => setWorkspaceMode("library")}>{m.nav.allBooks} <ArrowRight size={16} /></button>}</div>
              <div className="recent-scroll">{recentBooks.length ? recentBooks.map((book) => <button key={book.id} className="recent-book" onClick={() => { setActiveBookId(book.id); setWorkspaceMode("library"); }}><div><CoverImage src={book.coverUrl} title={book.displayTitle} fit="cover" genre={book.genres[0]} /></div><strong>{book.displayTitle}</strong><span>{authorLabel(m, book.author)}</span></button>) : <div className="home-empty compact"><p>{m.home.recentEmpty}</p></div>}</div>
            </section>
          </div>
        </section>}

        {mode === "library" && <>
          <section className="library-heading"><div><span className="eyebrow">{m.library.myCollection}</span><h1>{librarySort === "recent" && libraryFilter === "all" ? m.nav.recentlyAdded : libraryFilterLabel(libraryFilter)}</h1><p>{m.common.booksCount(filteredBooks.length, books.length)}</p></div><button className="secondary-action" onClick={() => enterOnlineMode(libraryQuery)}><Cloud size={18} />{m.library.findOnline}</button></section>
          <section className={`content-grid${libraryFocus ? " library-focus-grid" : ""}`}>
            <div className="library-panel">
              <div className="filter-row">{libraryFilterOptions.map((filter) => <button key={filter} type="button" className={filterChipClass(libraryFilter, filter)} onClick={() => { setLibraryFilter(filter); if (filter === "all") return; setLibrarySort("title"); }}>{libraryFilterLabel(filter)}</button>)}</div>
              {loading ? <BookGridSkeleton />
                : noBooksYet ? <div className="empty-state welcome-empty"><div className="empty-icon"><BookPlus size={30} /></div><h2>{m.library.welcomeTitle}</h2><p>{m.library.welcomeText}</p><button className="primary-action" onClick={() => enterOnlineMode()}><Compass size={18} />{m.library.findFirstBook}</button></div>
                : filteredBooks.length === 0 ? <div className="empty-state"><Sparkles size={30} /><h2>{m.library.nothingFound}</h2><p>{m.library.nothingFoundHint}</p></div>
                : viewMode === "grid" ? <div className="book-grid">{filteredBooks.map((book) => (
                  <article key={book.id} className={book.id === activeBook?.id ? "book-card selected" : "book-card"}>
                    <div className="book-card-cover-wrap">
                      <button type="button" className="book-card-open" onClick={() => selectLibraryBook(book.id)}>
                        <div className="cover">
                          <CoverImage src={book.coverUrl} title={book.displayTitle} fit="cover" status={book.status} genre={book.genres[0] || book.category} />
                        </div>
                      </button>
                    </div>
                    <button type="button" className="book-card-meta" onClick={() => selectLibraryBook(book.id)}>
                      <div className="book-card-body">
                        <h2 title={book.displayTitle}>{book.displayTitle}</h2>
                        {(() => {
                          const subtitle = normalizeBookSubtitle(book.subtitle || "", book.displayTitle);
                          return subtitle ? <small className="book-subtitle">{subtitle}</small> : null;
                        })()}
                        <p>{authorLabel(m, book.author)}</p>
                        <div className="book-meta">
                          <span className="book-meta-year">{book.year ?? m.common.noYear}</span>
                          <div
                            className="book-meta-rating"
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <RatingPicker
                              inline
                              readOnly={book.id !== activeBook?.id}
                              value={book.rating}
                              saving={ratingSavingId === book.id}
                              onChange={(rating) => void handleUpdateRating(book, rating)}
                            />
                          </div>
                        </div>
                      </div>
                    </button>
                  </article>
                ))}</div>
                : <div className="book-table"><div className="table-row table-head"><span>{m.library.tableTitle}</span><span>{m.library.tableAuthor}</span><span>{m.library.tableYear}</span><span>{m.library.tableStatus}</span><span>{m.library.tableRating}</span></div>{filteredBooks.map((book) => (
                  <div key={book.id} className={book.id === activeBook?.id ? "table-row selected" : "table-row"}>
                    <button type="button" className="table-row-select" onClick={() => selectLibraryBook(book.id)}>
                      <span>{book.displayTitle}</span>
                      <span>{authorLabel(m, book.author)}</span>
                      <span>{book.year ?? m.common.notSpecified}</span>
                    </button>
                    <div className="table-row-status">
                      <StatusSwitcher
                        compact
                        iconsOnly
                        value={book.status}
                        saving={statusSavingId === book.id}
                        onChange={(status) => void handleUpdateStatus(book, status)}
                      />
                    </div>
                    <div className="table-row-rating">
                      <RatingPicker
                        inline
                        value={book.rating}
                        saving={ratingSavingId === book.id}
                        onChange={(rating) => void handleUpdateRating(book, rating)}
                      />
                    </div>
                  </div>
                ))}</div>}
            </div>

            <aside className="details-panel" key={activeBook?.id}>{activeBook ? <>
              <div className="detail-ambient"><CoverImage src={activeBook.coverUrl} title={activeBook.displayTitle} fit="cover" genre={activeBook.genres[0]} /></div>
              <div className="detail-hero">
                <div className="detail-cover"><CoverImage src={activeBook.coverUrl} title={activeBook.displayTitle} fit="cover" genre={activeBook.genres[0]} /></div>
                <div className="detail-hero-head">
                  <h2>{activeBook.displayTitle}</h2>
                  <p className="author">{authorLabel(m, activeBook.author)}</p>
                  {activeBook.workTitle && activeBook.workTitle !== activeBook.displayTitle && <p className="detail-work-title">{activeBook.workTitle}</p>}
                </div>
              </div>
              <section className="detail-status-panel">
                <span className="detail-status-label">{m.library.readingStatus}</span>
                <StatusSwitcher
                  value={activeBook.status}
                  saving={statusSavingId === activeBook.id}
                  onChange={(status) => void handleUpdateStatus(activeBook, status)}
                />
              </section>
              <section className="detail-rating-panel">
                <span className="detail-status-label">{m.library.rating}</span>
                <RatingPicker
                  value={activeBook.rating}
                  saving={ratingSavingId === activeBook.id}
                  onChange={(rating) => void handleUpdateRating(activeBook, rating)}
                />
              </section>
              {activeBook.editionTitle && activeBook.editionTitle !== activeBook.displayTitle && <p className="detail-edition-title">{m.common.editionLabel(activeBook.editionTitle)}</p>}
              {(() => {
                const subtitle = normalizeBookSubtitle(activeBook.subtitle || "", activeBook.displayTitle);
                return subtitle ? <p className="detail-subtitle">{subtitle}</p> : null;
              })()}
              <div className="detail-spec-sheet">
                <div className="detail-spec-row"><span>{m.library.year}</span><strong>{activeBook.year ?? m.common.notSpecified}</strong></div>
                {activeBook.firstPublishedYear && <div className="detail-spec-row"><span>{m.library.firstPublished}</span><strong>{activeBook.firstPublishedYear}</strong></div>}
                {activeBook.publisher && <div className="detail-spec-row"><span>{m.library.publisher}</span><strong>{formatPublisher(activeBook.publisher)}</strong></div>}
                {activeBook.pageCount && <div className="detail-spec-row"><span>{m.library.pages}</span><strong>{activeBook.pageCount}</strong></div>}
                {activeBook.language && <div className="detail-spec-row"><span>{m.library.language}</span><strong>{languageLabel(m, activeBook.language)}</strong></div>}
                <div className="detail-spec-row"><span>{m.library.category}</span><strong>{genreLabel(m, activeBook.category)}</strong></div>
                {activeBook.isbn && <div className="detail-spec-row"><span>{m.library.isbn}</span><strong>{activeBook.isbn}</strong></div>}
              </div>
              {(activeBook.coverStatus === "missing" || activeBook.coverStatus === "download-failed" || !activeBook.coverUrl) && (
                <p className={`cover-note ${activeBook.coverStatus || "missing"}`}>{coverStatusLabel(m, activeBook)}</p>
              )}
              {activeBookExtraGenres.length > 0 && <div className="detail-genres">{activeBookExtraGenres.map((genre) => <span key={genre}>{genreLabel(m, genre)}</span>)}</div>}
              {activeBookDescription && <section className="description-box"><h3>{m.library.aboutBook}</h3><ExpandableText text={activeBookDescription} /></section>}
              {activeBook.sourceUrl && <button className="external-source" onClick={() => void getApi().openExternal(activeBook.sourceUrl!)}><ExternalLink size={16} />{m.library.openSourceRecord}</button>}
              <DetailReviewSection key={activeBook.id} book={activeBook} onSave={handleSaveReview} />
              {confirmDeleteId === activeBook.id ? <div className="delete-confirm"><p>{m.library.deleteConfirm}</p><div><button className="secondary-action" onClick={() => setConfirmDeleteId(null)}>{m.common.cancel}</button><button className="danger-action" onClick={() => void handleDeleteBook(activeBook)} disabled={deleting}><Trash2 size={17} />{deleting ? m.common.deleting : m.common.delete}</button></div></div>
              : <div className="detail-actions"><button className={activeBook.favorite ? "secondary-action favorite-active" : "secondary-action"} onClick={() => void handleToggleFavorite(activeBook)}><Star size={17} fill={activeBook.favorite ? "currentColor" : "none"} />{activeBook.favorite ? m.library.removeFavorite : m.library.addFavorite}</button><button className="secondary-action" onClick={() => openEditDialog(activeBook)}><Pencil size={17} />{m.library.metadata}</button><button className="secondary-action detail-delete" onClick={() => setConfirmDeleteId(activeBook.id)}><Trash2 size={17} />{m.common.delete}</button></div>}
            </> : <div className="details-empty"><BookOpen size={28} /><p>{noBooksYet ? m.library.addBookForDetails : m.library.selectBook}</p></div>}</aside>
          </section>
        </>}

        {mode === "online" && <section className="online-workspace">
          <div className="online-compact-header discover-panel">
            <div className="online-compact-copy">
              <span className="eyebrow discover-eyebrow"><Compass size={13} strokeWidth={2.2} />{m.online.title}</span>
              <p>{m.online.subtitle}</p>
            </div>
            <div className="search-mode-panel compact discover-mode">
              <div className="search-mode-heading"><Layers3 size={18} strokeWidth={2.1} /><span>{m.online.mode}</span></div>
              <div className="search-mode-switch" role="tablist" aria-label={m.online.mode}>{( ["auto", "author", "title", "isbn"] as OnlineSearchMode[]).map((searchMode) => <button key={searchMode} type="button" role="tab" aria-selected={onlineSearchMode === searchMode} className={onlineSearchMode === searchMode ? "selected" : ""} onClick={() => handleOnlineSearchModeChange(searchMode)}>{m.searchMode[searchMode]}</button>)}</div>
            </div>
          </div>
          {onlineSearchHistory.length > 0 && (
            <div className="discover-history" aria-label={m.online.searchHistory}>
              <span>{m.online.searchHistory}</span>
              <div>
                {onlineSearchHistory.map((item) => (
                  <span
                    key={`${item.mode}:${item.query}`}
                    className="discover-history-chip"
                  >
                    <button type="button" onClick={() => void handleOnlineHistoryPick(item)} title={m.online.repeatSearch(item.query)}>
                      {item.query}
                    </button>
                    <button type="button" className="discover-history-remove" onClick={() => handleRemoveOnlineHistory(item)} title={m.online.removeSearchHistory(item.query)} aria-label={m.online.removeSearchHistory(item.query)}>
                      <X size={13} />
                    </button>
                  </span>
                ))}
                <button type="button" className="discover-history-clear" onClick={handleClearOnlineHistory}>{m.online.clearSearchHistory}</button>
              </div>
            </div>
          )}
          {showOnlineIdle && <div className="online-start compact"><img className="online-start-mark subtle" src={brandIcon} width={54} height={54} alt="" draggable={false} /><h2>{m.online.idleTitle}</h2><p>{m.online.idleHint}</p></div>}
          {showOnlineSkeleton && <>
            <div className="resolution-strip loading"><LoaderCircle className="spin-icon" size={16} /><span>{m.online.resolving}</span></div>
            <OnlineResultsSkeleton />
          </>}
          {onlineState === "error" && <div className="online-error standalone"><AlertTriangle size={22} /><div><strong>{m.online.searchFailed}</strong><p>{onlineError}</p><button className="secondary-action" onClick={() => void handleOnlineSearch()}>{m.common.retry}</button></div></div>}
          {showOnlineResults && <>
            <div className="online-toolbar">
              <span>
                {sortedOnlineResults.length > 0
                  ? m.online.resultsRange(onlineResultsFrom, onlineResultsTo, sortedOnlineResults.length)
                  : m.online.resultsCount(0)}
              </span>
              {onlineResponse?.fromCache && <span className="cache-badge">{m.online.fromCache}</span>}
              {onlineResponse?.providerStatuses?.some((status) => !status.ok && status.provider !== "google-books") && (
                <span className="online-catalog-warning">{m.online.catalogsPartial}</span>
              )}
              {sortedOnlineResults.length > 0 && (
                <div className="online-results-controls">
                  <label className="online-sort">
                    <span>{m.online.sortBy}</span>
                    <select
                      value={onlineResultSort}
                      onChange={(event) => {
                        setOnlineResultSort(event.target.value as OnlineResultSort);
                        setOnlineVisibleCount(ONLINE_RESULTS_PAGE_SIZE);
                      }}
                    >
                      <option value="relevance">{m.online.sortRelevance}</option>
                      <option value="popularity" title={m.online.sortPopularityHint}>{m.online.sortPopularity}</option>
                      <option value="year_desc">{m.online.sortYearDesc}</option>
                      <option value="year_asc">{m.online.sortYearAsc}</option>
                      <option value="title">{m.online.sortTitle}</option>
                    </select>
                  </label>
                </div>
              )}
            </div>
            {onlineResponse && (() => {
              const strip = searchResolutionStrip(m, onlineResponse.resolution);
              if (!strip) return null;
              return (
                <section className={`resolution-strip ${onlineResponse.resolution.confidence >= 75 ? "high" : onlineResponse.resolution.confidence >= 55 ? "medium" : "low"}`}>
                  <BrandIcon size={18} className="resolution-strip-icon" />
                  <div className="resolution-strip-copy"><strong>{strip.title}</strong>{strip.hint && <span>{strip.hint}</span>}</div>
                </section>
              );
            })()}
            {onlineResponse && onlineResponse.resolution.resolvedMode === "author" && onlineResponse.resolution.confidence < 88 && (onlineResponse.resolution.disambiguationOptions?.length || 0) > 0 && (
              <div className="disambiguation-strip">
                <span>{m.online.wrongAuthor}</span>
                {onlineResponse.resolution.disambiguationOptions!.map((option) => (
                  <button type="button" className="disambiguation-chip" key={option.label} onClick={() => handleDisambiguationPick(option)} title={option.hint}>
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            {!onlineResponse?.results.length ? <div className="online-start"><img className="online-start-mark" src={brandIcon} width={64} height={64} alt="" draggable={false} /><h2>{m.online.noResults}</h2><p>{m.online.noResultsHint}</p></div>
            : <div className="work-results">{visibleOnlineResults.map((result, index) => {
              const quickAdd = shouldOfferQuickAdd(result, onlineResponse.resolution.resolvedMode, settings.autoSelectHighConfidence);
              const isFeatured = index === 0 && quickAdd;
              return <article className={`work-result-card shelf-row ${isFeatured ? "featured-result" : ""}`} key={result.id}>
              {isFeatured && <span className="best-match-ribbon">{m.online.bestMatch}</span>}
              <div className="result-cover-cell"><div className={`cover work-cover${!hasCatalogCover(result) ? " cover-pending" : ""}`}><CoverImage src={result.coverUrl} title={result.displayTitle || result.title} fit="cover" genre={result.genres[0]} /></div></div>
              <div className="work-result-copy"><div className="result-title-row"><div className="result-heading"><h2>{result.displayTitle || result.title}</h2>{result.displayTitle && result.displayTitle !== result.title && <small className="canonical-result-title">{result.title}</small>}<p>{authorLabel(m, result.author)}</p></div>{shouldShowExactBadge(result.matchReasons, onlineResponse?.resolution.resolvedMode) && <div className="result-badges"><span className="match-badge high">{m.online.exactMatch}</span></div>}</div><div className="metadata-line">{result.languages.length > 0 && <span>{result.languages.slice(0, 2).map((lang) => languageLabel(m, lang)).join(" · ")}</span>}{result.catalogSeries && <span className="series-inline">{result.catalogSeries}{result.catalogSeriesNum ? ` #${result.catalogSeriesNum}` : ""}</span>}{result.genres[0] && <span className="genre-inline">{genreLabel(m, result.genres[0])}</span>}{(result.listedEditionCount ?? 0) > 0 && <span>{m.common.editionCountInCatalog(result.listedEditionCount!)}</span>}</div><div className="result-extra">{result.description && cleanBookDescription(result.description) && <p className="work-description">{cleanBookDescription(result.description)}</p>}</div></div>
              <div className="result-actions"><button className="primary-action quick-add" onClick={() => void handleQuickAddCandidate(result)} disabled={Boolean(quickAddingId || previewLoadingId)}>{quickAddingId === result.id ? <LoaderCircle className="spin-icon" size={17} /> : <BookPlus size={17} />}{quickAddingId === result.id ? m.online.preparing : m.online.add}</button><button className="secondary-action" onClick={() => void handleOpenCandidate(result)} disabled={Boolean(previewLoadingId || quickAddingId)}>{previewLoadingId === result.id ? <LoaderCircle className="spin-icon" size={17} /> : <BookCopy size={17} />}{previewLoadingId === result.id ? m.online.loading : m.online.editions}</button></div>
            </article>;
            })}
            {hasMoreOnlineResults && (
              <div className="online-load-more">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => setOnlineVisibleCount((count) => count + ONLINE_RESULTS_PAGE_SIZE)}
                >
                  {m.online.showMore(sortedOnlineResults.length - visibleOnlineResults.length)}
                </button>
              </div>
            )}
            </div>}
          </>}
        </section>}
      </section>

      {editor && <BookEditorDialog state={editor} saving={saving} onClose={() => setEditor(null)} onSave={handleSaveBook} />}
      {editionPreview && <EditionPickerDialog preview={editionPreview} preparing={preparingEdition} loadingMoreEditions={loadingMoreEditions} onLoadMoreEditions={handleLoadMoreEditions} onEditionsPatch={handlePatchEditionCovers} defaultTitlePreference={settings.displayTitlePreference} preferRussian={editionPreferRussian(onlineQuery, settings.preferRussian, settings.uiLocale)} onClose={() => setEditionPreview(null)} onConfirm={handlePrepareEdition} />}
      {settingsOpen && <SettingsDialog settings={settings} mode={settingsDialogMode} saving={settingsSaving} diagnostics={diagnostics} diagnosing={diagnosing} onClose={() => setSettingsOpen(false)} onSave={handleSaveSettings} onDiagnose={handleDiagnose} onClearCache={handleClearCache} />}
      {commandOpen && <CommandPalette query={commandQuery} books={books} onQueryChange={setCommandQuery} onClose={() => { setCommandOpen(false); setCommandQuery(""); }} onOpenBook={(book) => { setActiveBookId(book.id); setWorkspaceMode("library"); }} onNavigate={setWorkspaceMode} onCreate={() => openCreateDialog()} onSettings={() => openSettingsDialog("application")} />}
      {notice && <div className="toast" role="status"><CheckCircle2 size={18} />{notice}</div>}
    </main>
  );
}

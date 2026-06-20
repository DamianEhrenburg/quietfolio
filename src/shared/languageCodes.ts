/** Normalize catalog language tokens to BCP 47 / ISO 639 codes for display. */
const LANGUAGE_ALIASES: Record<string, string> = {
  russian: "ru",
  rus: "ru",
  english: "en",
  eng: "en",
  german: "de",
  ger: "de",
  deu: "de",
  french: "fr",
  fre: "fr",
  fra: "fr",
  spanish: "es",
  spa: "es",
  italian: "it",
  ita: "it",
  ukrainian: "uk",
  ukr: "uk",
  portuguese: "pt",
  por: "pt",
  polish: "pl",
  pol: "pl",
  japanese: "ja",
  jpn: "ja",
  czech: "cs",
  ces: "cs",
  cze: "cs",
  dutch: "nl",
  nld: "nl",
  dut: "nl",
  finnish: "fi",
  fin: "fi",
  korean: "ko",
  kor: "ko",
  sanskrit: "sa",
  san: "sa",
  yiddish: "yi",
  yid: "yi",
  chinese: "zh",
  chi: "zh",
  zho: "zh",
  arabic: "ar",
  ara: "ar",
  hebrew: "he",
  heb: "he",
  hindi: "hi",
  hin: "hi",
  turkish: "tr",
  tur: "tr",
  swedish: "sv",
  swe: "sv",
  norwegian: "no",
  nor: "no",
  danish: "da",
  dan: "da",
  hungarian: "hu",
  hun: "hu",
  romanian: "ro",
  ron: "ro",
  rum: "ro",
  bulgarian: "bg",
  bul: "bg",
  greek: "el",
  gre: "el",
  ell: "el",
  catalan: "ca",
  cat: "ca",
  latin: "la",
  lat: "la",
  persian: "fa",
  fas: "fa",
  per: "fa",
  vietnamese: "vi",
  vie: "vi",
  thai: "th",
  tha: "th",
  indonesian: "id",
  ind: "id",
  malay: "ms",
  msa: "ms",
  may: "ms",
  serbian: "sr",
  srp: "sr",
  croatian: "hr",
  hrv: "hr",
  slovak: "sk",
  slk: "sk",
  slo: "sk",
  slovenian: "sl",
  slv: "sl",
  lithuanian: "lt",
  lit: "lt",
  latvian: "lv",
  lav: "lv",
  estonian: "et",
  est: "et",
  georgian: "ka",
  kat: "ka",
  geo: "ka",
  armenian: "hy",
  hye: "hy",
  arm: "hy",
  bengali: "bn",
  ben: "bn",
  tamil: "ta",
  tam: "ta",
  telugu: "te",
  tel: "te",
  urdu: "ur",
  urd: "ur",
  welsh: "cy",
  wel: "cy",
  cym: "cy",
  irish: "ga",
  gle: "ga",
  scottish: "gd",
  gla: "gd",
  basque: "eu",
  baq: "eu",
  eus: "eu",
  icelandic: "is",
  ice: "is",
  isl: "is",
  afrikaans: "af",
  afr: "af",
  albanian: "sq",
  sqi: "sq",
  alb: "sq",
  belarusian: "be",
  bel: "be",
  bosnian: "bs",
  bos: "bs",
  macedonian: "mk",
  mkd: "mk",
  mac: "mk",
  maltese: "mt",
  mlt: "mt",
  mongolian: "mn",
  mon: "mn",
  nepali: "ne",
  nep: "ne",
  swahili: "sw",
  swa: "sw",
  tagalog: "tl",
  tgl: "tl",
  filipino: "fil",
  uzbek: "uz",
  uzb: "uz",
  kazakh: "kk",
  kaz: "kk",
  azerbaijani: "az",
  aze: "az",
  mult: "mul",
  multiple: "mul",
  und: "und",
  unknown: "und"
};

export function resolveLanguageCode(language?: string) {
  const trimmed = (language || "").trim().toLowerCase();
  if (!trimmed) return "";
  const alpha = trimmed.replace(/[^a-z]/g, "");
  if (!alpha) return "";
  if (LANGUAGE_ALIASES[alpha]) return LANGUAGE_ALIASES[alpha];
  if (/^[a-z]{2}$/.test(alpha)) return alpha;
  if (/^[a-z]{3}$/.test(alpha)) return alpha;
  return alpha.slice(0, 3);
}

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function languageDisplayNames(locale: "ru" | "en") {
  const cached = displayNamesCache.get(locale);
  if (cached) return cached;
  const created = new Intl.DisplayNames([locale], { type: "language" });
  displayNamesCache.set(locale, created);
  return created;
}

export function formatLanguageName(language: string | undefined, locale: "ru" | "en") {
  const code = resolveLanguageCode(language);
  if (!code || code === "und" || code === "mul") {
    return locale === "ru" ? "язык не указан" : "language not specified";
  }
  const display = languageDisplayNames(locale);
  const candidates = uniqueLanguageCandidates(code, language);
  for (const candidate of candidates) {
    try {
      const label = display.of(candidate);
      if (label && label !== candidate) {
        return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
      }
    } catch {
      // Try the next candidate form.
    }
  }
  return (language || code).trim();
}

function uniqueLanguageCandidates(code: string, original?: string) {
  const values = new Set<string>();
  if (code) values.add(code);
  if (original?.trim()) values.add(original.trim().toLowerCase());
  if (code.length === 2) values.add(code);
  if (code.length === 3) values.add(code);
  return [...values];
}

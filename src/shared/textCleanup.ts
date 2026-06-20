export function decodeHtmlEntities(text: string) {
  return text
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtmlTags(text: string) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function stripCatalogMetadata(text: string) {
  return text
    .replace(/^From\s+(?:Wikipedia(?:,\s*the free encyclopedia)?|\[[^\]]+\]\[[^\]]+\])\s*:?\s*/i, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/\[[^\]]+\]\[[^\]]*\]/g, "")
    .replace(/\s*\[\d+\]/g, "")
    .replace(/\(\s*(?:Russian|English|German|French|Spanish|Italian|рус(?:ский)?)\s*:[^)]*(?:\btr\.|\bIPA\b)[^)]*\)/gi, "")
    .replace(/\(\s*tr\.\s*[^)]+\)/gi, "")
    .replace(/\(?\s*IPA\s*:\s*\[[^\]]+\]\s*\)?/gi, "")
    .replace(/\[[^\]]*[\u0250-\u02FF][^\]]*\]/g, "")
    .replace(/,\s*tr\.\s*[^,;)]+/gi, "")
    // Normalize glued sentences before stripping library boilerplate
    .replace(/\.([Вв] формате)/g, ". $1")
    // Russian digital-library edition notes (PDF layout boilerplate from catalogs)
    .replace(
      /\s*[Вв] формате\s+(?:PDF\s*|pdf\s*)?A4(?:\.pdf)?\s+сохран[её]н\s+издательский\s+макет(?:\s+книги)?\.?\s*/gi,
      " "
    )
    // Section dividers left by OCR / library scrapers
    .replace(/\s*\*{3,}\s*/g, " ")
    .replace(/\s*·{3,}\s*/g, " ");
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Drop catalog marketing blurbs masquerading as edition subtitles. */
export function normalizeBookSubtitle(subtitle: string, title = ""): string {
  const text = normalizeWhitespace(decodeHtmlEntities(subtitle.trim()));
  if (!text) return "";

  if (text.length > 72) return "";

  if (/^[a-z]/.test(text)) return "";

  if (text.includes("...") || text.includes("…")) return "";

  if ((text.match(/[.!?]/g) || []).length >= 2) return "";

  if (/\b(?:pulitzer|bestselling|award-winning|temperature at which)\b/i.test(text)) return "";

  const titleNorm = title.trim().toLowerCase();
  if (titleNorm && text.toLowerCase().startsWith(titleNorm) && text.length > title.length + 15) {
    return "";
  }

  return text;
}

/** Strip HTML, wiki footnotes, IPA and other catalog boilerplate from book descriptions. */
export function cleanBookDescription(text: string) {
  if (!text.trim()) return "";

  let result = decodeHtmlEntities(text.trim());
  result = stripHtmlTags(result);
  result = stripCatalogMetadata(result);
  result = normalizeWhitespace(result);

  return result;
}

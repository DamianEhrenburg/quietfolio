
const MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ґ: "g", і: "i", ї: "yi", є: "ye"
};

function hasCyrillic(value: string) {
  return /[\u0400-\u04FF]/.test(value);
}

export function transliterateCyrillicToLatin(value: string) {
  let result = "";
  for (const char of value.toLowerCase()) {
    result += MAP[char] ?? char;
  }
  return result.replace(/\s+/g, " ").trim();
}

export function latinSearchVariants(...values: Array<string | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value?: string) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
    if (hasCyrillic(trimmed)) {
      const latin = transliterateCyrillicToLatin(trimmed);
      if (latin && latin !== trimmed.toLowerCase()) add(latin);
    }
  };
  for (const value of values) add(value);
  return out;
}

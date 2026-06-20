import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { UiLocale } from "../shared/types";
import { getMessages } from "./helpers";
import type { Messages } from "./types";

interface I18nContextValue {
  locale: UiLocale;
  m: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  children
}: {
  locale: UiLocale;
  children: ReactNode;
}) {
  const m = getMessages(locale);

  useEffect(() => {
    document.documentElement.lang = m.localeTag;
  }, [m.localeTag]);

  return <I18nContext.Provider value={{ locale, m }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Direction } from "radix-ui";
import { currentConfig, directionOf, translate, type MessageVars, type Messages } from "./i18n.ts";
import { formatCompact, formatCurrency, formatDate, formatList, formatNumber } from "./format.ts";
import { applyTheme, type ThemePreference } from "./theme.ts";

interface LocaleState {
  locale: string;
  messages: Messages;
}

const LocaleContext = createContext<LocaleState | null>(null);

export interface XOSProviderProps {
  /** BCP 47 locale for copy and Intl formatting; en-US by default. */
  locale?: string;
  /** Flat `ui` messages merged over the catalog, keyed without the namespace. */
  messages?: Messages;
  /** Applies a theme preference to the document root while mounted. */
  theme?: ThemePreference;
  children: ReactNode;
}

/**
 * Sets the locale, text direction and, optionally, the theme for every component below it. Without a
 * provider, components read the locale set by `configure`.
 */
export function XOSProvider({ locale, messages, theme, children }: XOSProviderProps) {
  const fallback = currentConfig();
  const resolvedLocale = locale ?? fallback.locale;
  const value = useMemo(
    () => ({ locale: resolvedLocale, messages: { ...fallback.messages, ...messages } }),
    [resolvedLocale, fallback.messages, messages],
  );
  useEffect(() => (theme === undefined ? undefined : applyTheme(theme)), [theme]);
  return (
    <LocaleContext.Provider value={value}>
      <Direction.Provider dir={directionOf(resolvedLocale)}>{children}</Direction.Provider>
    </LocaleContext.Provider>
  );
}

function useLocaleState(): LocaleState {
  return useContext(LocaleContext) ?? currentConfig();
}

/** The active locale for Intl formatting. */
export function useLocale(): string {
  return useLocaleState().locale;
}

export type Translate = (key: string, vars?: MessageVars) => string;

/** A `t` bound to the provider's locale and messages. */
export function useT(): Translate {
  const { locale, messages } = useLocaleState();
  return (key, vars) => translate(locale, key, vars, messages);
}

/** Number, money, list and date formatters bound to the active locale. */
export function useFormat() {
  const locale = useLocale();
  return {
    locale,
    number: (value: number) => formatNumber(locale, value),
    currency: (value: number, currency?: string) => formatCurrency(locale, value, currency),
    compact: (value: number, currency?: string) => formatCompact(locale, value, currency),
    list: (items: string[]) => formatList(locale, items),
    date: (iso: string) => formatDate(locale, iso),
  };
}

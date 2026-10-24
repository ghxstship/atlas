import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { Direction } from "radix-ui";
import { currentConfig, directionOf, translate, type MessageVars, type Messages } from "./i18n.ts";
import {
  displayTimeZone,
  formatCompact,
  formatCurrency,
  formatDate,
  formatList,
  formatNumber,
  formatZonedDateTime,
} from "./format.ts";
import { applyTheme, type ThemePreference } from "./theme.ts";
import { DEFAULT_PREFERENCES, type DisplayPreferences } from "./preferences.ts";
import { resolveUnitSystem, type UnitSystem } from "@xos/i18n/units";

interface LocaleState {
  locale: string;
  messages: Messages;
}

const LocaleContext = createContext<LocaleState | null>(null);
const PreferencesContext = createContext<DisplayPreferences>(DEFAULT_PREFERENCES);
/** The viewer's own IANA time zone (locale.time_zone), for me.time_zone_display. */
const ViewerZoneContext = createContext<string | null>(null);

export interface XOSProviderProps {
  /** BCP 47 locale for copy and Intl formatting; en-US by default. */
  locale?: string;
  /** Flat `ui` messages merged over the catalog, keyed without the namespace. */
  messages?: Messages;
  /** Applies a theme preference to the document root while mounted. */
  theme?: ThemePreference;
  /** The person's display preferences (density, date format, units, week start); defaults when omitted. */
  preferences?: DisplayPreferences;
  children: ReactNode;
}

/**
 * Sets the locale, text direction and, optionally, the theme for every component below it. Without a
 * provider, components read the locale set by `configure`.
 */
export function XOSProvider({ locale, messages, theme, preferences, children }: XOSProviderProps) {
  const fallback = currentConfig();
  const resolvedLocale = locale ?? fallback.locale;
  const value = useMemo(
    () => ({ locale: resolvedLocale, messages: { ...fallback.messages, ...messages } }),
    [resolvedLocale, fallback.messages, messages],
  );
  useEffect(() => (theme === undefined ? undefined : applyTheme(theme)), [theme]);
  return (
    <LocaleContext.Provider value={value}>
      <PreferencesContext.Provider value={preferences ?? DEFAULT_PREFERENCES}>
        <Direction.Provider dir={directionOf(resolvedLocale)}>{children}</Direction.Provider>
      </PreferencesContext.Provider>
    </LocaleContext.Provider>
  );
}

/**
 * Sets the display preferences for the components below it, under an `XOSProvider`. The app shells use it
 * with the person's resolved settings, so a saved setting shows on the page it was saved from.
 */
export function PreferencesProvider({
  preferences,
  timeZone,
  children,
}: {
  preferences: DisplayPreferences;
  /** The viewer's own IANA time zone (locale.time_zone), which "my time zone" shows schedule times in. */
  timeZone?: string | null;
  children: ReactNode;
}) {
  return (
    <PreferencesContext.Provider value={preferences}>
      <ViewerZoneContext.Provider value={timeZone ?? null}>{children}</ViewerZoneContext.Provider>
    </PreferencesContext.Provider>
  );
}

/** The person's display preferences from the nearest provider (Section 4.5.6, A65-001). */
export function usePreferences(): DisplayPreferences {
  return useContext(PreferencesContext);
}

/** The viewer's own time zone from the nearest PreferencesProvider, or null when the shell gave none. */
export function useViewerTimeZone(): string | null {
  return useContext(ViewerZoneContext);
}

/**
 * Formats schedule times in the zone the person chose (me.time_zone_display, Section 15): the event's zone by
 * default, their own when they chose it. Every time carries its zone abbreviation.
 */
export function useZonedTime() {
  const locale = useLocale();
  const { timeZoneDisplay } = usePreferences();
  const viewer = useViewerTimeZone();
  return {
    zone: (eventZone: string | null | undefined) =>
      displayTimeZone(eventZone, timeZoneDisplay, viewer),
    dateTime: (iso: string, eventZone: string | null | undefined) => {
      const zone = displayTimeZone(eventZone, timeZoneDisplay, viewer);
      return zone
        ? formatZonedDateTime(locale, iso, zone)
        : formatZonedDateTime(locale, iso, "UTC");
    },
    time: (iso: string, eventZone: string | null | undefined) => {
      const zone = displayTimeZone(eventZone, timeZoneDisplay, viewer);
      return formatZonedDateTime(locale, iso, zone ?? "UTC", "time");
    },
  };
}

/** The unit system to show values in (locale.units), given the page's project jurisdiction when it has one. */
export function useUnitSystem(jurisdiction?: UnitSystem | null): UnitSystem {
  const locale = useLocale();
  const { units } = usePreferences();
  return resolveUnitSystem(units, { jurisdiction: jurisdiction ?? null, locale });
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

/** Number, money, list and date formatters bound to the active locale and the person's date format. */
export function useFormat() {
  const locale = useLocale();
  const { dateFormat } = usePreferences();
  return {
    locale,
    number: (value: number) => formatNumber(locale, value),
    currency: (value: number, currency?: string) => formatCurrency(locale, value, currency),
    compact: (value: number, currency?: string) => formatCompact(locale, value, currency),
    list: (items: string[]) => formatList(locale, items),
    date: (iso: string) => formatDate(locale, iso, dateFormat),
  };
}

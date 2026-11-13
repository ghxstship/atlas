import format, { type CompiledMessage } from "icu-minify/format";

/**
 * The Inbox's translator over the `email` namespace (crawl 4.9). Each Inbox item reads as its notification email does
 * (describe.ts), and email copy names ICU's date, time and number styles: a new shift starts
 * `{startsAt, date, full} at {startsAt, time, short}`. Atlas formats messages with next-intl's format-only runtime
 * (icu-minify, ADR 0027), which looks a named style up in next-intl's `formats.dateTime` alone, so a date style and a
 * time style of the same name cannot differ, and Atlas sets no formats: both fell back to the default date and the
 * item read "starting 11/13/2026 at 11/13/2026", with no time. Here each named style becomes the Intl options
 * intl-messageformat gives it, the formatter @xos/email renders the same copy with, so the Inbox reads
 * "starting Thursday, November 12, 2026 at 7:00 PM", in the time zone given.
 */

const TYPE_NUMBER = 4;
const TYPE_DATE = 5;
const TYPE_TIME = 6;

/** intl-messageformat's built-in styles (IntlMessageFormat.formats), which @xos/email formats email copy with. */
const STYLES: Readonly<Record<number, Readonly<Record<string, object>>>> = {
  [TYPE_NUMBER]: {
    integer: { maximumFractionDigits: 0 },
    currency: { style: "currency" },
    percent: { style: "percent" },
  },
  [TYPE_DATE]: {
    short: { month: "numeric", day: "numeric", year: "2-digit" },
    medium: { month: "short", day: "numeric", year: "numeric" },
    long: { month: "long", day: "numeric", year: "numeric" },
    full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
  },
  [TYPE_TIME]: {
    short: { hour: "numeric", minute: "numeric" },
    medium: { hour: "numeric", minute: "numeric", second: "numeric" },
    long: { hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" },
    full: { hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" },
  },
};

/** A compiled message with every named date, time and number style replaced by its options. */
export function withNamedStyles(node: unknown): unknown {
  if (Array.isArray(node)) {
    const [name, type, style] = node as unknown[];
    if (
      typeof name === "string" &&
      typeof type === "number" &&
      typeof style === "string" &&
      node.length === 3
    ) {
      const options = STYLES[type]?.[style];
      if (options) return [name, type, options];
    }
    return node.map(withNamedStyles);
  }
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, withNamedStyles(value)]),
    );
  }
  return node;
}

const formatters = {
  getDateTimeFormat: (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) =>
    new Intl.DateTimeFormat(...args),
  getNumberFormat: (...args: ConstructorParameters<typeof Intl.NumberFormat>) =>
    new Intl.NumberFormat(...args),
  getPluralRules: (...args: ConstructorParameters<typeof Intl.PluralRules>) =>
    new Intl.PluralRules(...args),
};

type Values = Record<string, string | number | Date>;

/**
 * Formats `email.<key>` from the precompiled email namespace (`compiled`, as next-intl holds it) in a locale and time
 * zone, honouring named styles. Returns null for a key the namespace does not hold, or a message that cannot be
 * formatted with the values given, so the caller can fall back.
 */
export function emailCopy(
  compiled: unknown,
  locale: string,
  timeZone: string,
): (key: string, values?: Values) => string | null {
  const cache = new Map<string, unknown>();
  return (key, values) => {
    let message = cache.get(key);
    if (message === undefined) {
      const found = key
        .split(".")
        .reduce<unknown>(
          (node, k) =>
            typeof node === "object" && node !== null && !Array.isArray(node)
              ? (node as Record<string, unknown>)[k]
              : undefined,
          compiled,
        );
      if (typeof found !== "string" && !Array.isArray(found)) return null;
      message = withNamedStyles(found);
      cache.set(key, message);
    }
    try {
      const out = format(message as CompiledMessage, locale, values ?? {}, {
        formatters,
        timeZone,
      });
      return Array.isArray(out) ? out.join("") : String(out);
    } catch {
      return null;
    }
  };
}

/**
 * Formatting for generated documents: a translator over the `documents` catalog namespace, and
 * locale-aware money, dates and durations. Money stays NULL-aware: an unpriced amount prints as the
 * catalog's Unpriced, never as zero (Section 3.7).
 */

export type Translate = (key: string, values?: Readonly<Record<string, string | number>>) => string;

/**
 * A translator over one catalog namespace. Document copy uses only `{name}` arguments, so a plain
 * substitution formats it the same way in a route, a test and the veraPDF check. A missing key
 * returns the key itself, which the catalog tests catch.
 */
export function documentTranslator(messages: unknown): Translate {
  return (key, values) => {
    let node: unknown = messages;
    for (const part of key.split(".")) {
      node =
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined;
    }
    if (typeof node !== "string") return key;
    return node.replace(/\{(\w+)\}/g, (match, name: string) =>
      values && name in values ? String(values[name]) : match,
    );
  };
}

/** Minor-unit digits of a currency (2 for USD, 0 for JPY). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export interface Formatter {
  readonly locale: string;
  readonly timeZone: string;
  money(minor: number | null, currency: string): string;
  number(value: number): string;
  /** A calendar day (YYYY-MM-DD) as a long date, never shifted by a time zone. */
  day(day: string | null): string;
  /** An instant as date and time in the formatter's time zone. */
  dateTime(iso: string | null): string;
  /** An instant as a time of day in the formatter's time zone. */
  time(iso: string | null): string;
  /** Seconds as H:MM:SS or M:SS. */
  duration(seconds: number | null): string;
}

export function formatter(locale: string, timeZone: string, t: Translate): Formatter {
  const zone = (() => {
    try {
      new Intl.DateTimeFormat(locale, { timeZone });
      return timeZone;
    } catch {
      return "UTC";
    }
  })();
  const none = t("common.none");
  return {
    locale,
    timeZone: zone,
    money(minor, currency) {
      if (minor === null) return t("common.unpriced");
      const code = currency.trim() || "USD";
      const digits = currencyDigits(code);
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: code,
          currencyDisplay: "code",
        }).format(minor / 10 ** digits);
      } catch {
        return `${(minor / 10 ** digits).toFixed(digits)} ${code}`;
      }
    },
    number(value) {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
    },
    day(day) {
      if (!day) return none;
      const at = Date.parse(`${day.slice(0, 10)}T12:00:00Z`);
      if (Number.isNaN(at)) return day;
      return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
    },
    dateTime(iso) {
      if (!iso) return none;
      const at = Date.parse(iso);
      if (Number.isNaN(at)) return iso;
      return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
        timeZoneName: "short",
      }).format(at);
    },
    time(iso) {
      if (!iso) return none;
      const at = Date.parse(iso);
      if (Number.isNaN(at)) return iso;
      return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: zone }).format(at);
    },
    duration(seconds) {
      if (seconds === null) return none;
      const s = Math.max(0, Math.round(seconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = String(s % 60).padStart(2, "0");
      return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
    },
  };
}

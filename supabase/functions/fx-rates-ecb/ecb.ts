// European Central Bank daily reference rates (Section 15, ADR 0053). Web APIs only, so it runs in the Edge
// runtime and under Vitest (packages/platform/test/fx-rates-ecb.test.ts parses a committed fixture; no test
// touches the network).
//
// The daily file lists one euro's worth of each currency for one ECB publication date, a TARGET business day
// in Central European Time. That date is the rate date: nothing here derives a date from the clock or UTC.

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_SOURCE = "ECB";

export interface EcbDaily {
  /** The ECB publication date, YYYY-MM-DD, as the file states it. */
  readonly date: string;
  /** Units of each currency one euro buys, by ISO 4217 code. */
  readonly rates: Readonly<Record<string, number>>;
}

export class EcbParseError extends Error {
  override readonly name = "EcbParseError";
}

const DAY = /<Cube\s+time\s*=\s*["'](\d{4}-\d{2}-\d{2})["']\s*>/;
const RATE =
  /<Cube\s+currency\s*=\s*["']([A-Z]{3})["']\s+rate\s*=\s*["']([0-9]+(?:\.[0-9]+)?)["']\s*\/>/g;

/** Parses the daily file. Refuses a file without exactly one date or without any valid rate. */
export function parseEcbDaily(xml: string): EcbDaily {
  if (!xml.includes("eurofxref")) throw new EcbParseError("Not an ECB reference rate file.");
  const days = xml.match(new RegExp(DAY.source, "g")) ?? [];
  if (days.length !== 1) {
    throw new EcbParseError(`Expected one rate date, found ${days.length}.`);
  }
  const date = DAY.exec(xml)?.[1] ?? "";
  const [y, m, d] = date.split("-").map(Number);
  const check = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 0));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    throw new EcbParseError(`The rate date ${date} is not a calendar date.`);
  }
  const rates: Record<string, number> = {};
  for (const match of xml.matchAll(RATE)) {
    const code = match[1] ?? "";
    const rate = Number(match[2]);
    if (code === "EUR" || !Number.isFinite(rate) || rate <= 0) continue;
    rates[code] = rate;
  }
  if (Object.keys(rates).length === 0) throw new EcbParseError("The file holds no rates.");
  return { date, rates };
}

/** Where the feed writes: app.record_fx_reference_rates and app.record_fx_feed_failure (migration 1542). */
export interface FxFeedStore {
  record(source: string, daily: EcbDaily): Promise<unknown>;
  fail(source: string, error: string): Promise<void>;
}

export type FeedOutcome =
  | {
      readonly ok: true;
      readonly date: string;
      readonly currencies: number;
      readonly result: unknown;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Fetches the daily file, parses it and records the rates; any failure (network, HTTP status, a file that does
 * not parse, the database refusing it) is recorded as a failed run, never dropped.
 */
export async function runEcbFeed(deps: {
  readonly fetch: typeof fetch;
  readonly store: FxFeedStore;
  readonly url?: string;
}): Promise<FeedOutcome> {
  let stage = "fetch";
  try {
    const response = await deps.fetch(deps.url ?? ECB_DAILY_URL, {
      headers: { Accept: "application/xml, text/xml" },
    });
    if (!response.ok) throw new Error(`The ECB answered HTTP ${response.status}.`);
    stage = "parse";
    const daily = parseEcbDaily(await response.text());
    stage = "record";
    const result = await deps.store.record(ECB_SOURCE, daily);
    return { ok: true, date: daily.date, currencies: Object.keys(daily.rates).length, result };
  } catch (error) {
    const message = `${stage}: ${error instanceof Error ? error.message : String(error)}`.slice(
      0,
      500,
    );
    try {
      await deps.store.fail(ECB_SOURCE, message);
    } catch (recordError) {
      return {
        ok: false,
        error: `${message} (and the failure could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)})`,
      };
    }
    return { ok: false, error: message };
  }
}

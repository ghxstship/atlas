// US National Weather Service feed (B8, gap G-150, ADR 0147 decision 8). Web APIs only, so it runs in the Edge runtime
// and under Vitest (packages/platform/test/weather-feed.test.ts reads committed fixtures; no test touches the network).
//
// For each due feed (app.due_weather_feeds, migration 2976): the points endpoint gives the hourly forecast URL and the
// list of observation stations, cached for 30 days; the nearest station's latest observation gives Wind (the gust, or
// the sustained speed without one) in mph and Heat (the heat index) in °F, converted from the unit the NWS names; the
// active alerts for the point; and the hourly forecast at most once an hour. Only the venue's coordinates, rounded to
// 4 decimals by the database, leave XOS. The NWS asks every client for a User-Agent naming a contact; without
// XOS_WEATHER_USER_AGENT nothing is fetched and every due feed records why.

export const NWS_BASE = "https://api.weather.gov";
const POINTS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORECAST_TTL_MS = 60 * 60 * 1000;
const OBSERVATION_MAX_AGE_MS = 90 * 60 * 1000;
export const MISSING_USER_AGENT = "XOS_WEATHER_USER_AGENT is not set";

/** A feed the database says is due now. */
export interface DueFeed {
  readonly feed_id: string;
  readonly project_id: string;
  readonly latitude: number | string;
  readonly longitude: number | string;
  readonly nws_forecast_hourly_url: string | null;
  readonly nws_station_id: string | null;
  readonly points_checked_at: string | null;
  readonly forecast_fetched_at: string | null;
}

/** One poll as app.record_weather_feed takes it. */
export interface FeedPayload {
  points?: { forecast_hourly_url: string | null; station_id: string | null };
  observation?: { observed_at: string; wind_mph: number | null; heat_f: number | null };
  alerts?: readonly AlertPayload[];
  forecast?: readonly ForecastPayload[];
}

export interface AlertPayload {
  readonly id: string;
  readonly event: string;
  readonly severity: string;
  readonly certainty: string | null;
  readonly urgency: string | null;
  readonly headline: string | null;
  readonly description: string | null;
  readonly instruction: string | null;
  readonly onset: string | null;
  readonly expires: string | null;
  readonly ends: string | null;
  readonly sent: string | null;
  readonly status: string;
  readonly message_type: string;
  readonly references: readonly string[];
}

export interface ForecastPayload {
  readonly starts_at: string;
  readonly ends_at: string;
  readonly temperature_f: number | null;
  readonly wind_speed_mph: number | null;
  readonly precipitation_percent: number | null;
  readonly short_forecast: string | null;
}

/** Where the feed reads and writes: the service-role RPCs of migration 2976. */
export interface WeatherFeedStore {
  dueFeeds(): Promise<readonly DueFeed[]>;
  record(feedId: string, payload: FeedPayload): Promise<void>;
  fail(feedId: string, error: string): Promise<void>;
}

export interface WeatherFeedSummary {
  readonly due: number;
  readonly succeeded: number;
  readonly failed: number;
}

interface QuantitativeValue {
  readonly value?: number | null;
  readonly unitCode?: string;
}

/** A speed in mph, from km/h or m/s; null for a missing value or any other unit. */
export function toMph(q: QuantitativeValue | null | undefined): number | null {
  if (q === null || q === undefined || typeof q.value !== "number" || !Number.isFinite(q.value))
    return null;
  if (q.unitCode === "wmoUnit:km_h-1") return round1(q.value * 0.621371);
  if (q.unitCode === "wmoUnit:m_s-1") return round1(q.value * 2.236936);
  return null;
}

/** A temperature in °F, from °C; null for a missing value or any other unit. */
export function toFahrenheit(q: QuantitativeValue | null | undefined): number | null {
  if (q === null || q === undefined || typeof q.value !== "number" || !Number.isFinite(q.value))
    return null;
  if (q.unitCode === "wmoUnit:degC") return round1(q.value * 1.8 + 32);
  return null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The observation's Wind and Heat, or null when it is older than 90 minutes or has no time. */
export function readObservation(
  body: unknown,
  now: Date,
): NonNullable<FeedPayload["observation"]> | null {
  const p = (body as { properties?: Record<string, unknown> } | null)?.properties;
  const timestamp = typeof p?.["timestamp"] === "string" ? (p["timestamp"] as string) : null;
  if (p === undefined || timestamp === null) return null;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at) || now.getTime() - at > OBSERVATION_MAX_AGE_MS) return null;
  const gust = toMph(p["windGust"] as QuantitativeValue);
  const wind = gust ?? toMph(p["windSpeed"] as QuantitativeValue);
  const heat = toFahrenheit(p["heatIndex"] as QuantitativeValue);
  return { observed_at: new Date(at).toISOString(), wind_mph: wind, heat_f: heat };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The active alerts of a point, as the database stores them. */
export function readAlerts(body: unknown): AlertPayload[] {
  const features = (body as { features?: unknown[] } | null)?.features;
  if (!Array.isArray(features)) throw new Error("The NWS alerts answer has no features list.");
  const out: AlertPayload[] = [];
  for (const feature of features) {
    const p = (feature as { properties?: Record<string, unknown> }).properties ?? {};
    const id = text(p["id"]);
    const event = text(p["event"]);
    if (id === null || event === null) continue;
    const references = Array.isArray(p["references"])
      ? (p["references"] as { identifier?: unknown }[])
          .map((r) => text(r.identifier))
          .filter((r): r is string => r !== null)
      : [];
    out.push({
      id,
      event,
      severity: text(p["severity"]) ?? "Unknown",
      certainty: text(p["certainty"]),
      urgency: text(p["urgency"]),
      headline: text(p["headline"]),
      description: text(p["description"]),
      instruction: text(p["instruction"]),
      onset: text(p["onset"]),
      expires: text(p["expires"]),
      ends: text(p["ends"]),
      sent: text(p["sent"]),
      status: text(p["status"]) ?? "Actual",
      message_type: text(p["messageType"]) ?? "Alert",
      references,
    });
  }
  return out;
}

/** "10 mph" or "5 to 10 mph" as mph, the upper end of a range. */
export function forecastWind(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const numbers = [...value.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (numbers.length === 0) return null;
  const top = Math.max(...numbers);
  if (/km\/h/i.test(value)) return round1(top * 0.621371);
  return /mph/i.test(value) ? top : null;
}

/** The next hourly forecast periods, at most 48. */
export function readForecast(body: unknown): ForecastPayload[] {
  const periods = (body as { properties?: { periods?: unknown[] } } | null)?.properties?.periods;
  if (!Array.isArray(periods)) throw new Error("The NWS forecast answer has no periods.");
  return periods.slice(0, 48).flatMap((raw) => {
    const p = raw as Record<string, unknown>;
    const starts = text(p["startTime"]);
    const ends = text(p["endTime"]);
    if (starts === null || ends === null) return [];
    const temperature = typeof p["temperature"] === "number" ? (p["temperature"] as number) : null;
    const unit = text(p["temperatureUnit"]);
    const pop = (p["probabilityOfPrecipitation"] as QuantitativeValue | undefined)?.value;
    return [
      {
        starts_at: new Date(starts).toISOString(),
        ends_at: new Date(ends).toISOString(),
        temperature_f:
          temperature === null ? null : unit === "C" ? round1(temperature * 1.8 + 32) : temperature,
        wind_speed_mph: forecastWind(p["windSpeed"]),
        precipitation_percent:
          typeof pop === "number" && pop >= 0 && pop <= 100 ? Math.round(pop) : null,
        short_forecast: text(p["shortForecast"])?.slice(0, 200) ?? null,
      },
    ];
  });
}

function older(at: string | null, ttlMs: number, now: Date): boolean {
  return at === null || now.getTime() - Date.parse(at) > ttlMs;
}

/** One poll of one feed: what to record, fetched with the NWS headers. */
export async function pollFeed(
  feed: DueFeed,
  deps: {
    readonly fetch: typeof fetch;
    readonly userAgent: string;
    readonly now: Date;
    readonly base?: string;
  },
): Promise<FeedPayload> {
  const base = deps.base ?? NWS_BASE;
  const get = async (url: string): Promise<unknown> => {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/geo+json", "User-Agent": deps.userAgent },
    });
    if (!response.ok)
      throw new Error(`The NWS answered HTTP ${response.status} for ${new URL(url).pathname}.`);
    return response.json();
  };
  const point = `${Number(feed.latitude)},${Number(feed.longitude)}`;
  const payload: FeedPayload = {};
  let forecastUrl = feed.nws_forecast_hourly_url;
  let station = feed.nws_station_id;
  if (
    station === null ||
    forecastUrl === null ||
    older(feed.points_checked_at, POINTS_TTL_MS, deps.now)
  ) {
    const points = (await get(`${base}/points/${point}`)) as {
      properties?: Record<string, unknown>;
    };
    forecastUrl = text(points.properties?.["forecastHourly"]);
    const stationsUrl = text(points.properties?.["observationStations"]);
    if (stationsUrl === null)
      throw new Error("The NWS points answer names no observation stations.");
    const stations = (await get(stationsUrl)) as {
      features?: { properties?: { stationIdentifier?: unknown } }[];
    };
    station = text(stations.features?.[0]?.properties?.stationIdentifier);
    payload.points = { forecast_hourly_url: forecastUrl, station_id: station };
  }
  if (station !== null) {
    const observation = readObservation(
      await get(`${base}/stations/${encodeURIComponent(station)}/observations/latest`),
      deps.now,
    );
    if (observation !== null) payload.observation = observation;
  }
  payload.alerts = readAlerts(await get(`${base}/alerts/active?point=${point}`));
  if (forecastUrl !== null && older(feed.forecast_fetched_at, FORECAST_TTL_MS, deps.now)) {
    payload.forecast = readForecast(await get(forecastUrl));
  }
  return payload;
}

/** Polls every due feed and records each outcome; a failure is recorded, never dropped. */
export async function runNwsFeed(deps: {
  readonly fetch: typeof fetch;
  readonly store: WeatherFeedStore;
  readonly userAgent: string | undefined;
  readonly now?: () => Date;
  readonly base?: string;
}): Promise<WeatherFeedSummary> {
  const feeds = await deps.store.dueFeeds();
  let succeeded = 0;
  let failed = 0;
  const userAgent = deps.userAgent?.trim() ?? "";
  for (const feed of feeds) {
    if (userAgent === "") {
      await deps.store.fail(feed.feed_id, MISSING_USER_AGENT);
      failed += 1;
      continue;
    }
    try {
      const payload = await pollFeed(feed, {
        fetch: deps.fetch,
        userAgent,
        now: deps.now?.() ?? new Date(),
        ...(deps.base === undefined ? {} : { base: deps.base }),
      });
      await deps.store.record(feed.feed_id, payload);
      succeeded += 1;
    } catch (error) {
      await deps.store.fail(
        feed.feed_id,
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
      );
      failed += 1;
    }
  }
  return { due: feeds.length, succeeded, failed };
}

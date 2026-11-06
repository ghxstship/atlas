import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MISSING_USER_AGENT,
  forecastWind,
  readAlerts,
  readForecast,
  readObservation,
  runNwsFeed,
  toFahrenheit,
  toMph,
  type DueFeed,
  type FeedPayload,
  type WeatherFeedStore,
} from "../../../supabase/functions/weather-feed/nws.ts";

/**
 * The NWS weather feed worker (B8, gap G-150, ADR 0147 decision 8), on committed copies of the National Weather Service
 * answers. No test here touches the network: the fetch is scripted.
 */

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/nws/${name}.json`, import.meta.url)), "utf8"),
  );

const NOW = new Date("2027-06-02T19:10:00Z");

const FEED: DueFeed = {
  feed_id: "feed-1",
  project_id: "prj-1",
  latitude: "25.7654",
  longitude: "-80.1235",
  nws_forecast_hourly_url: null,
  nws_station_id: null,
  points_checked_at: null,
  forecast_fetched_at: null,
};

function scriptedFetch(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const path = url.replace("https://api.weather.gov", "");
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (status[path] !== undefined) return new Response("{}", { status: status[path] });
    if (key === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function memoryStore(feeds: readonly DueFeed[]) {
  const recorded: { feedId: string; payload: FeedPayload }[] = [];
  const failed: { feedId: string; error: string }[] = [];
  const store: WeatherFeedStore = {
    dueFeeds: async () => feeds,
    async record(feedId, payload) {
      recorded.push({ feedId, payload });
    },
    async fail(feedId, error) {
      failed.push({ feedId, error });
    },
  };
  return { store, recorded, failed };
}

const ROUTES = {
  "/points/25.7654,-80.1235": fixture("points"),
  "/gridpoints/MFL/110,50/stations": fixture("stations"),
  "/stations/KMIA/observations/latest": fixture("observation"),
  "/alerts/active?point=25.7654,-80.1235": fixture("alerts"),
  "/gridpoints/MFL/110,50/forecast/hourly": fixture("forecast-hourly"),
};

describe("units", () => {
  it("converts km/h and m/s to mph and °C to °F, and skips any other unit", () => {
    expect(toMph({ value: 54, unitCode: "wmoUnit:km_h-1" })).toBe(33.6);
    expect(toMph({ value: 5, unitCode: "wmoUnit:m_s-1" })).toBe(11.2);
    expect(toMph({ value: 20, unitCode: "wmoUnit:knot" })).toBeNull();
    expect(toMph({ value: null, unitCode: "wmoUnit:km_h-1" })).toBeNull();
    expect(toFahrenheit({ value: 38.1, unitCode: "wmoUnit:degC" })).toBe(100.6);
    expect(toFahrenheit({ value: 99, unitCode: "wmoUnit:degF" })).toBeNull();
    expect(forecastWind("10 to 15 mph")).toBe(15);
    expect(forecastWind("8 mph")).toBe(8);
    expect(forecastWind("calm")).toBeNull();
  });

  it("reads the gust, else the sustained wind, and skips an observation older than 2 hours", () => {
    expect(readObservation(fixture("observation"), NOW)).toEqual({
      observed_at: "2027-06-02T18:53:00.000Z",
      wind_mph: 33.6,
      heat_f: 100.6,
    });
    expect(readObservation(fixture("observation-no-gust"), NOW)).toEqual({
      observed_at: "2027-06-02T18:53:00.000Z",
      wind_mph: 11.2,
      heat_f: null,
    });
    expect(
      readObservation(fixture("observation"), new Date("2027-06-02T20:30:00Z")),
    ).not.toBeNull();
    expect(readObservation(fixture("observation"), new Date("2027-06-02T20:54:00Z"))).toBeNull();
  });

  it("uses the temperature as Heat when the NWS gives no heat index, so a raised alert can lower", () => {
    expect(readObservation(fixture("observation-cool"), NOW)).toEqual({
      observed_at: "2027-06-02T18:53:00.000Z",
      wind_mph: 7.8,
      heat_f: 64.4,
    });
  });

  it("keeps only Actual alerts: a Test or Exercise message is not a warning", () => {
    const alert = (id: string, status: string) => ({
      properties: { id, event: "Tornado Warning", severity: "Extreme", status },
    });
    expect(
      readAlerts({
        features: [alert("a", "Actual"), alert("t", "Test"), alert("x", "Exercise")],
      }).map((a) => a.id),
    ).toEqual(["a"]);
  });

  it("passes on an Update's references, which decide whether it tells anyone", () => {
    expect(readAlerts(fixture("alerts-escalation"))).toMatchObject([
      {
        id: "urn:oid:2.49.0.1.840.0.2002",
        severity: "Severe",
        status: "Actual",
        message_type: "Update",
        references: ["urn:oid:2.49.0.1.840.0.2001"],
      },
    ]);
  });

  it("reads alerts with their Cancel references, and the hourly forecast in °F and mph", () => {
    const alerts = readAlerts(fixture("alerts"));
    expect(alerts.map((a) => [a.id, a.severity, a.message_type])).toEqual([
      ["urn:oid:2.49.0.1.840.0.1001", "Severe", "Alert"],
      ["urn:oid:2.49.0.1.840.0.1002", "Moderate", "Cancel"],
    ]);
    expect(alerts[1]?.references).toEqual(["urn:oid:2.49.0.1.840.0.0990"]);
    const forecast = readForecast(fixture("forecast-hourly"));
    expect(forecast).toEqual([
      {
        starts_at: "2027-06-02T23:00:00.000Z",
        ends_at: "2027-06-03T00:00:00.000Z",
        temperature_f: 88,
        wind_speed_mph: 15,
        precipitation_percent: 60,
        short_forecast: "Showers And Thunderstorms",
      },
      {
        starts_at: "2027-06-03T00:00:00.000Z",
        ends_at: "2027-06-03T01:00:00.000Z",
        temperature_f: 87.8,
        wind_speed_mph: 8,
        precipitation_percent: null,
        short_forecast: "Chance Showers And Thunderstorms",
      },
    ]);
  });
});

describe("runNwsFeed", () => {
  it("polls a new feed: points, stations, the latest observation, alerts and the hourly forecast", async () => {
    const { fetchImpl, calls } = scriptedFetch(ROUTES);
    const { store, recorded, failed } = memoryStore([FEED]);
    const summary = await runNwsFeed({
      fetch: fetchImpl,
      store,
      userAgent: "XOS weather feed (ops@example.test)",
      now: () => NOW,
    });
    expect(summary).toEqual({ due: 1, succeeded: 1, failed: 0 });
    expect(failed).toEqual([]);
    expect(calls.map((c) => c.url.replace("https://api.weather.gov", ""))).toEqual([
      "/points/25.7654,-80.1235",
      "/gridpoints/MFL/110,50/stations",
      "/stations/KMIA/observations/latest",
      "/alerts/active?point=25.7654,-80.1235",
      "/gridpoints/MFL/110,50/forecast/hourly",
    ]);
    expect(
      calls.every((c) => c.headers["User-Agent"] === "XOS weather feed (ops@example.test)"),
    ).toBe(true);
    expect(calls.every((c) => c.headers["Accept"] === "application/geo+json")).toBe(true);
    const payload = recorded[0]?.payload;
    expect(payload?.points).toEqual({
      forecast_hourly_url: "https://api.weather.gov/gridpoints/MFL/110,50/forecast/hourly",
      station_id: "KMIA",
    });
    expect(payload?.observation?.wind_mph).toBe(33.6);
    expect(payload?.alerts).toHaveLength(2);
    expect(payload?.forecast).toHaveLength(2);
  });

  it("reuses the cached points for 30 days and fetches the forecast at most once an hour", async () => {
    const { fetchImpl, calls } = scriptedFetch(ROUTES);
    const { store, recorded } = memoryStore([
      {
        ...FEED,
        nws_forecast_hourly_url: "https://api.weather.gov/gridpoints/MFL/110,50/forecast/hourly",
        nws_station_id: "KMIA",
        points_checked_at: "2027-05-20T00:00:00Z",
        forecast_fetched_at: "2027-06-02T18:40:00Z",
      },
    ]);
    await runNwsFeed({ fetch: fetchImpl, store, userAgent: "XOS", now: () => NOW });
    expect(calls.map((c) => c.url.replace("https://api.weather.gov", ""))).toEqual([
      "/stations/KMIA/observations/latest",
      "/alerts/active?point=25.7654,-80.1235",
    ]);
    expect(recorded[0]?.payload.points).toBeUndefined();
    expect(recorded[0]?.payload.forecast).toBeUndefined();
  });

  it("fetches nothing without XOS_WEATHER_USER_AGENT and records the reason for every due feed", async () => {
    const { fetchImpl, calls } = scriptedFetch(ROUTES);
    const { store, recorded, failed } = memoryStore([FEED, { ...FEED, feed_id: "feed-2" }]);
    const summary = await runNwsFeed({
      fetch: fetchImpl,
      store,
      userAgent: undefined,
      now: () => NOW,
    });
    expect(summary).toEqual({ due: 2, succeeded: 0, failed: 2 });
    expect(calls).toEqual([]);
    expect(recorded).toEqual([]);
    expect(failed).toEqual([
      { feedId: "feed-1", error: MISSING_USER_AGENT },
      { feedId: "feed-2", error: MISSING_USER_AGENT },
    ]);
  });

  it("retries a 5xx once, so a passing error does not lose the poll", async () => {
    const { fetchImpl, calls } = scriptedFetch(ROUTES);
    let failures = 1;
    const flaky = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/alerts/active") && failures > 0) {
        failures -= 1;
        return new Response("{}", { status: 503 });
      }
      return fetchImpl(input as string, init);
    }) as typeof fetch;
    const { store, recorded, failed } = memoryStore([FEED]);
    const summary = await runNwsFeed({ fetch: flaky, store, userAgent: "XOS", now: () => NOW });
    expect(summary).toEqual({ due: 1, succeeded: 1, failed: 0 });
    expect(failed).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/alerts/active"))).toHaveLength(1);
  });

  it("does not retry a 4xx, and tries a 5xx only twice", async () => {
    const notFound = scriptedFetch(ROUTES, { "/alerts/active?point=25.7654,-80.1235": 404 });
    await runNwsFeed({
      fetch: notFound.fetchImpl,
      store: memoryStore([FEED]).store,
      userAgent: "XOS",
      now: () => NOW,
    });
    expect(notFound.calls.filter((c) => c.url.includes("/alerts/active"))).toHaveLength(1);
    const down = scriptedFetch(ROUTES, { "/alerts/active?point=25.7654,-80.1235": 503 });
    await runNwsFeed({
      fetch: down.fetchImpl,
      store: memoryStore([FEED]).store,
      userAgent: "XOS",
      now: () => NOW,
    });
    expect(down.calls.filter((c) => c.url.includes("/alerts/active"))).toHaveLength(2);
  });

  it("records an NWS error as a failed run and goes on to the next feed", async () => {
    const { fetchImpl } = scriptedFetch(ROUTES, { "/alerts/active?point=25.7654,-80.1235": 503 });
    const { store, recorded, failed } = memoryStore([FEED]);
    const summary = await runNwsFeed({ fetch: fetchImpl, store, userAgent: "XOS", now: () => NOW });
    expect(summary).toEqual({ due: 1, succeeded: 0, failed: 1 });
    expect(recorded).toEqual([]);
    expect(failed[0]?.error).toBe("The NWS answered HTTP 503 for /alerts/active.");
  });
});

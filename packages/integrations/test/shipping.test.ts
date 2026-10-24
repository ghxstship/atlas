import { afterEach, describe, expect, it, vi } from "vitest";
import { httpFromFetch, type FetchLike } from "../src/framework/http.ts";
import type { Credential } from "../src/framework/support.ts";
import {
  CarrierTokenCache,
  dhlCarrier,
  fedexCarrier,
  shipmentTracking,
  startTracking,
  stopTracking,
  supabaseTrackingSource,
  trackingConnector,
  trackingConnectors,
  trackingScans,
  TOKEN_SAFETY_MARGIN_MS,
  upsCarrier,
  usesClientCredentials,
  type TrackingSource,
  type TrackingUpdate,
} from "../src/connectors/shipping/index.ts";
import {
  bodyOf,
  contextFor,
  dbError,
  memoryStore,
  okData,
  recordingDb,
  scriptedHttp,
} from "./doubles.ts";

const run = { scope: "Tracking Refresh" as const, direction: "Inbound" as const };

// Fixture values only, shorter than any real carrier credential.
const upsPair: Credential = {
  token: "",
  fields: { client_id: "ups-cid", client_secret: "ups-sec1" },
};
const fedexPair: Credential = {
  token: "",
  fields: { client_id: "fdx-cid", client_secret: "fx+s/c=1" },
};
const UPS_TOKEN_URL = "https://onlinetools.ups.com/security/v1/oauth/token";
const FEDEX_TOKEN_URL = "https://apis.fedex.com/oauth/token";
const upsToken = {
  match: `POST ${UPS_TOKEN_URL}`,
  respond: () => ({ json: { access_token: "ups-tok", expires_in: "14399" } }),
};
const fedexToken = {
  match: `POST ${FEDEX_TOKEN_URL}`,
  respond: () => ({ json: { access_token: "fdx-tok", expires_in: 3599 } }),
};

function source(numbers: string[] = ["1Z999AA10123456784"], added = 2) {
  const recorded: [string, TrackingUpdate][] = [];
  const value: TrackingSource = {
    openTrackers: async () =>
      numbers.map((n, i) => ({ id: `t-${i}`, shipmentId: `s-${i}`, trackingNumber: n })),
    record: async (id, update) => {
      recorded.push([id, update]);
      return added;
    },
  };
  return { value, recorded };
}

describe("UPS", () => {
  it("normalizes activity, estimate and delivery", async () => {
    const { http, requests } = scriptedHttp([
      upsToken,
      {
        match: "GET https://onlinetools.ups.com/api/track/v1/details/1Z999AA10123456784",
        respond: () => ({
          json: {
            trackResponse: {
              shipment: [
                {
                  package: [
                    {
                      currentStatus: { type: "D", description: "Delivered" },
                      deliveryDate: [{ type: "DEL", date: "20270603" }],
                      activity: [
                        {
                          status: { type: "D", code: "KB", description: "Delivered" },
                          location: {
                            address: { city: "Miami", stateProvince: "FL", countryCode: "US" },
                          },
                          date: "20270603",
                          time: "151200",
                        },
                        {
                          status: { type: "I", code: "DP", description: "Departed" },
                          date: "20270602",
                          time: "030000",
                        },
                        { status: { type: "M" }, date: "20270601" },
                        { status: { type: "I" }, date: "bad" },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        }),
      },
    ]);
    const s = source();
    const outcome = await trackingConnector(upsCarrier(new CarrierTokenCache()), s.value).sync(
      contextFor("ups", { http, store: memoryStore().store, run, credential: upsPair }),
    );
    expect(requests[1]?.headers).toMatchObject({
      authorization: "Bearer ups-tok",
      transid: "run-1",
    });
    const update = s.recorded[0]?.[1];
    expect(update).toMatchObject({
      status: "Delivered",
      statusText: "Delivered",
      deliveredAt: "2027-06-03T00:00:00Z",
      estimatedDeliveryAt: null,
    });
    expect(update?.scans).toEqual([
      {
        status: "Delivered",
        code: "KB",
        description: "Delivered",
        location: "Miami, FL, US",
        occurredAt: "2027-06-03T15:12:00Z",
      },
      {
        status: "In Transit",
        code: "DP",
        description: "Departed",
        location: null,
        occurredAt: "2027-06-02T03:00:00Z",
      },
      {
        status: "Label Created",
        code: "M",
        description: "",
        location: null,
        occurredAt: "2027-06-01T00:00:00Z",
      },
    ]);
    expect(outcome.counts).toEqual({ read: 1, written: 1, skipped: 0, failed: 0 });
  });

  it("falls back to scans, estimates and unknown numbers", async () => {
    const { http } = scriptedHttp([
      upsToken,
      {
        match: "GET https://onlinetools.ups.com/api/track/v1/details/GONE00",
        respond: () => ({ status: 404 }),
      },
      {
        match: "GET https://onlinetools.ups.com/api/track/v1/details/EMPTY0",
        respond: () => ({ json: { trackResponse: { shipment: [{}] } } }),
      },
      {
        match: "GET https://onlinetools.ups.com/api/track/v1/details/MOVING",
        respond: () => ({
          json: {
            trackResponse: {
              shipment: [
                {
                  package: [
                    {
                      deliveryDate: [{ type: "SDD", date: "20270605" }],
                      activity: [
                        {
                          status: { type: "X", description: "Weather delay" },
                          date: "20270604",
                          time: "120000",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        }),
      },
      {
        match: "GET https://onlinetools.ups.com/api/track/v1/details/QUIET0",
        respond: () => ({
          json: { trackResponse: { shipment: [{ package: [{ currentStatus: { type: "D" } }] }] } },
        }),
      },
    ]);
    const s = source(["GONE00", "EMPTY0", "MOVING", "QUIET0"], 0);
    const memory = memoryStore();
    const outcome = await trackingConnector(upsCarrier(new CarrierTokenCache()), s.value).sync(
      contextFor("ups", { http, store: memory.store, run, credential: upsPair }),
    );
    expect(memory.itemErrors.map((e) => e.code)).toEqual([
      "tracking_number_unknown",
      "tracking_number_unknown",
    ]);
    expect(memory.itemErrors[0]?.ref).toEqual({
      entity: "Shipment",
      localId: "s-0",
      externalId: "GONE00",
    });
    expect(s.recorded[0]?.[1]).toMatchObject({
      status: "Exception",
      statusText: "Weather delay",
      estimatedDeliveryAt: "2027-06-05T00:00:00Z",
      deliveredAt: null,
    });
    expect(s.recorded[1]?.[1]).toMatchObject({
      status: "Delivered",
      statusText: null,
      deliveredAt: null,
    });
    expect(outcome.counts).toEqual({ read: 4, written: 0, skipped: 2, failed: 2 });
    const denied = scriptedHttp([
      upsToken,
      { match: "GET https://onlinetools.ups.com", respond: () => ({ status: 401 }) },
    ]);
    await expect(
      trackingConnector(upsCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("ups", { http: denied.http, store: memory.store, run, credential: upsPair }),
      ),
    ).rejects.toMatchObject({ code: "credential_refused" });
    await expect(
      trackingConnector(upsCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("ups", { http, store: memory.store, run, credential: null }),
      ),
    ).rejects.toMatchObject({ code: "credential_required" });
  });
});

describe("FedEx", () => {
  it("normalizes scan events and delivery", async () => {
    const { http, requests } = scriptedHttp([
      fedexToken,
      {
        match: "POST https://apis.fedex.com/track/v1/trackingnumbers",
        respond: (r) => {
          const number = (
            bodyOf(r) as { trackingInfo: { trackingNumberInfo: { trackingNumber: string } }[] }
          ).trackingInfo[0]?.trackingNumberInfo.trackingNumber;
          if (number === "794600000000")
            return {
              json: {
                output: {
                  completeTrackResults: [
                    { trackResults: [{ error: { code: "TRACKING.TRACKINGNUMBER.NOTFOUND" } }] },
                  ],
                },
              },
            };
          if (number === "794600000001") return { json: { output: {} } };
          if (number === "794600000002")
            return {
              json: {
                output: {
                  completeTrackResults: [
                    {
                      trackResults: [
                        { scanEvents: [{ date: "2027-06-02T08:00:00-04:00", eventType: "AR" }] },
                      ],
                    },
                  ],
                },
              },
            };
          return {
            json: {
              output: {
                completeTrackResults: [
                  {
                    trackResults: [
                      {
                        latestStatusDetail: { code: "DL", description: "Delivered" },
                        dateAndTimes: [
                          { type: "ACTUAL_DELIVERY", dateTime: "2027-06-03T10:00:00-04:00" },
                        ],
                        estimatedDeliveryTimeWindow: {
                          window: { ends: "2027-06-03T20:00:00-04:00" },
                        },
                        scanEvents: [
                          {
                            date: "2027-06-03T10:00:00-04:00",
                            eventType: "DL",
                            eventDescription: "Delivered",
                            derivedStatusCode: "DL",
                            scanLocation: {
                              city: "MIAMI",
                              stateOrProvinceCode: "FL",
                              countryCode: "US",
                            },
                          },
                          { eventType: "IT" },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          };
        },
      },
    ]);
    const s = source(["794698761234", "794600000000", "794600000001", "794600000002"]);
    const memory = memoryStore();
    await trackingConnector(fedexCarrier(new CarrierTokenCache()), s.value).sync(
      contextFor("fedex", { http, store: memory.store, run, credential: fedexPair }),
    );
    expect(requests[1]?.headers).toMatchObject({ authorization: "Bearer fdx-tok" });
    expect(bodyOf(requests[1])).toEqual({
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: "794698761234" } }],
    });
    expect(s.recorded[0]?.[1]).toEqual({
      status: "Delivered",
      statusText: "Delivered",
      estimatedDeliveryAt: "2027-06-03T20:00:00-04:00",
      deliveredAt: "2027-06-03T10:00:00-04:00",
      scans: [
        {
          status: "Delivered",
          code: "DL",
          description: "Delivered",
          location: "MIAMI, FL, US",
          occurredAt: "2027-06-03T14:00:00.000Z",
        },
      ],
    });
    expect(s.recorded[1]?.[1]).toMatchObject({
      status: "In Transit",
      statusText: null,
      deliveredAt: null,
      scans: [{ code: "AR", description: "" }],
    });
    expect(memory.itemErrors).toHaveLength(2);
  });
});

/**
 * A fake fetch standing in for UPS and FedEx on one clock: each token request mints the next token for the
 * lifetime the carrier states, and tracking refuses an expired, revoked or unknown token with 401, as the
 * carriers do.
 */
function carrierWorld(options: { lifetimeSeconds?: number; refuseTokens?: boolean } = {}) {
  let clock = Date.parse("2027-06-30T12:00:00Z");
  const expiry = new Map<string, number>();
  const revoked = new Set<string>();
  const minted: string[] = [];
  const mintRequests: { url: string; headers: Headers; body: string }[] = [];
  const tracked: string[] = [];
  let refused = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    if (url === UPS_TOKEN_URL || url === FEDEX_TOKEN_URL) {
      const ups = url === UPS_TOKEN_URL;
      mintRequests.push({ url, headers, body: String(init.body) });
      const token = `${ups ? "ups" : "fdx"}-tok-${minted.length + 1}`;
      minted.push(token);
      const lifetime = options.lifetimeSeconds ?? (ups ? 14399 : 3599);
      expiry.set(token, clock + lifetime * 1000);
      return Response.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: ups ? String(lifetime) : lifetime,
      });
    }
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    tracked.push(token);
    const until = expiry.get(token);
    if (options.refuseTokens || until === undefined || clock >= until || revoked.has(token)) {
      refused += 1;
      return Response.json(
        {
          response: {
            errors: [{ code: "250002", message: "Invalid Authentication Information." }],
          },
        },
        { status: 401 },
      );
    }
    return url.startsWith("https://apis.fedex.com")
      ? Response.json({
          output: {
            completeTrackResults: [
              { trackResults: [{ latestStatusDetail: { code: "IT", description: "In transit" } }] },
            ],
          },
        })
      : Response.json({
          trackResponse: {
            shipment: [{ package: [{ currentStatus: { type: "I", description: "On the way" } }] }],
          },
        });
  };
  const http = httpFromFetch(fetchImpl);
  return {
    minted,
    mintRequests,
    tracked,
    revoked,
    refused: () => refused,
    advance(ms: number) {
      clock += ms;
    },
    async sync(
      carrier: ReturnType<typeof upsCarrier>,
      trackers: TrackingSource,
      credential: Credential,
    ) {
      const context = contextFor(carrier.provider, {
        http,
        store: memoryStore().store,
        run,
        credential,
      });
      return trackingConnector(carrier, trackers).sync({ ...context, now: () => new Date(clock) });
    },
  };
}

const HOUR = 3_600_000;

/** The error a sync rejects with; fails the test when the sync succeeds. */
async function rejection(outcome: Promise<unknown>): Promise<Error> {
  try {
    await outcome;
  } catch (error) {
    return error as Error;
  }
  throw new Error("The sync was expected to fail.");
}

describe("UPS and FedEx access tokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints one UPS token per run with HTTP Basic and sends it on every tracking call", async () => {
    const world = carrierWorld();
    const s = source(["1ZA", "1ZB", "1ZC"]);
    const outcome = await world.sync(upsCarrier(new CarrierTokenCache()), s.value, upsPair);
    expect(world.minted).toEqual(["ups-tok-1"]);
    const mint = world.mintRequests[0];
    expect(mint?.headers.get("authorization")).toBe(`Basic ${btoa("ups-cid:ups-sec1")}`);
    expect(mint?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(mint?.body).toBe("grant_type=client_credentials");
    expect(world.tracked).toEqual(["ups-tok-1", "ups-tok-1", "ups-tok-1"]);
    expect(outcome.counts).toEqual({ read: 3, written: 3, skipped: 0, failed: 0 });
  });

  it("keeps tracking past token expiry: reuses the cached token, then mints before it lapses", async () => {
    const world = carrierWorld();
    const tokens = new CarrierTokenCache();
    const s = source(["1ZA", "1ZB"]);
    await world.sync(upsCarrier(tokens), s.value, upsPair);
    world.advance(3 * HOUR);
    await world.sync(upsCarrier(tokens), s.value, upsPair);
    expect(world.minted).toEqual(["ups-tok-1"]);
    // Inside the safety margin of the first token's 14399 seconds: a new token, never a refused call.
    world.advance(14399_000 - TOKEN_SAFETY_MARGIN_MS - 3 * HOUR);
    await world.sync(upsCarrier(tokens), s.value, upsPair);
    world.advance(5 * HOUR);
    await world.sync(upsCarrier(tokens), s.value, upsPair);
    expect(world.minted).toEqual(["ups-tok-1", "ups-tok-2", "ups-tok-3"]);
    expect(world.tracked).toEqual([
      "ups-tok-1",
      "ups-tok-1",
      "ups-tok-1",
      "ups-tok-1",
      "ups-tok-2",
      "ups-tok-2",
      "ups-tok-3",
      "ups-tok-3",
    ]);
    expect(world.refused()).toBe(0);
    expect(s.recorded).toHaveLength(8);
  });

  it("refreshes the token after a 401 and retries the call exactly once", async () => {
    const world = carrierWorld();
    const tokens = new CarrierTokenCache();
    const s = source(["1ZA", "1ZB"]);
    await world.sync(upsCarrier(tokens), s.value, upsPair);
    world.revoked.add("ups-tok-1");
    world.advance(HOUR);
    const outcome = await world.sync(upsCarrier(tokens), s.value, upsPair);
    expect(world.minted).toEqual(["ups-tok-1", "ups-tok-2"]);
    expect(world.tracked.slice(2)).toEqual(["ups-tok-1", "ups-tok-2", "ups-tok-2"]);
    expect(outcome.counts).toEqual({ read: 2, written: 2, skipped: 0, failed: 0 });

    const refusing = carrierWorld({ refuseTokens: true });
    await expect(
      refusing.sync(upsCarrier(new CarrierTokenCache()), source().value, upsPair),
    ).rejects.toMatchObject({ code: "credential_refused", connectionError: true });
    expect(refusing.minted).toEqual(["ups-tok-1", "ups-tok-2"]);
    expect(refusing.tracked).toEqual(["ups-tok-1", "ups-tok-2"]);
  });

  it("mints FedEx tokens with the pair in the form body and refreshes them each hour", async () => {
    const world = carrierWorld();
    const tokens = new CarrierTokenCache();
    const s = source(["794600000001", "794600000002"]);
    await world.sync(fedexCarrier(tokens), s.value, fedexPair);
    const mint = world.mintRequests[0];
    expect(mint?.url).toBe(FEDEX_TOKEN_URL);
    expect(mint?.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(mint?.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "fdx-cid",
      client_secret: "fx+s/c=1",
    });
    world.advance(3599_000 - TOKEN_SAFETY_MARGIN_MS);
    await world.sync(fedexCarrier(tokens), s.value, fedexPair);
    world.advance(HOUR / 2);
    await world.sync(fedexCarrier(tokens), s.value, fedexPair);
    expect(world.minted).toEqual(["fdx-tok-1", "fdx-tok-2"]);
    expect(world.tracked).toEqual([
      "fdx-tok-1",
      "fdx-tok-1",
      "fdx-tok-2",
      "fdx-tok-2",
      "fdx-tok-2",
      "fdx-tok-2",
    ]);
    expect(s.recorded[0]?.[1]).toMatchObject({ status: "In Transit", statusText: "In transit" });
  });

  it("never reuses a token of a rotated secret, and keeps a short-lived token half its life", async () => {
    const world = carrierWorld();
    const tokens = new CarrierTokenCache();
    await world.sync(upsCarrier(tokens), source().value, upsPair);
    const rotated: Credential = {
      token: "",
      fields: { ...upsPair.fields, client_secret: "ups-sec2" },
    };
    await world.sync(upsCarrier(tokens), source().value, rotated);
    expect(world.minted).toEqual(["ups-tok-1", "ups-tok-2"]);

    const brief = carrierWorld({ lifetimeSeconds: 120 });
    const briefTokens = new CarrierTokenCache();
    await brief.sync(upsCarrier(briefTokens), source().value, upsPair);
    brief.advance(59_000);
    await brief.sync(upsCarrier(briefTokens), source().value, upsPair);
    brief.advance(2_000);
    await brief.sync(upsCarrier(briefTokens), source().value, upsPair);
    expect(brief.minted).toEqual(["ups-tok-1", "ups-tok-2"]);
  });

  it("keeps the client ID, secret and tokens out of errors and logs", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    // A carrier that echoes whatever it was sent into its error bodies.
    const echoing = scriptedHttp([
      {
        match: "POST https://apis.fedex.com/oauth/token",
        respond: (r) => ({ status: 401, body: `rejected ${String(r.body)}` }),
      },
      {
        match: "POST https://onlinetools.ups.com/security/v1/oauth/token",
        respond: (r) => ({ status: 401, body: `rejected ${r.headers?.["authorization"]}` }),
      },
    ]);
    const fedexError = await rejection(
      trackingConnector(fedexCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("fedex", {
          http: echoing.http,
          store: memoryStore().store,
          run,
          credential: fedexPair,
        }),
      ),
    );
    const upsError = await rejection(
      trackingConnector(upsCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("ups", {
          http: echoing.http,
          store: memoryStore().store,
          run,
          credential: upsPair,
        }),
      ),
    );
    expect(fedexError).toMatchObject({ code: "credential_refused", connectionError: true });
    expect(upsError).toMatchObject({ code: "credential_refused", connectionError: true });
    for (const secret of ["fx+s/c=1", "fx%2Bs%2Fc%3D1", "fdx-cid"])
      expect(fedexError.message).not.toContain(secret);
    for (const secret of ["ups-sec1", "ups-cid", btoa("ups-cid:ups-sec1")])
      expect(upsError.message).not.toContain(secret);
    expect(fedexError.message).toContain("[redacted]");

    const leaking = scriptedHttp([
      upsToken,
      {
        match: "GET https://onlinetools.ups.com/api/track",
        respond: (r) => ({ status: 503, body: `down for ${r.headers?.["authorization"]}` }),
      },
    ]);
    const trackError = await rejection(
      trackingConnector(upsCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("ups", {
          http: leaking.http,
          store: memoryStore().store,
          run,
          credential: upsPair,
        }),
      ),
    );
    expect(trackError).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(trackError.message).toBe("UPS returned 503: down for Bearer [redacted]");

    // A network failure keeps its name, so the runner still retries it as unreachable.
    const unreachable = httpFromFetch(async (_url, init) => {
      throw new TypeError(`fetch failed sending ${String(init.body)}`);
    });
    const networkError = await rejection(
      trackingConnector(fedexCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("fedex", {
          http: unreachable,
          store: memoryStore().store,
          run,
          credential: fedexPair,
        }),
      ),
    );
    expect(networkError.name).toBe("TypeError");
    expect(networkError.message).not.toContain("fx%2Bs%2Fc%3D1");
    expect(networkError.message).toContain("client_secret=[redacted]");
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("asks for the client ID and secret, and refuses a token answer it cannot use", async () => {
    const { http, requests } = scriptedHttp([upsToken]);
    await expect(
      trackingConnector(upsCarrier(new CarrierTokenCache()), source().value).sync(
        contextFor("ups", { http, store: memoryStore().store, run }),
      ),
    ).rejects.toMatchObject({
      code: "credential_incomplete",
      connectionError: true,
      message: expect.stringContaining("client ID and client secret") as unknown,
    });
    expect(requests).toHaveLength(0);
    for (const answer of [
      { json: {} },
      { body: "not json" },
      { json: null },
      { json: { access_token: "ups-tok", expires_in: "soon" } },
    ]) {
      const odd = scriptedHttp([{ match: `POST ${UPS_TOKEN_URL}`, respond: () => answer }]);
      await expect(
        trackingConnector(upsCarrier(new CarrierTokenCache()), source().value).sync(
          contextFor("ups", {
            http: odd.http,
            store: memoryStore().store,
            run,
            credential: upsPair,
          }),
        ),
      ).rejects.toMatchObject({ code: "provider_malformed_response", retryable: true });
    }
    expect(["ups", "fedex", "dhl"].map(usesClientCredentials)).toEqual([true, true, false]);
  });
});

describe("DHL", () => {
  it("normalizes events with the API key header", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api-eu.dhl.com/track/shipments?trackingNumber=00340434292135100186",
        respond: () => ({
          json: {
            shipments: [
              {
                status: {
                  statusCode: "delivered",
                  status: "DELIVERED",
                  timestamp: "2027-06-03T12:00:00Z",
                },
                estimatedTimeOfDelivery: "2027-06-03T18:00:00Z",
                events: [
                  {
                    timestamp: "2027-06-03T12:00:00Z",
                    statusCode: "delivered",
                    description: "Delivered",
                    location: { address: { addressLocality: "Miami" } },
                  },
                  { statusCode: "transit" },
                ],
              },
            ],
          },
        }),
      },
      {
        match: "GET https://api-eu.dhl.com/track/shipments?trackingNumber=UNKNOWN1",
        respond: () => ({ status: 404 }),
      },
      {
        match: "GET https://api-eu.dhl.com/track/shipments?trackingNumber=EMPTY000",
        respond: () => ({ json: { shipments: [] } }),
      },
      {
        match: "GET https://api-eu.dhl.com/track/shipments?trackingNumber=MOVING00",
        respond: () => ({
          json: {
            shipments: [
              {
                status: { statusCode: "weird" },
                events: [{ timestamp: "2027-06-02T00:00:00Z", status: "Processed" }],
              },
            ],
          },
        }),
      },
      {
        match: "GET https://api-eu.dhl.com/track/shipments?trackingNumber=LATE0000",
        respond: () => ({
          json: { shipments: [{ status: { statusCode: "delivered", description: "Delivered" } }] },
        }),
      },
    ]);
    const s = source(["00340434292135100186", "UNKNOWN1", "EMPTY000", "MOVING00", "LATE0000"]);
    const memory = memoryStore();
    await trackingConnector(dhlCarrier, s.value).sync(
      contextFor("dhl", { http, store: memory.store, run }),
    );
    expect(requests[0]?.headers).toMatchObject({ "dhl-api-key": "fixture-token" });
    expect(s.recorded[0]?.[1]).toEqual({
      status: "Delivered",
      statusText: "DELIVERED",
      estimatedDeliveryAt: "2027-06-03T18:00:00Z",
      deliveredAt: "2027-06-03T12:00:00Z",
      scans: [
        {
          status: "Delivered",
          code: "delivered",
          description: "Delivered",
          location: "Miami",
          occurredAt: "2027-06-03T12:00:00.000Z",
        },
      ],
    });
    expect(s.recorded[1]?.[1]).toMatchObject({
      status: "Unknown",
      statusText: null,
      scans: [{ status: "Unknown", code: "unknown", description: "Processed" }],
    });
    expect(s.recorded[2]?.[1]).toMatchObject({
      status: "Delivered",
      statusText: "Delivered",
      deliveredAt: null,
    });
    expect(memory.itemErrors).toHaveLength(2);
    const down = scriptedHttp([
      { match: "GET https://api-eu.dhl.com", respond: () => ({ status: 500 }) },
    ]);
    await expect(
      trackingConnector(dhlCarrier, source().value).sync(
        contextFor("dhl", { http: down.http, store: memory.store, run }),
      ),
    ).rejects.toMatchObject({ retryable: true });
    expect(trackingConnectors(source().value).map((c) => c.provider)).toEqual([
      "ups",
      "fedex",
      "dhl",
    ]);
  });
});

describe("tracking source and the A11 interface", () => {
  it("reads open trackers and records updates for the runner", async () => {
    const { db, calls } = recordingDb({
      "from:shipment_trackers": [okData([{ id: "t", shipment_id: "s", tracking_number: "N" }])],
      "rpc:record_tracking_update": [okData(1)],
    });
    const s = supabaseTrackingSource(db);
    expect(await s.openTrackers("c")).toEqual([{ id: "t", shipmentId: "s", trackingNumber: "N" }]);
    expect(calls[0]?.steps).toContainEqual([
      "not",
      ["tracking_status", "in", "(Delivered,Returned)"],
    ]);
    expect(
      await s.record("t", {
        status: "In Transit",
        statusText: null,
        estimatedDeliveryAt: null,
        deliveredAt: null,
        scans: [
          {
            status: "In Transit",
            code: "DP",
            description: "Departed",
            location: null,
            occurredAt: "2027-06-02T03:00:00Z",
          },
        ],
      }),
    ).toBe(1);
    expect(calls[1]?.steps[0]?.[1]).toMatchObject([
      {
        p_events: [
          {
            status: "In Transit",
            code: "DP",
            description: "Departed",
            location: null,
            occurred_at: "2027-06-02T03:00:00Z",
          },
        ],
      },
    ]);
  });

  it("lets logistics pages read, start and stop tracking as the person", async () => {
    const row = {
      id: "t",
      shipment_id: "s",
      integration_connection_id: "c",
      tracking_number: "N",
      tracking_status: "In Transit",
      carrier_status_text: null,
      estimated_delivery_at: null,
      delivered_at: null,
      last_checked_at: null,
    };
    const { db, calls } = recordingDb({
      "from:shipment_trackers": [
        okData([row]),
        dbError("42501", "denied"),
        okData(row),
        dbError(
          "XR001",
          "integration_not_connected: Track shipments through a Connected carrier connection.",
          "integration_not_connected",
        ),
        okData({ id: "t" }),
        okData(null),
        dbError("08006", "down"),
      ],
      "from:shipment_tracking_events": [
        okData([
          {
            tracking_status: "Delivered",
            carrier_status_code: "D",
            description: "Delivered",
            location_text: null,
            occurred_at: "x",
          },
        ]),
        dbError("42501", "denied"),
      ],
    });
    const tracking = await shipmentTracking(db, ["s"]);
    expect(tracking.ok && tracking.data.get("s")?.status).toBe("In Transit");
    expect(await shipmentTracking(db, [])).toEqual({ ok: true, data: new Map() });
    expect(await shipmentTracking(db, ["s"])).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await startTracking(db, "s", "c", " 1Z999 ")).ok).toBe(true);
    expect(calls[2]?.steps[0]).toEqual([
      "insert",
      [{ shipment_id: "s", integration_connection_id: "c", tracking_number: "1Z999" }],
    ]);
    expect(await startTracking(db, "s", "c")).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "integration_not_connected" },
    });
    expect(await stopTracking(db, "t")).toEqual({ ok: true, data: null });
    expect(await stopTracking(db, "t")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect(await stopTracking(db, "t")).toMatchObject({ ok: false, error: { kind: "unexpected" } });
    expect(await trackingScans(db, "t")).toEqual({
      ok: true,
      data: [
        {
          status: "Delivered",
          code: "D",
          description: "Delivered",
          location: null,
          occurredAt: "x",
        },
      ],
    });
    expect(await trackingScans(db, "t")).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});

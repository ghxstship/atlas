import { describe, expect, it } from "vitest";
import {
  dhlCarrier,
  fedexCarrier,
  shipmentTracking,
  startTracking,
  stopTracking,
  supabaseTrackingSource,
  trackingConnector,
  trackingConnectors,
  trackingScans,
  upsCarrier,
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
    const outcome = await trackingConnector(upsCarrier, s.value).sync(
      contextFor("ups", { http, store: memoryStore().store, run }),
    );
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer fixture-token",
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
    const outcome = await trackingConnector(upsCarrier, s.value).sync(
      contextFor("ups", { http, store: memory.store, run }),
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
      { match: "GET https://onlinetools.ups.com", respond: () => ({ status: 401 }) },
    ]);
    await expect(
      trackingConnector(upsCarrier, source().value).sync(
        contextFor("ups", { http: denied.http, store: memory.store, run }),
      ),
    ).rejects.toMatchObject({ code: "credential_refused" });
    await expect(
      trackingConnector(upsCarrier, source().value).sync(
        contextFor("ups", { http, store: memory.store, run, credential: null }),
      ),
    ).rejects.toMatchObject({ code: "credential_required" });
  });
});

describe("FedEx", () => {
  it("normalizes scan events and delivery", async () => {
    const { http, requests } = scriptedHttp([
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
    await trackingConnector(fedexCarrier, s.value).sync(
      contextFor("fedex", { http, store: memory.store, run }),
    );
    expect(bodyOf(requests[0])).toEqual({
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

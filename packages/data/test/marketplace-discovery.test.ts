import { describe, expect, it } from "vitest";
import {
  listMarketplacePlaces,
  listMyAlerts,
  listMySavedSearches,
  passOpportunity,
  RECOMMENDATION_WEIGHTS,
  restoreSavedSearch,
  saveSearch,
  searchMarketplace,
  toDisplayKey,
  undoPass,
  unsaveListing,
} from "../src/gateway.ts";
import { getMyQuietHours, setMyQuietHours } from "../src/party-notifications.ts";
import { listCategoriesInDiscipline } from "../src/canon.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";
import { gatewayClient } from "./gateway-client.ts";

const OPP = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61";

const ranked = {
  id: OPP,
  org_id: "o1",
  org_name: "Northwind Live",
  org_verified: true,
  title: "Delay Tower Audio",
  description: null,
  role_type: "Vendor",
  role_code: null,
  cat_urid: "5000.01.02",
  venue_name: "Bayfront Pier Stage",
  venue_locality: "Miami",
  venue_latitude: 25.7752,
  venue_longitude: -80.1855,
  jurisdiction_id: "US-FL-MIAMI-DADE",
  starts_on: "2027-06-04",
  ends_on: "2027-06-06",
  visibility: "Public",
  rate_type: null,
  pay_min_minor: null,
  pay_max_minor: null,
  currency_code: null,
  rate_on_request: null,
  deadline_at: "2027-05-01T00:00:00Z",
  minimum_age: null,
  opportunity_state: "Published",
  position_count: null,
  distance_km: "12.4",
  recommendation_score: 85,
  skill_points: 25,
  certification_points: 30,
  location_points: 20,
  availability_points: 10,
  certifications_required: 0,
  certifications_met: 0,
  is_saved: false,
  is_passed: false,
  client_hidden: false,
};

describe("ranked marketplace search (A89, 1460)", () => {
  it("passes every filter to app.search_marketplace and maps the score parts", async () => {
    const { db, calls } = fakeClient({
      "rpc:search_marketplace": [
        okResponse([ranked]),
        errorResponse("XR001", "x", "marketplace_sort_unknown"),
      ],
    });
    const result = await searchMarketplace(db, {
      query: " towers ",
      roleTypes: ["Vendor"],
      discCode: "5000.01",
      catUrid: "5000.01.02",
      startsAfter: "2027-06-01",
      endsBefore: "2027-06-30",
      minPayMinor: 50000,
      certificationName: " ETCP ",
      near: { label: "Miami", latitude: 25.77, longitude: -80.19, radiusKm: 50 },
      orgId: "o1",
      sort: "soonest",
      includePassed: true,
      limit: 12,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_query: "towers",
          p_role_types: ["Vendor"],
          p_disc_code: "5000.01",
          p_cat_urid: "5000.01.02",
          p_starts_after: "2027-06-01",
          p_ends_before: "2027-06-30",
          p_min_pay_minor: 50000,
          p_currency_code: "USD",
          p_certification_name: "ETCP",
          p_near_latitude: 25.77,
          p_near_longitude: -80.19,
          p_radius_km: 50,
          p_org_id: "o1",
          p_sort: "soonest",
          p_include_passed: true,
          p_limit: 12,
        },
      ],
    ]);
    expect(result.ok && result.data[0]).toMatchObject({
      key: toDisplayKey("opportunity", OPP),
      orgVerified: true,
      rateOnRequest: true,
      positionCount: 0,
      distanceKm: 12.4,
      recommendation: { score: 85, skills: 25, certifications: 30, location: 20, availability: 10 },
    });
    expect((await searchMarketplace(db)).ok).toBe(false);
  });

  it("maps a hidden client's listing (2871): no venue name, the rounded point, whole kilometers", async () => {
    const { db } = fakeClient({
      "rpc:search_marketplace": [
        okResponse([
          {
            ...ranked,
            venue_name: null,
            venue_latitude: 25.8,
            venue_longitude: -80.2,
            distance_km: "3",
            client_hidden: true,
          },
          { ...ranked, id: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f62", client_hidden: null },
        ]),
      ],
    });
    const result = await searchMarketplace(db);
    expect(result.ok && result.data[0]).toMatchObject({
      clientHidden: true,
      venueName: null,
      venueLocality: "Miami",
      venueLatitude: 25.8,
      venueLongitude: -80.2,
      distanceKm: 3,
    });
    expect(result.ok && result.data[1]?.clientHidden).toBe(false);
  });

  it("asks for the best match with no filters by default", async () => {
    const { db, calls } = fakeClient({ "rpc:search_marketplace": [okResponse(null)] });
    expect(await searchMarketplace(db)).toEqual({ ok: true, data: [] });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_sort: "recommended", p_include_passed: false, p_limit: 100 }],
    ]);
  });

  it("publishes weights that add up to 100", () => {
    expect(Object.values(RECOMMENDATION_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("places, passing and alerts", () => {
  it("lists places to search near", async () => {
    const { db } = fakeClient({
      "rpc:marketplace_places": [
        okResponse([{ label: "Miami", latitude: 25.7, longitude: -80.2, listing_count: 3 }]),
        errorResponse("08000", "down"),
      ],
    });
    expect(await listMarketplacePlaces(db)).toEqual({
      ok: true,
      data: [{ label: "Miami", latitude: 25.7, longitude: -80.2, listingCount: 3 }],
    });
    expect((await listMarketplacePlaces(db)).ok).toBe(false);
  });

  it("passes, undoes a pass and unsaves by the listing", async () => {
    const { db, calls } = fakeClient({
      "from:passed_opportunities": [
        okResponse(null),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
      "from:saved_opportunities": [okResponse(null)],
      "from:saved_searches": [okResponse(null)],
    });
    expect((await passOpportunity(db, OPP)).ok).toBe(true);
    expect(calls[0]?.steps[0]).toEqual(["insert", [{ opportunity_id: OPP }]]);
    expect((await undoPass(db, OPP)).ok).toBe(true);
    expect(calls[1]?.steps).toContainEqual(["eq", ["opportunity_id", OPP]]);
    expect(calls[1]?.steps).toContainEqual(["is", ["deleted_at", null]]);
    expect((await undoPass(db, OPP)).ok).toBe(false);
    expect((await unsaveListing(db, OPP)).ok).toBe(true);
    expect((await restoreSavedSearch(db, "s1")).ok).toBe(true);
    expect(calls[4]?.steps[0]).toEqual(["update", [{ deleted_at: null }]]);
  });

  it("lists recent alert matches", async () => {
    const { db } = gatewayClient({
      "from:api_external.my_opportunity_alerts": [
        okResponse([
          {
            id: "a1",
            saved_search_id: "s1",
            opportunity_id: OPP,
            matched_at: "2026-10-21T12:00:00Z",
            delivered_at: null,
            is_open: true,
          },
        ]),
        errorResponse("42501", "no"),
      ],
    });
    const alerts = await listMyAlerts(db, 5);
    expect(alerts.ok && alerts.data[0]).toEqual({
      id: "a1",
      savedSearchId: "s1",
      opportunityId: OPP,
      matchedAt: "2026-10-21T12:00:00Z",
      deliveredAt: null,
      open: true,
    });
    expect((await listMyAlerts(db)).ok).toBe(false);
  });
});

describe("saved search filters", () => {
  it("saves every Explore filter", async () => {
    const { db, calls } = gatewayClient({ "from:saved_searches": [okResponse({ id: "ss1" })] });
    await saveSearch(db, {
      personId: "me",
      name: "Audio near Miami",
      roleType: null,
      startsAfter: null,
      endsBefore: null,
      orgId: null,
      query: " towers ",
      discCode: "5000.01",
      catUrid: "5000.01.02",
      certificationName: " ETCP ",
      near: { label: "Miami", latitude: 25.77, longitude: -80.19, radiusKm: 50 },
      minPayMinor: 50000,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          person_id: "me",
          name: "Audio near Miami",
          role_type: null,
          starts_after: null,
          ends_before: null,
          org_id: null,
          query_text: "towers",
          disc_code: "5000.01",
          cat_urid: "5000.01.02",
          certification_name: "ETCP",
          near_label: "Miami",
          near_latitude: 25.77,
          near_longitude: -80.19,
          radius_km: 50,
          min_rate_minor: 50000,
          currency_code: "USD",
        },
      ],
    ]);
  });

  it("reads the filters back", async () => {
    const { db } = gatewayClient({
      "from:api_external.my_saved_searches": [
        okResponse([
          {
            id: "s1",
            name: "Audio",
            role_type: null,
            starts_after: null,
            ends_before: null,
            alerts_enabled: true,
            query_text: "towers",
            disc_code: "5000.01",
            cat_urid: null,
            certification_name: null,
            near_label: "Miami",
            near_latitude: 25.77,
            near_longitude: -80.19,
            radius_km: 50,
            min_rate_minor: null,
          },
        ]),
      ],
    });
    const listed = await listMySavedSearches(db);
    expect(listed.ok && listed.data[0]).toMatchObject({
      query: "towers",
      discCode: "5000.01",
      near: { label: "Miami", latitude: 25.77, longitude: -80.19, radiusKm: 50 },
    });
  });
});

describe("quiet hours and canon categories", () => {
  it("reads and saves a person's own quiet hours", async () => {
    const { db, calls } = fakeClient({
      "from:person_notification_settings": [
        okResponse({
          time_zone: "America/New_York",
          quiet_hours_start: "22:00:00",
          quiet_hours_end: "07:00:00",
        }),
        okResponse(null),
        errorResponse("42501", "no"),
      ],
      "rpc:set_my_quiet_hours": [
        okResponse(null),
        errorResponse("XR001", "x", "time_zone_unknown"),
      ],
    });
    expect(await getMyQuietHours(db)).toEqual({
      ok: true,
      data: { timeZone: "America/New_York", start: "22:00", end: "07:00" },
    });
    expect(await getMyQuietHours(db)).toEqual({ ok: true, data: null });
    expect((await getMyQuietHours(db)).ok).toBe(false);
    expect(
      (await setMyQuietHours(db, { timeZone: "America/New_York", start: null, end: null })).ok,
    ).toBe(true);
    expect(calls[3]?.steps[0]).toEqual(["args", [{ p_time_zone: "America/New_York" }]]);
    expect(
      (await setMyQuietHours(db, { timeZone: "Mars/Olympus", start: "22:00", end: "07:00" })).ok,
    ).toBe(false);
  });

  it("lists the categories of one discipline", async () => {
    const { db, calls } = fakeClient({
      "from:xpms.dim_category": [
        okResponse([
          {
            cat_urid: "5000.01.02",
            disc_code: "5000.01",
            category: "PA Systems",
            xyz: null,
            is_extension: false,
          },
        ]),
      ],
    });
    const result = await listCategoriesInDiscipline(db, "5000.01");
    expect(result.ok && result.data[0]?.name).toBe("PA Systems");
    expect(calls[0]?.steps).toContainEqual(["eq", ["disc_code", "5000.01"]]);
  });
});

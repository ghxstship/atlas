import { describe, expect, it } from "vitest";
import { insideNow } from "../src/credentials.ts";
import {
  getWeatherFeedBoard,
  guestByPassCode,
  isSevereWarning,
  listDoorGuests,
  listMuster,
  musterAccess,
  musterByZone,
  type MusterRow,
} from "../src/workforce-site.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/**
 * B8 (RRR-232) site reads: the scan log's Inside now (2971 app.zone_counts_live), the muster list (app.muster_list),
 * the door list's pass fields and pass lookup (2974), and the Weather page's official feed board (2976, 2977).
 */

describe("Inside now", () => {
  it("sums each zone's people and splits them by category and by team, zones by code", async () => {
    const { db, calls } = fakeClient({
      "from:zone_counts_live": [
        okResponse([
          {
            zone_id: "z2",
            credential_category_id: "c1",
            engagement_id: "e1",
            inside: 3,
            last_entry_at: "2027-06-04T20:00:00Z",
          },
          {
            zone_id: "z2",
            credential_category_id: "c2",
            engagement_id: null,
            inside: 1,
            last_entry_at: "2027-06-04T20:10:00Z",
          },
          {
            zone_id: "z1",
            credential_category_id: "c1",
            engagement_id: "e1",
            inside: 2,
            last_entry_at: "2027-06-04T19:00:00Z",
          },
        ]),
      ],
      "from:zones": [
        okResponse([
          { id: "z1", code: "BOH", name: "Back of House", venue_id: "v", venue: { name: "Arena" } },
          {
            id: "z2",
            code: "FOH",
            name: "Front of House",
            venue_id: "v",
            venue: { name: "Arena" },
          },
        ]),
      ],
      "from:credential_categories": [
        okResponse([
          { id: "c1", project_id: "p", code: "CREW", name: "Crew" },
          { id: "c2", project_id: "p", code: "VIP", name: "VIP" },
        ]),
      ],
      "from:engagements": [
        okResponse([{ id: "e1", person_id: null, counterparty: { name: "Bayside Audio" } }]),
      ],
      "rpc:person_names": [okResponse([])],
    });
    const result = await insideNow(db, { orgId: "o", projectId: "p", venueId: "v" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((z) => [z.code, z.total])).toEqual([
      ["BOH", 2],
      ["FOH", 4],
    ]);
    const foh = result.data[1];
    expect(foh?.lastEntryAt).toBe("2027-06-04T20:10:00Z");
    expect(foh?.byCategory.reduce((n, p) => n + p.inside, 0)).toBe(4);
    expect(foh?.byTeam).toEqual([
      { id: "e1", label: "Bayside Audio", inside: 3 },
      { id: null, label: null, inside: 1 },
    ]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p"]]);
  });

  it("reads nothing more when nobody is inside", async () => {
    const { db, calls } = fakeClient({ "from:zone_counts_live": [okResponse([])] });
    expect(await insideNow(db, { orgId: "o", projectId: "p", venueId: null })).toEqual({
      ok: true,
      data: [],
    });
    expect(calls).toHaveLength(1);
  });
});

describe("the muster list", () => {
  it("names people through app.person_names and keeps guests' own names", async () => {
    const { db } = fakeClient({
      "from:muster_list": [
        okResponse([
          {
            person_id: "p1",
            guest_name: null,
            plus_ones: null,
            zone_id: "z1",
            credential_category_id: "c1",
            engagement_id: null,
            entered_at: "2027-06-04T20:00:00Z",
            source: "Scan",
            door: null,
          },
          {
            person_id: null,
            guest_name: "Sasha Bell",
            plus_ones: 1,
            zone_id: null,
            credential_category_id: null,
            engagement_id: null,
            entered_at: "2027-06-04T20:05:00Z",
            source: "Guest Check In",
            door: "North Gate",
          },
        ]),
      ],
      "rpc:person_names": [okResponse([{ person_id: "p1", full_name: "Kai Morgan" }])],
    });
    const result = await listMuster(db, { projectId: "p" });
    expect(result.ok && result.data.map((r) => [r.name, r.source])).toEqual([
      ["Kai Morgan", "Scan"],
      ["Sasha Bell", "Guest Check In"],
    ]);
  });

  it("groups by zone in the zones' order, door check-ins last", () => {
    const row = (zoneId: string | null, name: string): MusterRow => ({
      personId: null,
      name,
      guestName: null,
      plusOnes: null,
      zoneId,
      credentialCategoryId: null,
      engagementId: null,
      enteredAt: "2027-06-04T20:00:00Z",
      source: zoneId ? "Scan" : "Guest Check In",
      door: null,
    });
    const groups = musterByZone(
      [row(null, "Guest"), row("z2", "Zed"), row("z1", "Bo"), row("z2", "Al")],
      ["z1", "z2"],
    );
    expect(groups.map((g) => [g.zoneId, g.rows.map((r) => r.name)])).toEqual([
      ["z1", ["Bo"]],
      ["z2", ["Al", "Zed"]],
      [null, ["Guest"]],
    ]);
  });

  it("is offered with the scan log or the time entries of the project", async () => {
    const { db } = fakeClient({
      "rpc:my_capabilities_on_project": [okResponse(["crew.time_entry.read"]), okResponse([])],
    });
    expect(await musterAccess(db, "p")).toEqual({
      ok: true,
      data: { scans: false, clockIns: true },
    });
    expect(await musterAccess(db, "p")).toEqual({
      ok: true,
      data: { scans: false, clockIns: false },
    });
  });
});

describe("guest passes at the door", () => {
  it("maps the pass fields and finds a guest by the scanned code", async () => {
    const { db } = fakeClient({
      "rpc:door_guest_list": [
        okResponse([
          {
            guest_list_entry_id: "g1",
            guest_name: "Sasha Bell",
            plus_ones: 1,
            entry_state: "Approved",
            note: null,
            checked_in_at: null,
            plus_ones_admitted: null,
            door: null,
            pass_code: "GP-ABCDEFGHIJ",
            pass_category_code: "VIP",
            pass_category_name: "VIP Guest",
            table_label: "Table 4",
            host_person_id: "h1",
          },
        ]),
      ],
    });
    const list = await listDoorGuests(db, "p");
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data[0]).toMatchObject({
      passCategoryName: "VIP Guest",
      tableLabel: "Table 4",
      hostPersonId: "h1",
    });
    expect(guestByPassCode(list.data, " gp-abcdefghij ")?.entryId).toBe("g1");
    expect(guestByPassCode(list.data, "GP-ZZZZZZZZZZ")).toBeUndefined();
  });
});

describe("the official weather feed board", () => {
  it("reads the status, active warnings, the next hours, the open hold and the templates", async () => {
    const { db, calls } = fakeClient({
      "rpc:weather_feed_status": [
        okResponse([
          {
            supported: true,
            feed_id: "f1",
            last_success_at: "2027-06-04T20:00:00Z",
            last_failure_at: null,
            last_error: null,
            failures_since_success: 0,
          },
        ]),
      ],
      "from:weather_warnings": [
        okResponse([
          {
            id: "w1",
            event: "Severe Thunderstorm Warning",
            severity: "Severe",
            headline: "Until 9:45 PM",
            description: null,
            instruction: null,
            onset: null,
            ends_at: "2027-06-05T01:45:00Z",
            expires_at: null,
          },
        ]),
      ],
      "from:weather_forecast_periods": [
        okResponse([
          {
            starts_at: "2027-06-04T21:00:00Z",
            temperature_f: 84,
            wind_speed_mph: 12,
            precipitation_percent: 40,
            short_forecast: "Chance Showers",
          },
        ]),
      ],
      "from:weather_holds": [okResponse([])],
      "from:weather_message_templates": [
        okResponse([{ id: "t1", message_kind: "Hold", body: "Stop work." }]),
      ],
    });
    const board = await getWeatherFeedBoard(db, "p", new Date("2027-06-04T20:30:00Z"));
    expect(board.ok).toBe(true);
    if (!board.ok) return;
    expect(board.data.status).toMatchObject({ supported: true, feedId: "f1" });
    expect(board.data.warnings.filter(isSevereWarning)).toHaveLength(1);
    expect(board.data.forecast[0]?.precipitationPercent).toBe(40);
    expect(board.data.openHold).toBeNull();
    expect(board.data.templates).toEqual({ Hold: { id: "t1", body: "Stop work." } });
    expect(calls.find((c) => c.target === "from:weather_warnings")?.steps).toContainEqual([
      "is",
      ["ended_at", null],
    ]);
    expect(calls.find((c) => c.target === "from:weather_forecast_periods")?.steps).toContainEqual([
      "limit",
      [12],
    ]);
  });
});

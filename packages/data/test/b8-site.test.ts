import { describe, expect, it } from "vitest";
import { credentialReviews, insideNow } from "../src/credentials.ts";
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
 * B8 (RRR-232) site reads: the scan log's Inside now (6251 app.zone_counts_live), the muster list (app.muster_list),
 * the door list's pass fields and pass lookup (6254), and the Weather page's official feed board (6256, 6257).
 */

describe("Inside now", () => {
  it("sums each zone's people and splits them by category and by team, zones by code", async () => {
    const { db, calls } = fakeClient({
      "rpc:zone_count_rows": [
        okResponse([
          {
            zone_id: "z2",
            credential_category_id: "c1",
            engagement_id: "e1",
            party_name: "Bayside Audio",
            inside: 3,
            last_entry_at: "2027-06-04T20:00:00Z",
          },
          {
            zone_id: "z2",
            credential_category_id: "c2",
            engagement_id: null,
            party_name: null,
            inside: 1,
            last_entry_at: "2027-06-04T20:10:00Z",
          },
          {
            zone_id: "z1",
            credential_category_id: "c1",
            engagement_id: "e1",
            party_name: "Bayside Audio",
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
    expect(calls[0]?.steps).toContainEqual(["args", [{ p_project_id: "p" }]]);
    // The team comes from the view: a field reader holds the scan log without opportunities.engagement.read.
    expect(calls.some((c) => c.target.includes("engagements"))).toBe(false);
  });

  it("reads nothing more when nobody is inside", async () => {
    const { db, calls } = fakeClient({ "rpc:zone_count_rows": [okResponse([])] });
    expect(await insideNow(db, { orgId: "o", projectId: "p", venueId: null })).toEqual({
      ok: true,
      data: [],
    });
    expect(calls).toHaveLength(1);
  });
});

describe("the accreditation checks of the Issued page", () => {
  const review = (id: string) => ({
    credential_id: id,
    holder_source: "Member",
    other_badges_on_project: 0,
    same_name_on_project: 0,
    duplicate_live: false,
    missing_requirements: 0,
    booked_elsewhere: false,
  });

  it("reads every credential a batch at a time, so nothing past the first 500 goes unchecked", async () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `c${i}`);
    const { db, calls } = fakeClient({
      "rpc:credential_review": [
        okResponse(ids.slice(0, 500).map(review)),
        okResponse(ids.slice(500, 1000).map(review)),
        okResponse(ids.slice(1000).map(review)),
      ],
    });
    const result = await credentialReviews(db, ids);
    expect(result.ok && result.data.size).toBe(1203);
    expect(calls).toHaveLength(3);
  });

  it("asks nothing for no credentials, and fails whole when a batch fails", async () => {
    const empty = fakeClient({});
    expect(await credentialReviews(empty.db, [])).toEqual({ ok: true, data: new Map() });
    expect(empty.calls).toHaveLength(0);
    const ids = Array.from({ length: 501 }, (_, i) => `c${i}`);
    const { db } = fakeClient({
      "rpc:credential_review": [
        okResponse(ids.slice(0, 500).map(review)),
        {
          data: null,
          error: { code: "57014", message: "canceling statement due to statement timeout" },
        },
      ],
    });
    expect((await credentialReviews(db, ids)).ok).toBe(false);
  });
});

describe("the muster list", () => {
  const base = {
    person_id: null,
    full_name: null,
    guest_name: null,
    plus_ones: null,
    zone_id: null,
    zone_code: null,
    zone_name: null,
    credential_number: null,
    credential_category_id: null,
    category_code: null,
    engagement_id: null,
    party_name: null,
    door: null,
  };

  it("reads the names and codes from the view, so the export carries the same names", async () => {
    const { db, calls } = fakeClient({
      "rpc:muster_rows": [
        okResponse([
          {
            ...base,
            person_id: "p1",
            full_name: "Kai Morgan",
            zone_id: "z1",
            zone_code: "STG",
            zone_name: "Stage",
            credential_number: "CR-1001",
            credential_category_id: "c1",
            category_code: "CREW",
            party_name: "Harbor Audio",
            entered_at: "2027-06-04T20:00:00Z",
            source: "Scan",
          },
          {
            ...base,
            person_id: "p2",
            full_name: "Ana Ruiz",
            zone_id: "z1",
            entered_at: "2027-06-04T20:01:00Z",
            source: "Clock In",
          },
          {
            ...base,
            guest_name: "Sasha Bell",
            plus_ones: 1,
            entered_at: "2027-06-04T20:05:00Z",
            source: "Guest Check In",
            door: "North Gate",
          },
        ]),
      ],
    });
    const result = await listMuster(db, { projectId: "p" });
    expect(
      result.ok &&
        result.data.map((r) => [r.name, r.source, r.zoneCode, r.categoryCode, r.partyName]),
    ).toEqual([
      ["Kai Morgan", "Scan", "STG", "CREW", "Harbor Audio"],
      ["Ana Ruiz", "Clock In", null, null, null],
      ["Sasha Bell", "Guest Check In", null, null, null],
    ]);
    expect(JSON.stringify(calls)).not.toContain("person_names");
  });

  it("groups by zone in the zones' order, door check-ins last", () => {
    const row = (zoneId: string | null, name: string): MusterRow => ({
      personId: null,
      name,
      guestName: null,
      plusOnes: null,
      zoneId,
      zoneCode: null,
      zoneName: null,
      credentialNumber: null,
      credentialCategoryId: null,
      categoryCode: null,
      engagementId: null,
      partyName: null,
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

  it("says which sources the viewer may read", async () => {
    const { db } = fakeClient({
      "rpc:my_capabilities_on_project": [
        okResponse(["crew.time_entry.read", "advancing.packet.read"]),
        okResponse([]),
      ],
    });
    expect(await musterAccess(db, "p")).toEqual({
      ok: true,
      data: { scans: false, clockIns: true, guests: true, doors: false },
    });
    expect(await musterAccess(db, "p")).toEqual({
      ok: true,
      data: { scans: false, clockIns: false, guests: false, doors: false },
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
            host_name: "Dana Ortiz",
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
      hostName: "Dana Ortiz",
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

import { describe, expect, it } from "vitest";
import {
  listAdvanceProgress,
  listAllocationHeat,
  listRosterReadiness,
  listTrackProgress,
  revokeTrackSignoff,
  sendAdvanceReminderNow,
  setSectionTrack,
  signOffTrack,
} from "../src/advancing.ts";
import { listMyTrackProgress, listSectionTracks } from "../src/gateway-operations.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/**
 * R11 (RRR-192, migrations 2740 to 2743): the Progress section's reads and writes. Rows from the computed views map to
 * typed cells; the reminder batch, the revoke reason and a stale track change are refused before or by the database.
 */
describe("advance progress", () => {
  it("maps each cell of a project's sent packets", async () => {
    const { db, calls } = fakeClient({
      "from:advance_progress": [
        okResponse([
          {
            advance_packet_id: "pk1",
            packet_title: "Production Advance",
            due_at: null,
            advance_recipient_id: "r1",
            recipient_engagement_id: "e1",
            recipient_label: "Bayside Audio",
            advance_section_id: "s1",
            position: 1,
            section_title: "Power",
            section_kind: "Text",
            latest_submission_id: null,
            submitted_at: null,
            cell_state: "Missing",
            overdue: true,
          },
        ]),
      ],
    });
    const result = await listAdvanceProgress(db, "pr1", "pk1");
    expect(result).toMatchObject({
      ok: true,
      data: [{ recipientLabel: "Bayside Audio", state: "Missing", overdue: true, position: 1 }],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["advance_packet_id", "pk1"]]);
  });

  it("reads past the API's row cap, a page at a time, on every grid", async () => {
    // max_rows (1,000) cuts a call with no note: 101 people at ten readiness rows each is already past it.
    const full = (row: Record<string, unknown>) => Array.from({ length: 1000 }, () => row);
    const readiness = { roster_entry_id: "x1", engagement_id: "e1", category: "Contact", cell_state: "Missing" };
    const progress = { advance_packet_id: "pk1", advance_recipient_id: "r1", advance_section_id: "s1", cell_state: "Missing" };
    const heat = { engagement_id: "e1", kind: "Credential", requested_quantity: 1 };
    const track = { advance_packet_id: "pk1", advance_recipient_id: "r1", track: "General", track_state: "In Progress" };
    const { db, calls } = fakeClient({
      "rpc:roster_readiness": [okResponse(full(readiness)), okResponse([readiness])],
      "from:advance_progress": [okResponse(full(progress)), okResponse([progress, progress])],
      "from:advance_allocation_heat": [okResponse(full(heat)), okResponse([])],
      "from:advance_track_progress": [okResponse(full(track)), okResponse([track])],
    });
    const rows = await listRosterReadiness(db, "pr1");
    const cells = await listAdvanceProgress(db, "pr1");
    const allocations = await listAllocationHeat(db, "pr1");
    const tracks = await listTrackProgress(db, "pr1");
    expect(rows.ok && rows.data.length).toBe(1001);
    expect(cells.ok && cells.data.length).toBe(1002);
    expect(allocations.ok && allocations.data.length).toBe(1000);
    expect(tracks.ok && tracks.data.length).toBe(1001);
    for (const target of [
      "rpc:roster_readiness",
      "from:advance_progress",
      "from:advance_allocation_heat",
      "from:advance_track_progress",
    ]) {
      const pages = calls.filter((c) => c.target === target);
      expect(pages.map((c) => c.steps.find(([step]) => step === "range")?.[1])).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
    }
    // The pages cannot overlap: the last key makes the view's order unique.
    const orders = calls
      .filter((c) => c.target === "from:advance_progress")[0]
      ?.steps.filter(([step]) => step === "order")
      .map(([, args]) => args[0]);
    expect(orders?.slice(-2)).toEqual(["advance_recipient_id", "advance_section_id"]);
  });

  it("fails rather than answering a partial grid when a later page fails", async () => {
    const { db } = fakeClient({
      "from:advance_progress": [
        okResponse(Array.from({ length: 1000 }, () => ({ cell_state: "Missing" }))),
        errorResponse("timeout", "57014"),
      ],
    });
    expect((await listAdvanceProgress(db, "pr1")).ok).toBe(false);
  });

  it("says when a recipient's engagement has closed", async () => {
    const { db } = fakeClient({
      "from:advance_progress": [
        okResponse([
          { advance_recipient_id: "r1", recipient_open: false, cell_state: "Missing", overdue: false },
          { advance_recipient_id: "r2", recipient_open: true, cell_state: "Missing", overdue: true },
        ]),
      ],
    });
    expect(await listAdvanceProgress(db, "pr1")).toMatchObject({
      ok: true,
      data: [{ recipientOpen: false }, { recipientOpen: true }],
    });
  });

  it("reads readiness, allocation heat and tracks", async () => {
    const { db } = fakeClient({
      "rpc:roster_readiness": [
        okResponse([
          {
            roster_entry_id: "x1",
            engagement_id: "e1",
            party_label: "Bayside Audio",
            person_label: "Kai Morgan",
            role_code: null,
            entry_state: "Accepted",
            category: "Allergies",
            cell_state: "Shared",
          },
        ]),
      ],
      "from:advance_allocation_heat": [
        okResponse([
          {
            engagement_id: "e1",
            party_label: "Bayside Audio",
            kind: "Asset",
            offering: "Radios",
            requested_quantity: 0,
            approved_quantity: 4,
            issued_quantity: "2",
            allocation_count: 3,
          },
        ]),
      ],
      "from:advance_track_progress": [
        okResponse([
          {
            advance_packet_id: "pk1",
            advance_recipient_id: "r1",
            track: "Hospitality",
            track_state: "Ready for Sign-off",
          },
          {
            advance_packet_id: "pk1",
            advance_recipient_id: "r1",
            track: "Backstage",
            track_state: "In Progress",
          },
        ]),
      ],
    });
    expect(await listRosterReadiness(db, "pr1")).toMatchObject({
      ok: true,
      data: [{ category: "Allergies", state: "Shared", personLabel: "Kai Morgan" }],
    });
    expect(await listAllocationHeat(db, "pr1")).toMatchObject({
      ok: true,
      data: [{ offering: "Radios", approved: 4, issued: 2, allocations: 3 }],
    });
    const tracks = await listTrackProgress(db, "pr1");
    expect(tracks.ok && tracks.data.map((t) => [t.track, t.state])).toEqual([
      ["Hospitality", "Ready for Sign-off"],
    ]);
  });
});

describe("reminders and sign-off", () => {
  it("reminds 1 to 200 recipients at a time", async () => {
    const empty = fakeClient({});
    expect(await sendAdvanceReminderNow(empty.db, "pk1", [])).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "advance_reminder_batch" },
    });
    const many = Array.from({ length: 201 }, (_, i) => `r${i}`);
    expect((await sendAdvanceReminderNow(empty.db, "pk1", many)).ok).toBe(false);
    const { db, calls } = fakeClient({
      "rpc:send_advance_reminder_now": [okResponse([{ sent: 1, skipped: 1 }])],
    });
    expect(await sendAdvanceReminderNow(db, "pk1", ["r1", "r2", "r1"])).toEqual({
      ok: true,
      data: { sent: 1, skipped: 1 },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_packet_id: "pk1", p_recipient_ids: ["r1", "r2"] }],
    ]);
  });

  it("signs off and revokes with a reason", async () => {
    const { db } = fakeClient({
      "rpc:sign_off_advance_track": [
        okResponse("so1"),
        errorResponse(
          "XR001",
          "advance_track_incomplete: Every section on the track must be done first.",
        ),
      ],
      "rpc:revoke_advance_track_signoff": [okResponse(null)],
    });
    expect(await signOffTrack(db, "r1", "Hospitality")).toEqual({ ok: true, data: { id: "so1" } });
    expect((await signOffTrack(db, "r1", "Technical")).ok).toBe(false);
    expect(await revokeTrackSignoff(db, "so1", "   ")).toMatchObject({
      ok: false,
      error: { rule: "advance_track_revoke_reason" },
    });
    expect(await revokeTrackSignoff(db, "so1", " Came in late. ")).toEqual({
      ok: true,
      data: null,
    });
  });

  it("moves a section's track, refusing a stale version", async () => {
    const { db, calls } = fakeClient({
      "from:advance_sections": [okResponse([{ id: "s1" }]), okResponse([])],
    });
    expect(await setSectionTrack(db, "s1", "Hospitality")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual(["update", [{ track: "Hospitality" }]]);
    expect(await setSectionTrack(db, "s1", "Finance", "2026-10-30T12:00:00Z")).toMatchObject({
      ok: false,
      error: { rule: "advance_section_stale" },
    });
  });
});

describe("Gateway tracks", () => {
  it("reads the caller's tracks and section tracks", async () => {
    const { db } = fakeClient({
      "from:api_external.advance_track_progress": [
        okResponse([
          {
            advance_recipient_id: "r1",
            advance_packet_id: "pk1",
            track: "Hospitality",
            sections_total: 2,
            sections_done: 2,
            track_state: "Signed Off",
            signed_off_at: "2026-10-31T12:00:00Z",
          },
        ]),
      ],
      "from:api_external.advance_sections": [okResponse([{ id: "s1", track: null }])],
    });
    expect(await listMyTrackProgress(db, [])).toEqual({ ok: true, data: [] });
    expect(await listMyTrackProgress(db, ["pk1"])).toMatchObject({
      ok: true,
      data: [{ state: "Signed Off", signedOffAt: "2026-10-31T12:00:00Z" }],
    });
    const tracks = await listSectionTracks(db, ["s1"]);
    expect(tracks.ok && tracks.data.get("s1")).toBe("General");
  });
});

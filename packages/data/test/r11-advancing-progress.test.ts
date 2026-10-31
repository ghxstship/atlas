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

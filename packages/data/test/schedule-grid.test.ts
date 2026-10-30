import { describe, expect, it } from "vitest";
import {
  cueGridPayload,
  dayGridPayload,
  gridErrors,
  saveCueGrid,
  saveDayGrid,
  toGridSave,
} from "../src/schedule-grid.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** The schedule grid (B4, G-41, migration 2931): row mappers, counts, refusals in place and the RPC calls. */

describe("grid rows", () => {
  it("sends a kind only for a new record, and the loaded values of an edited one", () => {
    expect(
      dayGridPayload([
        {
          title: "Rig the follow spots",
          recordKind: "Task",
          startsAt: "a",
          endsAt: "b",
          dueAt: null,
          startTbc: false,
          ownerPartyId: null,
        },
        {
          id: "r1",
          expect: { title: "Old" },
          title: "New",
          recordKind: "Task",
          startsAt: null,
          endsAt: null,
          dueAt: "c",
          startTbc: true,
          ownerPartyId: "p",
        },
      ]),
    ).toEqual([
      {
        record_kind: "Task",
        title: "Rig the follow spots",
        starts_at: "a",
        ends_at: "b",
        due_at: null,
        start_tbc: false,
        owner_party_id: null,
      },
      {
        id: "r1",
        expect: { title: "Old" },
        title: "New",
        starts_at: null,
        ends_at: null,
        due_at: "c",
        start_tbc: true,
        owner_party_id: "p",
      },
    ]);
    expect(
      cueGridPayload([
        { label: "Encore", plannedAt: "t", durationMinutes: 5, segment: null, startTbc: false },
      ]),
    ).toEqual([
      { label: "Encore", planned_at: "t", duration_minutes: 5, segment: null, start_tbc: false },
    ]);
  });

  it("counts created, changed and refused rows", () => {
    const save = toGridSave([
      { row_index: 1, record_id: "a", action: "create", refusal_code: null, refusal_message: null },
      { row_index: 2, record_id: "b", action: "update", refusal_code: null, refusal_message: null },
      { row_index: 3, record_id: "c", action: "move", refusal_code: null, refusal_message: null },
      {
        row_index: 4,
        record_id: null,
        action: "refused",
        refusal_code: "record_title_grammar",
        refusal_message: "Start with a verb.",
      },
    ]);
    expect([save.created, save.changed, save.refused]).toEqual([1, 2, 1]);
    expect(gridErrors(save, ["g1", "g2", "g3", "g4"], () => "title")).toEqual({
      "g4:title": "Start with a verb.",
    });
  });
});

describe("grid saves", () => {
  it("previews a day grid without committing", async () => {
    const { db, calls } = fakeClient({
      "rpc:save_day_grid": [
        okResponse([
          {
            row_index: 1,
            record_id: "a",
            action: "create",
            refusal_code: null,
            refusal_message: null,
          },
        ]),
      ],
    });
    const saved = await saveDayGrid(db, {
      projectId: "p1",
      day: "2027-06-01",
      rows: [],
      commit: false,
    });
    expect(saved.ok && saved.data.created).toBe(1);
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_project_id: "p1",
      p_day: "2027-06-01",
      p_commit: false,
    });
  });

  it("returns grid_too_large as a refusal", async () => {
    const { db } = fakeClient({
      "rpc:save_cue_grid": [
        errorResponse(
          "XR001",
          "grid_too_large: A grid saves at most 200 rows at a time.",
          "grid_too_large",
        ),
      ],
    });
    const saved = await saveCueGrid(db, { runOfShowId: "r1", rows: [], commit: true });
    expect(!saved.ok && saved.error).toMatchObject({ kind: "refusal", rule: "grid_too_large" });
  });
});

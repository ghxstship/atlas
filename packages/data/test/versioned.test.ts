import { describe, expect, it } from "vitest";
import { restorableEntries, type ActivityEntry } from "../src/activity.ts";
import { toBulkOutcome } from "../src/bulk.ts";
import { sameFieldValue, saveVersioned } from "../src/versioned.ts";
import { saveRecordFields } from "../src/work.ts";
import { okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const V1 = "2027-06-01T12:00:00.123456+00:00";
const V2 = "2027-06-01T12:05:00.654321+00:00";
const V3 = "2027-06-01T12:06:00.000001+00:00";

describe("saves against the version the person edited (A118)", () => {
  it("compares instants by meaning and numbers across their spellings", () => {
    expect(sameFieldValue("2027-06-05T18:00:00Z", "2027-06-05T18:00:00.000+00:00")).toBe(true);
    expect(sameFieldValue("2027-06-05T18:00:00Z", "2027-06-05T18:00:01Z")).toBe(false);
    expect(sameFieldValue(null, undefined)).toBe(true);
    expect(sameFieldValue(4000, "4000")).toBe(true);
    expect(sameFieldValue("Truss", "truss")).toBe(false);
  });

  it("writes once when the version still matches, compare-and-set on updated_at", async () => {
    const { db, calls } = moduleClient({ "from:records": [okResponse([{ updated_at: V2 }])] });
    const result = await saveVersioned(
      db,
      "records",
      { column: "id", value: "r1" },
      { set: { title: "Hang two banners" }, expect: { title: "Hang the banner" }, version: V1 },
    );
    expect(result).toEqual({ ok: true, data: { saved: true, version: V2 } });
    expect(stepsOf(calls[0], "update")).toEqual([[{ title: "Hang two banners" }]]);
    expect(stepsOf(calls[0], "eq")).toEqual([
      ["id", "r1"],
      ["updated_at", V1],
    ]);
  });

  it("merges when someone saved another field since", async () => {
    const { db, calls } = moduleClient({
      "from:records": [
        okResponse([]),
        okResponse({ title: "Hang the banner", updated_at: V2 }),
        okResponse([{ updated_at: V3 }]),
      ],
    });
    const result = await saveVersioned(
      db,
      "records",
      { column: "id", value: "r1" },
      { set: { title: "Hang two banners" }, expect: { title: "Hang the banner" }, version: V1 },
    );
    expect(result).toEqual({ ok: true, data: { saved: true, version: V3 } });
    expect(stepsOf(calls[2], "eq")).toEqual([
      ["id", "r1"],
      ["updated_at", V2],
    ]);
  });

  it("answers the current value when someone changed the same field", async () => {
    const { db, calls } = moduleClient({
      "from:records": [okResponse([]), okResponse({ title: "Hang the flags", updated_at: V2 })],
    });
    const result = await saveVersioned(
      db,
      "records",
      { column: "id", value: "r1" },
      { set: { title: "Hang two banners" }, expect: { title: "Hang the banner" }, version: V1 },
    );
    expect(result).toEqual({
      ok: true,
      data: { saved: false, current: { title: "Hang the flags" }, version: V2 },
    });
    expect(calls).toHaveLength(2);
  });

  it("treats a version with nothing else expected as stale once it moved on", async () => {
    const { db } = moduleClient({
      "from:records": [okResponse([]), okResponse({ owner_party_id: "p2", updated_at: V2 })],
    });
    const result = await saveVersioned(
      db,
      "records",
      { column: "id", value: "r1" },
      { set: { owner_party_id: "p1" }, version: V1 },
    );
    expect(result.ok && result.data.saved).toBe(false);
  });

  it("reads a gone or hidden row as not found", async () => {
    const { db } = moduleClient({ "from:records": [okResponse([]), okResponse(null)] });
    const result = await saveVersioned(
      db,
      "records",
      { column: "id", value: "r1" },
      { set: { title: "x" }, version: V1 },
    );
    expect(result).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("maps record properties to their columns and back, and never compares the replan reason", async () => {
    const { db, calls } = moduleClient({
      "from:records": [
        okResponse([]),
        okResponse({ due_at: "2027-06-06T18:00:00+00:00", updated_at: V2 }),
      ],
    });
    const result = await saveRecordFields(db, "r1", {
      set: { dueAt: "2027-06-07T18:00:00.000Z" },
      expect: { dueAt: "2027-06-05T18:00:00.000Z" },
      version: V1,
      replanReason: "Truss arrives Friday.",
    });
    expect(stepsOf(calls[0], "update")).toEqual([
      [{ due_at: "2027-06-07T18:00:00.000Z", replan_reason: "Truss arrives Friday." }],
    ]);
    expect(result).toEqual({
      ok: true,
      data: { saved: false, current: { dueAt: "2027-06-06T18:00:00+00:00" }, version: V2 },
    });
  });
});

describe("stale bulk rows carry the row's values (2120)", () => {
  it("reads current from a stale refusal", () => {
    const outcome = toBulkOutcome({
      committed: false,
      refused: [
        {
          id: "a",
          rule: "bulk_stale",
          message: "Someone changed this row after you loaded it; reload to see the change.",
          current: { owner_party_id: "p2", updated_at: V2 },
        },
        { id: "b", rule: "not_allowed", message: "" },
      ],
    });
    expect(outcome.refused[0]?.current).toEqual({ owner_party_id: "p2", updated_at: V2 });
    expect(outcome.refused[1]).not.toHaveProperty("current");
  });
});

describe("Restore on activity entries (2121)", () => {
  const entry = (id: string, type: string, subjectId: string): ActivityEntry => ({
    id,
    at: "2027-06-01T12:00:00Z",
    type,
    subjectTable: "records",
    subjectId,
    project: null,
    actor: "Dave",
    recordKey: null,
    recordTitle: null,
    data: {},
    description: null,
    actorPersonId: null,
  });

  it("offers Restore on the newest trashed entry of a row still in Trash", async () => {
    const { db, calls } = moduleClient({
      "from:trash_items": [
        okResponse([
          { subject_table: "records", subject_id: "r1", purge_after: "2099-01-01T00:00:00Z" },
          { subject_table: "invoice_lines", subject_id: "l1", purge_after: "2020-01-01T00:00:00Z" },
        ]),
      ],
    });
    const offered = await restorableEntries(db, [
      entry("e3", "record.trashed", "r1"),
      entry("e2", "record.state_changed", "r1"),
      entry("e1", "record.trashed", "r1"),
      entry("e0", "invoice_line.trashed", "l1"),
    ]);
    expect(offered).toEqual({
      e3: { table: "records", id: "r1", purgeAfter: "2099-01-01T00:00:00Z" },
    });
    expect(stepsOf(calls[0], "in")).toEqual([["subject_id", ["r1", "l1"]]]);
  });

  it("asks nothing when no entry is a trashed one", async () => {
    const { db, calls } = moduleClient({});
    expect(await restorableEntries(db, [entry("e1", "record.created", "r1")])).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

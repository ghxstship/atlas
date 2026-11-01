import { describe, expect, it } from "vitest";
import { applyArchived, inArchived, parseArchived, setArchived } from "../src/archive.ts";
import {
  countMyRecords,
  listBlockedRecords,
  listMyOverdueRecords,
  listMyRecordsBetween,
  listRecentRecords,
} from "../src/home.ts";
import { listMyWork } from "../src/my-work.ts";
import { getPersonCard } from "../src/person-card.ts";
import { getObjectRecord, type ObjectType } from "../src/custom-objects.ts";
import { listFilingTargets } from "../src/project-inbox.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

describe("archive (A124)", () => {
  it("reads the archived query parameter, leaving archived rows out by default", () => {
    expect(parseArchived("include")).toBe("include");
    expect(parseArchived("only")).toBe("only");
    expect(parseArchived(undefined)).toBe("exclude");
    expect(parseArchived("1")).toBe("exclude");
  });

  it("narrows a list by archived_at", async () => {
    const { db, calls } = fakeClient({
      "from:vendors": [okResponse([]), okResponse([]), okResponse([])],
    });
    await applyArchived(db.from("vendors").select("id"));
    await applyArchived(db.from("vendors").select("id"), "only");
    await applyArchived(db.from("vendors").select("id"), "include");
    expect(calls[0]?.steps).toContainEqual(["is", ["archived_at", null]]);
    expect(calls[1]?.steps).toContainEqual(["not", ["archived_at", "is", null]]);
    expect(calls[2]?.steps.map(([m]) => m)).toEqual(["select"]);
  });

  it("says whether a row belongs in a filtered list", () => {
    expect(inArchived("exclude", null)).toBe(true);
    expect(inArchived("exclude", "2027-01-01T00:00:00Z")).toBe(false);
    expect(inArchived("only", "2027-01-01T00:00:00Z")).toBe(true);
    expect(inArchived("only", null)).toBe(false);
    expect(inArchived("include", "2027-01-01T00:00:00Z")).toBe(true);
  });

  it("archives and unarchives through the RPCs and types their refusals", async () => {
    const { db, calls } = fakeClient({
      "rpc:archive_row": [
        okResponse("2027-01-01T00:00:00Z"),
        errorResponse("42501", "work.record.write is required"),
        errorResponse(
          "XR001",
          "archive_row_not_found: This row no longer exists or is not available to you.",
          "archive_row_not_found",
        ),
      ],
      "rpc:unarchive_row": [
        okResponse(null),
        errorResponse(
          "XR001",
          "archive_name_taken: A live venue already has this name.",
          "archive_name_taken",
        ),
      ],
    });
    expect(await setArchived(db, "records", "r1", true)).toEqual({
      ok: true,
      data: { archivedAt: "2027-01-01T00:00:00Z" },
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_entity: "records", p_id: "r1" }]]);
    expect(await setArchived(db, "records", "r1", true)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    // A row the caller cannot see is refused by name and comes back as not-found, like one they cannot edit.
    expect(await setArchived(db, "records", "r2", true)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await setArchived(db, "documents", "d1", false)).toEqual({
      ok: true,
      data: { archivedAt: null },
    });
    const refused = await setArchived(db, "venues", "v1", false);
    expect(refused.ok === false && refused.error).toMatchObject({
      kind: "refusal",
      rule: "archive_name_taken",
    });
  });

  it("leaves archived records out of Home, My Work, filing targets and the person card", async () => {
    const { db, calls } = fakeClient({
      "from:records": Array.from({ length: 8 }, () => okResponse([])),
      "from:memberships": [okResponse(null)],
    });
    const person = { orgId: "o1", personId: "p1" };
    await listMyRecordsBetween(db, { ...person, from: new Date(0), to: new Date(1) });
    await listMyOverdueRecords(db, { ...person, now: new Date(0) });
    await listBlockedRecords(db, "o1");
    await listRecentRecords(db, person);
    await countMyRecords(db, { ...person, which: "open" });
    await listMyWork(db, { ...person, membershipId: null });
    await listFilingTargets(db, "prj1", "NWL");
    await getPersonCard(db, "o1", "p1");
    const reads = calls.filter((c) => c.target === "from:records");
    expect(reads).toHaveLength(8);
    for (const read of reads) expect(read.steps).toContainEqual(["is", ["archived_at", null]]);
  });

  it("reads one custom object record by id, archived or not, with its ordinal for its key", async () => {
    const type: ObjectType = {
      id: "t1",
      key: "props",
      label: "Props",
      icon: "Box",
      defaultView: "List",
      fields: [],
    };
    const row = {
      id: "r9",
      title: "Breakaway chair",
      created_at: "2027-01-02T00:00:00Z",
      updated_at: "2027-01-03T00:00:00Z",
      archived_at: "2027-01-03T00:00:00Z",
      custom_object_values: [],
    };
    const { db, calls } = fakeClient({
      "from:custom_object_records": [
        okResponse(row),
        { ...okResponse(null), count: 612 } as ReturnType<typeof okResponse>,
        okResponse(null),
      ],
    });
    const found = await getObjectRecord(db, type, "r9");
    expect(found).toEqual({
      ok: true,
      data: {
        record: {
          id: "r9",
          title: "Breakaway chair",
          createdAt: "2027-01-02T00:00:00Z",
          updatedAt: "2027-01-03T00:00:00Z",
          archivedAt: "2027-01-03T00:00:00Z",
          values: {},
        },
        ordinal: 612,
      },
    });
    // No archived_at filter and no 500-row limit: the record is read by id among every record.
    expect(calls[0]?.steps).toContainEqual(["eq", ["id", "r9"]]);
    expect(calls[0]?.steps.map(([m]) => m)).not.toContain("limit");
    expect(calls[0]?.steps.flatMap(([, a]) => a)).not.toContain("archived_at");
    expect(calls[1]?.steps).toContainEqual(["lte", ["created_at", "2027-01-02T00:00:00Z"]]);
    expect(await getObjectRecord(db, type, "gone")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

import { describe, expect, it } from "vitest";
import { applyArchived, inArchived, parseArchived, setArchived } from "../src/archive.ts";
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
});

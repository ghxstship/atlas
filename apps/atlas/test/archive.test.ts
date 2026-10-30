import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { errorKey } from "../components/places/kit/action-state";
import { archivedOf } from "../lib/archive/param";
import { peekedRow } from "../lib/archive/peek";
import { archiveOf, legacyArchiveChanges } from "../components/places/venues/archive-param";

/** Archive and unarchive in Atlas (A124): the query parameter and the refusals Places explains. */
describe("archive (A124)", () => {
  it("reads the Archived filter from the query string, leaving archived rows out by default", () => {
    expect(archivedOf({})).toBe("exclude");
    expect(archivedOf({ archived: "include" })).toBe("include");
    expect(archivedOf({ archived: ["only", "include"] })).toBe("only");
    expect(archivedOf({ archived: "1" })).toBe("exclude");
  });

  it("loads the venues the Archived filter asks for", () => {
    expect(archiveOf({})).toBe("live");
    expect(archiveOf({ archived: "only" })).toBe("archived");
    expect(archiveOf({ archived: "include" })).toBe("all");
    // The older parameter is moved to `archived` before the list loads (legacyArchiveChanges).
    expect(archiveOf({ archive: "archived" })).toBe("live");
  });

  it("moves an older venue link's archive= to the Archived filter, archived winning", () => {
    expect(legacyArchiveChanges({})).toBeUndefined();
    expect(legacyArchiveChanges({ archived: "only" })).toBeUndefined();
    expect(legacyArchiveChanges({ archive: "archived" })).toEqual({
      archive: undefined,
      archived: "only",
    });
    expect(legacyArchiveChanges({ archive: "all", q: "hall" })).toEqual({
      archive: undefined,
      archived: "include",
    });
    expect(legacyArchiveChanges({ archive: "live" })).toEqual({
      archive: undefined,
      archived: undefined,
    });
    expect(legacyArchiveChanges({ archive: "archived", archived: "include" })).toEqual({
      archive: undefined,
      archived: "include",
    });
  });

  it("explains a venue restore refused because a live venue took its name, in both languages", () => {
    const refusal = { kind: "refusal", rule: "archive_name_taken", message: "" } as const;
    expect(errorKey(refusal)).toBe("archive_name_taken");
    for (const locale of ["en-US", "es-US"] as const) {
      const places = getMessages(locale)["places"] as { errors: Record<string, string> };
      expect(places.errors["archive_name_taken"], locale).toBeTruthy();
    }
  });

  it("opens a peek the list leaves out by reading it by id, only on a miss", async () => {
    const live = { id: "d1", projectId: "p1" };
    const archived = { id: "d2", projectId: "p1" };
    const reads: string[] = [];
    const read = async (id: string) => {
      reads.push(id);
      return id === archived.id
        ? ({ ok: true, data: archived } as const)
        : ({ ok: false, error: { kind: "not-found" } } as const);
    };
    expect(await peekedRow([live], undefined, read)).toBeNull();
    expect(await peekedRow([live], "d1", read)).toBe(live);
    expect(reads).toEqual([]);
    // An archived document a Favorite names is not in the default list, and still opens.
    expect(await peekedRow([live], "d2", read)).toBe(archived);
    expect(await peekedRow([live], "d3", read)).toBeNull();
    // A project's tab keeps only that project's documents.
    expect(await peekedRow([live], "d2", read, (d) => d.projectId === "p2")).toBeNull();
    expect(reads).toEqual(["d2", "d3", "d2"]);
  });
});

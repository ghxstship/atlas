import { getMessages } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import { errorKey } from "../components/places/kit/action-state";
import { archivedOf } from "../lib/archive/param";

/** Archive and unarchive in Atlas (A124): the query parameter and the refusals Places explains. */
describe("archive (A124)", () => {
  it("reads the Archived filter from the query string, leaving archived rows out by default", () => {
    expect(archivedOf({})).toBe("exclude");
    expect(archivedOf({ archived: "include" })).toBe("include");
    expect(archivedOf({ archived: ["only", "include"] })).toBe("only");
    expect(archivedOf({ archived: "1" })).toBe("exclude");
  });

  it("explains a venue restore refused because a live venue took its name, in both languages", () => {
    const refusal = { kind: "refusal", rule: "archive_name_taken", message: "" } as const;
    expect(errorKey(refusal)).toBe("archive_name_taken");
    for (const locale of ["en-US", "es-US"] as const) {
      const places = getMessages(locale)["places"] as { errors: Record<string, string> };
      expect(places.errors["archive_name_taken"], locale).toBeTruthy();
    }
  });
});

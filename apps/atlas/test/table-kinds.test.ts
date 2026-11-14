import { describe, expect, it } from "vitest";
import trashEn from "../../../packages/i18n/messages/en-US/trash.json";
import trashEs from "../../../packages/i18n/messages/es-US/trash.json";
import tables from "./table-kinds.generated.json";

/**
 * RRR-267: Trash's Kind column and filter and the legal-hold table picker name each table from the catalog
 * trash.kinds, in every launch locale. The table lists come from a migrated database
 * (scripts/generate-table-kinds.ts; CI's database job fails when they drift), so a migration that adds a Trash table
 * or a retention policy fails here until both catalogs name it.
 */
const bare = (table: string) => table.replace(/^[a-z_]+\./, "");
const trash = [...new Set(tables.trash.map(bare))];
const retention = [...new Set(tables.retention.map(bare))];
const catalogs = { "en-US": trashEn.kinds, "es-US": trashEs.kinds } as Record<
  string,
  Record<string, string>
>;

describe("the table lists", () => {
  it("hold the Trash tables and the retention tables", () => {
    expect(trash.length).toBeGreaterThan(100);
    expect(retention.length).toBeGreaterThan(trash.length);
    expect(tables.retention.every((t) => t.startsWith("app."))).toBe(true);
  });
});

for (const [locale, kinds] of Object.entries(catalogs)) {
  describe(`trash.kinds in ${locale}`, () => {
    it("names every table in private.trash_tables", () => {
      expect(trash.filter((t) => !kinds[t]?.trim())).toEqual([]);
    });

    it("names every retention-policy table the legal-hold picker offers", () => {
      expect(retention.filter((t) => !kinds[t]?.trim())).toEqual([]);
    });

    it("names no table the database does not have", () => {
      const known = new Set([...trash, ...retention]);
      expect(Object.keys(kinds).filter((t) => !known.has(t))).toEqual([]);
    });

    it("never shows the identifier itself", () => {
      expect(
        Object.entries(kinds).filter(([t, words]) => words === t || words.includes("_")),
      ).toEqual([]);
    });
  });
}

describe("trash.kinds in es-US", () => {
  it("is Spanish, not the English words of the table's name", () => {
    const same = Object.entries(trashEs.kinds).filter(
      ([t, words]) => words === (trashEn.kinds as Record<string, string>)[t],
    );
    // Words spelled the same in both: Spanish borrows rider, and the plural of rol is roles.
    expect(same.map(([t]) => t).sort()).toEqual(["riders", "roles"]);
  });
});

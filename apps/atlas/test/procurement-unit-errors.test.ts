import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toDataError } from "@xos/data";
import { describe, expect, it } from "vitest";
import enProcurement from "../../../packages/i18n/messages/en-US/procurement.json";
import esProcurement from "../../../packages/i18n/messages/es-US/procurement.json";
import { fromDataError } from "@/lib/collection-kit/forms";

/**
 * Crawl 4.9: the Unit help on needs, order, RFQ and catalog lines suggested "ea" and "m", which
 * xpms.dim_unit_alias does not hold, and the foreign key violation they raise read as a server
 * error. The help now names the canon units, and a unit outside them reads on the Unit field.
 */

const MIGRATIONS = join(__dirname, "../../../supabase/migrations");

/** Every alias the migrations insert into xpms.dim_unit_alias. */
function canonUnits(): Set<string> {
  const units = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const insert =
      /insert into xpms\.dim_unit_alias \(alias, unit_code, dimension_code\) values([\s\S]*?);/g;
    for (const match of sql.matchAll(insert)) {
      for (const row of (match[1] ?? "").matchAll(/\('([^']+)',/g)) units.add(row[1] ?? "");
    }
  }
  return units;
}

describe("the unit of a procurement line", () => {
  it("reads a unit outside the canon on the Unit field", () => {
    const error = toDataError({
      code: "23503",
      message:
        'insert or update on table "po_lines" violates foreign key constraint "po_lines_unit_basis_fkey"',
    });
    expect(fromDataError(error)).toEqual({ fieldErrors: { unitBasis: "unit" } });
  });

  it("keeps any other foreign key as the generic invalid message, not a server error", () => {
    const error = toDataError({
      code: "23503",
      message:
        'insert or update on table "po_lines" violates foreign key constraint "po_lines_x_fkey"',
    });
    expect(fromDataError(error)).toEqual({ error: "invalid" });
  });

  it("names exactly the canon units in its help and its field error, in both languages", () => {
    const units = canonUnits();
    expect(units.size).toBeGreaterThanOrEqual(11);
    for (const catalog of [enProcurement, esProcurement]) {
      for (const copy of [catalog.lines.unitBasisHelp, catalog.kit.validation.unit]) {
        for (const unit of units) expect(copy).toContain(unit);
        // The old examples are not canon units.
        expect(copy).not.toMatch(/\bea\b/);
        expect(copy).not.toMatch(/\bm\b/);
      }
    }
  });
});

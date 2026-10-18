import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Section 18 gate 18: pgTAP covers every separation of duties rule. Each rule is a database check that refuses
 * with its code (`private.refuse` or `private.assert_separation` with a `sod_` code, SQLSTATE XR001, message "<code>: <sentence>"). A suite that
 * expects only XR001 passes on any refusal, so this audit asks for the code itself: every sod_ code a migration
 * raises must appear in at least one file under supabase/tests. The registry of rules is checked from the catalog
 * by supabase/tests/1150_gate18_separation_of_duties.test.sql.
 */
const root = fileURLToPath(new URL("../../../supabase/", import.meta.url));
const read = (dir: string) =>
  readdirSync(`${root}${dir}`)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".psql"))
    .map((f) => readFileSync(`${root}${dir}/${f}`, "utf8"));

const raised = new Set(
  read("migrations").flatMap((sql) =>
    [...sql.matchAll(/(?:refuse|assert_separation)\(\s*'(sod_[a-z_]+)'/g)].map(
      (m) => m[1] as string,
    ),
  ),
);
const tests = read("tests").join("\n");

describe("separation of duties coverage (gate 18)", () => {
  it("finds the rules the migrations raise", () => {
    expect(raised.size).toBeGreaterThanOrEqual(18);
  });

  it("asserts every rule by its code in a pgTAP suite", () => {
    const untested = [...raised].filter((code) => !tests.includes(code)).sort();
    expect(untested, "sod_ rules no pgTAP suite names by code").toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { roundTripReport } from "../src/ledger.ts";
import { normalized } from "../src/playbook/views.ts";

describe("generated text keeps what it wraps", () => {
  it("places an expression in its normalizer as text, dollar signs included", () => {
    expect(normalized("numeric", "t.amount")).toBe("xpms.pb_num((t.amount)::numeric)");
    expect(normalized(undefined, "regexp_replace(c, 'a$', '$&')")).toBe(
      "xpms.pb_text((regexp_replace(c, 'a$', '$&'))::text)",
    );
  });

  it("escapes the backslash and the bar in a report cell", () => {
    const diff = { sheet: "S", row: 2, column: "B", header: "H", source: "a|b", database: "c\\|d" };
    const report = roundTripReport([diff], { unexplained: [diff], stale: [] });
    expect(report).toContain("| a\\|b | c\\\\\\|d | no |");
  });
});

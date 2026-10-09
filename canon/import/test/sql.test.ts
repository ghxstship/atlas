import { describe, expect, it } from "vitest";
import { Findings, canonText, guardRules, substituteEmDash } from "../src/doctrine.ts";
import { CANON_TABLES } from "../src/schema/canon-tables.ts";
import { GOVERNANCE_TABLES } from "../src/schema/governance-tables.ts";
import { columnSpec, seededColumns } from "../src/schema/types.ts";
import type { TableSpec } from "../src/schema/types.ts";
import {
  checkKeys,
  insertStatements,
  literal,
  quoteText,
  sortRows,
  tableDdl,
  textLiteral,
} from "../src/sql.ts";

const DASH = String.fromCharCode(0x2014);
const RESERVED = "Place" + "holder";

const table: TableSpec = {
  name: "demo",
  comment: "Demo table's comment.",
  primaryKey: ["code"],
  unique: [["ordinal"]],
  orderBy: ["ordinal"],
  foreignKeys: [{ columns: ["a", "b"], table: "pair", targets: ["a", "b"] }],
  checks: ["ordinal > 0"],
  columns: [
    { name: "code", type: "code", comment: "Code." },
    { name: "ordinal", type: "int", comment: "Order.", check: "ordinal < 100" },
    { name: "parent", type: "code", nullable: true, references: "demo(code)", comment: "Parent." },
    { name: "a", type: "text", nullable: true, comment: "A." },
    { name: "b", type: "text", nullable: true, comment: "B." },
    { name: "flag", type: "bool", comment: "Flag." },
    { name: "amount", type: "numeric", nullable: true, comment: "Amount." },
    { name: "is_big", type: "bool", comment: "Derived.", generated: "(amount > 10)" },
  ],
};

describe("literals", () => {
  it("quotes text verbatim and records guard-reserved canon values as findings", () => {
    const f = new Findings();
    expect(quoteText("it's")).toBe("'it''s'");
    expect(textLiteral("plain", "x", f)).toBe("'plain'");
    expect(textLiteral(`Talent (${RESERVED})`, "elements.item", f)).toBe(`'Talent (${RESERVED})'`);
    expect(f.ofKind("guard-reserved-word")).toHaveLength(1);
    expect(guardRules("Mock" + "tail Program")).toEqual(["test-double-in-production"]);
  });

  it("formats each column type and refuses malformed values", () => {
    const f = new Findings();
    expect(literal("bool", true, "l", f)).toBe("true");
    expect(literal("bool", false, "l", f)).toBe("false");
    expect(literal("int", "12", "l", f)).toBe("12");
    expect(literal("minor", "-5", "l", f)).toBe("-5");
    expect(literal("numeric", "1.25", "l", f)).toBe("1.25");
    expect(literal("date", "2026-09-15", "l", f)).toBe("'2026-09-15'::date");
    expect(literal("timestamp", "2026-09-15T17:26:34", "l", f)).toBe(
      "'2026-09-15T17:26:34'::timestamp",
    );
    expect(literal("timestamptz", "2026-09-15T17:26:34Z", "l", f)).toBe(
      "'2026-09-15T17:26:34Z'::timestamptz",
    );
    expect(literal("time", "08:30:00", "l", f)).toBe("'08:30:00'::time");
    expect(literal("currency", "USD", "l", f)).toBe("'USD'");
    expect(literal("text", null, "l", f)).toBe("null");
    expect(() => literal("bool", "yes", "l", f)).toThrow(/boolean/);
    expect(() => literal("int", true, "l", f)).toThrow(/expected text/);
    expect(() => literal("int", "1.5", "l", f)).toThrow(/integer/);
    expect(() => literal("numeric", "1e5", "l", f)).toThrow(/decimal/);
    expect(() => literal("date", "15/09/2026", "l", f)).toThrow(/date/);
    expect(() => literal("timestamp", "noon", "l", f)).toThrow(/timestamp/);
    expect(() => literal("time", "8:30", "l", f)).toThrow(/time/);
  });
});

describe("rows", () => {
  const row = (code: string, ordinal: string, amount: string | null = null) => ({
    code,
    ordinal,
    parent: null,
    a: null,
    b: null,
    flag: false,
    amount,
  });

  it("sorts by the order columns numerically and refuses duplicate keys", () => {
    const sorted = sortRows(table, [row("b", "10"), row("a", "9"), row("c", "100")]);
    expect(sorted.map((r) => r["code"])).toEqual(["a", "b", "c"]);
    expect(() => checkKeys(table, [row("a", "1"), row("a", "2")])).toThrow(/duplicate code/);
    expect(() => checkKeys(table, [row("a", "1"), row("b", "1")])).toThrow(/duplicate ordinal/);
    expect(() => sortRows({ ...table, orderBy: ["nope"] }, [])).toThrow(/unknown column/);
  });

  it("emits ordered insert statements without generated columns", () => {
    const f = new Findings();
    const sql = insertStatements({ table, rows: [row("b", "2", "3.5"), row("a", "1")] }, f);
    expect(sql).toBe(
      "insert into xpms.demo (code, ordinal, parent, a, b, flag, amount) values\n" +
        "  ('a', 1, null, null, null, false, null),\n" +
        "  ('b', 2, null, null, null, false, 3.5);\n",
    );
    expect(insertStatements({ table, rows: [] }, f)).toBe("-- xpms.demo: canon states no rows.\n");
    expect(() => insertStatements({ table, rows: [{ ...row("a", "1"), extra: "x" }] }, f)).toThrow(
      /no seeded column extra/,
    );
    const partial: Record<string, string | null> = { code: "a", ordinal: "1" };
    expect(() => insertStatements({ table, rows: [partial] }, f)).toThrow(/no value for parent/);
    expect(() => insertStatements({ table, rows: [{ ...row("a", "1"), code: null }] }, f)).toThrow(
      /code is required/,
    );
  });
});

describe("ddl", () => {
  it("writes the table, keys, comments and supporting indexes", () => {
    const ddl = tableDdl(table);
    expect(ddl).toContain("create table xpms.demo (");
    expect(ddl).toContain("  code xpms.canon_code not null,");
    expect(ddl).toContain("  ordinal integer not null check (ordinal < 100),");
    expect(ddl).toContain("  parent xpms.canon_code references xpms.demo(code),");
    expect(ddl).toContain("  is_big boolean generated always as (amount > 10) stored not null,");
    expect(ddl).toContain("  unique (ordinal),");
    expect(ddl).toContain("  foreign key (a, b) references xpms.pair (a, b),");
    expect(ddl).toContain("  check (ordinal > 0)");
    expect(ddl).toContain("comment on table xpms.demo is 'Demo table''s comment.';");
    expect(ddl).toContain("comment on column xpms.demo.is_big is 'Derived.';");
    expect(ddl).toContain("create index demo_parent_idx on xpms.demo (parent);");
    expect(ddl).toContain("create index demo_a_b_idx on xpms.demo (a, b);");
  });

  it("documents every column of every xpms table", () => {
    const names = new Set<string>();
    for (const t of [...CANON_TABLES, ...GOVERNANCE_TABLES]) {
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(t.comment.length).toBeGreaterThan(10);
      for (const c of t.columns) expect(c.comment.endsWith(".")).toBe(true);
      for (const k of t.primaryKey) expect(columnSpec(t, k).nullable).toBeFalsy();
      expect(seededColumns(t).length).toBeGreaterThan(0);
    }
    expect(() => columnSpec(table, "nope")).toThrow(/no column nope/);
  });
});

describe("doctrine", () => {
  it("substitutes em dashes with a spaced hyphen and reports them", () => {
    const f = new Findings();
    expect(substituteEmDash(`a${DASH}b`)).toBe("a - b");
    expect(canonText(`Assembly ${DASH} standing`, "Bible 16 row 5 item", f)).toBe(
      "Assembly - standing",
    );
    expect(canonText("clean", "x", f)).toBe("clean");
    expect(f.items).toHaveLength(1);
    expect(f.items[0]?.detail).toContain("<em dash>");
  });
});

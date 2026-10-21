import { describe, expect, it } from "vitest";
import { findTable, firstSentence, loadDictionary, tableSlug } from "../lib/dictionary.ts";
import {
  DICTIONARY_SQL,
  GENERATED_NOTE,
  parseQueryOutput,
  toDictionary,
  type DictionaryTable,
} from "../lib/dictionary-source.ts";

const table = (name: string, kind: DictionaryTable["kind"] = "table"): DictionaryTable => ({
  schema: "app",
  name,
  kind,
  partitioned: false,
  rls: true,
  comment: `The ${name}. Second sentence.`,
  primaryKey: ["id"],
  columns: [
    { name: "id", type: "uuid", nullable: false, comment: "Identifier.", references: null },
    {
      name: "org_id",
      type: "uuid",
      nullable: false,
      comment: "Org.",
      references: "app.organizations.id",
    },
  ],
});

describe("parseQueryOutput", () => {
  it("reads the dictionary from an array of rows, a rows object, or JSON text", () => {
    const tables = [table("venues")];
    expect(parseQueryOutput(JSON.stringify([{ dictionary: tables }]))).toEqual(tables);
    expect(
      parseQueryOutput(
        `notice\n${JSON.stringify({ rows: [{ dictionary: tables }] })}\nupdate notice`,
      ),
    ).toEqual(tables);
    expect(parseQueryOutput(JSON.stringify([{ dictionary: JSON.stringify(tables) }]))).toEqual(
      tables,
    );
  });

  it("refuses output without a dictionary", () => {
    expect(() => parseQueryOutput("no json here")).toThrow(/no JSON/);
    expect(() => parseQueryOutput(JSON.stringify([{ other: 1 }]))).toThrow(/no dictionary/);
  });
});

describe("toDictionary", () => {
  it("counts tables, views and columns and carries the generated note", () => {
    const dictionary = toDictionary([table("venues"), table("v_venues", "view")]);
    expect(dictionary).toMatchObject({
      $generated: GENERATED_NOTE,
      tableCount: 1,
      viewCount: 1,
      columnCount: 4,
    });
  });

  it("asks the catalog for the doctrine's scope in a stable order", () => {
    expect(DICTIONARY_SQL).toContain("not c.relispartition");
    expect(DICTIONARY_SQL).toContain("('app', 'xpms', 'api_external', 'api_public')");
    expect(DICTIONARY_SQL).toContain("order by r.schema_name, r.rel_name");
  });
});

describe("helpers", () => {
  it("slugs a table by schema and name and takes a comment's first sentence", () => {
    expect(tableSlug({ schema: "xpms", name: "dim_department" })).toBe("xpms.dim_department");
    expect(firstSentence("The venues. Second sentence.")).toBe("The venues.");
    expect(firstSentence("No full stop")).toBe("No full stop");
    expect(firstSentence(null)).toBe("");
  });
});

describe("content/data-dictionary.json", () => {
  const dictionary = loadDictionary();

  it("was generated, and its counts match its tables", () => {
    expect(dictionary.$generated).toBe(GENERATED_NOTE);
    expect(toDictionary(dictionary.tables)).toEqual(dictionary);
    expect(dictionary.tableCount).toBeGreaterThan(500);
  });

  it("describes every table, view and table column (the comment doctrine, pgTAP 1280)", () => {
    expect(dictionary.tables.filter((t) => !t.comment).map(tableSlug)).toEqual([]);
    const missing = dictionary.tables
      .filter((t) => t.kind === "table")
      .flatMap((t) => t.columns.filter((c) => !c.comment).map((c) => `${tableSlug(t)}.${c.name}`));
    expect(missing).toEqual([]);
  });

  it("has one page per table and finds each by its slug", () => {
    const slugs = dictionary.tables.map(tableSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(findTable("app.organizations")?.kind).toBe("table");
    expect(findTable("app.access_scans")?.partitioned).toBe(true);
    expect(findTable("app.nothing")).toBeUndefined();
  });
});

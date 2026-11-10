import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  columnOf,
  FIXTURE_PATH,
  isColumnName,
  isTableName,
  loadDenormalizationRegister,
  MARKDOWN_PATH,
  parseDenormalizationRegister,
  REGISTER_PATH,
  registerProblems,
  renderRegisterFixture,
  renderRegisterMarkdown,
  tableOf,
  type DenormalizationRegister,
} from "../../src/denormalization/index.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const register = loadDenormalizationRegister();

/** A minimal register document; each list can be replaced. */
function doc(more: Record<string, unknown> = {}): string {
  return stringify({
    version: 1,
    derived: [
      {
        objects: ["app.cues.project_id", "app.usage_rollups"],
        source: "`app.run_of_show.project_id`",
        refresh: "Stamped by trigger on insert",
        reason: "PowerSync filters by project",
        adr: "0022",
      },
    ],
    own_names: [
      { name: "name", note: "The row's own name." },
      { name: "org_id", note: "Tenant key." },
    ],
    json: [{ column: "app.audit_events.diff", kind: "audit-diff", note: "Row diff." }],
    arrays: [{ column: "app.api_keys.scopes", kind: "reviewed", note: "Capability groups." }],
    restated: [
      {
        column: "app.cues.project_id",
        parent: "app.run_of_show.project_id",
        kind: "registered",
        note: "Stamped.",
      },
      {
        column: "private.session_devices.user_id",
        parent: "auth.sessions.user_id",
        kind: "finding",
        note: "The session's sign-in.",
        finding: "A108-003",
      },
    ],
    stored: [{ column: "app.usage_rollups.quantity_total", kind: "registered", note: "Rollup." }],
    tenant_exceptions: [{ table: "app.people", kind: "identity", note: "A person." }],
    ...more,
  });
}

const empty: DenormalizationRegister = {
  derived: [],
  ownNames: [],
  json: [],
  arrays: [],
  restated: [],
  stored: [],
  tenantExceptions: [],
};

describe("denormalization register", () => {
  it("parses docs/adr/denormalization-register.yaml without a problem", () => {
    expect(registerProblems(register)).toEqual([]);
    expect(readFileSync(REGISTER_PATH, "utf8")).toContain("version: 1");
    expect(register.json.length).toBeGreaterThan(0);
    expect(register.ownNames.map((n) => n.name)).toContain("org_id");
    expect(register.tenantExceptions.map((t) => t.table)).toContain("app.person_profiles");
  });

  it("lists the person-owned tables ADR 0033 decision 69 accepts", () => {
    const personOwned = register.tenantExceptions.filter((t) => t.kind === "person-owned");
    expect(personOwned.map((t) => t.table)).toEqual(
      expect.arrayContaining(["app.person_profiles", "app.shortcut_bindings", "app.blocks"]),
    );
  });

  it("matches the generated pgTAP fixture", () => {
    expect(readFileSync(join(repoRoot, FIXTURE_PATH), "utf8")).toBe(
      renderRegisterFixture(register),
    );
  });

  // Prettier formats the whole register (about 190 KB of Markdown tables): 11.6 s on a CI runner.
  it("matches the generated Markdown view", async () => {
    const target = join(repoRoot, MARKDOWN_PATH);
    const expected = await format(renderRegisterMarkdown(register), {
      ...((await resolveConfig(target)) ?? {}),
      filepath: target,
    });
    expect(readFileSync(target, "utf8")).toBe(expected);
  }, 60_000);

  it("names an existing finding file for every finding entry", () => {
    for (const e of [
      ...register.json,
      ...register.arrays,
      ...register.restated,
      ...register.stored,
    ]) {
      if (e.kind === "finding") {
        expect(e.finding, `${e.column} needs a finding`).not.toBeNull();
        expect(() =>
          readFileSync(join(repoRoot, `legal/qa/findings/${e.finding}.md`)),
        ).not.toThrow();
      }
    }
  });

  it("reads a minimal document", () => {
    const parsed = parseDenormalizationRegister(doc());
    expect(parsed.json).toEqual([
      { column: "app.audit_events.diff", kind: "audit-diff", note: "Row diff.", finding: null },
    ]);
    expect(parsed.ownNames.map((n) => n.name)).toEqual(["name", "org_id"]);
    expect(parsed.tenantExceptions[0]).toEqual({
      table: "app.people",
      kind: "identity",
      note: "A person.",
    });
    expect(parsed.restated[1]?.parent).toBe("auth.sessions.user_id");
    expect(parsed.restated[1]?.finding).toBe("A108-003");
  });

  it("refuses unknown fields and kinds", () => {
    expect(() => parseDenormalizationRegister(doc({ extra: [] }))).toThrow();
    expect(() =>
      parseDenormalizationRegister(
        doc({ json: [{ column: "app.x.y", kind: "settings", note: "Not an exception." }] }),
      ),
    ).toThrow();
    expect(() =>
      parseDenormalizationRegister(
        doc({ json: [{ column: "app.x.y", kind: "audit-diff", note: " " }] }),
      ),
    ).toThrow();
    expect(() =>
      parseDenormalizationRegister(
        doc({ tenant_exceptions: [{ table: "app.x", kind: "finding", note: "No such kind." }] }),
      ),
    ).toThrow();
  });

  it("lists every consistency problem", () => {
    const problems = registerProblems({
      ...empty,
      derived: [{ objects: ["public.x"], source: "s", refresh: "r", reason: "m", adr: "0002" }],
      ownNames: [
        { name: "org_id", note: "n" },
        { name: "name", note: "n" },
        { name: "name", note: "n" },
        { name: "Bad", note: "n" },
      ],
      json: [
        { column: "app.b.c", kind: "registered", note: "n", finding: null },
        { column: "app.a.c", kind: "finding", note: "n", finding: null },
        { column: "app.a.c", kind: "rich-text", note: "n", finding: "bad" },
      ],
      restated: [
        { column: "app.a.b", parent: "app.a.b", kind: "finding", note: "n", finding: "A108-001" },
        { column: "app.c.d", parent: "app.e.f", kind: "finding", note: "n", finding: "A108-001" },
        { column: "app.g.h", parent: "nope", kind: "finding", note: "n", finding: "A108-001" },
        { column: "app.i.name", parent: "app.j.name", kind: "own", note: "n", finding: null },
      ],
      tenantExceptions: [
        { table: "private.y", kind: "platform", note: "n" },
        { table: "app.x.y", kind: "platform", note: "n" },
        { table: "app.x.y", kind: "platform", note: "n" },
      ],
    });
    expect(problems).toEqual([
      "derived: public.x is not a table or column name",
      "own_names: name is listed twice",
      "own_names: entries are not sorted by name",
      "own_names: Bad is not a column name",
      "json: app.a.c is listed twice",
      "json: entries are not sorted by name",
      "json: app.b.c is marked registered but no derived entry names it",
      "json: app.a.c needs a finding id",
      "json: app.a.c names finding bad, which is not an id like A108-001",
      "restated: app.a.b names a column of its own table as its parent",
      "restated: app.c.d and its parent app.e.f have different column names",
      "restated: app.g.h names parent nope, not a column",
      "restated: app.i.name has a name the lint never compares (own_names)",
      "tenant_exceptions: app.x.y is listed twice",
      "tenant_exceptions: entries are not sorted by name",
      "tenant_exceptions: private.y is not an app table name",
      "tenant_exceptions: app.x.y is not an app table name",
      "tenant_exceptions: app.x.y is not an app table name",
    ]);
    expect(() =>
      parseDenormalizationRegister(
        doc({ json: [{ column: "app.x.y", kind: "registered", note: "No derived entry." }] }),
      ),
    ).toThrow(/no derived entry names it/);
  });

  it("accepts a registered column whose table is a derived entry", () => {
    expect(
      registerProblems({
        ...empty,
        derived: [
          { objects: ["app.usage_rollups"], source: "s", refresh: "r", reason: "m", adr: "0021" },
        ],
        stored: [
          { column: "app.usage_rollups.total", kind: "registered", note: "n", finding: null },
        ],
      }),
    ).toEqual([]);
  });

  it("renders one temporary table per allow-list, quoting values", () => {
    const sql = renderRegisterFixture({
      ...empty,
      ownNames: [{ name: "org_id", note: "n" }],
      json: [{ column: "app.a.b", kind: "audit-diff", note: "n", finding: null }],
      restated: [
        { column: "app.c.d", parent: "app.e.d", kind: "finding", note: "n", finding: "A108-001" },
      ],
      tenantExceptions: [{ table: "app.it's", kind: "platform", note: "n" }],
    });
    expect(sql).toContain(
      "create temporary table register_own_names (column_name text not null, primary key (column_name));\ninsert into register_own_names values\n  ('org_id');",
    );
    expect(sql).toContain(
      "create temporary table register_json (column_name text not null, exception text not null, primary key (column_name));\ninsert into register_json values\n  ('app.a.b', 'audit-diff');",
    );
    expect(sql).toContain("primary key (column_name, parent_column)");
    expect(sql).toContain("  ('app.c.d', 'app.e.d', 'finding');");
    expect(sql).toContain("('app.it''s', 'platform')");
    expect(sql).toContain(
      "create temporary table register_stored (column_name text not null, kind text not null, primary key (column_name));\ncreate temporary table register_tenant_exceptions",
    );
  });

  it("renders the Markdown view with every list and links findings", () => {
    const md = renderRegisterMarkdown({
      ...empty,
      json: [
        { column: "app.a.b", kind: "finding", note: "Settings | values", finding: "A108-001" },
      ],
    });
    expect(md).toContain("# Denormalization Register");
    expect(md).toContain(
      "| `app.a.b` | finding | Settings \\| values ([A108-001](../../legal/qa/findings/A108-001.md)) |",
    );
    expect(md.match(/^None\.$/gm)).toHaveLength(6);
  });

  it("names tables and columns of the linted schemas only", () => {
    expect(isTableName("app.people")).toBe(true);
    expect(isTableName("public.people")).toBe(false);
    expect(isColumnName("xpms.intake.reason")).toBe(true);
    expect(isColumnName("app.people")).toBe(false);
    expect(tableOf("private.sync_scope_grants.person_id")).toBe("private.sync_scope_grants");
    expect(columnOf("private.sync_scope_grants.person_id")).toBe("person_id");
  });
});

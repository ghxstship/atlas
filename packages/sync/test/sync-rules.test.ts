import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  EXTERNAL_AUDIENCES,
  INTERNAL_AUDIENCES,
  TABLE_RULES,
  type Audience,
  type ScopeKey,
} from "../src";

interface Bucket {
  parameters?: string;
  data: string[];
}

const rules = parse(readFileSync(new URL("../sync-rules.yaml", import.meta.url), "utf8")) as {
  bucket_definitions: Record<string, Bucket>;
};

const ALL: readonly Audience[] = [...INTERNAL_AUDIENCES, ...EXTERNAL_AUDIENCES];

/** A data query reduced to what the device-side rules express. */
interface Grant {
  table: string;
  column: string | null;
  key: ScopeKey | null;
  audiences: readonly Audience[];
}

/** One data query of the rules file, parsed. */
interface Query {
  bucket: string;
  /** Schema-qualified source table. */
  source: string;
  /** Local table the rows land in: the alias, or the source table name. */
  table: string;
  /** Source columns selected, or ["*"]. */
  columns: string[];
  column: string | null;
  audiences: Audience[] | null;
}

const QUERY = /^SELECT (.+?) FROM (\w+)\.(\w+)(?: AS (\w+))?(?: WHERE (.+))?$/;

/** The source column an output column reads: `col`, `col AS alias` or `FN(col) AS alias`. */
function sourceColumn(item: string): string {
  const expr = item.split(/ AS /i)[0]?.trim() ?? "";
  const call = /^\w+\((\w+)\)$/.exec(expr);
  return call ? (call[1] ?? "") : expr;
}

function parseQueries(): Query[] {
  const out: Query[] = [];
  for (const [bucket, definition] of Object.entries(rules.bucket_definitions)) {
    for (const query of definition.data) {
      const match = QUERY.exec(query);
      expect(match, `${bucket}: ${query}`).not.toBeNull();
      if (!match) continue;
      const [, list = "", schema = "", source = "", alias, where] = match;
      let column: string | null = null;
      let audiences: Audience[] | null = null;
      for (const condition of where ? where.split(" AND ") : []) {
        const param = /^(\w+) = bucket\.\w+$/.exec(condition);
        const many = /^bucket\.audience IN \(([^)]+)\)$/.exec(condition);
        const one = /^bucket\.audience = '([\w-]+)'$/.exec(condition);
        if (param) column = param[1] ?? null;
        else if (many)
          audiences = (many[1] ?? "")
            .split(",")
            .map((v) => v.trim().replace(/'/g, "")) as Audience[];
        else if (one) audiences = [one[1] as Audience];
      }
      out.push({
        bucket,
        source: `${schema}.${source}`,
        table: alias ?? source,
        columns: list.split(",").map((c) => sourceColumn(c.trim())),
        column,
        audiences,
      });
    }
  }
  return out;
}

function grantsFromYaml(): Grant[] {
  return parseQueries().map((q) => {
    const key = rules.bucket_definitions[q.bucket]?.parameters
      ? (/scope_key = '(\w+)'/.exec(
          rules.bucket_definitions[q.bucket]?.parameters ?? "",
        )?.[1] as ScopeKey)
      : null;
    const domain =
      key === "engagementIds" || key === "engagedProjectIds"
        ? EXTERNAL_AUDIENCES
        : key === "personIds" || key === "rosterEntryIds" || key === null
          ? ALL
          : INTERNAL_AUDIENCES;
    return { table: q.table, column: q.column, key, audiences: q.audiences ?? domain };
  });
}

function grantsFromScope(): Grant[] {
  return TABLE_RULES.flatMap((rule): Grant[] =>
    rule.global
      ? [{ table: rule.table, column: null, key: null, audiences: ALL }]
      : rule.anyOf
          .filter((alt) => !alt.restOnly)
          .map((alt) => ({
            table: rule.table,
            column: alt.column,
            key: alt.key,
            audiences: alt.audiences ?? ALL,
          })),
  );
}

function canonical(grants: Grant[]): string[] {
  return grants
    .map(
      (g) =>
        `${g.table}.${g.column ?? "*"}<-${g.key ?? "global"}[${[...g.audiences].sort().join(",")}]`,
    )
    .sort();
}

describe("sync rules (Section 13: tested against the same scope rules as RLS)", () => {
  it("every bucket query matches a device-side scope rule and the reverse", () => {
    expect(canonical(grantsFromYaml())).toEqual(canonical(grantsFromScope()));
  });

  it("external buckets are parameterized only by engagement or roster entry scope", () => {
    for (const [name, bucket] of Object.entries(rules.bucket_definitions)) {
      if (!name.startsWith("external_")) continue;
      expect(bucket.parameters).toMatch(/scope_key = '(engagementIds|engagedProjectIds|rosterEntryIds)'/);
    }
  });

  it("every parameter query reads the caller's own grants", () => {
    for (const bucket of Object.values(rules.bucket_definitions)) {
      if (bucket.parameters)
        expect(bucket.parameters).toContain("person_user_id = request.user_id()");
    }
  });

  it("names every source with its schema, so PowerSync never resolves it in public", () => {
    for (const q of parseQueries()) expect(q.source).toMatch(/^(app|xpms)\.\w+$/);
    for (const bucket of Object.values(rules.bucket_definitions)) {
      if (bucket.parameters) expect(bucket.parameters).toContain("FROM private.sync_scope_grants");
    }
  });

  it("never selects every column for external, person or canon buckets (Section 8.7)", () => {
    for (const q of parseQueries()) {
      if (
        q.bucket.startsWith("external_") ||
        q.bucket === "own_person" ||
        q.bucket === "roster_entry" ||
        q.bucket === "canon_reference"
      )
        expect(q.columns, `${q.bucket} ${q.source}`).not.toContain("*");
    }
  });

  it("lists exactly the sources and columns the database test checks", () => {
    const sql = readFileSync(
      new URL("../../../supabase/tests/1022_sync_rules_sources.test.sql", import.meta.url),
      "utf8",
    );
    const block = /-- sync-rules: begin([\s\S]*?)-- sync-rules: end/.exec(sql)?.[1] ?? "";
    const checked = [...block.matchAll(/\('([\w]+)', '([\w.]+)', '([^']+)'/g)].map(
      (m) =>
        `${m[1]} ${m[2]} ${(m[3] ?? "")
          .split(",")
          .map((c) => c.split(">")[0])
          .join(",")}`,
    );
    const listed = parseQueries().map((q) => `${q.bucket} ${q.source} ${q.columns.join(",")}`);
    expect(checked.length).toBeGreaterThan(0);
    expect(listed).toEqual(checked);
  });
});

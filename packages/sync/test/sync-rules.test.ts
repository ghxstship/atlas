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

function grantsFromYaml(): Grant[] {
  const grants: Grant[] = [];
  for (const [name, bucket] of Object.entries(rules.bucket_definitions)) {
    const key = bucket.parameters
      ? (/scope_key = '(\w+)'/.exec(bucket.parameters)?.[1] as ScopeKey)
      : null;
    const domain =
      key === "engagementIds" || key === "engagedProjectIds"
        ? EXTERNAL_AUDIENCES
        : key === "personIds" || key === null
          ? ALL
          : INTERNAL_AUDIENCES;
    for (const query of bucket.data) {
      const match =
        /^SELECT \* FROM (\w+)(?: WHERE (\w+) = bucket\.\w+)?(?: AND bucket\.audience (?:IN \(([^)]+)\)|= '([\w-]+)'))?$/.exec(
          query,
        );
      expect(match, `${name}: ${query}`).not.toBeNull();
      if (!match) continue;
      const listed = match[3] ?? (match[4] ? `'${match[4]}'` : null);
      const audiences = listed
        ? (listed.split(",").map((s) => s.trim().replace(/'/g, "")) as Audience[])
        : domain;
      grants.push({ table: match[1] ?? "", column: match[2] ?? null, key, audiences });
    }
  }
  return grants;
}

function grantsFromScope(): Grant[] {
  return TABLE_RULES.flatMap((rule) =>
    rule.global
      ? [{ table: rule.table, column: null, key: null, audiences: ALL }]
      : rule.anyOf.map((alt) => ({
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

  it("external buckets are parameterized only by engagement scope", () => {
    for (const [name, bucket] of Object.entries(rules.bucket_definitions)) {
      if (!name.startsWith("external_")) continue;
      expect(bucket.parameters).toMatch(/scope_key = '(engagementIds|engagedProjectIds)'/);
    }
  });

  it("every parameter query reads the caller's own grants", () => {
    for (const bucket of Object.values(rules.bucket_definitions)) {
      if (bucket.parameters)
        expect(bucket.parameters).toContain("person_user_id = request.user_id()");
    }
  });
});

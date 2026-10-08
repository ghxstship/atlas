import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CLASSES,
  CAPABILITY_REACHES,
  CAPABILITY_SEED_MIGRATION,
  NAV_GROUPS,
  loadCapabilityRegistry,
  renderCapabilitySeedSql,
} from "../../src/capabilities/index.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(`${repoRoot}${path}`, "utf8");

function enumValues(sql: string, type: string): string[] {
  const match = new RegExp(`create type ${type.replace(".", "\\.")} as enum \\(([^)]*)\\)`).exec(
    sql,
  );
  if (match?.[1] === undefined) throw new Error(`enum ${type} not found`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

describe("generated capability seed migration", () => {
  it("matches the generator output for capabilities.yaml", () => {
    expect(read(CAPABILITY_SEED_MIGRATION)).toBe(renderCapabilitySeedSql(loadCapabilityRegistry()));
  });
});

describe("Postgres enums", () => {
  const reference = read("supabase/migrations/0201_platform_reference.sql");

  it("carry exactly the registry's closed lists", () => {
    expect(enumValues(reference, "app.capability_class")).toEqual([...CAPABILITY_CLASSES]);
    expect(enumValues(reference, "app.capability_reach")).toEqual([...CAPABILITY_REACHES]);
    expect(enumValues(reference, "app.nav_group")).toEqual([...NAV_GROUPS]);
  });
});

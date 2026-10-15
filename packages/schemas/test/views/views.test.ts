import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { GENERATED_PATH, renderViewRegistryModule } from "../../src/views/generate.ts";
import { loadViewRegistry, parseViewRegistry } from "../../src/views/load.ts";
import {
  entityDefault,
  fits,
  offeredViews,
  SAVED_VIEW_TYPES,
  savedViewTypeOf,
  VIEW_REGISTRY,
  viewCodeOf,
} from "../../src/views/index.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const registry = loadViewRegistry();

describe("view registry", () => {
  it("matches the generated module", async () => {
    const target = join(packageRoot, GENERATED_PATH);
    const options = (await resolveConfig(target)) ?? {};
    const expected = await format(renderViewRegistryModule(registry), {
      ...options,
      filepath: target,
    });
    expect(readFileSync(target, "utf8")).toBe(expected);
    expect(VIEW_REGISTRY).toEqual(registry);
  });

  it("stores only view types the database knows", () => {
    const sql = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
      .join("\n");
    const declared = new Set<string>();
    const create = /create type app\.view_type as enum \(([^)]*)\)/.exec(sql);
    for (const m of (create?.[1] ?? "").matchAll(/'([^']+)'/g)) declared.add(m[1] as string);
    for (const m of sql.matchAll(/alter type app\.view_type add value if not exists '([^']+)'/g)) {
      declared.add(m[1] as string);
    }
    expect([...declared].sort()).toEqual([...SAVED_VIEW_TYPES].sort());
    for (const view of registry.views) expect(declared.has(view.savedAs)).toBe(true);
  });

  it("offers only declared views that fit the data and the shell", () => {
    const offered = offeredViews(registry, {
      declared: ["table", "board", "calendar", "map", "made-up"],
      shell: "atlas",
      traits: ["single_choice"],
    });
    expect(offered.map((v) => v.code)).toEqual(["table", "board"]);
    expect(
      offeredViews(registry, { declared: ["table", "tree", "list"], shell: "compass" }).map(
        (v) => v.code,
      ),
    ).toEqual(["list"]);
    expect(
      offeredViews(registry, { declared: ["calendar"], shell: "atlas", traits: new Set(["date"]) }),
    ).toHaveLength(1);
  });

  it("checks traits, defaults and saved types", () => {
    const board = registry.views.find((v) => v.code === "board");
    expect(board && fits(board, new Set(["single_choice"]))).toBe(true);
    expect(board && fits(board, [])).toBe(false);
    expect(entityDefault(registry, "shifts", "atlas")).toBe("resource-schedule");
    expect(entityDefault(registry, "shifts", "compass")).toBe("calendar");
    expect(entityDefault(registry, "projects", "atlas")).toBeUndefined();
    expect(savedViewTypeOf(registry, "resource-schedule")).toBe("Resource Schedule");
    expect(savedViewTypeOf(registry, "nothing")).toBeUndefined();
    expect(viewCodeOf(registry, "List")).toBe("list");
    expect(viewCodeOf(registry, "List", ["split"])).toBe("split");
    expect(viewCodeOf(registry, "Map", ["list"])).toBeUndefined();
  });

  it("refuses broken registry files", () => {
    const base = readFileSync(join(packageRoot, "views.yaml"), "utf8");
    expect(() => parseViewRegistry(`${base}\n  - entity: crew\n    atlas: kanban\n`)).toThrow(
      /unknown view kanban/,
    );
    expect(() =>
      parseViewRegistry(
        "traits: [{code: date, description: A date.}, {code: date, description: Twice.}]\nviews:\n  - {code: list, saved_as: List, icon: List, requires: [missing], shells: [atlas]}\n  - {code: list, saved_as: List, icon: List, requires: [], shells: [atlas]}\ndefaults: []\n",
      ),
    ).toThrow(/listed twice[\s\S]*unknown trait missing/);
    expect(() =>
      parseViewRegistry(
        "traits: []\nviews:\n  - {code: list, saved_as: Kanban, icon: List, requires: [], shells: [atlas]}\ndefaults: []\n",
      ),
    ).toThrow();
  });
});

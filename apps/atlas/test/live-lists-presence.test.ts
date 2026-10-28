import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  othersPresent,
  PRESENCE_TABLES,
  presenceState,
  presenceTopic,
} from "../components/presence/presence";

/**
 * A123 (RRR-168, ADR 0083): the list pages that update live name only published tables, and the
 * presence channels Atlas joins are the ones 2170's join rule admits.
 */
const atlas = fileURLToPath(new URL("../", import.meta.url));
const migrations = join(atlas, "../../supabase/migrations");

function migration(prefix: string): string {
  const file = readdirSync(migrations).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`No migration ${prefix}`);
  return readFileSync(join(migrations, file), "utf8");
}

/** Every app table in the supabase_realtime publication, from the migrations that add them. */
function publishedTables(): Set<string> {
  const tables = new Set<string>();
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(migrations, file), "utf8");
    if (!sql.includes("supabase_realtime")) continue;
    for (const m of sql.matchAll(/alter publication supabase_realtime add table ([^;']+);/g)) {
      for (const t of (m[1] ?? "").split(",")) tables.add(t.trim().replace(/^app\./, ""));
    }
    // 0807, 1450 and 2170 add their tables in a loop over a list of names.
    for (const m of sql.matchAll(/array\[([^\]]+)\]|\(values\s([\s\S]+?)\) as t/g)) {
      for (const n of (m[1] ?? m[2] ?? "").matchAll(/'([a-z_]+)'/g)) tables.add(n[1] ?? "");
    }
  }
  return tables;
}

/** Each `<LiveList ... tables={[...]} />` in the Atlas app routes. */
function liveListTables(dir: string, found: Map<string, string[]> = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) liveListTables(path, found);
    else if (entry.name === "page.tsx") {
      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(/<LiveList[^>]*tables=\{\[([^\]]*)\]\}/g)) {
        found.set(
          path.slice(atlas.length),
          [...(m[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((n) => n[1] ?? ""),
        );
      }
    }
  }
  return found;
}

describe("live lists", () => {
  const pages = liveListTables(join(atlas, "app"));

  it("cover the projects, procurement, vendors, work order, advancing, logistics and people lists", () => {
    const routes = [...pages.keys()].map((p) =>
      p.replace(/^app\/\[org\]\//, "").replace(/\/page\.tsx$/, ""),
    );
    for (const route of [
      "projects",
      "procurement/purchase-orders",
      "procurement/receipts",
      "procurement/rfqs",
      "vendors/directory",
      "work/work-orders",
      "advancing/packets",
      "advancing/submissions",
      "logistics/shipments",
      "logistics/dock-schedule",
      "logistics/marshalling-yard-log",
      "people/directory",
      "people/requisitions",
      "people/agreements",
    ]) {
      expect(routes, route).toContain(route);
    }
  });

  it("watch only tables in the Realtime publication", () => {
    const published = publishedTables();
    for (const [page, tables] of pages) {
      expect(tables.length, page).toBeGreaterThan(0);
      for (const table of tables) expect(published, `${page}: ${table}`).toContain(table);
    }
  });
});

describe("presence", () => {
  it("joins only tables 2170 lists in private.presence_subjects", () => {
    const sql = migration("2170_");
    const block = sql.slice(sql.indexOf("insert into private.presence_subjects"));
    const listed = [...block.slice(0, block.indexOf(";")).matchAll(/'app\.([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect([...PRESENCE_TABLES].sort()).toEqual(listed.sort());
  });

  it("names a row's channel as the join rule reads it", () => {
    const id = "0190f0aa-1111-7222-8333-944455556666";
    expect(presenceTopic("records", id)).toBe(`presence:records:${id}`);
    expect(presenceTopic("records", id)).toMatch(
      /^presence:[a-z][a-z0-9_]{0,58}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(presenceState({ key: "p1", name: "Ana Ruiz" })).toEqual({ key: "p1", name: "Ana Ruiz" });
  });

  it("lists the other people once each, without this tab's person", () => {
    const members = [
      { key: "me", name: "Morgan Lee", presence_ref: "a" },
      { key: "p2", name: "Ben Ortiz", presence_ref: "b" },
      { key: "p3", name: "Ana Ruiz", presence_ref: "c" },
      { key: "p2", name: "Ben Ortiz", presence_ref: "d" },
      { key: "me", name: "Morgan Lee", presence_ref: "e" },
    ];
    expect(othersPresent(members, "me")).toEqual(["Ana Ruiz", "Ben Ortiz"]);
  });

  it("ignores members without a key or a name", () => {
    expect(
      othersPresent(
        [{ name: "No Key" }, { key: "p2" }, { key: "p3", name: "  " }, { key: 4, name: "X" }],
        "me",
      ),
    ).toEqual([]);
  });
});

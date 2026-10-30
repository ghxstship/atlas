import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  othersEditing,
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

/** Every table any migration inserts into private.presence_subjects (2170, then 2811 and later). */
function presenceSubjects(): string[] {
  const listed: string[] = [];
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const m of sql.matchAll(/insert into private\.presence_subjects[^;]*;/g)) {
      for (const n of m[0].matchAll(/'app\.([a-z_]+)'/g)) listed.push(n[1] ?? "");
    }
  }
  return listed;
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

  it("cover the finance budgets page and the project Budget tab", () => {
    expect(pages.get("app/[org]/finance/budgets/page.tsx")).toEqual(["budgets"]);
    expect(pages.get("app/[org]/p/[projectKey]/budget/page.tsx")).toEqual(["budgets"]);
  });

  it("watch only tables in the Realtime publication", () => {
    const published = publishedTables();
    for (const [page, tables] of pages) {
      expect(tables.length, page).toBeGreaterThan(0);
      for (const table of tables) expect(published, `${page}: ${table}`).toContain(table);
    }
  });
});

describe("live budget grid", () => {
  it("follows only published tables, narrowed to the budget and its project", () => {
    const src = readFileSync(join(atlas, "components/finance/budget-editor.tsx"), "utf8");
    const call = src.slice(src.indexOf("useLiveRefresh("), src.indexOf("useLiveRefresh(") + 600);
    const topics = [...call.matchAll(/table: "([a-z_]+)", filter: `([a-z_]+)=eq\./g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(topics).toEqual([
      ["budget_lines", "budget_id"],
      ["purchase_orders", "project_id"],
    ]);
    const published = publishedTables();
    for (const [table] of topics) expect(published).toContain(table);
  });
});

describe("presence", () => {
  it("joins only tables the migrations list in private.presence_subjects", () => {
    expect([...PRESENCE_TABLES].sort()).toEqual(presenceSubjects().sort());
    expect(PRESENCE_TABLES).toContain("budgets");
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

  it("tracks the line a budget cell is open on, and lists who is editing which line", () => {
    expect(presenceState({ key: "p1", name: "Ana Ruiz" }, { line: 12 })).toEqual({
      key: "p1",
      name: "Ana Ruiz",
      line: 12,
    });
    const members = [
      { key: "me", name: "Morgan Lee", line: 3 },
      { key: "p2", name: "Ben Ortiz", presence_ref: "b" },
      { key: "p3", name: "Ana Ruiz", line: 12 },
      { key: "p2", name: "Ben Ortiz", line: 4 },
      { key: "p4", name: "Cy Park", line: "7" },
    ];
    expect(othersEditing(members, "me")).toEqual([
      { key: "p3", name: "Ana Ruiz", line: 12 },
      { key: "p2", name: "Ben Ortiz", line: 4 },
      { key: "p4", name: "Cy Park", line: null },
    ]);
  });

  it("keeps two people who share a name apart, by their presence key", () => {
    const members = [
      { key: "p2", name: "Sam Lee", line: 2 },
      { key: "p3", name: "Sam Lee", line: 5 },
    ];
    const others = othersEditing(members, "me");
    expect(others.map((o) => o.key).sort()).toEqual(["p2", "p3"]);
    expect(new Set(others.map((o) => o.key)).size).toBe(others.length);
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

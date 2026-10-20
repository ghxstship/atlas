import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareCounts, formatDifferences, parseCounts } from "../src/compare.ts";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  deriveSeedMarkers,
  extractMarkerBlock,
  readMarkerSources,
  renderMarkerBlock,
  replaceMarkerBlock,
  unsafeDomains,
} from "../src/seed-markers.ts";
import { batchByBucket, deleteObjects, parseObjectList } from "../src/storage.ts";
import { DRY_RUN_REPORT, RUN_REPORT, toPlainSql } from "../src/plain-sql.ts";
import { deleteStorageLinked, parseReport, runLinked } from "../src/linked.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sqlPath = fileURLToPath(new URL("../remove-demo-data.sql", import.meta.url));
const repoSeeds = () => readMarkerSources(repoRoot);

describe("seed markers", () => {
  const files = [
    {
      name: "0020_b.sql",
      sql: "insert into app.projects (id) values ('01920000-0000-7000-8000-000000001001'); -- crew@example.com",
    },
    {
      name: "0010_a.sql",
      sql: "INSERT INTO auth.users (id, email) values ('01920000-0000-7000-8000-0000000001AB', 'Owner@Example.com');\ninsert into app.projects select 1;",
    },
  ];

  it("reads ids, email domains and seeded tables, sorted and without repeats", () => {
    const markers = deriveSeedMarkers(files);
    expect(markers.files).toEqual(["0010_a.sql", "0020_b.sql"]);
    expect(markers.ids).toEqual([
      "01920000-0000-7000-8000-0000000001ab",
      "01920000-0000-7000-8000-000000001001",
    ]);
    expect(markers.domains).toEqual(["example.com"]);
    expect(markers.tables).toEqual(["app.projects", "auth.users"]);
  });

  it("renders a block the extractor finds and the replacer swaps", () => {
    const block = renderMarkerBlock(deriveSeedMarkers(files));
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
    expect(block).toContain("('01920000-0000-7000-8000-000000001001'::uuid)");
    const sql = `before\n${BLOCK_BEGIN}\nold\n${BLOCK_END}\nafter`;
    const replaced = replaceMarkerBlock(sql, block);
    expect(extractMarkerBlock(replaced)).toBe(block);
    expect(replaced.startsWith("before\n") && replaced.endsWith("\nafter")).toBe(true);
  });

  it("refuses an empty marker set and a file without the block", () => {
    expect(() =>
      renderMarkerBlock({ files: [], ids: [], domains: ["example.com"], tables: [] }),
    ).toThrow(/No seed ids/);
    expect(() =>
      renderMarkerBlock({
        files: [],
        ids: ["01920000-0000-7000-8000-000000000001"],
        domains: [],
        tables: [],
      }),
    ).toThrow(/email domains/);
    expect(extractMarkerBlock("no block here")).toBeNull();
    expect(() => replaceMarkerBlock("no block here", "x")).toThrow(/no generated marker block/);
  });

  it("flags email domains that are not reserved for testing", () => {
    const markers = {
      files: [],
      ids: [],
      tables: [],
      domains: ["example.com", "calendar.example.com", "acme.io", "x.test"],
    };
    expect(unsafeDomains(markers)).toEqual(["acme.io"]);
  });
});

describe("the repository's removal script", () => {
  const sql = readFileSync(sqlPath, "utf8");
  const markers = deriveSeedMarkers(repoSeeds());

  it("carries the marker block the current seeds produce", () => {
    expect(extractMarkerBlock(sql)).toBe(renderMarkerBlock(markers));
  });

  it("starts from the demo org and the demo sign-ins of the conventions file", () => {
    for (const id of [
      "01920000-0000-7000-8000-000000000001",
      "01920000-0000-7000-8000-000000000101",
      "01920000-0000-7000-8000-000000000301",
    ]) {
      expect(markers.ids).toContain(id);
    }
    expect(unsafeDomains(markers)).toEqual([]);
    expect(markers.domains).toContain("load.example.test");
    expect(markers.files.some((name) => name.startsWith("supabase/seeds/0010_"))).toBe(true);
  });

  it("deletes through the sanctioned tenant purge and never switches integrity off", () => {
    expect(sql).toContain("private.begin_tenant_purge(");
    expect(sql).toContain("private.end_tenant_purge()");
    expect(sql).not.toMatch(/session_replication_role/i);
    expect(sql).not.toMatch(/disable\s+trigger/i);
    expect(sql).not.toMatch(/\btruncate\s+(app|auth|private|storage)\./i);
  });
});

describe("storage objects", () => {
  it("parses the dry run's CSV, quoted names included", () => {
    expect(parseObjectList('org-brand,a/b.png\n"profile-media","x/""q"",y.png"\n\n')).toEqual([
      { bucket: "org-brand", name: "a/b.png" },
      { bucket: "profile-media", name: 'x/"q",y.png' },
    ]);
    expect(() => parseObjectList("only-one-field")).toThrow(/Malformed/);
  });

  it("batches per bucket", () => {
    const objects = [
      { bucket: "b", name: "1" },
      { bucket: "a", name: "2" },
      { bucket: "b", name: "3" },
      { bucket: "b", name: "4" },
    ];
    expect(
      batchByBucket(objects, 2).map((batch) => batch.map((o) => `${o.bucket}/${o.name}`)),
    ).toEqual([["a/2"], ["b/1", "b/3"], ["b/4"]]);
  });

  it("deletes through the Storage API with the service role and stops on a refusal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { prefixes: string[] };
      return Promise.resolve(
        new Response(JSON.stringify(body.prefixes.map((name) => ({ name }))), { status: 200 }),
      );
    };
    const result = await deleteObjects(
      [
        { bucket: "org-brand", name: "o/logo.png" },
        { bucket: "profile-media", name: "p/a.png" },
      ],
      { url: "http://127.0.0.1:58621/", serviceKey: "test-key", fetch: ok },
    );
    expect(result).toEqual({ requested: 2, deleted: 2 });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:58621/storage/v1/object/org-brand",
      "http://127.0.0.1:58621/storage/v1/object/profile-media",
    ]);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer test-key",
    );

    const refused: typeof fetch = () => Promise.resolve(new Response("{}", { status: 403 }));
    await expect(
      deleteObjects([{ bucket: "org-brand", name: "x" }], {
        url: "http://h",
        serviceKey: "k",
        fetch: refused,
      }),
    ).rejects.toThrow(/HTTP 403/);
    const odd: typeof fetch = () => Promise.resolve(new Response("{}", { status: 200 }));
    expect(
      await deleteObjects([{ bucket: "b", name: "x" }], {
        url: "http://h",
        serviceKey: "k",
        fetch: odd,
      }),
    ).toEqual({
      requested: 1,
      deleted: 0,
    });
  });
});

describe("no-seed comparison", () => {
  const baseline = parseCounts(
    "app.organizations 0\nxpms.dim_department 12\ncron.job_run_details 0\n",
  );

  it("matches when every table has the same count", () => {
    expect(compareCounts(baseline, new Map(baseline))).toEqual([]);
    expect(formatDifferences([])).toMatch(/matches/);
  });

  it("separates data differences from runtime history", () => {
    const target = parseCounts(
      "app.organizations 2\nxpms.dim_department 12\ncron.job_run_details 3\nsupabase_migrations.seed_files 26\n",
    );
    const differences = compareCounts(baseline, target);
    expect(differences).toEqual([
      { table: "app.organizations", baseline: 0, target: 2, runtime: false },
      { table: "cron.job_run_details", baseline: 0, target: 3, runtime: true },
      { table: "supabase_migrations.seed_files", baseline: null, target: 26, runtime: true },
    ]);
    expect(formatDifferences(differences)).toContain(
      "DATA    app.organizations: no-seed 0, target 2",
    );
    expect(formatDifferences(differences)).toContain("no-seed absent, target 26");
  });

  it("rejects malformed lines", () => {
    expect(() => parseCounts("app.organizations two")).toThrow(/Malformed/);
  });
});

describe("plain SQL for supabase db query --linked", () => {
  const script = readFileSync(sqlPath, "utf8");
  const noMeta = (sql: string) => sql.split("\n").filter((l) => /^\s*\\/.test(l));

  it("leaves no psql meta-command or variable in any mode", () => {
    for (const mode of ["dry-run", "rehearse", "execute"] as const) {
      const sql = toPlainSql(script, mode);
      expect(noMeta(sql)).toEqual([]);
      expect(sql).not.toContain(":'mode'");
      expect(sql).not.toMatch(/\\gset/);
      expect(sql).toContain(`set_config('xos.demo_removal_mode', '${mode}', false)`);
    }
  });

  it("stops the dry run before any delete, with the report right before the rollback", () => {
    const sql = toPlainSql(script, "dry-run");
    expect(sql).not.toContain("begin_tenant_purge(array");
    expect(sql).not.toMatch(/delete from %s/);
    expect(sql.trimEnd().endsWith(`${DRY_RUN_REPORT}\n  rollback;`)).toBe(true);
    expect(sql.match(/^\s*(commit|rollback)\s*;\s*$/gim)).toHaveLength(1);
  });

  it("commits only in execute, after every verification, and rolls the rehearsal back", () => {
    const execute = toPlainSql(script, "execute");
    const rehearse = toPlainSql(script, "rehearse");
    expect(execute.trimEnd().endsWith(`${RUN_REPORT}\n  commit;`)).toBe(true);
    expect(rehearse.trimEnd().endsWith(`${RUN_REPORT}\n  rollback;`)).toBe(true);
    for (const sql of [execute, rehearse]) {
      expect(sql.match(/^\s*(commit|rollback)\s*;\s*$/gim)).toHaveLength(1);
      expect(sql.indexOf("Verification failed")).toBeLessThan(sql.indexOf("as report;"));
      expect(sql.indexOf("begin_tenant_purge(array")).toBeGreaterThan(sql.indexOf("begin;"));
    }
    // The stop-after-report and storage-list branches never reach the plain SQL.
    expect(execute).not.toContain("to stdout with (format csv)");
  });

  it("refuses scripts it cannot translate faithfully", () => {
    const head = "begin;\nselect 1;\n";
    expect(() => toPlainSql(`${head}\\copy t to 'x'\ncommit;\n`, "execute")).toThrow(
      /unsupported psql meta-command/,
    );
    expect(() => toPlainSql(`${head}select :'other';\ncommit;\n`, "execute")).toThrow(
      /untranslated psql variable/,
    );
    expect(() => toPlainSql(`${head}\\if :{?surprise}\n\\endif\ncommit;\n`, "execute")).toThrow(
      /unknown \\if/,
    );
    expect(() => toPlainSql("begin;\nselect 1;\n", "execute")).toThrow(
      /never ended its transaction/,
    );
    expect(() => toPlainSql(script, "nope" as never)).toThrow(/Unknown mode/);
  });

  it("keeps dollar-quoted bodies verbatim, colons included", () => {
    const sql = toPlainSql(
      "begin;\ndo $w$\nbegin perform 1::int; end;\n$w$;\ncommit;\n",
      "execute",
    );
    expect(sql).toContain("begin perform 1::int; end;");
  });
});

describe("the linked runner", () => {
  it("reads the single report row the CLI prints", () => {
    expect(parseReport<{ a: number }>('[{"report":{"a":1}}]')).toEqual({ a: 1 });
    expect(parseReport<{ a: number }>('[{"report":"{\\"a\\":2}"}]')).toEqual({ a: 2 });
    expect(() => parseReport("[]")).toThrow(/one report row/);
    expect(() => parseReport('[{"other":1}]')).toThrow(/no report/);
  });

  it("runs the translated SQL through db query --linked as JSON", () => {
    const calls: string[][] = [];
    const report = runLinked<{ mode: string }>(
      readFileSync(sqlPath, "utf8"),
      "dry-run",
      repoRoot,
      (args) => {
        calls.push(args);
        const file = args[args.indexOf("-f") + 1] ?? "";
        expect(readFileSync(file, "utf8")).toContain("'dry-run'");
        return '[{"report":{"mode":"dry-run"}}]';
      },
    );
    expect(report.mode).toBe("dry-run");
    expect(calls[0]?.slice(0, 5)).toEqual(["db", "query", "--linked", "-o", "json"]);
  });

  it("deletes storage objects through storage rm --linked in batches of 50", () => {
    const calls: string[][] = [];
    const objects = Array.from({ length: 120 }, (_, i) => ({
      bucket: "org-brand",
      name: `org/${i}.png`,
    }));
    expect(deleteStorageLinked(objects, repoRoot, (args) => (calls.push(args), ""))).toBe(120);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.slice(0, 4)).toEqual(["storage", "rm", "--linked", "--experimental"]);
    expect(calls[0]).toContain("ss:///org-brand/org/0.png");
  });
});

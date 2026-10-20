/** End-to-end CLI runs against the contract test server, with a temporary config directory. */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signWebhookPayload } from "@xos/sdk";
import type { ContractServer } from "@xos/sdk/test-server";
import { startContractServer } from "@xos/sdk/test-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HELP, run, splitGlobals } from "../src/cli.ts";
import { configPath, readConfig, resolveCredentials } from "../src/config.ts";
import { formatCsv, parseCsv, parseRows } from "../src/csv.ts";
import { rowIdempotencyKey } from "../src/commands/transfer.ts";
import { canonColumns } from "../src/commands/canon.ts";
import { columnsFor, table } from "../src/output.ts";

let server: ContractServer;
let dir: string;

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function xos(
  argv: readonly string[],
  options: { stdin?: string; env?: Record<string, string>; tty?: boolean } = {},
): Promise<Result> {
  let out = "";
  let err = "";
  const code = await run(
    {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      readStdin: async () => options.stdin ?? "",
      env: { XOS_CONFIG_DIR: dir, ...options.env },
      isTTY: options.tty ?? false,
      sleep: async () => undefined,
    },
    argv,
  );
  return { code, out, err };
}

function json(r: Result): unknown {
  if (r.out === "") throw new Error(`No output (exit ${r.code}): ${r.err}`);
  return JSON.parse(r.out) as unknown;
}

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  expect(server.violations).toEqual([]);
  await server.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "xos-cli-"));
  const login = await xos(["auth", "login", "--base-url", server.baseUrl, "--key-stdin"], {
    stdin: `${server.apiKey}\n`,
  });
  expect(login.code).toBe(0);
});

describe("help and globals", () => {
  it("prints help and version", async () => {
    expect((await xos(["--help"])).out).toBe(HELP);
    expect((await xos([])).out).toBe(HELP);
    expect((await xos(["--version"])).out).toMatch(/^xos 4\.0\.0 \(API /);
  });

  it("parses global flags anywhere", () => {
    expect(splitGlobals(["projects", "list", "--profile=work", "-o", "json"])).toMatchObject({
      flags: { profile: "work", output: "json" },
      rest: ["projects", "list"],
    });
    expect(() => splitGlobals(["--profile"])).toThrow(/needs a value/);
  });

  it("reports usage errors with exit code 2", async () => {
    const bad = await xos(["--output", "yaml", "resources"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/--output takes json or table/);
    expect((await xos(["projects", "list", "--bogus"])).code).toBe(2);
    expect((await xos(["nope", "list"])).err).toMatch(/Unknown resource/);
    expect((await xos(["projects", "fly"])).err).toMatch(/has no "fly" operation/);
    expect((await xos(["auth", "dance"])).code).toBe(2);
    expect((await xos(["org", "dance"])).code).toBe(2);
  });
});

describe("auth and org selection", () => {
  it("stores the profile with mode 0600 and reports status", async () => {
    const file = configPath({ XOS_CONFIG_DIR: dir });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const config = readConfig(file);
    expect(config.defaultProfile).toBe("default");
    expect(config.profiles["default"]?.apiKey).toBe(server.apiKey);
    const status = json(await xos(["auth", "status"])) as Record<string, unknown>;
    expect(status).toMatchObject({ profile: "default", base_url: server.baseUrl });
  });

  it("refuses a rejected key without saving it", async () => {
    const result = await xos(["auth", "login", "--profile", "bad", "--base-url", server.baseUrl], {
      env: { XOS_API_KEY: "xos_live_wrong" },
    });
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/xos auth login/);
    expect(readConfig(configPath({ XOS_CONFIG_DIR: dir })).profiles["bad"]).toBeUndefined();
  });

  it("requires a base URL and a key source", async () => {
    expect((await xos(["auth", "login", "--profile", "x"])).err).toMatch(/--base-url/);
    expect(
      (await xos(["auth", "login", "--profile", "x", "--base-url", server.baseUrl])).err,
    ).toMatch(/XOS_API_KEY/);
    expect(
      (await xos(["auth", "login", "--profile", "x", "--base-url", server.baseUrl, "--key-stdin"]))
        .err,
    ).toMatch(/empty/);
    expect(
      (await xos(["auth", "login", "--profile", "bad name", "--base-url", server.baseUrl])).err,
    ).toMatch(/Profile names/);
  });

  it("switches between organization profiles", async () => {
    await xos(["auth", "login", "--profile", "client-b", "--base-url", server.baseUrl], {
      env: { XOS_API_KEY: server.apiKey },
    });
    const list = json(await xos(["org", "list"])) as { profile: string; current: boolean }[];
    expect(list.map((p) => [p.profile, p.current])).toEqual([
      ["default", true],
      ["client-b", false],
    ]);
    expect((await xos(["org", "use", "client-b"])).code).toBe(0);
    expect((json(await xos(["org", "current"])) as { profile: string }).profile).toBe("client-b");
    expect((await xos(["org", "use", "missing"])).code).toBe(2);
    expect((await xos(["org", "use"])).code).toBe(2);
    expect((await xos(["projects", "list", "--profile", "missing"])).err).toMatch(
      /No profile named/,
    );
    const remote = await xos(["org", "list", "--remote"]);
    expect(remote.code).toBe(0);
    expect((await xos(["auth", "logout"])).code).toBe(0);
    expect(readConfig(configPath({ XOS_CONFIG_DIR: dir })).defaultProfile).toBe("default");
    expect((await xos(["auth", "logout", "--profile", "client-b"])).code).toBe(2);
  });

  it("explains an empty profile list and missing credentials", async () => {
    await xos(["auth", "logout"]);
    expect((await xos(["org", "list"], { tty: true })).out).toMatch(/No profiles yet/);
    expect((await xos(["projects", "list"])).err).toMatch(/Not signed in/);
    expect((await xos(["auth", "logout"])).code).toBe(2);
  });

  it("lets environment variables override the profile", () => {
    const creds = resolveCredentials(
      { defaultProfile: null, profiles: {} },
      { XOS_API_KEY: "k", XOS_BASE_URL: "http://x" },
      {},
    );
    expect(creds).toEqual({ profileName: null, baseUrl: "http://x", apiKey: "k" });
  });
});

describe("resources", () => {
  it("lists resources and operations", async () => {
    const resources = json(await xos(["resources", "--tag", "Projects"])) as { resource: string }[];
    expect(resources.map((r) => r.resource)).toContain("projects");
    expect((await xos(["resources", "--tag", "Nope"])).code).toBe(2);
    const ops = json(await xos(["ops", "purchase-orders"])) as { operation: string }[];
    expect(ops.map((o) => o.operation)).toContain("purchaseOrders.approve");
    expect((await xos(["ops"])).code).toBe(2);
    expect((await xos(["ops", "nope"])).code).toBe(2);
    expect((await xos(["projects"])).code).toBe(0);
    expect((await xos(["resources"], { tty: true })).out).toMatch(/resource\s+module\s+operations/);
  });

  it("creates, reads, updates and transitions through the shorthand", async () => {
    const created = json(
      await xos([
        "projects",
        "create",
        "--data",
        JSON.stringify({
          name: "CLI Show",
          tier_code: "04",
          currency: "USD",
          project_key: "CLI-1",
          time_zone: "America/New_York",
        }),
      ]),
    ) as { id: string; project_state: string };
    const read = await xos(["projects", "get", created.id, "--fields", "name"]);
    expect(json(read)).toEqual({ id: created.id, name: "CLI Show" });

    expect((await xos(["projects", "update", created.id, "--data", '{"name":"x"}'])).err).toMatch(
      /--if-match/,
    );
    const updated = json(
      await xos([
        "projects",
        "update",
        created.id,
        "--data",
        '{"name":"CLI Show Two"}',
        "--if-match",
        "auto",
      ]),
    ) as { name: string };
    expect(updated.name).toBe("CLI Show Two");

    const refused = await xos([
      "projects",
      "transition",
      created.id,
      "--data",
      '{"expected_state":"Closed","to_state":"Active"}',
    ]);
    expect(refused.code).toBe(5);
    expect(refused.err).toMatch(/Refused \(REFUSE\)/);

    const tableOut = await xos(["call", "projects.get", created.id], { tty: true });
    expect(tableOut.err).toMatch(/ETag: W\//);
    expect(tableOut.out).toMatch(/name\s+CLI Show Two/);

    const calendar = json(
      await xos([
        "calendars",
        "create",
        "--data",
        '{"name":"Venue Working Days","time_zone":"UTC"}',
      ]),
    ) as { id: string };
    const deleted = await xos(["calendars", "delete", calendar.id], { tty: true });
    expect(deleted.err).toMatch(/done \(204\)/);
    expect((await xos(["calendars", "get", calendar.id])).code).toBe(4);
  });

  it("lists with filters, pages and --all", async () => {
    for (let i = 0; i < 3; i++) {
      await xos([
        "projects",
        "create",
        "--data",
        JSON.stringify({
          name: `CLI Page ${i}`,
          tier_code: "04",
          currency: "USD",
          project_key: "CLI-1",
          time_zone: "America/New_York",
        }),
      ]);
    }
    const page = json(
      await xos([
        "projects",
        "list",
        "--filter",
        "name.contains=CLI Page",
        "--limit",
        "2",
        "--sort",
        "name",
      ]),
    ) as { data: unknown[]; next_cursor: string };
    expect(page.data).toHaveLength(2);
    const tty = await xos(
      ["projects", "list", "--filter", "name.contains=CLI Page", "--limit", "2"],
      { tty: true },
    );
    expect(tty.err).toMatch(/--cursor/);
    const all = json(
      await xos([
        "projects",
        "list",
        "--filter",
        "name.contains=CLI Page",
        "--limit",
        "1",
        "--all",
      ]),
    ) as unknown[];
    expect(all).toHaveLength(3);
    const none = await xos(["projects", "list", "--filter", "name.eq=Nothing"], { tty: true });
    expect(none.out).toMatch(/No rows match/);
    expect((await xos(["projects", "list", "--filter", "bad"])).code).toBe(2);
    expect((await xos(["projects", "list", "--filter", "name.like=x"])).code).toBe(2);
    expect((await xos(["projects", "list", "--limit", "900"])).code).toBe(2);
    expect((await xos(["projects", "get", "a", "b"])).code).toBe(2);
    expect((await xos(["projects", "get"])).code).toBe(2);
    expect((await xos(["projects", "get", "x", "--all"])).code).toBe(2);
    expect((await xos(["call"])).code).toBe(2);
    expect((await xos(["call", "nope.nope"])).code).toBe(2);
    expect((await xos(["projects", "create", "--data", "{bad"])).code).toBe(2);
    expect((await xos(["projects", "list", "--query", "novalue"])).code).toBe(2);
  });

  it("reads --data from a file and from stdin, and passes extra query parameters", async () => {
    const file = join(dir, "project.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "From File",
        tier_code: "04",
        currency: "USD",
        project_key: "CLI-1",
        time_zone: "America/New_York",
      }),
    );
    expect((await xos(["projects", "create", "--data", `@${file}`])).code).toBe(0);
    const piped = await xos(
      ["projects", "create", "--data", "-", "--idempotency-key", "cli-stdin-0001"],
      {
        stdin: JSON.stringify({
          name: "From Stdin",
          tier_code: "04",
          currency: "USD",
          project_key: "CLI-1",
          time_zone: "America/New_York",
        }),
      },
    );
    expect(piped.code).toBe(0);
    expect((await xos(["canon-elements", "resolve", "--query", "query=stage deck"])).code).toBe(0);
    expect((await xos(["call", "canonDepartments.get", "--path", "dept_code=4000"])).code).toBe(4);
  });

  it("reports validation pointers", async () => {
    const result = await xos([
      "projects",
      "create",
      "--data",
      '{"name":"","tier_code":"04","currency":"usd","project_key":"CLI-1","time_zone":"America/New_York"}',
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/\/currency/);
  });
});

describe("import and export", () => {
  it("imports rows idempotently and exports them in every format", async () => {
    const file = join(dir, "projects.csv");
    writeFileSync(
      file,
      'name,tier_code,currency,project_key,time_zone\n"Import, One",04,USD,IMP-1,UTC\nImport Two,04,USD,IMP-2,UTC\nBad,04,usd,IMP-3,UTC\n',
    );
    const dry = await xos(["import", "projects", "--file", file, "--dry-run"]);
    expect(dry.err).toMatch(/Dry run: 3 row/);

    const first = await xos(["import", "projects", "--file", file]);
    expect(first.code).toBe(1);
    const rows = json(first) as { status: string; detail: string }[];
    expect(rows.map((r) => r.status)).toEqual(["created", "created", "failed 422"]);
    expect(rows[2]?.detail).toMatch(/\/currency/);
    expect(first.err).toMatch(/2 of 3 row\(s\) imported/);

    const again = json(await xos(["import", "projects", "--file", file, "--stop-on-error"])) as {
      status: string;
    }[];
    expect(again.map((r) => r.status)).toEqual([
      "already imported",
      "already imported",
      "failed 422",
    ]);

    const csv = await xos([
      "export",
      "projects",
      "--format",
      "csv",
      "--filter",
      "name.contains=Import",
      "--fields",
      "name",
    ]);
    expect(parseCsv(csv.out).map((r) => r["name"])).toEqual(["Import, One", "Import Two"]);
    const nd = await xos(["export", "projects", "--filter", "name.contains=Import"]);
    expect(nd.out.trim().split("\n")).toHaveLength(2);
    const out = join(dir, "export.json");
    const toFile = await xos([
      "export",
      "projects",
      "--format",
      "json",
      "--out",
      out,
      "--filter",
      "name.contains=Import",
      "--sort",
      "name",
    ]);
    expect(toFile.err).toMatch(/Exported 2 projects row/);
    expect(JSON.parse(readFileSync(out, "utf8"))).toHaveLength(2);
    expect((await xos(["export", "projects", "--format", "xml"])).code).toBe(2);
    expect((await xos(["export"])).code).toBe(2);
    expect((await xos(["import", "projects"])).code).toBe(2);
    expect((await xos(["import", "projects", "--file", join(dir, "missing.csv")])).code).toBe(2);
  });

  it("drives server import and export jobs", async () => {
    const doc = "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f";
    const importBody = {
      target_code: "projects",
      source: "CSV",
      original_filename: "projects.csv",
      storage_object_path: "imports/projects.csv",
      import_mapping_profile_id: doc,
    };
    const job = json(
      await xos(["import", "job", "create", "--data", JSON.stringify(importBody)]),
    ) as { id: string };
    expect(job.id).toBeTruthy();
    expect((await xos(["import", "job", "dry-run", job.id])).code).toBe(0);
    expect((await xos(["import", "job", "commit", job.id])).code).toBe(0);
    expect((await xos(["import", "job", "status", job.id])).code).toBe(0);
    expect((await xos(["import", "job", "status"])).code).toBe(2);
    expect((await xos(["import", "job", "create"])).code).toBe(2);
    expect((await xos(["import", "job", "explode"])).code).toBe(2);
    expect((await xos(["import", "undo"])).code).toBe(2);
    expect((await xos(["import", "undo", doc])).code).toBe(4);

    const exp = json(
      await xos([
        "export",
        "job",
        "create",
        "--data",
        JSON.stringify({
          source_label: "Projects",
          export_format: "CSV",
          columns: ["app.projects.name"],
        }),
      ]),
    ) as { id: string };
    expect((await xos(["export", "job", "status", exp.id])).code).toBe(0);
    expect((await xos(["export", "job", "status"])).code).toBe(2);
    expect((await xos(["export", "job", "create"])).code).toBe(2);
    expect((await xos(["export", "job", "explode"])).code).toBe(2);
  });

  it("derives a stable key per row", () => {
    const a = rowIdempotencyKey("", "f.csv", 0, { name: "A" });
    expect(a).toBe(rowIdempotencyKey("", "f.csv", 0, { name: "A" }));
    expect(a).not.toBe(rowIdempotencyKey("", "f.csv", 1, { name: "A" }));
    expect(a).toMatch(/^xos-import-[0-9a-f]{48}$/);
  });
});

describe("canon validation", () => {
  it("derives canon columns from the operation table", () => {
    const columns = canonColumns();
    expect(columns.get("dept_code")?.id).toBe("canonDepartments.list");
    expect(columns.get("phase_code")?.id).toBe("canonPhases.list");
  });

  it("flags codes that are not in canon", async () => {
    server.seed("/canon/departments", { dept_code: "4000" });
    const file = join(dir, "rows.ndjson");
    writeFileSync(file, '{"dept_code":"4000"}\n{"dept_code":"9999"}\n{"dept_code":null}\n');
    const result = await xos(["canon", "validate", "--file", file]);
    expect(result.code).toBe(1);
    expect(json(result)).toEqual([
      { row: 2, column: "dept_code", value: "9999", problem: "not in canonDepartments" },
    ]);

    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify([{ dept: "4000" }]));
    const mapped = await xos([
      "canon",
      "validate",
      "--file",
      good,
      "--column",
      "dept=canonDepartments",
    ]);
    expect(mapped.code).toBe(0);
    expect(mapped.err).toMatch(/are valid/);
    expect((await xos(["canon", "validate", "--file", good])).err).toMatch(/No canon code columns/);
    expect(
      (await xos(["canon", "validate", "--file", good, "--column", "dept=projects"])).code,
    ).toBe(2);
    expect((await xos(["canon", "validate"])).code).toBe(2);
    expect((await xos(["canon", "explode"])).code).toBe(2);
  });
});

describe("webhooks", () => {
  it("signs, verifies and sends test deliveries", async () => {
    const body = join(dir, "body.json");
    writeFileSync(body, '{"type":"po.approved"}');
    const env = { WEBHOOK_SECRET: "whsec_cli" };
    const signed = await xos(
      [
        "webhooks",
        "sign",
        "--file",
        body,
        "--secret-env",
        "WEBHOOK_SECRET",
        "--timestamp",
        "1760000000",
      ],
      { env },
    );
    expect(signed.out.trim()).toBe(
      await signWebhookPayload('{"type":"po.approved"}', "whsec_cli", 1760000000),
    );

    const fresh = (
      await xos(["webhooks", "sign", "--file", body, "--secret-stdin"], { stdin: "whsec_cli" })
    ).out.trim();
    const ok = await xos(
      [
        "webhooks",
        "verify",
        "--file",
        body,
        "--signature",
        fresh,
        "--secret-env",
        "WEBHOOK_SECRET",
      ],
      { env },
    );
    expect(ok.code).toBe(0);
    const stale = await xos(
      [
        "webhooks",
        "verify",
        "--file",
        body,
        "--signature",
        signed.out.trim(),
        "--secret-env",
        "WEBHOOK_SECRET",
        "--tolerance",
        "1",
      ],
      { env },
    );
    expect(stale.code).toBe(1);
    expect(json(stale)).toEqual({ valid: false, reason: "timestamp_out_of_tolerance" });

    let received: { signature: string | undefined; body: string } | null = null;
    const endpoint = createServer((req, res) => {
      let text = "";
      req.on("data", (c: Buffer) => (text += c.toString()));
      req.on("end", () => {
        received = { signature: req.headers["xos-signature"] as string | undefined, body: text };
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/hooks`;
    const sent = await xos(
      ["webhooks", "send", "--url", url, "--file", body, "--secret-env", "WEBHOOK_SECRET"],
      { env },
    );
    await new Promise<void>((r) => endpoint.close(() => r()));
    expect(sent.code).toBe(0);
    expect(received).toMatchObject({ body: '{"type":"po.approved"}' });
    expect((received as unknown as { signature: string }).signature).toMatch(/^t=\d+,v1=/);

    expect((await xos(["webhooks", "events"])).code).toBe(0);
    expect((await xos(["webhooks", "replay", "0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"])).code).toBe(
      4,
    );
    expect((await xos(["webhooks", "replay"])).code).toBe(2);
    expect((await xos(["webhooks", "sign", "--file", body])).code).toBe(2);
    expect(
      (await xos(["webhooks", "sign", "--file", body, "--secret-env", "UNSET_VAR"])).code,
    ).toBe(2);
    expect((await xos(["webhooks", "sign", "--file", body, "--secret-stdin"])).code).toBe(2);
    expect((await xos(["webhooks", "sign", "--secret-env", "WEBHOOK_SECRET"], { env })).code).toBe(
      2,
    );
    expect(
      (
        await xos(
          [
            "webhooks",
            "sign",
            "--file",
            body,
            "--secret-env",
            "WEBHOOK_SECRET",
            "--timestamp",
            "x",
          ],
          { env },
        )
      ).code,
    ).toBe(2);
    expect(
      (await xos(["webhooks", "verify", "--file", body, "--secret-env", "WEBHOOK_SECRET"], { env }))
        .code,
    ).toBe(2);
    expect(
      (await xos(["webhooks", "send", "--file", body, "--secret-env", "WEBHOOK_SECRET"], { env }))
        .code,
    ).toBe(2);
    expect((await xos(["webhooks", "explode"])).code).toBe(2);
  });
});

describe("formats", () => {
  it("round-trips CSV with quotes, commas, newlines and empty cells", () => {
    const rows = [{ a: 'say "hi"', b: "x,y", c: "line\nbreak", d: null }];
    expect(parseCsv(formatCsv(rows))).toEqual(rows);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("")).toEqual([]);
    expect(() => parseCsv('a\n"open')).toThrow(/quoted/);
    expect(() => parseCsv("a,b\n1")).toThrow(/fields/);
    expect(formatCsv([{ o: { n: 1 } }])).toBe('o\n"{""n"":1}"\n');
  });

  // A69-005: exports opened in a spreadsheet never run record data as a formula, and import back unchanged.
  it("neutralizes formula cells on export and restores them on import", () => {
    const rows = [{ name: '=HYPERLINK("https://evil.example","x")', n: "-12.5", at: "@home" }];
    const csv = formatCsv(rows);
    expect(csv).toBe(`name,n,at\n"'=HYPERLINK(""https://evil.example"",""x"")",-12.5,'@home\n`);
    expect(parseCsv(csv)).toEqual(rows);
  });

  it("reads NDJSON and JSON arrays and refuses other files", () => {
    expect(parseRows('{"a":1}\n\n{"a":2}\n', "x.jsonl")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseRows("[1]\n", "x.ndjson")).toThrow(/not a JSON object/);
    expect(() => parseRows("{}", "x.json")).toThrow(/array/);
    expect(() => parseRows("", "x.xlsx")).toThrow(/Use a \.csv/);
  });

  it("renders tables with masked values and truncation", () => {
    const rows = [
      {
        id: "1",
        rate_minor: { masked: true, reason: "payroll" },
        note: "n".repeat(60),
        org_id: "o",
        nested: [1],
      },
    ];
    expect(columnsFor(rows)).toEqual(["id", "note"]);
    expect(columnsFor(rows, "rate_minor")).toEqual(["id", "rate_minor"]);
    const out = table(rows, ["id", "rate_minor", "note", "nested"]);
    expect(out).toMatch(/\(masked\)/);
    expect(out).toMatch(/…/);
    expect(out).toMatch(/\[1\]/);
  });
});

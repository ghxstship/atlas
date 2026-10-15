import { describe, expect, it } from "vitest";
import {
  apiFeed,
  attendanceFromCsv,
  csvFeed,
  parseCsv,
  supabaseTicketingSource,
  ticketingConnector,
  ticketingConnectors,
  validateAttendance,
  type AttendanceRow,
  type TicketingSource,
} from "../src/connectors/ticketing/index.ts";
import { IntegrationError } from "../src/framework/errors.ts";
import { contextFor, memoryStore, okData, recordingDb, scriptedHttp } from "./doubles.ts";

const csv = [
  "Event Date,Ticket Type,Tickets Sold,Scans,Comps,Revenue,Currency,Show Code",
  '2027-06-05,General Admission,1800,1650,40,"81,000.00",USD,NWL-E01',
  "2027-06-05,VIP,200,,,,,NWL-E01",
  "2027-06-05,Bad Row,lots,,,,,",
  "",
].join("\r\n");

function source(overrides: Partial<TicketingSource> = {}) {
  const recorded: AttendanceRow[][] = [];
  const value: TicketingSource = {
    readFile: async () => new TextEncoder().encode(csv),
    scopeCodes: async () => new Map([["NWL-E01", "show-1"]]),
    exponentOf: async (c) => {
      if (c === "QQQ")
        throw new IntegrationError(
          "currency_unknown",
          "QQQ is not an ISO 4217 currency the database knows.",
        );
      return c === "JPY" ? 0 : 2;
    },
    record: async (_run, rows) => {
      recorded.push([...rows]);
      return rows.length;
    },
    ...overrides,
  };
  return { value, recorded };
}

const run = {
  scope: "Attendance Import" as const,
  direction: "Inbound" as const,
  projectId: "prj-1",
  sourceUri: "integration-imports/org/box.csv",
};

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes, embedded commas and line breaks", () => {
    expect(parseCsv('\uFEFFa,b\n"x, y","say ""hi""\nthere"\r\n\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
    expect(() => parseCsv('a,"open')).toThrow(expect.objectContaining({ code: "csv_malformed" }));
  });

  it("maps header aliases and requires date, class and sold", () => {
    expect(attendanceFromCsv(csv)[0]).toEqual({
      date: "2027-06-05",
      ticketClass: "General Admission",
      sold: "1800",
      scanned: "1650",
      comps: "40",
      gross: "81,000.00",
      currency: "USD",
      showCode: "NWL-E01",
    });
    expect(attendanceFromCsv("")).toEqual([]);
    expect(() => attendanceFromCsv("date,sold\n2027-06-05,1")).toThrow(
      "The file needs a ticket class column.",
    );
    expect(() => attendanceFromCsv("class,sold\nGA,1")).toThrow("The file needs a date column.");
    expect(() => attendanceFromCsv("date,class,other\n2027-06-05,GA,1")).toThrow(
      "The file needs a sold column.",
    );
  });
});

describe("attendance validation", () => {
  const scopes = new Map([["NWL-E01", "show-1"]]);
  const exp = async (c: string) => (c === "JPY" ? 0 : 2);
  it("accepts good figures with money in minor units", async () => {
    expect(
      await validateAttendance(
        {
          date: "2027-06-05",
          ticketClass: "GA",
          sold: "10",
          gross: "1234.5",
          currency: "usd",
          showCode: "nwl-e01",
        },
        scopes,
        exp,
      ),
    ).toEqual({
      row: {
        counted_on: "2027-06-05",
        ticket_class: "GA",
        tickets_sold: 10,
        tickets_scanned: null,
        comps: null,
        gross_minor: "123450",
        currency_code: "USD",
        scope_node_id: "show-1",
      },
    });
  });

  it("refuses bad figures with a reason", async () => {
    const reason = async (raw: Parameters<typeof validateAttendance>[0]) => {
      const result = await validateAttendance(raw, scopes, exp);
      return "code" in result ? result.code : "ok";
    };
    expect(await reason({ ticketClass: "GA", sold: "1" })).toBe("attendance_date_invalid");
    expect(await reason({ date: "2027-13-45", ticketClass: "GA", sold: "1" })).toBe(
      "attendance_date_invalid",
    );
    expect(await reason({ date: "2027-06-05", sold: "1" })).toBe("attendance_class_invalid");
    expect(await reason({ date: "2027-06-05", ticketClass: "x".repeat(101), sold: "1" })).toBe(
      "attendance_class_invalid",
    );
    expect(await reason({ date: "2027-06-05", ticketClass: "GA" })).toBe(
      "attendance_count_invalid",
    );
    expect(await reason({ date: "2027-06-05", ticketClass: "GA", sold: "1", comps: "-2" })).toBe(
      "attendance_count_invalid",
    );
    expect(
      await reason({ date: "2027-06-05", ticketClass: "GA", sold: "1", showCode: "NOPE" }),
    ).toBe("attendance_show_unknown");
    expect(await reason({ date: "2027-06-05", ticketClass: "GA", sold: "1", gross: "10" })).toBe(
      "attendance_currency_missing",
    );
    expect(
      await reason({
        date: "2027-06-05",
        ticketClass: "GA",
        sold: "1",
        gross: "10.5",
        currency: "JPY",
      }),
    ).toBe("amount_precision");
    expect(
      await reason({
        date: "2027-06-05",
        ticketClass: "GA",
        sold: "1",
        gross: "-10",
        currency: "USD",
      }),
    ).toBe("attendance_gross_negative");
    await expect(
      validateAttendance(
        { date: "2027-06-05", ticketClass: "GA", sold: "1", gross: "10", currency: "USD" },
        scopes,
        () => Promise.reject(new Error("db down")),
      ),
    ).rejects.toThrow("db down");
  });
});

describe("CSV import", () => {
  it("records valid rows and reports bad ones by row number", async () => {
    const s = source();
    const memory = memoryStore();
    const outcome = await ticketingConnector(csvFeed(s.value), s.value).sync(
      contextFor("ticketing_csv", {
        http: scriptedHttp([]).http,
        store: memory.store,
        run,
        credential: null,
        cursor: "c",
      }),
    );
    expect(s.recorded[0]).toEqual([
      {
        counted_on: "2027-06-05",
        ticket_class: "General Admission",
        tickets_sold: 1800,
        tickets_scanned: 1650,
        comps: 40,
        gross_minor: "8100000",
        currency_code: "USD",
        scope_node_id: "show-1",
      },
      {
        counted_on: "2027-06-05",
        ticket_class: "VIP",
        tickets_sold: 200,
        tickets_scanned: null,
        comps: null,
        gross_minor: null,
        currency_code: null,
        scope_node_id: "show-1",
      },
    ]);
    expect(memory.itemErrors).toEqual([
      {
        code: "attendance_count_invalid",
        message: "Row 3: sold must be a whole number of tickets.",
        ref: undefined,
      },
    ]);
    expect(outcome).toEqual({
      counts: { read: 3, written: 2, skipped: 0, failed: 1 },
      cursorAfter: "c",
    });
  });

  it("needs a project, a file and UTF-8 text", async () => {
    const s = source();
    const http = scriptedHttp([]).http;
    const store = memoryStore().store;
    await expect(
      ticketingConnector(csvFeed(s.value), s.value).sync(
        contextFor("ticketing_csv", { http, store, run: { ...run, projectId: null } }),
      ),
    ).rejects.toMatchObject({ code: "attendance_project_missing" });
    await expect(
      ticketingConnector(csvFeed(s.value), s.value).sync(
        contextFor("ticketing_csv", { http, store, run: { ...run, sourceUri: null } }),
      ),
    ).rejects.toMatchObject({ code: "attendance_source_missing" });
    const binary = source({ readFile: async () => new Uint8Array([0xff, 0xfe, 0x00]) });
    await expect(
      ticketingConnector(csvFeed(binary.value), binary.value).sync(
        contextFor("ticketing_csv", { http, store, run }),
      ),
    ).rejects.toThrow();
    const empty = source({ readFile: async () => new TextEncoder().encode("date,class,sold\n") });
    const outcome = await ticketingConnector(csvFeed(empty.value), empty.value).sync(
      contextFor("ticketing_csv", { http, store, run }),
    );
    expect(outcome.counts.written).toBe(0);
    expect(empty.recorded).toHaveLength(0);
  });
});

describe("ticketing API import", () => {
  const publicResolver = async () => ["93.184.216.34"];
  it("fetches figures since the cursor from a public HTTPS host", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://tickets.example.com/v2/attendance",
        respond: () => ({
          json: {
            figures: [
              { date: "2027-06-05", ticketClass: "GA", sold: "900", currency: "QQQ", gross: "5" },
              { date: "2027-06-05", ticketClass: "VIP", sold: "50" },
            ],
            cursor: "2027-06-05T23:00:00Z",
          },
        }),
      },
    ]);
    const s = source();
    const memory = memoryStore();
    const outcome = await ticketingConnector(apiFeed(publicResolver), s.value).sync(
      contextFor("ticketing_api", {
        http,
        store: memory.store,
        run,
        settings: { base_url: "https://tickets.example.com/v2/", "project:prj-1": "evt-77" },
        cursor: "2027-06-04T00:00:00Z",
      }),
    );
    expect(requests[0]?.url).toBe(
      "https://tickets.example.com/v2/attendance?since=2027-06-04T00%3A00%3A00Z&event=evt-77",
    );
    expect(memory.itemErrors[0]?.code).toBe("currency_unknown");
    expect(s.recorded[0]).toHaveLength(1);
    expect(outcome.cursorAfter).toBe("2027-06-05T23:00:00Z");
    const noCursor = scriptedHttp([
      {
        match: "GET https://tickets.example.com/attendance",
        respond: () => ({ json: { figures: [] } }),
      },
    ]);
    const quiet = await ticketingConnector(apiFeed(publicResolver), s.value).sync(
      contextFor("ticketing_api", {
        http: noCursor.http,
        store: memory.store,
        run,
        settings: { base_url: "https://tickets.example.com" },
      }),
    );
    expect(noCursor.requests[0]?.url).toBe("https://tickets.example.com/attendance");
    expect(quiet.cursorAfter).toBeNull();
  });

  it("refuses unsafe or missing settings and malformed answers", async () => {
    const s = source();
    const store = memoryStore().store;
    const http = scriptedHttp([
      { match: "GET https://tickets.example.com", respond: () => ({ json: { rows: [] } }) },
    ]).http;
    const sync = (
      settings: Record<string, unknown>,
      resolver = publicResolver,
      credential: { token: string; fields: Record<string, string> } | null = {
        token: "t",
        fields: {},
      },
    ) =>
      ticketingConnector(apiFeed(resolver), s.value).sync(
        contextFor("ticketing_api", { http, store, run, settings, credential }),
      );
    await expect(sync({})).rejects.toMatchObject({ code: "setting_missing" });
    await expect(sync({ base_url: "not a url" })).rejects.toMatchObject({
      code: "setting_invalid",
      message: "The base_url setting is not a URL.",
    });
    await expect(sync({ base_url: "http://tickets.example.com" })).rejects.toMatchObject({
      message: "The base_url must use HTTPS.",
    });
    await expect(
      sync({ base_url: "https://intranet.example.com" }, async () => ["10.0.0.5"]),
    ).rejects.toMatchObject({ message: "The base_url must resolve to public addresses only." });
    await expect(
      sync({ base_url: "https://nowhere.example.com" }, async () => []),
    ).rejects.toMatchObject({ code: "setting_invalid" });
    await expect(
      sync({ base_url: "https://tickets.example.com" }, publicResolver, null),
    ).rejects.toMatchObject({ code: "credential_required" });
    await expect(sync({ base_url: "https://tickets.example.com" })).rejects.toMatchObject({
      code: "provider_malformed_response",
    });
    expect(ticketingConnectors(s.value, publicResolver).map((c) => c.provider)).toEqual([
      "ticketing_csv",
      "ticketing_api",
    ]);
  });
});

describe("ticketing source", () => {
  it("reads uploaded files, scope codes and exponents and records rows", async () => {
    const { db, calls } = recordingDb({
      "from:scope_nodes": [okData([{ id: "n", scope_code: "nwl-e01" }])],
      "from:currencies": [okData({ minor_unit_exponent: 2 }), okData(null)],
      "rpc:record_attendance": [okData(1)],
    });
    const downloads: string[] = [];
    const storage = {
      from: (bucket: string) => ({
        download: async (path: string) => {
          downloads.push(`${bucket}:${path}`);
          return path === "missing.csv"
            ? { data: null, error: { message: "Object not found" } }
            : { data: new Blob(["date,class,sold\n"]), error: null };
        },
      }),
    };
    const s = supabaseTicketingSource(db, storage);
    expect(new TextDecoder().decode(await s.readFile("integration-imports/org/box.csv"))).toBe(
      "date,class,sold\n",
    );
    expect(downloads).toEqual(["integration-imports:org/box.csv"]);
    await expect(s.readFile("nobucket")).rejects.toMatchObject({
      code: "attendance_source_invalid",
    });
    await expect(s.readFile("integration-imports/missing.csv")).rejects.toMatchObject({
      code: "attendance_source_unreadable",
    });
    expect((await s.scopeCodes("p")).get("NWL-E01")).toBe("n");
    expect(await s.exponentOf("USD")).toBe(2);
    await expect(s.exponentOf("QQQ")).rejects.toMatchObject({ code: "currency_unknown" });
    expect(await s.record("run", [])).toBe(1);
    expect(calls.at(-1)?.steps[0]?.[1]).toEqual([{ p_run_id: "run", p_rows: [] }]);
  });
});

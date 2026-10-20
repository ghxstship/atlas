import { isPublicAddress, type HostResolver } from "@xos/platform";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { unwrap, type DbClient } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson } from "../../framework/http.ts";
import { decimalToMinor } from "../../framework/support.ts";

/** One attendance figure as a ticketing source reports it, before validation. */
export interface RawAttendance {
  readonly date?: string;
  readonly ticketClass?: string;
  readonly sold?: string;
  readonly scanned?: string;
  readonly comps?: string;
  readonly gross?: string;
  readonly currency?: string;
  readonly showCode?: string;
}

/** A validated row, shaped for app.record_attendance (migration 0636). Money stays in minor units. */
export interface AttendanceRow {
  readonly counted_on: string;
  readonly ticket_class: string;
  readonly tickets_sold: number;
  readonly tickets_scanned: number | null;
  readonly comps: number | null;
  readonly gross_minor: string | null;
  readonly currency_code: string | null;
  readonly scope_node_id: string | null;
}

export interface TicketingSource {
  /** Bytes of an uploaded file, by the run's source_uri ("<bucket>/<path>"). */
  readFile(sourceUri: string): Promise<Uint8Array>;
  /** Show and scope codes of a project, mapped to scope node ids. */
  scopeCodes(projectId: string): Promise<ReadonlyMap<string, string>>;
  exponentOf(currencyCode: string): Promise<number>;
  record(runId: string, rows: readonly AttendanceRow[]): Promise<number>;
}

/** Parses RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new IntegrationError("csv_malformed", "The file ends inside a quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

const HEADERS: Readonly<Record<string, keyof RawAttendance>> = {
  date: "date",
  counted_on: "date",
  event_date: "date",
  ticket_class: "ticketClass",
  ticket_type: "ticketClass",
  class: "ticketClass",
  sold: "sold",
  tickets_sold: "sold",
  scanned: "scanned",
  tickets_scanned: "scanned",
  scans: "scanned",
  comps: "comps",
  complimentary: "comps",
  gross: "gross",
  revenue: "gross",
  currency: "currency",
  currency_code: "currency",
  show: "showCode",
  show_code: "showCode",
  scope_code: "showCode",
};

/** Reads a box office CSV by its header names (common aliases accepted); date, class and sold are required. */
export function attendanceFromCsv(text: string): RawAttendance[] {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) return [];
  const columns = header.map(
    (h) =>
      HEADERS[
        h
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_")
      ],
  );
  for (const required of ["date", "ticketClass", "sold"] as const) {
    if (!columns.includes(required))
      throw new IntegrationError(
        "csv_header_missing",
        `The file needs a ${required === "ticketClass" ? "ticket class" : required} column.`,
      );
  }
  return rows.map((cells) => {
    const raw: Record<string, string> = {};
    columns.forEach((column, index) => {
      const cell = cells[index]?.trim();
      if (column !== undefined && cell !== undefined && cell.length > 0) raw[column] = cell;
    });
    return raw as RawAttendance;
  });
}

const COUNT = /^\d{1,9}$/;

/** Validates one figure. Returns the row, or the reason it is refused. */
export async function validateAttendance(
  raw: RawAttendance,
  scopes: ReadonlyMap<string, string>,
  exponentOf: (currency: string) => Promise<number>,
): Promise<{ readonly row: AttendanceRow } | { readonly code: string; readonly message: string }> {
  if (
    raw.date === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) ||
    Number.isNaN(Date.parse(raw.date))
  ) {
    return { code: "attendance_date_invalid", message: "The date must be YYYY-MM-DD." };
  }
  if (raw.ticketClass === undefined || raw.ticketClass.length > 100)
    return {
      code: "attendance_class_invalid",
      message: "Name the ticket class in at most 100 characters.",
    };
  for (const [name, value] of [
    ["sold", raw.sold],
    ["scanned", raw.scanned],
    ["comps", raw.comps],
  ] as const) {
    if (value !== undefined && !COUNT.test(value))
      return {
        code: "attendance_count_invalid",
        message: `${name} must be a whole number of tickets.`,
      };
  }
  if (raw.sold === undefined)
    return { code: "attendance_count_invalid", message: "sold must be a whole number of tickets." };
  let scopeNodeId: string | null = null;
  if (raw.showCode !== undefined) {
    scopeNodeId = scopes.get(raw.showCode.toUpperCase()) ?? null;
    if (scopeNodeId === null)
      return {
        code: "attendance_show_unknown",
        message: `The project has no show ${raw.showCode}.`,
      };
  }
  let gross: string | null = null;
  let currency: string | null = null;
  if (raw.gross !== undefined) {
    currency = raw.currency?.toUpperCase() ?? null;
    if (currency === null || !/^[A-Z]{3}$/.test(currency))
      return {
        code: "attendance_currency_missing",
        message: "A gross amount needs its ISO 4217 currency.",
      };
    try {
      gross = decimalToMinor(raw.gross.replace(/,/g, ""), await exponentOf(currency)).toString();
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      return { code: error.code, message: error.message };
    }
    if (gross.startsWith("-"))
      return { code: "attendance_gross_negative", message: "Gross revenue cannot be negative." };
  }
  return {
    row: {
      counted_on: raw.date,
      ticket_class: raw.ticketClass,
      tickets_sold: Number(raw.sold),
      tickets_scanned: raw.scanned === undefined ? null : Number(raw.scanned),
      comps: raw.comps === undefined ? null : Number(raw.comps),
      gross_minor: gross,
      currency_code: currency,
      scope_node_id: scopeNodeId,
    },
  };
}

/** Where a run's raw figures come from: the uploaded CSV, or the ticketing API. */
export interface AttendanceFeed {
  readonly provider: "ticketing_csv" | "ticketing_api";
  fetch(
    context: SyncContext,
  ): Promise<{ readonly figures: readonly RawAttendance[]; readonly cursor: string | null }>;
}

export function csvFeed(source: Pick<TicketingSource, "readFile">): AttendanceFeed {
  return {
    provider: "ticketing_csv",
    async fetch(context) {
      if (context.run.sourceUri === null)
        throw new IntegrationError(
          "attendance_source_missing",
          "A CSV import names the uploaded file.",
        );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await source.readFile(context.run.sourceUri),
      );
      return { figures: attendanceFromCsv(text), cursor: context.cursor };
    },
  };
}

/**
 * The ticketing API feed: GET <base_url>/attendance returns figures in the RawAttendance shape. The
 * base URL is the org's own setting, so its host must resolve only to public addresses (SSRF, Section 9).
 */
export function apiFeed(resolve: HostResolver): AttendanceFeed {
  return {
    provider: "ticketing_api",
    async fetch(context) {
      const base = context.connection.settings["base_url"];
      if (typeof base !== "string")
        throw new IntegrationError("setting_missing", "The connection needs the base_url setting.");
      let url: URL;
      try {
        url = new URL(base);
      } catch {
        throw new IntegrationError("setting_invalid", "The base_url setting is not a URL.");
      }
      if (url.protocol !== "https:")
        throw new IntegrationError("setting_invalid", "The base_url must use HTTPS.");
      const addresses = await resolve(url.hostname);
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
        throw new IntegrationError(
          "setting_invalid",
          "The base_url must resolve to public addresses only.",
        );
      }
      if (context.credential === null)
        throw new IntegrationError(
          "credential_required",
          "The connection has no stored credential.",
          { connectionError: true },
        );
      const query = new URLSearchParams();
      if (context.cursor) query.set("since", context.cursor);
      const external =
        context.run.projectId === null
          ? undefined
          : context.connection.settings[`project:${context.run.projectId}`];
      if (typeof external === "string") query.set("event", external);
      const body = await callJson<{ figures: RawAttendance[]; cursor?: string | null }>(
        context.http,
        "Ticketing API",
        {
          method: "GET",
          url: `${url.origin}${url.pathname.replace(/\/$/, "")}/attendance${query.size > 0 ? `?${query.toString()}` : ""}`,
          token: context.credential.token,
        },
      );
      if (!Array.isArray(body.figures))
        throw new IntegrationError(
          "provider_malformed_response",
          "The ticketing API returned no figures list.",
        );
      return { figures: body.figures, cursor: body.cursor ?? context.cursor };
    },
  };
}

/** Imports attendance for the run's project: every figure validated, bad rows reported by number, good rows recorded. */
export function ticketingConnector(feed: AttendanceFeed, source: TicketingSource): Connector {
  return {
    provider: feed.provider,
    scopes: ["Attendance Import"],
    async sync(context) {
      if (context.run.projectId === null)
        throw new IntegrationError(
          "attendance_project_missing",
          "An attendance import names its project.",
        );
      const tally = new ItemTally(context);
      const { figures, cursor } = await feed.fetch(context);
      const scopes = await source.scopeCodes(context.run.projectId);
      const rows: AttendanceRow[] = [];
      for (const [index, raw] of figures.entries()) {
        tally.read += 1;
        const result = await validateAttendance(raw, scopes, (c) => source.exponentOf(c));
        if ("row" in result) rows.push(result.row);
        else await tally.fail(result.code, `Row ${index + 1}: ${result.message}`);
      }
      tally.written = rows.length === 0 ? 0 : await source.record(context.run.id, rows);
      return { counts: tally.counts(), cursorAfter: cursor };
    },
  };
}

export function ticketingConnectors(source: TicketingSource, resolve: HostResolver): Connector[] {
  return [
    ticketingConnector(csvFeed(source), source),
    ticketingConnector(apiFeed(resolve), source),
  ];
}

const IMPORTS_BUCKET = "imports";
/** imports/<person id>/<upload id>.csv or .xlsx; the capture is the object name inside the bucket. */
const IMPORT_UPLOAD = /^imports\/([0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:csv|xlsx))$/;

export function supabaseTicketingSource(
  db: DbClient,
  storage: {
    from(bucket: string): {
      download(path: string): PromiseLike<{ data: Blob | null; error: { message: string } | null }>;
    };
  },
): TicketingSource {
  return {
    async readFile(sourceUri) {
      // The worker holds the service role, so it reads only an imports bucket upload, named the way that bucket
      // names them, and only once it scanned Clean (A69-006; migrations 1061, 1240 and 1297).
      const match = IMPORT_UPLOAD.exec(sourceUri);
      if (match === null)
        throw new IntegrationError(
          "attendance_source_invalid",
          "A CSV import reads a spreadsheet uploaded to the imports bucket.",
        );
      const path = match[1] as string;
      const status = await unwrap<string | null>(
        db.rpc("object_scan_status", { p_bucket_id: IMPORTS_BUCKET, p_object_name: path }),
      );
      if (status === null || status === "Scanning")
        throw new IntegrationError(
          "attendance_source_scanning",
          "The uploaded file is still being checked for viruses.",
          { retryable: true },
        );
      if (status !== "Clean")
        throw new IntegrationError(
          "attendance_source_refused",
          "The uploaded file did not pass its virus scan, so it was not read.",
        );
      const { data, error } = await storage.from(IMPORTS_BUCKET).download(path);
      if (error || data === null)
        throw new IntegrationError(
          "attendance_source_unreadable",
          `The uploaded file could not be read: ${error?.message ?? "no content"}.`,
        );
      return new Uint8Array(await data.arrayBuffer());
    },
    async scopeCodes(projectId) {
      const rows = await unwrap<{ id: string; scope_code: string }[]>(
        db
          .from("scope_nodes")
          .select("id, scope_code")
          .eq("project_id", projectId)
          .is("deleted_at", null),
      );
      return new Map(rows.map((r) => [r.scope_code.toUpperCase(), r.id]));
    },
    async exponentOf(currencyCode) {
      const row = await unwrap<{ minor_unit_exponent: number } | null>(
        db
          .from("currencies")
          .select("minor_unit_exponent")
          .eq("currency_code", currencyCode)
          .maybeSingle(),
      );
      if (row === null)
        throw new IntegrationError(
          "currency_unknown",
          `${currencyCode} is not an ISO 4217 currency the database knows.`,
        );
      return row.minor_unit_exponent;
    },
    async record(runId, rows) {
      return unwrap<number>(db.rpc("record_attendance", { p_run_id: runId, p_rows: rows }));
    },
  };
}
